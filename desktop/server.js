"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { probe } = require("./probe");
const { Deployments } = require("./deploy");

const SERVICE = (process.env.MDP_SERVICE || "http://127.0.0.1:8790").replace(/[/]+$/, "");
const FRONTEND = path.join(__dirname, "..", "frontend", "index.html");

// A local JSON API has no legitimate multi-megabyte request. 1 MiB keeps a
// runaway body from being buffered whole in the Electron main process.
const MAX_BODY_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = Number(process.env.MDP_UPSTREAM_TIMEOUT_MS) > 0
  ? Number(process.env.MDP_UPSTREAM_TIMEOUT_MS)
  : 30000;

// Headers that belong to one hop and must not be forwarded. content-length is
// dropped because fetch recomputes it; host is dropped so fetch derives it from
// the control-plane URL rather than from the client.
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);
// fetch has already decoded the body, so a forwarded content-encoding would tell
// the browser to decode plain text a second time.
const DECODED = new Set(["content-encoding"]);

let cached = null;
let cachedAt = 0;
let deploys = null;

async function probeCached() {
  if (cached && Date.now() - cachedAt < 10000) return cached;
  cached = await probe();
  cachedAt = Date.now();
  return cached;
}

function send(res, status, body, type, extraHeaders) {
  if (res.writableEnded || res.destroyed) return undefined;
  const headers = {
    "content-type": type || "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (value === undefined || value === null) continue;
      headers[key.toLowerCase()] = value;
    }
  }
  try {
    res.writeHead(status, headers);
    res.end(body);
  } catch (e) {
    try {
      res.destroy();
    } catch (_) {
      // Already gone.
    }
  }
  return undefined;
}

function httpError(status, detail) {
  const e = new Error(detail);
  e.statusCode = status;
  return e;
}

// One place turns a thrown error into a response, so a 413 from readBody is not
// flattened into a 500 by an outer catch.
function fail(res, e, fallback) {
  const status = (e && e.statusCode) || fallback || 500;
  return send(res, status, JSON.stringify({ detail: String((e && e.message) || e) }));
}

function methodNotAllowed(res, allow) {
  return send(res, 405, JSON.stringify({ detail: "method not allowed" }), undefined, {
    allow: allow,
  });
}

function readBody(req, maxBytes) {
  const limit = maxBytes || MAX_BODY_BYTES;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const failRead = (err) => {
      if (settled) return;
      settled = true;
      req.removeListener("data", onData);
      // Drain the rest without buffering so the 413 can be flushed instead of
      // stalling on an unconsumed request body.
      req.resume();
      reject(err);
    };
    const onData = (c) => {
      if (settled) return;
      size += c.length;
      if (size > limit) {
        failRead(httpError(413, "请求体超过 " + limit / 1024 / 1024 + " MiB 上限"));
        return;
      }
      chunks.push(c);
    };
    req.on("data", onData);
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (e) => failRead(e));
  });
}

async function jsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw httpError(400, "请求体不是合法 JSON");
  }
  // Arrays, numbers, strings and null are valid JSON but not a request object.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw httpError(400, "请求体必须是 JSON 对象");
  }
  return parsed;
}

// Pass the client's meaningful headers upstream (authorization, accept, custom
// tracing headers, ...) instead of only content-type.
function upstreamRequestHeaders(req) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k)) continue;
    headers[k] = Array.isArray(value) ? value.join(", ") : value;
  }
  if (!headers["content-type"] && req.method !== "GET" && req.method !== "HEAD") {
    headers["content-type"] = "application/json";
  }
  return headers;
}

// Forward the upstream's own response headers (content-type, cache-control,
// pagination, retry-after, ...) rather than just the content type.
function upstreamResponseHeaders(r) {
  const headers = {};
  r.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k) || DECODED.has(k)) return;
    headers[k] = value;
  });
  return headers;
}

function timedOut(e) {
  return !!e && (e.name === "TimeoutError" || e.name === "AbortError");
}

async function forward(req, res, body) {
  const init = {
    method: req.method,
    headers: upstreamRequestHeaders(req),
    // A control plane that accepts the connection then stops answering used to
    // hang the desktop request forever.
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  };
  if (body !== undefined && body !== null && req.method !== "GET" && req.method !== "HEAD") {
    init.body = body;
  }
  let r;
  try {
    r = await fetch(SERVICE + req.url, init);
  } catch (e) {
    if (timedOut(e)) {
      return send(res, 504, JSON.stringify({
        detail: "上游控制面超时（" + Math.round(UPSTREAM_TIMEOUT_MS / 1000) + "s）",
      }));
    }
    return send(res, 502, JSON.stringify({
      detail: "无法连接控制面 " + SERVICE + ": " + ((e && e.message) || e),
    }));
  }
  let text;
  try {
    text = await r.text();
  } catch (e) {
    if (timedOut(e)) {
      return send(res, 504, JSON.stringify({ detail: "读取上游响应超时" }));
    }
    return send(res, 502, JSON.stringify({ detail: "读取上游响应失败: " + ((e && e.message) || e) }));
  }
  return send(
    res,
    r.status,
    text,
    r.headers.get("content-type") || "application/json",
    upstreamResponseHeaders(r)
  );
}

