"use strict";

const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const OLLAMA_BASE = "http://127.0.0.1:11434";
const OLLAMA_PORT = 11434;
const START_TIMEOUT_S = 90;
const PULL_TIMEOUT_MS = 30 * 60 * 1000;
const STOP_GRACE_MS = 5000;

function nowIso() {
  return new Date().toISOString().replace(/[.][0-9]{3}Z$/, "Z");
}

function hasBinary(name) {
  const probe = process.platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    execFile(probe, [name], (err) => resolve(!err));
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
    this.seq = 0;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch (e) {
      // Persistence is best effort; the app still works in memory.
    }
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const item of raw.items || []) {
        // A child process never survives the app, so anything that claimed to
        // be running was really stopped when we quit.
        if (item.status === "RUNNING" || item.status === "STARTING") {
          item.status = "STOPPED";
          item.log = (item.log || []).concat("应用重启，进程已不存在，标记为 STOPPED");
        }
        item.pid = null;
        this.items.set(item.id, item);
      }
      this.seq = raw.seq || this.items.size;
    } catch (e) {
      // First run, or the file was removed. Start empty.
    }
  }

  _save() {
    const items = [...this.items.values()].map((i) => Object.assign({}, i, { pid: null }));
    try {
      fs.writeFileSync(this.file, JSON.stringify({ seq: this.seq, items }, null, 2));
    } catch (e) {
      // Ignore: the in-memory record is still usable.
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
    if (await reachable(OLLAMA_BASE + "/api/tags", 1500)) backends.push("ollama");
    if (await hasBinary("llama-server")) backends.push("llama.cpp");
    if (await hasBinary("vllm")) installed.push("vllm");
    if (await hasBinary("sglang")) installed.push("sglang");
    // allow_remote_deploy is always true here: in the desktop app every
    // deployment is local by definition.
    return { backends, installed, allow_remote_deploy: true, local: true };
  }

  create(req) {
    const backend = req.backend || "ollama";
    const id = "dep_" + Date.now() + "_" + (this.seq += 1);
    let port = Number(req.port) || 8000;
    let modelPath = req.model_path || req.model_id || "custom";
    if (backend === "ollama") {
      port = OLLAMA_PORT;
      modelPath = req.model_name || req.model_path || req.model_id;
    }
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
    item.status = "BLOCKED";
    this._log(item, item.backend + " 在桌面端不支持：它面向 Linux 服务器，请改用 ollama 或 llama.cpp。");
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
    this._log(item, "命令：" + plan.command.join(" "));
    for (const w of plan.warnings || []) this._log(item, "警告：" + w);

    const bin = plan.command[0];
    const args = plan.command.slice(1);
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
      const code = await reachable(item.health_endpoint, 1500);
      if (code === 200) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  async _plan(item) {
    const fallback = {
      command: [
        "llama-server", "-m", item.model_path, "--host", "127.0.0.1",
        "--port", String(item.port), "-c", "65536", "-ctk", "q8_0", "-ctv", "q8_0",
        "-fa", "on", "-ngl", "99",
      ],
      warnings: [],
    };
    if (!this.service) return fallback;
    try {
      const r = await fetch(this.service + "/api/plans/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model_id: item.model_id,
          model_path: item.model_path,
          backend: "llama.cpp",
          port: item.port,
          quantization: item.quantization,
          hardware: item.hardware,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return fallback;
      const data = await r.json();
      if (!Array.isArray(data.command) || !data.command.length) return fallback;
      return { command: data.command, warnings: data.warnings || [] };
    } catch (e) {
      return fallback;
    }
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
    if (item.backend === "ollama") {
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
    this.procs.delete(id);
    this.items.delete(id);
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

module.exports = { Deployments };
