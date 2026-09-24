"use strict";

const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { installPlan, BACKEND_INFO, gpuPath } = require("./installers");

const OLLAMA_BASE = "http://127.0.0.1:11434";
const OLLAMA_PORT = 11434;
const START_TIMEOUT_S = 90;
const PULL_TIMEOUT_MS = 30 * 60 * 1000;
const STOP_GRACE_MS = 5000;
// mlx-lm loads weights lazily, so "server is listening" and "model can answer"
// are minutes apart on a large model.
const WARMUP_ATTEMPT_MS = 120 * 1000;
const WARMUP_TOTAL_MS = 30 * 60 * 1000;

// The service is a hint source, never a command source. These bounds are what
// makes that enforceable: a value outside them is treated as absent.
const DEFAULT_WINDOW = 65536;
const MIN_WINDOW = 1024;
const MAX_WINDOW = 1048576;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

// Docker deployment defaults and hard bounds. These are validated on the way in
// and never "cleaned up": a silently rewritten image name or path is worse than
// a rejected request (docs/docker-design.md §5).
const DEFAULT_DOCKER_IMAGE = "vllm/vllm-openai:latest";
const DOCKER_IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$/;
const GPUS_RE = /^[0-9]+(,[0-9]+)*$/;
const VOLUME_PATH_RE = /^\/[^:\u0000]{0,400}$/;
const MAX_VOLUMES = 8;
const MAX_EXTRA_ARGS = 32;
const MAX_EXTRA_ARG_LEN = 200;
const DOCKER_REMOVE_TIMEOUT_MS = 15000;
const HAS_BINARY_TIMEOUT_MS = 8000;

// Every backend the UI can show, so the ones this machine cannot run still get
// an explanation instead of vanishing from the list.
const ALL_BACKENDS = ["ollama", "llama.cpp", "mlx", "transformers", "vllm", "sglang", "docker"];

// An install downloads a lot and can compile; 30 minutes is the same budget a
// model pull gets.
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

function nowIso() {
  return new Date().toISOString().replace(/[.][0-9]{3}Z$/, "Z");
}

// A context window below 1K is meaningless and one above 1M would try to
// allocate the machine to death. Anything else, including a non-number, is
// reported as "no opinion" so the caller falls back to its own default.
function safeWindow(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const w = Math.floor(n);
  if (w < MIN_WINDOW || w > MAX_WINDOW) return null;
  return w;
}

// Warnings are rendered into the deployment log, so a newline in one would let
// the service forge additional log lines.
function safeWarnings(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).map((w) => String(w).replace(/[\r\n]+/g, " ").slice(0, 300));
}

// Ports below 1024 need root and ports above 65535 are not ports. An invalid
// value falls back to the caller's default instead of reaching spawn/listen
// (DESK-17).
function safePort(value, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_PORT || n > MAX_PORT) {
    return fallback === undefined ? null : fallback;
  }
  return n;
}

// The container port is inferred from the image, never supplied by the caller
// (docs/docker-design.md §3).
function inferContainerPort(image) {
  const name = String(image || "");
  if (name.indexOf("sglang") >= 0) return 30000;
  if (name.indexOf("vllm") >= 0) return 8000;
  return 8080;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Validate the docker-only request fields. Returns the normalised values or
// throws. A throw becomes a 400 in server.js and nothing is ever spliced into
// the argv (docs/docker-design.md §5).
function validateDockerFields(req) {
  let image = req.image;
  if (image === undefined || image === null || image === "") image = DEFAULT_DOCKER_IMAGE;
  if (typeof image !== "string" || !DOCKER_IMAGE_RE.test(image)) {
    throw new Error("非法的 docker 镜像名：" + String(image).slice(0, 80));
  }

  let gpus = req.gpus;
  if (gpus === undefined || gpus === null || gpus === "") gpus = "all";
  if (typeof gpus !== "string" || !(gpus === "all" || gpus === "none" || GPUS_RE.test(gpus))) {
    throw new Error("非法的 gpus：" + String(gpus).slice(0, 80));
  }

  let volumes = req.volumes;
  if (volumes === undefined || volumes === null) volumes = [];
  if (!Array.isArray(volumes)) throw new Error("volumes 必须是数组");
  if (volumes.length > MAX_VOLUMES) throw new Error("volumes 最多 " + MAX_VOLUMES + " 条");
  const vols = volumes.map((v, i) => {
    if (!isPlainObject(v)) throw new Error("volumes[" + i + "] 必须是对象");
    if (typeof v.host !== "string" || !VOLUME_PATH_RE.test(v.host)) {
      throw new Error("volumes[" + i + "].host 必须是绝对路径");
    }
    if (typeof v.container !== "string" || !VOLUME_PATH_RE.test(v.container)) {
      throw new Error("volumes[" + i + "].container 必须是绝对路径");
    }
    if (v.ro !== undefined && typeof v.ro !== "boolean") {
      throw new Error("volumes[" + i + "].ro 必须是布尔");
    }
    if (!fs.existsSync(v.host)) throw new Error("volumes[" + i + "].host 不存在：" + v.host);
    return { host: v.host, container: v.container, ro: v.ro === true };
  });

  let extra = req.extra_args;
  if (extra === undefined || extra === null) extra = [];
  if (!Array.isArray(extra)) throw new Error("extra_args 必须是数组");
  if (extra.length > MAX_EXTRA_ARGS) throw new Error("extra_args 最多 " + MAX_EXTRA_ARGS + " 项");
  const args = extra.map((a, i) => {
    if (typeof a !== "string") throw new Error("extra_args[" + i + "] 必须是字符串");
    if (a.length > MAX_EXTRA_ARG_LEN) throw new Error("extra_args[" + i + "] 超过 " + MAX_EXTRA_ARG_LEN + " 字符");
    if (a.indexOf("\u0000") >= 0 || /[\r\n]/.test(a)) throw new Error("extra_args[" + i + "] 含 NUL 或换行");
    return a;
  });

  return { image, gpus, volumes: vols, extra_args: args, container_port: inferContainerPort(image) };
}

function hasBinary(name) {
  const probe = process.platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    // A which that hangs (network filesystem, wrapper script) must not hang
    // /api/backends forever (DESK-24).
    execFile(probe, [name], { timeout: HAS_BINARY_TIMEOUT_MS }, (err) => resolve(!err));
  });
}

