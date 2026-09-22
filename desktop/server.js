"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { probe } = require("./probe");

const SERVICE = (process.env.MDP_SERVICE || "http://127.0.0.1:8790").replace(/[/]+$/, "");
const FRONTEND = path.join(__dirname, "..", "frontend", "index.html");

let cached = null;
let cachedAt = 0;

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

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    try {
      return send(res, 200, fs.readFileSync(FRONTEND, "utf8"), "text/html; charset=utf-8");
    } catch (e) {
      return send(res, 500, "找不到 frontend/index.html", "text/plain; charset=utf-8");
    }
  }

  if (url.pathname === "/api/health") {
    return send(res, 200, JSON.stringify({ status: "ok", mode: "desktop", service: SERVICE, version: "0.1.0" }));
  }

  if (url.pathname === "/api/hardware/self") {
    const data = await probeCached();
    return send(res, 200, JSON.stringify(Object.assign({}, data, {
      trusted: true,
      note: "本地助手实测，代表这台机器",
    })));
  }

  if (url.pathname === "/api/models/recommend" && req.method === "POST") {
    const raw = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(raw || "{}");
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

function start(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      handle(req, res).catch((e) => send(res, 500, JSON.stringify({ detail: String((e && e.message) || e) })));
    });
    server.listen(port || 0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        url: "http://127.0.0.1:" + addr.port + "/",
        port: addr.port,
        close: () => server.close(),
      });
    });
  });
}

module.exports = { start };
