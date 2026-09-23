"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { probe } = require("./probe");
const { Deployments } = require("./deploy");

const SERVICE = (process.env.MDP_SERVICE || "http://127.0.0.1:8790").replace(/[/]+$/, "");
const FRONTEND = path.join(__dirname, "..", "frontend", "index.html");

let cached = null;
let cachedAt = 0;
let deploys = null;

async function probeCached() {
  if (cached && Date.now() - cachedAt < 10000) return cached;
  cached = await probe();
  cachedAt = Date.now();
  return cached;
}

function send(res, status, body, type) {
  res.writeHead(status, {
    "content-type": type || "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function jsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

async function forward(req, res, body) {
  const init = {
    method: req.method,
    headers: { "content-type": req.headers["content-type"] || "application/json" },
  };
  if (body) init.body = body;
  try {
    const r = await fetch(SERVICE + req.url, init);
    send(res, r.status, await r.text(), r.headers.get("content-type") || "application/json");
  } catch (e) {
    send(res, 502, JSON.stringify({ detail: "无法连接控制面 " + SERVICE + ": " + e.message }));
  }
}

async function handle(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    try {
      return send(res, 200, fs.readFileSync(FRONTEND, "utf8"), "text/html; charset=utf-8");
    } catch (e) {
      return send(res, 500, "找不到 frontend/index.html", "text/plain; charset=utf-8");
    }
  }

  if (url.pathname === "/api/health") {
    return send(res, 200, JSON.stringify({ status: "ok", mode: "desktop", service: SERVICE, version: "0.2.0" }));
  }

  if (url.pathname === "/api/hardware/self") {
    const data = await probeCached();
    return send(res, 200, JSON.stringify(Object.assign({}, data, {
      trusted: true,
      note: "本地助手实测，代表这台机器",
    })));
  }

  if (url.pathname === "/api/backends") {
    return send(res, 200, JSON.stringify(await deploys.detectBackends()));
  }

  // Install a backend on THIS machine. Streamed over SSE so the user watches
  // each command run, rather than a spinner over something that is modifying
  // their computer.
  if (parts[0] === "api" && parts[1] === "backends" && parts[2] && parts[3] === "install") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    try {
      await deploys.installStream(decodeURIComponent(parts[2]), res);
    } catch (e) {
      res.write("data: " + JSON.stringify({
        type: "error",
        reason: String((e && e.message) || e),
      }) + "\n\n");
      res.end();
    }
    return undefined;
  }

  // --- deployments run HERE, on the user machine, not on the control plane ---
  if (parts[0] === "api" && parts[1] === "deployments") {
    const id = parts[2];
    const action = parts[3];
    try {
      if (!id && req.method === "GET") {
        return send(res, 200, JSON.stringify({ deployments: deploys.list() }));
      }
      if (!id && req.method === "POST") {
        const body = await jsonBody(req);
        body.hardware = await probeCached();
        return send(res, 200, JSON.stringify(deploys.create(body)));
      }
      if (id && !action && req.method === "GET") {
        return send(res, 200, JSON.stringify(deploys.get(id)));
      }
      if (id && action === "start" && req.method === "POST") {
        return send(res, 200, JSON.stringify(deploys.start(id)));
      }
      if (id && action === "stop" && req.method === "POST") {
        return send(res, 200, JSON.stringify(await deploys.stop(id)));
      }
      if (id && !action && req.method === "DELETE") {
        return send(res, 200, JSON.stringify(await deploys.delete(id)));
      }
      if (id && action === "health" && req.method === "GET") {
        return send(res, 200, JSON.stringify(await deploys.health(id)));
      }
      if (id && action === "test" && req.method === "POST") {
        const body = await jsonBody(req);
        return send(res, 200, JSON.stringify(
          await deploys.test(id, body.message, body.model_name, body.max_tokens)
        ));
      }
      return send(res, 404, JSON.stringify({ detail: "unknown deployment route" }));
    } catch (e) {
      return send(res, 400, JSON.stringify({ detail: String((e && e.message) || e) }));
    }
  }

  // --- size the plan for THIS machine, never for the control plane ---
  if (url.pathname === "/api/plans/preview" && req.method === "POST") {
    let payload;
    try {
      payload = await jsonBody(req);
    } catch (e) {
      return send(res, 400, JSON.stringify({ detail: "请求体不是合法 JSON" }));
    }
    if (!payload.hardware) payload.hardware = await probeCached();
    payload.client_is_local = true;
    return forward(req, res, JSON.stringify(payload));
  }

  if (url.pathname === "/api/models/recommend" && req.method === "POST") {
    let payload;
    try {
      payload = await jsonBody(req);
    } catch (e) {
      return send(res, 400, JSON.stringify({ detail: "请求体不是合法 JSON" }));
    }
    payload.hardware = await probeCached();
    payload.client_is_local = true;
    return forward(req, res, JSON.stringify(payload));
  }

  if (url.pathname.indexOf("/api/") === 0) {
    const body = req.method === "GET" || req.method === "HEAD" ? null : await readBody(req);
    return forward(req, res, body);
  }

  send(res, 404, JSON.stringify({ detail: "not found" }));
}

function start(port, options) {
  const opts = options || {};
  const dataDir = opts.dataDir || path.join(__dirname, ".mdp-data");
  deploys = new Deployments(dataDir, SERVICE);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      handle(req, res).catch((e) => send(res, 500, JSON.stringify({ detail: String((e && e.message) || e) })));
    });
    server.listen(port || 0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        url: "http://127.0.0.1:" + addr.port + "/",
        port: addr.port,
        dataDir,
        // Reap every child before the server goes away; otherwise a
        // llama-server or ollama pull outlives the window.
        stopAll: () => (deploys ? deploys.stopAll() : Promise.resolve()),
        close: async () => {
          if (deploys) await deploys.stopAll();
          server.close();
        },
      });
    });
  });
}

module.exports = { start };