async function reachable(url, timeoutMs) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs || 2000) });
    return r.status;
  } catch (e) {
    return 0;
  }
}

class Deployments {
  constructor(dataDir, service) {
    this.service = service || "";
    this.file = path.join(dataDir, "deployments.json");
    this.items = new Map();
    this.procs = new Map();
    // Ids deleted in this process, so a re-read merge does not resurrect them
    // (DESK-13).
    this._removed = new Set();
    this.seq = 0;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch (e) {
      // Persistence is best effort; the app still works in memory.
    }
    this._load();
  }

  _load() {
    let text;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (e) {
      // First run, or the file was removed. Start empty.
      return;
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      // A truncated or corrupt file used to be dropped without a trace,
      // silently losing every deployment (DESK-14). Keep a backup and say so.
      this._backupCorrupt(e);
      return;
    }
    let corrected = false;
    for (const item of raw.items || []) {
      // A child process never survives the app, so anything that claimed to
      // be running was really stopped when we quit.
      if (item.status === "RUNNING" || item.status === "STARTING") {
        item.status = "STOPPED";
        item.log = (item.log || []).concat("应用重启，进程已不存在，标记为 STOPPED");
        corrected = true;
      }
      item.pid = null;
      this.items.set(item.id, item);
    }
    this.seq = raw.seq || this.items.size;
    // Persist the correction so the file stops claiming RUNNING and the next
    // load does not append the restart line again (DESK-20).
    if (corrected) this._save();
  }

  _backupCorrupt(err) {
    const backup = this.file + ".bak";
    try {
      fs.copyFileSync(this.file, backup);
      console.error("[deploy] deployments.json 无法解析，已备份到 " + backup + "：" + err.message);
    } catch (e2) {
      console.error("[deploy] deployments.json 无法解析，备份也失败：" + e2.message);
    }
  }

  // Refresh seq from disk before allocating, so two instances that both loaded
  // an empty file do not hand out the same deployment id (DESK-13).
  _nextSeq() {
    const disk = this._readDisk();
    if (disk && typeof disk.seq === "number" && disk.seq > this.seq) this.seq = disk.seq;
    this.seq += 1;
    return this.seq;
  }

