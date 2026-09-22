"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { start } = require("./server");

let failures = 0;

function check(name, ok, detail) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  -> " + detail : ""));
  if (!ok) failures += 1;
}

async function getJson(url) {
  const r = await fetch(url);
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function postJson(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function waitSettled(base, id, seconds) {
  for (let i = 0; i < seconds; i += 1) {
    const d = (await getJson(base + "api/deployments/" + id)).body;
    if (d && d.status !== "STARTING") return d;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return (await getJson(base + "api/deployments/" + id)).body;
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdp-smoke-"));
  const s = await start(0, { dataDir });
  const base = s.url;
  console.log("local control plane:", base, "| data:", dataDir);

  const health = await getJson(base + "api/health");
  check("health mode=desktop", health.body && health.body.mode === "desktop", JSON.stringify(health.body));

  const self = (await getJson(base + "api/hardware/self")).body || {};
  check("hardware/self is real", !!self.cpu && !!self.ram_gb,
    self.cpu + " / " + self.ram_gb + "GB / free " + self.ram_available_gb + "GB");

  const page = await fetch(base);
  const html = await page.text();
  // Assert on the app's real element ids rather than a byte count or a headline,
  // so a UI restyle does not fail this check.
  const appMarkers = ['id="pick"', 'id="d-model"', 'id="t-out"', "<main>"];
  check("serves existing frontend",
    page.status === 200 && appMarkers.every((m) => html.indexOf(m) >= 0),
    html.length + " bytes");

  // The deploy dropdown used to serialise JSON into value="..." and the browser
  // truncated it at the first quote, so option.value was "{" and JSON.parse
  // always threw. Guard both halves of that fix.
  const escSrc = (html.match(/function esc\(s\)\{[^}]*\}/) || [""])[0];
  check("frontend esc escapes quotes",
    escSrc.indexOf("&quot;") >= 0 && escSrc.indexOf("&#39;") >= 0);
  // Scope this to the deploy dropdown itself: esc(JSON.stringify(...)) is still
  // correct elsewhere, where the result lands in text rather than in an attribute.
  const fillSrc = (html.match(/function fillDeployModels\(rec\)\{[\s\S]*?\n\}/) || [""])[0];
  check("deploy dropdown keeps model data out of the attribute",
    fillSrc.indexOf("JSON.stringify") < 0 && fillSrc.indexOf("DEPLOY_MODELS") >= 0);

  const rec = (await postJson(base + "api/models/recommend",
    { task: "chat", goal: "balanced", backend: "ollama", limit: 5 })).body || {};
  check("recommend is client-side", rec.client_is_local === true && rec.hardware_source === "client:agent",
    rec.reason_key + " -> " + (rec.recommendation && rec.recommendation.id));

  const backends = (await getJson(base + "api/backends")).body || {};
  check("backends detected locally", Array.isArray(backends.backends) && backends.backends.length > 0,
    JSON.stringify(backends.backends));

  // Inject a profile that is deliberately NOT this machine, to prove the plan
  // follows the client profile rather than the server probe.
  const foreign = (await postJson(base + "api/plans/preview", {
    model_id: "qwen3-8b", model_path: "/tmp/x.gguf", backend: "llama.cpp", port: 8080,
    hardware: {
      source: "browser", platform: "win32", ram_gb: 32,
      gpus: [{ name: "NVIDIA GeForce RTX 3060", vendor: "nvidia", vram_gb: 12, uma: false }],
    },
  })).body || {};
  check("plan follows an explicit client profile",
    foreign.hardware_source === "client:browser" &&
      Math.abs((foreign.hardware || {}).usable_vram_gb - 10.0) < 0.01,
    "source=" + foreign.hardware_source + " usable=" + (foreign.hardware || {}).usable_vram_gb +
      "GB window=" + (foreign.decision && foreign.decision.planned_window));

  const localPlan = (await postJson(base + "api/plans/preview",
    { model_id: "qwen3-8b", model_path: "/tmp/x.gguf", backend: "llama.cpp", port: 8080 })).body || {};
  check("plan defaults to this machine when none supplied",
    localPlan.hardware_source === "client:agent" && (localPlan.hardware || {}).usable_vram_gb > 10.5,
    "source=" + localPlan.hardware_source + " usable=" + (localPlan.hardware || {}).usable_vram_gb + "GB");

  // --- failure path: llama.cpp with a model file that does not exist ---
  const bad = (await postJson(base + "api/deployments",
    { model_path: "/nonexistent/model.gguf", model_id: "qwen3-8b", backend: "llama.cpp", port: 8080 })).body;
  check("create deployment", bad && bad.status === "CREATED" && bad.port === 8080, bad && bad.id);

  await postJson(base + "api/deployments/" + bad.id + "/start");
  const settled = await waitSettled(base, bad.id, 20);
  check("bad gguf path fails with a clear log", settled.status === "FAILED" &&
    (settled.log || []).some((l) => l.indexOf(".gguf") >= 0),
    settled.status + " | " + (settled.log || []).slice(-1)[0]);

  const h = (await getJson(base + "api/deployments/" + bad.id + "/health")).body || {};
  check("health reports unhealthy", h.healthy === false, h.error || h.status_code);

  const t = (await postJson(base + "api/deployments/" + bad.id + "/test", { message: "hi" })).body || {};
  check("test reports failure, not a crash", t.ok === false, String(t.error).slice(0, 60));

  const list = (await getJson(base + "api/deployments")).body || {};
  check("deployments persisted", (list.deployments || []).length === 1, (list.deployments || []).length + " item(s)");

  // --- real end-to-end: only when a model is named on the command line ---
  const flag = process.argv.indexOf("--ollama");
  if (flag > 0 && process.argv[flag + 1]) {
    const model = process.argv[flag + 1];
    console.log("\n  real ollama deployment of " + model + " (this loads it into memory)");
    const dep = (await postJson(base + "api/deployments",
      { model_path: model, model_name: model, model_id: model, backend: "ollama", port: 9999 })).body;
    check("ollama create forces port 11434", dep.port === 11434 && dep.model_path === model, dep.id);

    await postJson(base + "api/deployments/" + dep.id + "/start");
    const done = await waitSettled(base, dep.id, 180);
    check("ollama start reaches RUNNING", done.status === "RUNNING",
      done.status + " | " + (done.log || []).slice(-1)[0]);

    const hh = (await getJson(base + "api/deployments/" + dep.id + "/health")).body || {};
    check("ollama health is 200", hh.healthy === true, "status_code=" + hh.status_code);

    // qwen3 is a thinking model: too small a budget is spent on reasoning and
    // the visible content comes back empty, so give it room and assert text.
    const tt = (await postJson(base + "api/deployments/" + dep.id + "/test",
      { message: "用一句话说明你是什么模型", max_tokens: 256 })).body || {};
    check("ollama chat completion returns text",
      tt.ok === true && typeof tt.reply === "string" && tt.reply.trim().length > 0,
      tt.ok ? JSON.stringify(tt.reply).slice(0, 90) : String(tt.error).slice(0, 120));

    await postJson(base + "api/deployments/" + dep.id + "/stop");
    const stopped = (await getJson(base + "api/deployments/" + dep.id)).body || {};
    check("ollama stop unloads the model", stopped.status === "STOPPED", stopped.status);
  }

  s.close();
  console.log("\n" + (failures ? failures + " CHECK(S) FAILED" : "all checks passed"));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(1);
});
