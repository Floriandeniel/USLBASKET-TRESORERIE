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
  const u = store.getUserById(session.uid);
  if (!u) { sendJson(res, 401, { error: "not_authenticated" }); return null; }
  return u;
}
function requireSuperAdmin(req, res) {
  const u = requireAuth(req, res);
  if (!u) return null;
  if (u.role !== "super_admin") { sendJson(res, 403, { error: "forbidden" }); return null; }
  return u;
}
function requireSectionAdmin(req, res) {
  // admin OR super_admin (super_admin must specify a section via query, checked by caller)
  const u = requireAuth(req, res);
  if (!u) return null;
  if (u.role !== "admin" && u.role !== "super_admin") { sendJson(res, 403, { error: "forbidden" }); return null; }
  return u;
}

/* Détermine la section "active" pour cette requête :
   - utilisateur de section (admin/membre) : toujours SA section, le client ne peut pas la changer.
   - super_admin : doit préciser ?section=ID (sinon 400), car il peut voir n'importe quelle section. */
function resolveSectionId(req, url, res, u) {
  if (u.role !== "super_admin") {
    if (!u.section_id) { sendJson(res, 409, { error: "no_section", message: "Ce compte n'est rattaché à aucune section." }); return null; }
    return u.section_id;
  }
  const q = url.searchParams.get("section");
  const sectionId = Number(q);
  if (!q || !Number.isFinite(sectionId)) { sendJson(res, 400, { error: "section_required", message: "Section non précisée." }); return null; }
  const section = store.getSectionById(sectionId);
  if (!section) { sendJson(res, 404, { error: "section_not_found" }); return null; }
  return sectionId;
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, displayName: u.display_name, role: u.role, sectionId: u.section_id, locked: store.isUserLocked(u) };
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
      const out = { authenticated: true, needsSetup: false, user: publicUser(u) };
      if (u.role === "super_admin") {
        out.sections = store.listSections();
      } else if (u.section_id) {
        out.section = store.getSectionById(u.section_id);
      }
      return sendJson(res, 200, out);
    }

    if (pathname === "/api/setup" && method === "POST") {
      // Premier compte jamais créé sur l'appli : devient administrateur général (super_admin),
      // rattaché à aucune section. Il crée ensuite ses sections depuis l'application.
      if (store.countUsers() > 0) return sendJson(res, 409, { error: "already_initialized" });
      const body = await readJsonBody(req);
      const username = (body.username || "").trim().toLowerCase();
      const password = body.password || "";
      const displayName = (body.displayName || "").trim() || username;
      if (!username || password.length < 6) return sendJson(res, 400, { error: "invalid_input", message: "Identifiant requis, mot de passe de 6 caractères minimum." });
      const u = store.createUser({ username, passwordHash: auth.hashPassword(password), displayName, role: "super_admin", sectionId: null });
      res.setHeader("Set-Cookie", auth.makeSessionCookie(u));
      return sendJson(res, 200, { ok: true, user: publicUser(u) });
    }

    if (pathname === "/api/login" && method === "POST") {
      const body = await readJsonBody(req);
      const username = (body.username || "").trim().toLowerCase();
      const password = body.password || "";
      const u = store.getUserByUsername(username);

      if (u && store.isUserLocked(u)) {
        const mins = Math.max(1, Math.ceil((new Date(u.locked_until).getTime() - Date.now()) / 60000));
        const hrs = Math.floor(mins / 60);
        const remain = hrs >= 1 ? `${hrs} h` : `${mins} min`;
        return sendJson(res, 423, {
          error: "account_locked",
          message: `Compte temporairement bloqué suite à plusieurs tentatives de connexion échouées. Réessayez dans environ ${remain}, ou demandez à un administrateur de débloquer votre compte.`
        });
      }

      if (!u || !auth.verifyPassword(password, u.password)) {
        if (u) {
          const updated = store.recordFailedLogin(u.id);
          if (store.isUserLocked(updated)) {
            return sendJson(res, 423, {
              error: "account_locked",
              message: "Trop de tentatives échouées : compte bloqué pendant 24h. Demandez à un administrateur de le débloquer si besoin."
            });
          }
          const remaining = store.LOGIN_LOCK_THRESHOLD - updated.failed_attempts;
          return sendJson(res, 401, {
            error: "invalid_credentials",
            message: `Identifiant ou mot de passe incorrect. Encore ${remaining} tentative(s) avant blocage temporaire du compte.`
          });
        }
        return sendJson(res, 401, { error: "invalid_credentials", message: "Identifiant ou mot de passe incorrect." });
      }

      store.resetLoginAttempts(u.id);
      res.setHeader("Set-Cookie", auth.makeSessionCookie(u));
      return sendJson(res, 200, { ok: true, user: publicUser(u) });
    }

    if (pathname === "/api/logout" && method === "POST") {
      res.setHeader("Set-Cookie", auth.clearSessionCookie());
      return sendJson(res, 200, { ok: true });
    }

    /* ---------------- SECTIONS (super_admin uniquement) ---------------- */
    if (pathname === "/api/sections" && method === "GET") {
      const u = requireAuth(req, res);
      if (!u) return;
      if (u.role === "super_admin") {
        const sections = store.listSections().map((s) => {
          const cfg = store.getConfig(s.id);
          const txs = store.listTransactions(s.id);
          return { ...s, summary: sectionSummary(cfg, txs) };
        });
        return sendJson(res, 200, sections);
      }
      if (u.section_id) return sendJson(res, 200, [store.getSectionById(u.section_id)]);
      return sendJson(res, 200, []);
    }
    if (pathname === "/api/sections" && method === "POST") {
      if (!requireSuperAdmin(req, res)) return;
      const body = await readJsonBody(req);
      const name = (body.name || "").trim();
      if (!name) return sendJson(res, 400, { error: "invalid_input", message: "Nom de section requis." });
      if (name.length > 80) return sendJson(res, 400, { error: "invalid_input", message: "Nom trop long." });
      const existing = store.listSections().find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (existing) return sendJson(res, 409, { error: "name_taken", message: "Une section porte déjà ce nom." });
      const section = store.createSection(name);
      return sendJson(res, 200, section);
    }
    const sectionIdMatch = pathname.match(/^\/api\/sections\/(\d+)$/);
    if (sectionIdMatch && method === "PUT") {
      if (!requireSuperAdmin(req, res)) return;
      const id = Number(sectionIdMatch[1]);
      const body = await readJsonBody(req);
      const name = (body.name || "").trim();
      if (!name) return sendJson(res, 400, { error: "invalid_input", message: "Nom requis." });
      const section = store.renameSection(id, name);
      if (!section) return sendJson(res, 404, { error: "not_found" });
      return sendJson(res, 200, section);
    }
    if (sectionIdMatch && method === "DELETE") {
      if (!requireSuperAdmin(req, res)) return;
      const id = Number(sectionIdMatch[1]);
      if (store.sectionHasData(id)) {
        return sendJson(res, 400, { error: "not_empty", message: "Cette section contient encore des mouvements ou des membres. Videz-la avant de la supprimer." });
      }
      const ok = store.deleteSection(id);
      if (!ok) return sendJson(res, 404, { error: "not_found" });
      return sendJson(res, 200, { ok: true });
    }

    /* ---------------- SAUVEGARDE COMPLÈTE (administrateur général) ---------------- */
    if (pathname === "/api/backup" && method === "GET") {
      if (!requireSuperAdmin(req, res)) return;
      return sendJson(res, 200, { exportedAt: new Date().toISOString(), sections: store.fullBackup() });
    }

    /* ---------------- USERS ---------------- */
    if (pathname === "/api/users" && method === "GET") {
      const u = requireSectionAdmin(req, res);
      if (!u) return;
      if (u.role === "super_admin") {
        return sendJson(res, 200, store.listUsers(null).map((r) => ({
          id: r.id, username: r.username, displayName: r.display_name, role: r.role,
          sectionId: r.section_id, sectionName: r.section_name || null, createdAt: r.created_at,
          locked: store.isUserLocked({ locked_until: r.locked_until })
        })));
      }
      return sendJson(res, 200, store.listUsers(u.section_id).map((r) => ({
        id: r.id, username: r.username, displayName: r.display_name, role: r.role,
        sectionId: r.section_id, createdAt: r.created_at,
        locked: store.isUserLocked({ locked_until: r.locked_until })
      })));
    }
    if (pathname === "/api/users" && method === "POST") {
      const u = requireSectionAdmin(req, res);
      if (!u) return;
      const body = await readJsonBody(req);
      const username = (body.username || "").trim().toLowerCase();
      const password = body.password || "";
      const displayName = (body.displayName || "").trim() || username;
      const role = body.role === "admin" ? "admin" : "member"; // jamais super_admin via l'API
      let sectionId;
      if (u.role === "super_admin") {
        sectionId = Number(body.sectionId);
        if (!sectionId || !store.getSectionById(sectionId)) return sendJson(res, 400, { error: "invalid_section", message: "Section invalide." });
      } else {
        sectionId = u.section_id;
      }
      if (!username || password.length < 6) return sendJson(res, 400, { error: "invalid_input", message: "Identifiant requis, mot de passe de 6 caractères minimum." });
      if (store.getUserByUsername(username)) return sendJson(res, 409, { error: "username_taken" });
      const created = store.createUser({ username, passwordHash: auth.hashPassword(password), displayName, role, sectionId });
      return sendJson(res, 200, publicUser(created));
    }
    const userIdMatch = pathname.match(/^\/api\/users\/(\d+)$/);
    if (userIdMatch && method === "PUT") {
      const u = requireSectionAdmin(req, res);
      if (!u) return;
      const id = Number(userIdMatch[1]);
      const target = store.getUserById(id);
      if (!target) return sendJson(res, 404, { error: "not_found" });
      if (u.role !== "super_admin" && target.section_id !== u.section_id) return sendJson(res, 403, { error: "forbidden" });
      if (target.role === "super_admin" && u.role !== "super_admin") return sendJson(res, 403, { error: "forbidden" });
      const body = await readJsonBody(req);
      const fields = {};
      if (body.displayName !== undefined) fields.displayName = String(body.displayName).trim();
      if (body.role !== undefined && target.role !== "super_admin") fields.role = body.role === "admin" ? "admin" : "member";
      if (body.password) {
        if (String(body.password).length < 6) return sendJson(res, 400, { error: "invalid_input", message: "Mot de passe trop court." });
        fields.passwordHash = auth.hashPassword(body.password);
      }
      if (fields.role === "member" && target.role === "admin" && store.countSectionAdmins(target.section_id) <= 1) {
        return sendJson(res, 400, { error: "last_admin", message: "Impossible de retirer le dernier administrateur de cette section." });
      }
      if (body.unlock) store.resetLoginAttempts(id);
      const updated = store.updateUser(id, fields);
      if (!updated) return sendJson(res, 404, { error: "not_found" });
      return sendJson(res, 200, publicUser(updated));
    }
    if (userIdMatch && method === "DELETE") {
      const u = requireSectionAdmin(req, res);
      if (!u) return;
      const id = Number(userIdMatch[1]);
      const target = store.getUserById(id);
      if (!target) return sendJson(res, 404, { error: "not_found" });
      if (u.role !== "super_admin" && target.section_id !== u.section_id) return sendJson(res, 403, { error: "forbidden" });
      if (target.role === "super_admin") {
        if (u.role !== "super_admin") return sendJson(res, 403, { error: "forbidden" });
        if (store.countSuperAdmins() <= 1) return sendJson(res, 400, { error: "last_admin", message: "Impossible de supprimer le dernier administrateur général." });
      }
      if (target.role === "admin" && store.countSectionAdmins(target.section_id) <= 1) {
        return sendJson(res, 400, { error: "last_admin", message: "Impossible de supprimer le dernier administrateur de cette section." });
      }
      store.deleteUser(id);
      return sendJson(res, 200, { ok: true });
    }

    /* ---------------- CONFIG (scopé à la section active) ---------------- */
    if (pathname === "/api/config" && method === "GET") {
      const u = requireAuth(req, res);
      if (!u) return;
      const sectionId = resolveSectionId(req, url, res, u);
      if (sectionId === null) return;
      return sendJson(res, 200, store.getConfig(sectionId));
    }
    if (pathname === "/api/config" && method === "PUT") {
      const u = requireAuth(req, res);
      if (!u) return;
      const sectionId = resolveSectionId(req, url, res, u);
      if (sectionId === null) return;
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object") return sendJson(res, 400, { error: "invalid_input" });
      store.setConfig(sectionId, body);
      return sendJson(res, 200, { ok: true });
    }

    /* ---------------- TRANSACTIONS (scopées à la section active) ---------------- */
    if (pathname === "/api/transactions" && method === "GET") {
      const u = requireAuth(req, res);
      if (!u) return;
      const sectionId = resolveSectionId(req, url, res, u);
      if (sectionId === null) return;
      return sendJson(res, 200, store.listTransactions(sectionId));
    }
    if (pathname === "/api/transactions" && method === "POST") {
      const u = requireAuth(req, res);
      if (!u) return;
      const sectionId = resolveSectionId(req, url, res, u);
      if (sectionId === null) return;
      const body = await readJsonBody(req);
      if (!body.type || !body.montant) return sendJson(res, 400, { error: "invalid_input" });
      const tx = store.createTransaction(sectionId, body, u.username);
      return sendJson(res, 200, tx);
    }
    const txIdMatch = pathname.match(/^\/api\/transactions\/(\d+)$/);
    if (txIdMatch && method === "PUT") {
      const u = requireAuth(req, res);
      if (!u) return;
      const sectionId = resolveSectionId(req, url, res, u);
      if (sectionId === null) return;
      const id = Number(txIdMatch[1]);
      const body = await readJsonBody(req);
      const tx = store.updateTransaction(sectionId, id, body, u.username);
      if (!tx) return sendJson(res, 404, { error: "not_found" });
      return sendJson(res, 200, tx);
    }
    if (txIdMatch && method === "DELETE") {
      const u = requireAuth(req, res);
      if (!u) return;
      const sectionId = resolveSectionId(req, url, res, u);
      if (sectionId === null) return;
      const id = Number(txIdMatch[1]);
      const ok = store.deleteTransaction(sectionId, id);
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

/* Résumé minimal d'une section pour la vue globale de l'administrateur général. */
function sectionSummary(cfg, transactions) {
  var produits = 0, charges = 0;
  transactions.forEach(function (t) {
    if (t.type === "entree") produits += t.montant;
    else if (t.type === "sortie") charges += t.montant;
  });
  var accounts = cfg.accounts || [];
  var tresorerie = accounts.reduce(function (sum, a) { return sum + (Number(a.opening) || 0); }, 0);
  transactions.forEach(function (t) {
    if (t.type === "entree") tresorerie += t.montant;
    else if (t.type === "sortie") tresorerie -= t.montant;
    // les transferts ne changent pas le total tous-comptes-cumulés
  });
  return { produits, charges, resultat: produits - charges, tresorerie, nbMouvements: transactions.length };
}

server.listen(PORT, () => {
  console.log(`USL Trésorerie en écoute sur le port ${PORT}`);
});