function missingDeployment(res, id) {
  return send(res, 404, JSON.stringify({ detail: "Deployment " + id + " not found" }));
}

async function handle(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method;

  // Never forward a path-traversal attempt upstream. Literal ".." is already
  // normalized away by URL, so decode the remaining percent-encoded form.
  let decodedPath = url.pathname;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch (e) {
    // Malformed escape; leave it as-is and let the route decide.
  }
  if (decodedPath.indexOf("..") >= 0) {
    return send(res, 404, JSON.stringify({ detail: "not found" }));
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    if (method !== "GET" && method !== "HEAD") return methodNotAllowed(res, "GET, HEAD");
    try {
      return send(res, 200, fs.readFileSync(FRONTEND, "utf8"), "text/html; charset=utf-8");
    } catch (e) {
      return send(res, 500, "找不到 frontend/index.html", "text/plain; charset=utf-8");
    }
  }

  if (url.pathname === "/api/health") {
    if (method !== "GET") return methodNotAllowed(res, "GET");
    return send(res, 200, JSON.stringify({ status: "ok", mode: "desktop", service: SERVICE, version: "0.2.0" }));
  }

  if (url.pathname === "/api/hardware/self") {
    if (method !== "GET") return methodNotAllowed(res, "GET");
    const data = await probeCached();
    return send(res, 200, JSON.stringify(Object.assign({}, data, {
      trusted: true,
      note: "本地助手实测，代表这台机器",
    })));
  }

  if (url.pathname === "/api/backends") {
    if (method !== "GET") return methodNotAllowed(res, "GET");
    return send(res, 200, JSON.stringify(await deploys.detectBackends()));
  }

  // Install a backend on THIS machine. Streamed over SSE so the user watches
  // each command run, rather than a spinner over something that is modifying
  // their computer.
  if (parts[0] === "api" && parts[1] === "backends" && parts[2] && parts[3] === "install") {
    if (method !== "GET") return methodNotAllowed(res, "GET");
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
      if (!id) {
        if (method === "GET") {
          return send(res, 200, JSON.stringify({ deployments: deploys.list() }));
        }
        if (method === "POST") {
          const body = await jsonBody(req);
          body.hardware = await probeCached();
          return send(res, 200, JSON.stringify(deploys.create(body)));
        }
        return methodNotAllowed(res, "GET, POST");
      }
      // A nonexistent deployment is a missing resource, not a bad request.
      if (!deploys.get(id).id) return missingDeployment(res, id);
      if (!action) {
        if (method === "GET") return send(res, 200, JSON.stringify(deploys.get(id)));
        if (method === "DELETE") return send(res, 200, JSON.stringify(await deploys.delete(id)));
        return methodNotAllowed(res, "GET, DELETE");
      }
      if (action === "start") {
        if (method !== "POST") return methodNotAllowed(res, "POST");
        return send(res, 200, JSON.stringify(deploys.start(id)));
      }
      if (action === "stop") {
        if (method !== "POST") return methodNotAllowed(res, "POST");
        return send(res, 200, JSON.stringify(await deploys.stop(id)));
      }
      if (action === "health") {
        if (method !== "GET") return methodNotAllowed(res, "GET");
        return send(res, 200, JSON.stringify(await deploys.health(id)));
      }
      if (action === "test") {
        if (method !== "POST") return methodNotAllowed(res, "POST");
        const body = await jsonBody(req);
        return send(res, 200, JSON.stringify(
          await deploys.test(id, body.message, body.model_name, body.max_tokens)
        ));
      }
      return send(res, 404, JSON.stringify({ detail: "unknown deployment route" }));
    } catch (e) {
      return fail(res, e, 400);
    }
  }

  // --- size the plan for THIS machine, never for the control plane ---
  if (url.pathname === "/api/plans/preview") {
    if (method !== "POST") return methodNotAllowed(res, "POST");
    let payload;
    try {
      payload = await jsonBody(req);
    } catch (e) {
      return fail(res, e, 400);
    }
    if (!payload.hardware) payload.hardware = await probeCached();
    payload.client_is_local = true;
    return forward(req, res, JSON.stringify(payload));
  }

  if (url.pathname === "/api/models/recommend") {
    if (method !== "POST") return methodNotAllowed(res, "POST");
    let payload;
    try {
      payload = await jsonBody(req);
    } catch (e) {
      return fail(res, e, 400);
    }
    payload.hardware = await probeCached();
    payload.client_is_local = true;
    return forward(req, res, JSON.stringify(payload));
  }

  if (url.pathname.indexOf("/api/") === 0) {
    const body = method === "GET" || method === "HEAD" ? null : await readBody(req);
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
      handle(req, res).catch((e) => fail(res, e, 500));
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