  // Best-effort read of the on-disk state for merging. Never throws.
  _readDisk() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (e) {
      return null;
    }
  }

  _save() {
    // Re-read before writing and merge in items another instance added since we
    // loaded, so two windows do not overwrite each other (DESK-13).
    const disk = this._readDisk();
    if (disk && Array.isArray(disk.items)) {
      for (const item of disk.items) {
        if (!item || !item.id) continue;
        if (this._removed.has(item.id)) continue;
        if (!this.items.has(item.id)) this.items.set(item.id, item);
      }
      if (typeof disk.seq === "number" && disk.seq > this.seq) this.seq = disk.seq;
    }
    const items = [...this.items.values()].map((i) => Object.assign({}, i, { pid: null }));
    const json = JSON.stringify({ seq: this.seq, items }, null, 2);
    // Write to a temp file and rename over the target: rename is atomic, so a
    // crash mid-write cannot leave a truncated deployments.json (DESK-14).
    const tmp = this.file + ".tmp";
    try {
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // Ignore: the in-memory record is still usable.
      try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* ignore */ }
    }
  }

  _log(item, line) {
    if (!line) return;
    item.log = (item.log || []).concat(String(line).slice(0, 500));
    if (item.log.length > 300) item.log = item.log.slice(-300);
  }

  list() {
    return [...this.items.values()];
  }

  get(id) {
    return this.items.get(id) || {};
  }

  async detectBackends() {
    // Only advertise what this app can actually start. vLLM and SGLang used to
    // be listed when their binaries existed, but _run() blocks them here, so
    // choosing one only produced a deployment that failed at start.
    const backends = [];
    const installed = [];
    const caps = await this._caps();
    if (await reachable(OLLAMA_BASE + "/api/tags", 1500)) backends.push("ollama");
    if (await hasBinary("llama-server")) backends.push("llama.cpp");
    // MLX is the only high-throughput path on Apple Silicon; vLLM has no macOS
    // wheels at all.
    if (process.platform === "darwin" && process.arch === "arm64" && (await this._mlxPython())) {
      backends.push("mlx");
    }
    if (await hasBinary("vllm")) installed.push("vllm");
    if (await hasBinary("sglang")) installed.push("sglang");
    // A `docker` binary on PATH is not enough; only a live daemon makes the
    // backend deployable. Otherwise the entry goes through installPlan, which
    // either offers the install or explains that the daemon is down (§6).
    if (caps.docker) backends.push("docker");

    // For everything this app cannot start, work out whether it *could* be
    // installed here and what that would run. Greying an entry out and stopping
    // there leaves the user with no way forward; this is what the UI needs to
    // offer one.
    const ctx = await this._installCtx();
    const installable = {};
    const unavailable = {};
    for (const name of ALL_BACKENDS) {
      if (backends.indexOf(name) >= 0) continue;
      const plan = await installPlan(name, ctx);
      const info = BACKEND_INFO[name] || "";
      if (plan.ok) {
        installable[name] = {
          info,
          steps: plan.steps.map((s) => s.note),
          manual: plan.manual,
          gpu: plan.gpu || "",
        };
      } else {
        unavailable[name] = {
          info,
          reason: plan.reason,
          manual: plan.manual,
          kind: plan.kind,
          gpu: plan.gpu || "",
        };
      }
    }

    // allow_remote_deploy is always true here: in the desktop app every
    // deployment is local by definition.
    return {
      backends,
      installed,
      installable,
      unavailable,
      caps: ctx.caps,
      allow_remote_deploy: true,
      local: true,
    };
  }

  // Whether a GPU-only backend could run here at all, and by which route.
  // Probed rather than assumed - the whole reason this branch exists is that
  // assumed platform facts kept turning out wrong.
  async _caps() {
    if (this._capsCache && Date.now() - this._capsAt < 30000) return this._capsCache;
    const docker = (await hasBinary("docker")) && (await this._dockerAlive());
    const nvidia = await hasBinary("nvidia-smi");
    this._capsCache = { platform: process.platform, docker, nvidia };
    this._capsAt = Date.now();
    return this._capsCache;
  }

  // `docker` on PATH does not mean the daemon is up, and a stopped Docker
  // Desktop is the common case on a desktop machine.
  _dockerAlive() {
    return new Promise((resolve) => {
      let child;
      try {
        child = execFile(
          "docker",
          ["info", "--format", "{{.ServerVersion}}"],
          { timeout: 6000 },
          (err, stdout) => resolve(!err && String(stdout || "").trim().length > 0)
        );
      } catch (e) {
        // execFile validates its arguments synchronously; a throw here must not
        // take the whole capability probe down with it.
        resolve(false);
        return;
      }
      if (child && child.on) child.on("error", () => resolve(false));
    });
  }

  _hfCachePath() {
    // os.homedir() already resolves to USERPROFILE on Windows, so the same
    // relative path is right on every platform.
    return path.join(os.homedir(), ".cache", "huggingface");
  }

  // The HuggingFace cache is always mounted so `--rm` does not throw away
  // multi-GB weights between starts. Create the host directory if it is
  // missing; a failure only warns, because the user may point HF elsewhere
  // (docs/docker-design.md §4).
  _ensureHfCache(item) {
    const dir = this._hfCachePath();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      this._log(item, "警告：无法创建 HuggingFace 缓存目录 " + dir + "：" + e.message +
        "（容器仍会挂载它，权重可能无法跨重启保留）");
    }
    item.hf_cache = dir;
    return dir;
  }

  // `docker rm -f` by name, via execFile so it stays an argv array and never a
  // shell string. Failure is expected when the container does not exist, so it
  // is logged at most and never thrown (docs/docker-design.md §4.1).
  _dockerRemove(item) {
    return new Promise((resolve) => {
      let child;
      const done = (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || "").trim() || String(stdout || "").trim() || err.message;
          if (detail.indexOf("No such container") < 0 && detail.indexOf("No such object") < 0) {
            this._log(item, "docker rm -f 未删除容器：" + detail.split("\n")[0].slice(0, 160));
          }
        }
        resolve();
      };
      try {
        child = execFile("docker", ["rm", "-f", "mdp-" + item.id],
          { timeout: DOCKER_REMOVE_TIMEOUT_MS }, done);
      } catch (e) {
        resolve();
        return;
      }
      if (child && child.on) child.on("error", () => resolve());
    });
  }

  async _installCtx() {
    return {
      platform: process.platform,
      arch: process.arch,
      home: os.homedir(),
      has: hasBinary,
      caps: await this._caps(),
    };
  }

  // Streams an install over SSE. The plan is rebuilt locally from the backend
  // name - never accepted from the caller - for the same reason the launch argv
  // is (see _plan): this runs real commands on the user's machine.
  async installStream(name, res) {
    const emit = (event) => {
      try {
        res.write("data: " + JSON.stringify(event) + "\n\n");
      } catch (e) {
        // The window went away mid-install; the steps still finish.
      }
    };

    if (ALL_BACKENDS.indexOf(name) < 0) {
      emit({ type: "error", reason: "不认识这个后端：" + name });
      return res.end();
    }

    const plan = await installPlan(name, await this._installCtx());
    if (!plan.ok) {
      emit({ type: "error", reason: plan.reason, manual: plan.manual, gpu: plan.gpu || "" });
      return res.end();
    }

    emit({ type: "plan", backend: name, steps: plan.steps.map((s) => s.note), manual: plan.manual });
    for (let i = 0; i < plan.steps.length; i += 1) {
      const step = plan.steps[i];
      emit({ type: "step", index: i, note: step.note, command: step.argv.join(" ") });
      const code = await this._runInstallStep(step, (line) => emit({ type: "output", index: i, line }));
      if (code !== 0) {
        emit({ type: "done", ok: false, failedIndex: i, code });
        return res.end();
      }
    }

    // Re-probe so the entry turns selectable without a manual refresh.
    const after = await this.detectBackends();
    emit({ type: "done", ok: true, backends: after.backends, installable: after.installable });
    res.end();
  }

  _runInstallStep(step, onLine) {
    return new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(step.argv[0], step.argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        onLine("无法启动 " + step.argv[0] + "：" + e.message);
        return resolve(-1);
      }
      // Track it so quitting the app does not leave a half-finished install
      // holding the terminal.
      const key = "install:" + step.argv[0];
      this.procs.set(key, { proc, kind: "install" });
      let settled = false;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const cur = this.procs.get(key);
        if (cur && cur.proc === proc) this.procs.delete(key);
        resolve(code);
      };
      const timer = setTimeout(async () => {
        onLine("超过 " + INSTALL_TIMEOUT_MS / 60000 + " 分钟，已终止");
        await this._kill(proc, 3000);
        finish(-1);
      }, INSTALL_TIMEOUT_MS);

      const onData = (buf) => {
        String(buf).replace(/\r/g, "").split("\n").forEach((line) => {
          const text = line.trim();
          if (text) onLine(text.slice(0, 300));
        });
      };
      proc.stdout.on("data", onData);
      proc.stderr.on("data", onData);
      proc.on("error", (e) => {
        onLine(String(e.message));
        finish(-1);
      });
      proc.on("close", (code) => finish(code === null ? -1 : code));
    });
  }

  create(req) {
    const backend = req.backend || "ollama";
    const id = "dep_" + Date.now() + "_" + this._nextSeq();
    let port = safePort(req.port, 8000);
    let modelPath = req.model_path || req.model_id || "custom";
    if (backend === "ollama") {
      port = OLLAMA_PORT;
      // A missing model name used to fall through as undefined and only failed
      // at start time with "加载 undefined" (DESK-18).
      modelPath = req.model_name || req.model_path || req.model_id;
      if (!modelPath) throw new Error("ollama 部署必须提供 model_name（或 model_path）");
    }
    // The docker-only fields are validated before anything is stored, and a
    // rejection reaches the caller as a 400 (docs/docker-design.md §5).
    const docker = backend === "docker" ? validateDockerFields(req) : null;
    const host = "127.0.0.1";
    const item = {
      id,
      model_path: modelPath,
      model_id: req.model_id || "custom",
      backend,
      port,
      host,
      display_host: host,
      dtype: req.dtype || "bfloat16",
      quantization: req.quantization || null,
      status: "CREATED",
      pid: null,
      endpoint: "http://" + host + ":" + port + "/v1",
      health_endpoint:
        backend === "ollama"
          ? "http://" + host + ":" + port + "/api/tags"
          : "http://" + host + ":" + port + "/health",
      created_at: nowIso(),
      hardware: req.hardware || null,
      log: [],
    };
    if (docker) {
      item.image = docker.image;
      item.gpus = docker.gpus;
      item.volumes = docker.volumes;
      item.extra_args = docker.extra_args;
      item.container_port = docker.container_port;
      // Resolved here so _dockerArgv stays pure, and the host directory is
      // created before the mount is used.
      this._ensureHfCache(item);
    }
    this.items.set(id, item);
    this._save();
    return item;
  }

  start(id) {
    const item = this.items.get(id);
    if (!item) throw new Error("Deployment " + id + " not found");
    // STARTING must be a no-op too. Starting twice spawned two servers and the
    // second overwrote the first in this.procs, leaking a process that stop()
    // could no longer reach.
    if (item.status === "RUNNING" || item.status === "STARTING") return item;
    item.status = "STARTING";
    item.gen = (item.gen || 0) + 1;
    const gen = item.gen;
    this._save();
    this._run(item, gen).catch((e) => {
      if (this._stale(item, gen)) return;
      item.status = "FAILED";
      this._log(item, "启动失败：" + ((e && e.message) || e));
      this._save();
    });
    return item;
  }

  // Every start and stop bumps item.gen. Work still in flight from an older
  // generation must not write status back, or a stop gets undone by the start
  // it interrupted.
  _stale(item, gen) {
    return item.gen !== gen;
  }

  // SIGTERM, then SIGKILL if the process is still alive after the grace period.
  // llama-server and ollama both ignore SIGTERM in some states, and a process
  // that survived was still reported as stopped.
  _kill(proc, graceMs) {
    return new Promise((resolve) => {
      if (!proc || proc.exitCode !== null || proc.signalCode) return resolve();
      let done = false;
      let timer = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      proc.once("close", finish);
      timer = setTimeout(() => {
        if (done) return;
        try {
          proc.kill("SIGKILL");
        } catch (e) {
          // Already gone.
        }
        setTimeout(finish, 500);
      }, graceMs || STOP_GRACE_MS);
      try {
        proc.kill("SIGTERM");
      } catch (e) {
        finish();
      }
    });
  }

  async _run(item, gen) {
    if (item.backend === "ollama") return this._runOllama(item, gen);
    if (item.backend === "llama.cpp" || item.backend === "llamacpp") return this._runLlama(item, gen);
    if (item.backend === "mlx") return this._runMlx(item, gen);
    if (item.backend === "docker") return this._runDocker(item, gen);
    item.status = "BLOCKED";
    // "桌面端不支持" on its own told the user nothing: not why, not what to do
    // next (gap 5). Spell both out, reusing the GPU/Docker assessment.
    const caps = await this._caps();
    if (item.backend === "transformers") {
      this._log(item, "transformers 的 runtime 在控制面服务端" +
        "（backend/app/runtimes/transformers_server.py），桌面端本地没有这个模块" +
        "——这不是没装的问题，装了也一样跑不起来。");
      this._log(item, "下一步：在控制面所在的机器上部署它；本机想跑本地模型请用 ollama 或 mlx。");
    } else if (item.backend === "vllm" || item.backend === "sglang") {
      this._log(item, item.backend + " 官方只发 Linux wheel，没有 macOS 版本，桌面端无法本地启动。");
      this._log(item, "为什么：" + gpuPath(caps));
      this._log(item, "下一步：" + (caps.platform === "darwin"
        ? "本机请用 mlx（Apple Silicon 上对标 vLLM），或用 docker 后端跑 CPU 镜像。"
        : "Linux + NVIDIA 机器上装 Docker 后用 docker 后端，或 python3 -m pip install " + item.backend + "。"));
    } else {
      this._log(item, item.backend + " 在桌面端不支持。本机可用：ollama、llama.cpp" +
        (process.platform === "darwin" && process.arch === "arm64" ? "、mlx" : "") + "。");
    }
    this._save();
  }

  // MLX is the Apple Silicon equivalent of vLLM: it drives the GPU through
  // Metal and is the only high-throughput local path on this platform. vLLM
  // itself ships no macOS wheels, so offering it here only ever failed.
  _mlxPython() {
    // Homebrew and most distro Pythons are PEP 668 "externally managed", so
    // mlx-lm normally lands in a venv rather than the system interpreter.
    // Checking only PATH would miss exactly the install this app recommends.
    const home = os.homedir();
    const candidates = [
      process.env.MDP_MLX_PYTHON,
      path.join(home, ".mdp-mlx", "bin", "python3"),
      path.join(home, ".mdp-mlx", "bin", "python"),
      "python3",
      "python",
    ].filter(Boolean);
    return candidates.reduce(async (prev, name) => {
      const found = await prev;
      if (found) return found;
      const ok = await new Promise((resolve) => {
        execFile(name, ["-c", "import mlx_lm"], { timeout: 20000 }, (err) => resolve(!err));
      });
      return ok ? name : null;
    }, Promise.resolve(null));
  }

  // Cached: the flag set of an installed package does not change mid-session.
  async _mlxSupportsKvBits(python) {
    if (this._mlxKvBits !== undefined) return this._mlxKvBits;
    const help = await new Promise((resolve) => {
      execFile(python, ["-m", "mlx_lm", "server", "--help"],
        { timeout: 30000, maxBuffer: 1 << 20 },
        (err, stdout, stderr) => resolve(String(stdout || "") + String(stderr || "")));
    });
    this._mlxKvBits = help.includes("--kv-bits");
    return this._mlxKvBits;
  }

  async _runMlx(item, gen) {
    if (process.platform !== "darwin" || process.arch !== "arm64") {
      item.status = "BLOCKED";
      this._log(item, "MLX 需要 Apple Silicon（macOS + arm64），本机是 " +
        process.platform + "/" + process.arch + "。");
      this._save();
      return;
    }
    const python = await this._mlxPython();
    if (this._stale(item, gen)) return;
    if (!python) {
      item.status = "FAILED";
      // Homebrew 和多数发行版的 Python 都受 PEP 668 管控，直接 pip install 会被拒，
      // 所以给的是 venv 方案——探测顺序也覆盖了这个默认位置。
      this._log(item, "没有找到装了 mlx-lm 的 Python。安装（需要 venv，系统 Python 通常被 PEP 668 管控）：");
      this._log(item, "  python3 -m venv ~/.mdp-mlx && ~/.mdp-mlx/bin/pip install mlx-lm");
      this._log(item, "模型用 mlx-community 的权重，例如 mlx-community/Qwen3-8B-4bit。");
      this._log(item, "装在别处的话设 MDP_MLX_PYTHON 指向那个解释器。");
      this._save();
      return;
    }

    // "python -m mlx_lm.server" still works but prints a deprecation notice in
    // mlx-lm 0.31.3; the subcommand form is the one it points at.
    const cmd = [python, "-m", "mlx_lm", "server",
      "--model", item.model_path,
      "--host", "127.0.0.1",
      "--port", String(item.port)];
    // KV quantization is what makes the 64K floor affordable on unified memory,
    // and q8_0 maps to --kv-bits 8. But mlx-lm only grew that flag after the
    // released 0.31.3 (it is on main, unreleased), and passing it to an older
    // build aborts startup with exit code 2. Ask the installed version instead
    // of assuming. kv_bits === 0 disables it outright.
    if (item.kv_bits !== 0) {
      if (await this._mlxSupportsKvBits(python)) {
        cmd.push("--kv-bits", String(item.kv_bits || 8));
      } else {
        this._log(item, "这个 mlx-lm 版本不支持 --kv-bits，KV 缓存按全精度分配" +
          "（长上下文会更吃内存，必要时换更小的模型）。");
      }
    }
    item.command = cmd;
    this._log(item, "命令：" + cmd.join(" "));

    let proc;
    try {
      proc = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      item.status = "FAILED";
      this._log(item, "无法启动 mlx_lm.server：" + e.message);
      this._save();
      return;
    }
    this.procs.set(item.id, { proc, kind: "server" });
    item.pid = proc.pid;

    const onData = (buf) => {
      const text = String(buf).replace(/\r/g, "").trim();
      if (!text) return;
      // Our own warmup timeout closes the connection while the server is still
      // downloading, so it fails to write its response and prints a long
      // BrokenPipeError traceback. That is self-inflicted noise and would
      // otherwise look like a crash.
      if (text.indexOf("BrokenPipeError") >= 0) return;
      if (/^[~^ ]+$/.test(text)) return;
      this._log(item, text.split("\n").pop());
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", (e) => {
      item.status = "FAILED";
      this._log(item, "无法启动 mlx_lm.server：" + e.message);
      this._save();
    });
    proc.on("close", (code) => {
      const cur = this.procs.get(item.id);
      if (cur && cur.proc === proc) this.procs.delete(item.id);
      if (this._stale(item, gen)) return;
      item.pid = null;
      if (item.status !== "STOPPED") {
        item.status = code === 0 ? "STOPPED" : "FAILED";
        this._log(item, "mlx_lm.server 退出，code=" + code);
      }
      this._save();
    });

    const healthy = await this._waitHealthy(item, START_TIMEOUT_S, gen);
    if (this._stale(item, gen)) return;
    if (!healthy) {
      if (item.status === "STARTING") {
        item.status = "FAILED";
        this._log(item, "等待健康检查超时（" + START_TIMEOUT_S + "s），已终止进程");
        await this._kill(proc, STOP_GRACE_MS);
      }
      this._save();
      return;
    }

    // mlx_lm.server binds the port BEFORE the weights exist: /health is backed by
    // "the generation thread is alive", so it answers 200 while the model is
    // still downloading, and ModelProvider loads on demand at the first
    // completion request. Reporting RUNNING here made the user's first message
    // time out, so force the load and wait for a real answer.
    this._log(item, "服务已监听，正在加载权重（首次会下载，可能几分钟）…");
    const warmed = await this._warmup(item, gen);
    if (this._stale(item, gen)) return;
    if (warmed) {
      item.status = "RUNNING";
      this._log(item, "mlx_lm.server 就绪（权重已加载）：" + item.endpoint);
    } else if (item.status === "STARTING") {
      item.status = "FAILED";
      this._log(item, "权重加载超时（" + WARMUP_TOTAL_MS / 60000 + " 分钟），已终止进程");
      await this._kill(proc, STOP_GRACE_MS);
    }
    this._save();
  }

  // Force the lazy load with a one-token completion. A client timeout is the
  // model still downloading, not a failure, so this retries until the deadline.
  async _warmup(item, gen) {
    const deadline = Date.now() + WARMUP_TOTAL_MS;
    let announced = 0;
    while (Date.now() < deadline) {
      if (this._stale(item, gen)) return false;
      try {
        const r = await fetch(item.endpoint + "/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: item.model_path,
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 1,
          }),
          signal: AbortSignal.timeout(WARMUP_ATTEMPT_MS),
        });
        if (r.ok) return true;
        if (r.status >= 400 && r.status < 500) {
          // A 4xx is a real rejection, not a slow load.
          this._log(item, "权重加载被拒绝：" + r.status + " " + (await r.text()).slice(0, 160));
          return false;
        }
      } catch (e) {
        // Still loading: keep waiting rather than failing the deployment.
      }
      const waited = Math.round((WARMUP_TOTAL_MS - (deadline - Date.now())) / 1000);
      if (waited - announced >= 30) {
        announced = waited;
        this._log(item, "仍在加载权重…已等待 " + waited + "s");
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  // Pure: reads only the item and the window. No disk, no process, so the shape
  // is testable without Docker (docs/docker-design.md §4).
  _dockerArgv(item, window) {
    const image = item.image || DEFAULT_DOCKER_IMAGE;
    const containerPort = item.container_port || inferContainerPort(image);
    const argv = [
      "docker", "run", "--rm", "--name", "mdp-" + item.id,
      "-p", "127.0.0.1:" + item.port + ":" + containerPort,
    ];
    // "none" means no GPU at all, so the flag is omitted rather than passed
    // through as an empty value.
    if (item.gpus !== "none") argv.push("--gpus", item.gpus || "all");
    for (const v of item.volumes || []) {
      argv.push("-v", v.host + ":" + v.container + (v.ro ? ":ro" : ""));
    }
    argv.push("-e", "HF_HOME=/hf");
    // Normally mounted so --rm does not discard downloaded weights between
    // starts. But if the user already mounted something at /hf, adding ours
    // second would silently override their choice (Docker mounts the later
    // target). Skip ours and let the explicit volume win; HF_HOME stays /hf
    // either way.
    const userHfMount = (item.volumes || []).some((v) => v.container === "/hf");
    if (!userHfMount) {
      argv.push("-v", (item.hf_cache || this._hfCachePath()) + ":/hf");
    }
    argv.push(image);
    if (image.indexOf("vllm") >= 0) {
      argv.push("--model", item.model_path, "--host", "0.0.0.0",
        "--port", String(containerPort), "--max-model-len", String(window));
    } else if (image.indexOf("sglang") >= 0) {
      argv.push("--model-path", item.model_path, "--host", "0.0.0.0",
        "--port", String(containerPort), "--context-length", String(window));
    }
    for (const a of item.extra_args || []) argv.push(a);
    return argv;
  }

  async _runDocker(item, gen) {
    if (process.platform === "darwin") {
      // Allowed (CPU images work), but never pretend a Mac container has a GPU.
      this._log(item, "警告：" + gpuPath({ platform: "darwin", docker: true, nvidia: false }));
    }
    const plan = await this._plan(item, "docker");
    if (this._stale(item, gen)) return;
    const window = safeWindow(plan.window) || DEFAULT_WINDOW;
    // Re-ensure the cache dir for records loaded from disk; _dockerArgv always
    // mounts it.
    this._ensureHfCache(item);
    const argv = this._dockerArgv(item, window);
    item.command = argv;
    this._log(item, "命令：" + argv.join(" "));
    for (const w of plan.warnings) this._log(item, "警告：" + w);

    // Clear any container left behind by a previous hard kill before reusing
    // the name (docs/docker-design.md §4.1).
    await this._dockerRemove(item);
    if (this._stale(item, gen)) return;

    let proc;
    try {
      proc = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      item.status = "FAILED";
      this._log(item, "无法启动 docker：" + e.message);
      this._save();
      return;
    }
    this.procs.set(item.id, { proc, kind: "server" });
    item.pid = proc.pid;

    const onData = (buf) => {
      const text = String(buf).replace(/\r/g, "").trim();
      if (text) this._log(item, text.split("\n").pop());
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", (e) => {
      item.status = "FAILED";
      this._log(item, "无法启动 docker：" + e.message);
      this._save();
    });
    proc.on("close", (code) => {
      const cur = this.procs.get(item.id);
      if (cur && cur.proc === proc) this.procs.delete(item.id);
      if (this._stale(item, gen)) return;
      item.pid = null;
      if (item.status !== "STOPPED") {
        item.status = code === 0 ? "STOPPED" : "FAILED";
        this._log(item, "docker run 退出，code=" + code);
      }
      this._save();
    });

    const healthy = await this._waitHealthy(item, START_TIMEOUT_S, gen);
    if (this._stale(item, gen)) return;
    if (healthy) {
      item.status = "RUNNING";
      this._log(item, "容器就绪：" + item.endpoint);
    } else if (item.status === "STARTING") {
      item.status = "FAILED";
      this._log(item, "等待健康检查超时（" + START_TIMEOUT_S + "s），已终止进程");
      await this._kill(proc, STOP_GRACE_MS);
      // The CLI dying does not remove the container; delete it too.
      await this._dockerRemove(item);
    }
    this._save();
  }

  async _runOllama(item, gen) {
    const model = item.model_path;
    const tags = await this._ollamaTags();
    if (this._stale(item, gen)) return;
    if (!tags.includes(model)) {
      this._log(item, "本地没有 " + model + "，开始 ollama pull（可能要几分钟）…");
      await this._ollamaPull(item, model, gen);
      if (this._stale(item, gen)) return;
    }
    this._log(item, "加载 " + model + " 到内存…");
    try {
      const r = await fetch(OLLAMA_BASE + "/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: "", stream: false, keep_alive: "30m" }),
        signal: AbortSignal.timeout(180000),
      });
      // The user may have pressed stop while this request was in flight; if so
      // it must not flip the deployment back to RUNNING and re-pin the model.
      if (this._stale(item, gen)) return;
      if (!r.ok) {
        item.status = "FAILED";
        this._log(item, "Ollama 返回 " + r.status + "：" + (await r.text()).slice(0, 200));
      } else {
        item.status = "RUNNING";
        this._log(item, model + " 已常驻内存（keep_alive 30m）");
      }
    } catch (e) {
      if (this._stale(item, gen)) return;
      item.status = "FAILED";
      this._log(item, "Ollama 调用失败：" + e.message);
    }
    this._save();
  }

  async _ollamaTags() {
    try {
      const r = await fetch(OLLAMA_BASE + "/api/tags", { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return [];
      const data = await r.json();
      return (data.models || []).map((m) => m.name);
    } catch (e) {
      return [];
    }
  }

  _ollamaPull(item, model, gen) {
    return new Promise((resolve) => {
      let proc;
      try {
        proc = spawn("ollama", ["pull", model], { stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        this._log(item, "无法执行 ollama：" + e.message);
        return resolve();
      }
      // Register the pull so stop() can reach it. A pull can run for many
      // minutes and used to be invisible to the process table.
      this.procs.set(item.id, { proc, kind: "pull" });
      item.pid = proc.pid;
      let settled = false;
      let timer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const cur = this.procs.get(item.id);
        if (cur && cur.proc === proc) this.procs.delete(item.id);
        resolve();
      };
      timer = setTimeout(async () => {
        if (settled) return;
        this._log(item, "ollama pull 超过 " + PULL_TIMEOUT_MS / 60000 + " 分钟，已终止");
        await this._kill(proc, 3000);
        finish();
      }, PULL_TIMEOUT_MS);
      const onData = (buf) => {
        const text = String(buf).replace(/\r/g, "").trim();
        if (text) this._log(item, text.split("\n").pop());
      };
      proc.stdout.on("data", onData);
      proc.stderr.on("data", onData);
      proc.on("error", (e) => {
        this._log(item, "无法执行 ollama：" + e.message);
        finish();
      });
      proc.on("close", (code) => {
        this._log(item, "ollama pull 退出码 " + code);
        finish();
      });
    });
  }

  async _runLlama(item, gen) {
    if (!fs.existsSync(item.model_path)) {
      item.status = "FAILED";
      this._log(item, "找不到模型文件：" + item.model_path);
      this._log(item, "llama.cpp 需要本机 .gguf 文件路径，HuggingFace 仓库 id 不能直接启动。");
      this._save();
      return;
    }
    if (!(await hasBinary("llama-server"))) {
      item.status = "FAILED";
      this._log(item, "PATH 里没有 llama-server。请先安装 llama.cpp（例如 brew install llama.cpp）。");
      this._save();
      return;
    }

    const plan = await this._plan(item);
    // Built here, never taken from the service. See _plan().
    const argv = this._llamaArgv(item, plan.window);
    this._log(item, "命令：" + argv.join(" "));
    for (const w of plan.warnings) this._log(item, "警告：" + w);

    const bin = argv[0];
    const args = argv.slice(1);
    let proc;
    try {
      proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      item.status = "FAILED";
      this._log(item, "无法启动 llama-server：" + e.message);
      this._save();
      return;
    }
    this.procs.set(item.id, { proc, kind: "server" });
    item.pid = proc.pid;

    const onData = (buf) => {
      const text = String(buf).replace(/\r/g, "").trim();
      if (text) this._log(item, text.split("\n").pop());
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", (e) => {
      item.status = "FAILED";
      this._log(item, "无法启动 llama-server：" + e.message);
      this._save();
    });
    proc.on("close", (code) => {
      // Only clear the slot if it still holds this process: a newer start may
      // already have replaced it.
      const cur = this.procs.get(item.id);
      if (cur && cur.proc === proc) this.procs.delete(item.id);
      if (this._stale(item, gen)) return;
      item.pid = null;
      if (item.status !== "STOPPED") {
        item.status = code === 0 ? "STOPPED" : "FAILED";
        this._log(item, "llama-server 退出，code=" + code);
      }
      this._save();
    });

    const healthy = await this._waitHealthy(item, START_TIMEOUT_S, gen);
    if (this._stale(item, gen)) return;
    if (healthy) {
      item.status = "RUNNING";
      this._log(item, "llama-server 就绪：" + item.endpoint);
    } else if (item.status === "STARTING") {
      item.status = "FAILED";
      this._log(item, "等待健康检查超时（" + START_TIMEOUT_S + "s），已终止进程");
      // A timed-out server used to be left running as an orphan holding its
      // memory and port.
      await this._kill(proc, STOP_GRACE_MS);
    }
    this._save();
  }

  async _waitHealthy(item, seconds, gen) {
    for (let i = 0; i < seconds; i += 1) {
      if (this._stale(item, gen)) return false;
      if (item.status === "STOPPED" || item.status === "FAILED") return false;
      let code = await reachable(item.health_endpoint, 1500);
      // Some images only expose the OpenAI-compatible surface. Fall back to
      // /v1/models when /health is missing (docs/docker-design.md §9).
      if (code === 404) {
        code = await reachable("http://" + item.host + ":" + item.port + "/v1/models", 1500);
      }
      if (code === 200) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  // Ask the service how big a context window this model fits in, and nothing
  // else.
  //
  // The endpoint also returns a ready-made argv ("command"), and this used to be
  // spawned verbatim. That handed arbitrary code execution on this machine to
  // whoever could answer the service URL - which is unauthenticated and, when
  // the service is remote, not necessarily the control plane at all (DESK-01).
  //
  // So the argv is assembled locally from local state, and the only thing taken
  // from the response is a single integer, clamped to a range where a context
  // window is even meaningful. Warnings are carried through as text, with
  // newlines stripped so they cannot forge extra log lines.
  async _plan(item, backend) {
    const fallback = { window: DEFAULT_WINDOW, warnings: [] };
    if (!this.service) return fallback;
    try {
      const r = await fetch(this.service + "/api/plans/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model_id: item.model_id,
          model_path: item.model_path,
          backend: backend || "llama.cpp",
          port: item.port,
          quantization: item.quantization,
          hardware: item.hardware,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return fallback;
      const data = await r.json();
      const window = safeWindow(data && data.decision && data.decision.planned_window);
      return {
        window: window === null ? DEFAULT_WINDOW : window,
        warnings: safeWarnings(data && data.warnings),
      };
    } catch (e) {
      return fallback;
    }
  }

  // Every argument comes from local state; the window is the one value the
  // service influenced, and it arrives already clamped.
  _llamaArgv(item, window) {
    const kv = item.kv_quant === "f16" ? "f16" : "q8_0";
    return [
      "llama-server", "-m", item.model_path, "--host", "127.0.0.1",
      "--port", String(item.port), "-c", String(window),
      "-ctk", kv, "-ctv", kv, "-fa", "on", "-ngl", "99",
    ];
  }

  async stop(id) {
    const item = this.items.get(id);
    if (!item) throw new Error("Deployment " + id + " not found");
    // Bump the generation first: a start still in flight is now stale and must
    // not flip the status back to RUNNING when it completes.
    item.gen = (item.gen || 0) + 1;
    item.status = "STOPPING";
    this._save();
    const entry = this.procs.get(id);
    if (entry) {
      // Wait for the process to actually die before reporting STOPPED.
      // SIGTERM alone left servers alive that still held their memory.
      await this._kill(entry.proc, STOP_GRACE_MS);
      const cur = this.procs.get(id);
      if (cur === entry) this.procs.delete(id);
    }
    if (item.backend === "docker") {
      // Killing the CLI is not enough: the container can outlive it and keep
      // holding the host port (docs/docker-design.md §4.1).
      await this._dockerRemove(item);
    }
    if (item.backend === "ollama") {
      // Ollama keeps one copy of a model for the whole daemon. Unloading here
      // would pull the model out from under another deployment that still
      // references it (DESK-07).
      const shared = [...this.items.values()].some((other) =>
        other.id !== item.id &&
        other.backend === "ollama" &&
        other.model_path === item.model_path &&
        (other.status === "RUNNING" || other.status === "STARTING"));
      if (shared) {
        this._log(item, item.model_path + " 仍被其他部署使用，保留在 Ollama 中");
      } else {
        try {
          await fetch(OLLAMA_BASE + "/api/generate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: item.model_path, keep_alive: "0" }),
            signal: AbortSignal.timeout(10000),
          });
          this._log(item, item.model_path + " 已从 Ollama 卸载");
        } catch (e) {
          // Unloading is best effort.
        }
      }
    }
    item.status = "STOPPED";
    item.pid = null;
    this._save();
    return item;
  }

  async delete(id) {
    const item = this.items.get(id);
    if (!item) throw new Error("Deployment " + id + " not found");
    // Stop first so a deleted deployment never leaves a child behind.
    if (this.procs.has(id) || item.status === "RUNNING" || item.status === "STARTING") {
      await this.stop(id).catch(() => {});
    }
    if (item.backend === "docker") await this._dockerRemove(item);
    this.procs.delete(id);
    this.items.delete(id);
    // Remember the deletion so the merge in _save does not bring it back.
    this._removed.add(id);
    this._save();
    return { id, deleted: true };
  }

  // Called on app quit and on server close so no child outlives the window.
  async stopAll() {
    const ids = [...this.items.keys()];
    await Promise.all(ids.map((id) => this.stop(id).catch(() => {})));
  }

  async health(id) {
    const item = this.items.get(id);
    if (!item) throw new Error("Deployment " + id + " not found");
    const url = item.health_endpoint;
    // A deployment that is not RUNNING has no process of its own, so a 200 from
    // this port belongs to some other deployment. Only RUNNING can be healthy
    // (DESK-12).
    if (item.status !== "RUNNING") {
      return { deployment_id: id, url, healthy: false, status: item.status };
    }
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      return { deployment_id: id, url, status_code: r.status, healthy: r.status === 200, status: item.status };
    } catch (e) {
      return { deployment_id: id, url, healthy: false, error: e.message, status: item.status };
    }
  }

  async test(id, message, modelName, maxTokens) {
    const item = this.items.get(id);
    if (!item) throw new Error("Deployment " + id + " not found");
    const model = modelName || item.model_path;
    const url = "http://127.0.0.1:" + item.port + "/v1/chat/completions";
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: message || "你好，请用一句话介绍你自己" }],
          max_tokens: Number(maxTokens) || 512,
        }),
        signal: AbortSignal.timeout(120000),
      });
      if (!r.ok) {
        return { ok: false, url, status_code: r.status, error: (await r.text()).slice(0, 500) };
      }
      const data = await r.json();
      const choice = (data.choices || [])[0] || {};
      // Named replyMessage, not message: message is this function parameter and
      // is still referenced by the request body above.
      const replyMessage = choice.message || {};
      let reply = typeof replyMessage.content === "string" ? replyMessage.content : "";
      let source = "content";
      // Thinking models (qwen3, deepseek-r1) put the visible answer in content
      // and the chain of thought in reasoning. If the token budget runs out
      // mid-thought, content is empty and reasoning holds the only text there
      // is; returning blank would look like a broken deployment.
      if (!reply.trim()) {
        const thought = replyMessage.reasoning || replyMessage.reasoning_content;
        if (typeof thought === "string" && thought.trim()) {
          reply = thought;
          source = "reasoning";
        }
      }
      const result = {
        ok: true,
        url,
        status_code: r.status,
        model,
        reply,
        reply_source: source,
        finish_reason: choice.finish_reason || null,
        usage: data.usage || {},
      };
      if (choice.finish_reason === "length" && source === "reasoning") {
        result.hint = "回复被 max tokens 截断：模型把预算用在了思考上。请把最大 Token 调到 512 以上。";
      }
      return result;
    } catch (e) {
      return { ok: false, url, error: e.message };
    }
  }
}

module.exports = { Deployments, safePort, hasBinary };
