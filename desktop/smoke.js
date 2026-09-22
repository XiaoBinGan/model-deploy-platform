"use strict";

const { start } = require("./server");

async function get(url) {
  const r = await fetch(url);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json, text };
}

(async () => {
  const s = await start(0);
  console.log("local control plane:", s.url);

  const health = await get(s.url + "api/health");
  console.log("health:", JSON.stringify(health.json));

  const self = await get(s.url + "api/hardware/self");
  const hw = self.json || {};
  console.log("hardware/self:", JSON.stringify({
    source: hw.source,
    trusted: hw.trusted,
    cpu: hw.cpu,
    ram_gb: hw.ram_gb,
    ram_available_gb: hw.ram_available_gb,
    gpu: (hw.gpus || [])[0],
    backends: hw.backends,
  }, null, 2));

  const page = await get(s.url);
  console.log("page:", page.status, page.text.length, "bytes, has UI:",
    page.text.indexOf("Inference control plane") >= 0);

  const rec = await fetch(s.url + "api/models/recommend", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "chat", goal: "balanced", backend: "ollama", limit: 5 }),
  });
  const recText = await rec.text();
  let recJson = null;
  try { recJson = JSON.parse(recText); } catch (e) {}
  console.log("recommend:", rec.status, recJson ? JSON.stringify({
    mode: recJson.mode,
    client_is_local: recJson.client_is_local,
    hardware_source: recJson.hardware_source,
    reason_key: recJson.reason_key,
    pick: recJson.recommendation && recJson.recommendation.id,
  }) : recText.slice(0, 300));

  s.close();
})().catch((e) => { console.error("smoke failed:", e.message); process.exit(1); });
