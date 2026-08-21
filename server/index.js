"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const auth = require("./auth.js");
const store = require("./db.js");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) { reject(new Error("too_large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (e) { reject(new Error("invalid_json")); }
    });
    req.on("error", reject);
  });
}
function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback for unknown non-api paths
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end("Not found"); return; }
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

function requireAuth(req, res) {
  const session = auth.sessionFromRequest(req);
  if (!session) { sendJson(res, 401, { error: "not_authenticated" }); return null; }
  return session;
}
function requireAdmin(req, res) {
  const session = requireAuth(req, res);
  if (!session) return null;
  if (session.role !== "admin") { sendJson(res, 403, { error: "forbidden" }); return null; }
  return session;
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, displayName: u.display_name, role: u.role };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;
  const method = req.method;

  try {
    if (pathname === "/api/health" && method === "GET") {
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/me" && method === "GET") {
      const session = auth.sessionFromRequest(req);
      const needsSetup = store.countUsers() === 0;
      if (!session) return sendJson(res, 200, { authenticated: false, needsSetup });
      const u = store.getUserById(session.uid);
      if (!u) return sendJson(res, 200, { authenticated: false, needsSetup });
      return sendJson(res, 200, { authenticated: true, needsSetup: false, user: publicUser(u) });
    }

    if (pathname === "/api/setup" && method === "POST") {
      if (store.countUsers() > 0) return sendJson(res, 409, { error: "already_initialized" });
      const body = await readJsonBody(req);
      const username = (body.username || "").trim().toLowerCase();
      const password = body.password || "";
      const displayName = (body.displayName || "").trim() || username;
      if (!username || password.length < 6) return sendJson(res, 400, { error: "invalid_input", message: "Identifiant requis, mot de passe de 6 caractères minimum." });
      const u = store.createUser({ username, passwordHash: auth.hashPassword(password), displayName, role: "admin" });
      res.setHeader("Set-Cookie", auth.makeSessionCookie(u));
      return sendJson(res, 200, { ok: true, user: publicUser(u) });
    }

    if (pathname === "/api/login" && method === "POST") {
      const body = await readJsonBody(req);
      const username = (body.username || "").trim().toLowerCase();
      const password = body.password || "";
      const u = store.getUserByUsername(username);
      if (!u || !auth.verifyPassword(password, u.password)) {
        return sendJson(res, 401, { error: "invalid_credentials", message: "Identifiant ou mot de passe incorrect." });
      }
      res.setHeader("Set-Cookie", auth.makeSessionCookie(u));
      return sendJson(res, 200, { ok: true, user: publicUser(u) });
    }

    if (pathname === "/api/logout" && method === "POST") {
      res.setHeader("Set-Cookie", auth.clearSessionCookie());
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/users" && method === "GET") {
      if (!requireAdmin(req, res)) return;
      return sendJson(res, 200, store.listUsers().map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role, createdAt: u.created_at })));
    }
    if (pathname === "/api/users" && method === "POST") {
      if (!requireAdmin(req, res)) return;
      const body = await readJsonBody(req);
      const username = (body.username || "").trim().toLowerCase();
      const password = body.password || "";
      const displayName = (body.displayName || "").trim() || username;
      const role = body.role === "admin" ? "admin" : "member";
      if (!username || password.length < 6) return sendJson(res, 400, { error: "invalid_input", message: "Identifiant requis, mot de passe de 6 caractères minimum." });
      if (store.getUserByUsername(username)) return sendJson(res, 409, { error: "username_taken" });
      const u = store.createUser({ username, passwordHash: auth.hashPassword(password), displayName, role });
      return sendJson(res, 200, publicUser(u));
    }
    const userIdMatch = pathname.match(/^\/api\/users\/(\d+)$/);
    if (userIdMatch && method === "PUT") {
      const session = requireAdmin(req, res);
      if (!session) return;
      const id = Number(userIdMatch[1]);
      const body = await readJsonBody(req);
      const fields = {};
      if (body.displayName !== undefined) fields.displayName = String(body.displayName).trim();
      if (body.role !== undefined) fields.role = body.role === "admin" ? "admin" : "member";
      if (body.password) {
        if (String(body.password).length < 6) return sendJson(res, 400, { error: "invalid_input", message: "Mot de passe trop court." });
        fields.passwordHash = auth.hashPassword(body.password);
      }
      if (fields.role === "member" && store.getUserById(id) && store.getUserById(id).role === "admin" && store.countAdmins() <= 1) {
        return sendJson(res, 400, { error: "last_admin", message: "Impossible de retirer le dernier administrateur." });
      }
      const u = store.updateUser(id, fields);
      if (!u) return sendJson(res, 404, { error: "not_found" });
      return sendJson(res, 200, publicUser(u));
    }
    if (userIdMatch && method === "DELETE") {
      const session = requireAdmin(req, res);
      if (!session) return;
      const id = Number(userIdMatch[1]);
      const target = store.getUserById(id);
      if (!target) return sendJson(res, 404, { error: "not_found" });
      if (target.role === "admin" && store.countAdmins() <= 1) return sendJson(res, 400, { error: "last_admin", message: "Impossible de supprimer le dernier administrateur." });
      store.deleteUser(id);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/config" && method === "GET") {
      if (!requireAuth(req, res)) return;
      return sendJson(res, 200, store.getConfig());
    }
    if (pathname === "/api/config" && method === "PUT") {
      if (!requireAuth(req, res)) return;
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object") return sendJson(res, 400, { error: "invalid_input" });
      store.setConfig(body);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/transactions" && method === "GET") {
      if (!requireAuth(req, res)) return;
      return sendJson(res, 200, store.listTransactions());
    }
    if (pathname === "/api/transactions" && method === "POST") {
      const session = requireAuth(req, res);
      if (!session) return;
      const body = await readJsonBody(req);
      if (!body.type || !body.montant) return sendJson(res, 400, { error: "invalid_input" });
      const tx = store.createTransaction(body, session.username);
      return sendJson(res, 200, tx);
    }
    const txIdMatch = pathname.match(/^\/api\/transactions\/(\d+)$/);
    if (txIdMatch && method === "PUT") {
      const session = requireAuth(req, res);
      if (!session) return;
      const id = Number(txIdMatch[1]);
      const body = await readJsonBody(req);
      const tx = store.updateTransaction(id, body, session.username);
      if (!tx) return sendJson(res, 404, { error: "not_found" });
      return sendJson(res, 200, tx);
    }
    if (txIdMatch && method === "DELETE") {
      if (!requireAuth(req, res)) return;
      const id = Number(txIdMatch[1]);
      const ok = store.deleteTransaction(id);
      if (!ok) return sendJson(res, 404, { error: "not_found" });
      return sendJson(res, 200, { ok: true });
    }

    if (pathname.startsWith("/api/")) {
      return sendJson(res, 404, { error: "not_found" });
    }

    return serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    if (err && err.message === "too_large") return sendJson(res, 413, { error: "payload_too_large" });
    if (err && err.message === "invalid_json") return sendJson(res, 400, { error: "invalid_json" });
    return sendJson(res, 500, { error: "server_error" });
  }
});

server.listen(PORT, () => {
  console.log(`USL Trésorerie en écoute sur le port ${PORT}`);
});
