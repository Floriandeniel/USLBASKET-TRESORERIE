"use strict";
const crypto = require("node:crypto");

const SECRET = process.env.SESSION_SECRET || (function () {
  console.warn("[auth] SESSION_SECRET n'est pas défini : une clé aléatoire temporaire est utilisée " +
    "(toutes les sessions seront invalidées au prochain redémarrage). Définissez SESSION_SECRET en variable d'environnement.");
  return crypto.randomBytes(32).toString("hex");
})();

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return salt + ":" + hash;
}
function verifyPassword(password, stored) {
  if (!stored || stored.indexOf(":") === -1) return false;
  const [salt, hash] = stored.split(":");
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(check, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sign(payloadObj) {
  const payload = b64url(JSON.stringify(payloadObj));
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return payload + "." + sig;
}
function verify(token) {
  if (!token || token.indexOf(".") === -1) return null;
  const idx = token.lastIndexOf(".");
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (obj.exp && Date.now() > obj.exp) return null;
    return obj;
  } catch (e) {
    return null;
  }
}

function makeSessionCookie(user) {
  const token = sign({ uid: user.id, username: user.username, role: user.role, exp: Date.now() + MAX_AGE_MS });
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `usl_session=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(MAX_AGE_MS / 1000)}; SameSite=Lax${secure}`;
}
function clearSessionCookie() {
  return "usl_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax";
}
function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i === -1) return;
    const k = p.slice(0, i).trim();
    const v = p.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}
function sessionFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies["usl_session"];
  if (!token) return null;
  return verify(token);
}

module.exports = { hashPassword, verifyPassword, makeSessionCookie, clearSessionCookie, sessionFromRequest };
