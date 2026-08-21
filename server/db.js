"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "data.db");

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

const DEFAULT_CONFIG = require("./default-config.js");

/* ============================================================
   SCHEMA + MIGRATION
   L'application a d'abord été mono-section (un seul club). Elle
   devient multi-sections (plusieurs sections de l'association,
   chacune avec ses propres comptes/mouvements, confidentiels aux
   autres sections). Cette migration convertit une base existante
   sans perte de données, et ne fait rien sur une base déjà à jour
   ou toute neuve.
   ============================================================ */

function tableExists(name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function columnExists(table, col) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === col);
}

db.exec(`
CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL
);
`);

const usersTableIsNew = !tableExists("users");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  section_id INTEGER,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL
);
`);
if (!usersTableIsNew && !columnExists("users", "section_id")) {
  db.exec("ALTER TABLE users ADD COLUMN section_id INTEGER");
}
if (!usersTableIsNew && !columnExists("users", "failed_attempts")) {
  db.exec("ALTER TABLE users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0");
}
if (!usersTableIsNew && !columnExists("users", "locked_until")) {
  db.exec("ALTER TABLE users ADD COLUMN locked_until TEXT");
}

// L'ancien schéma "config" (id INTEGER PRIMARY KEY CHECK (id=1)) n'a pas de colonne
// section_id : CREATE TABLE IF NOT EXISTS ne le remplacerait pas. On le renomme donc
// explicitement avant de créer la table au nouveau schéma ; la migration ci-dessous
// lit ensuite "config_legacy" pour récupérer les données de l'ancienne installation.
if (tableExists("config") && !columnExists("config", "section_id")) {
  db.exec("ALTER TABLE config RENAME TO config_legacy;");
}
db.exec(`
CREATE TABLE IF NOT EXISTS config (
  section_id INTEGER PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT
);
`);

const txTableIsNew = !tableExists("transactions");
db.exec(`
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id INTEGER,
  type TEXT NOT NULL,
  montant REAL NOT NULL,
  account_id INTEGER,
  to_account_id INTEGER,
  cat_id INTEGER,
  sub_id INTEGER,
  date_op TEXT,
  date_saisie TEXT,
  fournisseur TEXT,
  salarie TEXT,
  description TEXT,
  evenement TEXT,
  reference TEXT,
  commentaire TEXT,
  valide INTEGER DEFAULT 1,
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT,
  updated_at TEXT
);
`);
if (!txTableIsNew && !columnExists("transactions", "section_id")) {
  db.exec("ALTER TABLE transactions ADD COLUMN section_id INTEGER");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_section ON transactions(section_id);");
db.exec("CREATE INDEX IF NOT EXISTS idx_users_section ON users(section_id);");

/* --- migration réelle : ancienne base mono-section détectée si une
   ligne "config" avec l'ancien schéma (id=1) existe encore sans
   qu'aucune section n'ait été créée. --- */
(function migrateLegacySingleTenant() {
  const hasLegacyConfigTable = tableExists("config_legacy");
  const sectionCount = db.prepare("SELECT COUNT(*) AS c FROM sections").get().c;
  if (sectionCount > 0) return; // déjà migré / déjà multi-sections

  const legacyConfigRow = hasLegacyConfigTable
    ? db.prepare("SELECT data FROM config_legacy WHERE id = 1").get()
    : null;
  const anyUsers = db.prepare("SELECT COUNT(*) AS c FROM users").get().c > 0;

  if (!legacyConfigRow && !anyUsers) {
    // base toute neuve : rien à migrer, /api/setup créera la première section.
    if (hasLegacyConfigTable) db.exec("DROP TABLE config_legacy;");
    return;
  }

  const now = new Date().toISOString();
  let legacyData = null;
  try { legacyData = legacyConfigRow ? JSON.parse(legacyConfigRow.data) : null; } catch (e) { legacyData = null; }
  const clubName = (legacyData && legacyData.meta && legacyData.meta.club) || "Section Basket";

  db.exec("BEGIN");
  try {
    const info = db.prepare("INSERT INTO sections (name, created_at) VALUES (?, ?)").run(clubName, now);
    const sectionId = Number(info.lastInsertRowid);

    const cfgToStore = legacyData || JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    db.prepare("INSERT INTO config (section_id, data, updated_at) VALUES (?, ?, ?)")
      .run(sectionId, JSON.stringify(cfgToStore), now);

    // Tous les comptes existants deviennent administrateur général (super_admin),
    // les autres deviennent membres de la nouvelle section.
    db.prepare("UPDATE users SET role = 'super_admin', section_id = NULL WHERE role = 'admin'").run();
    db.prepare("UPDATE users SET section_id = ? WHERE section_id IS NULL AND role != 'super_admin'").run(sectionId);

    db.prepare("UPDATE transactions SET section_id = ? WHERE section_id IS NULL").run(sectionId);

    db.exec("COMMIT");
    if (hasLegacyConfigTable) db.exec("DROP TABLE config_legacy;");
    console.log(`[migration] Base existante convertie en multi-sections. Section créée : "${clubName}" (id=${sectionId}).`);
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
})();

/* ============================================================
   SECTIONS
   ============================================================ */
function listSections() {
  return db.prepare("SELECT id, name, created_at FROM sections ORDER BY name ASC").all();
}
function getSectionById(id) {
  return db.prepare("SELECT id, name, created_at FROM sections WHERE id = ?").get(id);
}
function createSection(name) {
  const now = new Date().toISOString();
  const info = db.prepare("INSERT INTO sections (name, created_at) VALUES (?, ?)").run(name, now);
  const sectionId = Number(info.lastInsertRowid);
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.meta.club = name;
  db.prepare("INSERT INTO config (section_id, data, updated_at) VALUES (?, ?, ?)")
    .run(sectionId, JSON.stringify(cfg), now);
  return getSectionById(sectionId);
}
function renameSection(id, name) {
  const info = db.prepare("UPDATE sections SET name = ? WHERE id = ?").run(name, id);
  return info.changes > 0 ? getSectionById(id) : null;
}
function sectionHasData(id) {
  const tx = db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE section_id = ?").get(id).c;
  const us = db.prepare("SELECT COUNT(*) AS c FROM users WHERE section_id = ?").get(id).c;
  return tx > 0 || us > 0;
}
function deleteSection(id) {
  const info = db.prepare("DELETE FROM sections WHERE id = ?").run(id);
  if (info.changes > 0) db.prepare("DELETE FROM config WHERE section_id = ?").run(id);
  return info.changes > 0;
}

/* ============================================================
   CONFIG (par section)
   ============================================================ */
function getConfig(sectionId) {
  const row = db.prepare("SELECT data FROM config WHERE section_id = ?").get(sectionId);
  if (!row) {
    const data = JSON.stringify(DEFAULT_CONFIG);
    db.prepare("INSERT INTO config (section_id, data, updated_at) VALUES (?, ?, ?)").run(sectionId, data, new Date().toISOString());
    return JSON.parse(data);
  }
  try {
    return JSON.parse(row.data);
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}
function setConfig(sectionId, cfg) {
  const data = JSON.stringify(cfg);
  const now = new Date().toISOString();
  const row = db.prepare("SELECT section_id FROM config WHERE section_id = ?").get(sectionId);
  if (row) {
    db.prepare("UPDATE config SET data = ?, updated_at = ? WHERE section_id = ?").run(data, now, sectionId);
  } else {
    db.prepare("INSERT INTO config (section_id, data, updated_at) VALUES (?, ?, ?)").run(sectionId, data, now);
  }
}

/* ============================================================
   TRANSACTIONS (scoping strict par section)
   ============================================================ */
function rowToTx(r) {
  if (!r) return null;
  return {
    id: r.id,
    sectionId: r.section_id,
    type: r.type,
    montant: r.montant,
    accountId: r.account_id,
    toAccountId: r.to_account_id,
    catId: r.cat_id,
    subId: r.sub_id,
    dateOp: r.date_op,
    dateSaisie: r.date_saisie,
    fournisseur: r.fournisseur || "",
    salarie: r.salarie || "",
    description: r.description || "",
    evenement: r.evenement || "",
    reference: r.reference || "",
    commentaire: r.commentaire || "",
    valide: !!r.valide,
    createdBy: r.created_by || "",
    updatedBy: r.updated_by || "",
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}
function listTransactions(sectionId) {
  const rows = db.prepare("SELECT * FROM transactions WHERE section_id = ? ORDER BY date_op DESC, id DESC").all(sectionId);
  return rows.map(rowToTx);
}
function createTransaction(sectionId, tx, who) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`INSERT INTO transactions
    (section_id, type, montant, account_id, to_account_id, cat_id, sub_id, date_op, date_saisie, fournisseur, salarie, description, evenement, reference, commentaire, valide, created_by, updated_by, created_at, updated_at)
    VALUES (@sectionId,@type,@montant,@accountId,@toAccountId,@catId,@subId,@dateOp,@dateSaisie,@fournisseur,@salarie,@description,@evenement,@reference,@commentaire,@valide,@createdBy,@updatedBy,@createdAt,@updatedAt)`);
  const info = stmt.run({
    sectionId,
    type: tx.type,
    montant: tx.montant,
    accountId: tx.accountId != null ? tx.accountId : null,
    toAccountId: tx.toAccountId != null ? tx.toAccountId : null,
    catId: tx.catId != null ? tx.catId : null,
    subId: tx.subId != null ? tx.subId : null,
    dateOp: tx.dateOp || null,
    dateSaisie: tx.dateSaisie || null,
    fournisseur: tx.fournisseur || "",
    salarie: tx.salarie || "",
    description: tx.description || "",
    evenement: tx.evenement || "",
    reference: tx.reference || "",
    commentaire: tx.commentaire || "",
    valide: tx.valide ? 1 : 0,
    createdBy: who,
    updatedBy: who,
    createdAt: now,
    updatedAt: now
  });
  return rowToTx(db.prepare("SELECT * FROM transactions WHERE id = ?").get(info.lastInsertRowid));
}
function updateTransaction(sectionId, id, tx, who) {
  const existing = db.prepare("SELECT * FROM transactions WHERE id = ? AND section_id = ?").get(id, sectionId);
  if (!existing) return null;
  const now = new Date().toISOString();
  const stmt = db.prepare(`UPDATE transactions SET
    type=@type, montant=@montant, account_id=@accountId, to_account_id=@toAccountId,
    cat_id=@catId, sub_id=@subId, date_op=@dateOp, date_saisie=@dateSaisie,
    fournisseur=@fournisseur, salarie=@salarie, description=@description, evenement=@evenement,
    reference=@reference, commentaire=@commentaire, valide=@valide, updated_by=@updatedBy, updated_at=@updatedAt
    WHERE id=@id AND section_id=@sectionId`);
  stmt.run({
    id, sectionId,
    type: tx.type,
    montant: tx.montant,
    accountId: tx.accountId != null ? tx.accountId : null,
    toAccountId: tx.toAccountId != null ? tx.toAccountId : null,
    catId: tx.catId != null ? tx.catId : null,
    subId: tx.subId != null ? tx.subId : null,
    dateOp: tx.dateOp || null,
    dateSaisie: tx.dateSaisie || null,
    fournisseur: tx.fournisseur || "",
    salarie: tx.salarie || "",
    description: tx.description || "",
    evenement: tx.evenement || "",
    reference: tx.reference || "",
    commentaire: tx.commentaire || "",
    valide: tx.valide ? 1 : 0,
    updatedBy: who,
    updatedAt: now
  });
  return rowToTx(db.prepare("SELECT * FROM transactions WHERE id = ?").get(id));
}
function deleteTransaction(sectionId, id) {
  const info = db.prepare("DELETE FROM transactions WHERE id = ? AND section_id = ?").run(id, sectionId);
  return info.changes > 0;
}

/* ============================================================
   USERS
   ============================================================ */
function countUsers() {
  return db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
}
function getUserByUsername(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
}
function getUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}
function listUsers(sectionId) {
  // sectionId === null -> super_admin : liste globale (toutes sections)
  if (sectionId === null || sectionId === undefined) {
    return db.prepare(`SELECT u.id, u.username, u.display_name, u.role, u.section_id, u.failed_attempts, u.locked_until, u.created_at, s.name AS section_name
      FROM users u LEFT JOIN sections s ON s.id = u.section_id ORDER BY u.role='super_admin' DESC, s.name ASC, u.id ASC`).all();
  }
  return db.prepare("SELECT id, username, display_name, role, section_id, failed_attempts, locked_until, created_at FROM users WHERE section_id = ? ORDER BY id ASC").all(sectionId);
}
function createUser({ username, passwordHash, displayName, role, sectionId }) {
  const now = new Date().toISOString();
  const info = db.prepare("INSERT INTO users (username, password, display_name, role, section_id, created_at) VALUES (?,?,?,?,?,?)")
    .run(username, passwordHash, displayName, role, sectionId != null ? sectionId : null, now);
  return getUserById(info.lastInsertRowid);
}
function updateUser(id, fields) {
  const existing = getUserById(id);
  if (!existing) return null;
  const displayName = fields.displayName != null ? fields.displayName : existing.display_name;
  const role = fields.role != null ? fields.role : existing.role;
  const passwordHash = fields.passwordHash != null ? fields.passwordHash : existing.password;
  const sectionId = fields.sectionId !== undefined ? fields.sectionId : existing.section_id;
  db.prepare("UPDATE users SET display_name=?, role=?, password=?, section_id=? WHERE id=?").run(displayName, role, passwordHash, sectionId, id);
  return getUserById(id);
}
function deleteUser(id) {
  const info = db.prepare("DELETE FROM users WHERE id = ?").run(id);
  return info.changes > 0;
}
function countSuperAdmins() {
  return db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'super_admin'").get().c;
}
function countSectionAdmins(sectionId) {
  return db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND section_id = ?").get(sectionId).c;
}

/* ============================================================
   PROTECTION CONTRE LES TENTATIVES DE CONNEXION RÉPÉTÉES
   3 échecs consécutifs => compte bloqué 24h (même avec le bon mot
   de passe entre-temps), jusqu'à expiration du blocage ou
   déblocage manuel par un administrateur.
   ============================================================ */
const LOGIN_LOCK_THRESHOLD = 3;
const LOGIN_LOCK_DURATION_MS = 24 * 60 * 60 * 1000;

function isUserLocked(user) {
  return !!(user && user.locked_until && new Date(user.locked_until).getTime() > Date.now());
}
function recordFailedLogin(id) {
  const existing = getUserById(id);
  if (!existing) return null;
  const attempts = (existing.failed_attempts || 0) + 1;
  let lockedUntil = existing.locked_until;
  if (attempts >= LOGIN_LOCK_THRESHOLD) {
    lockedUntil = new Date(Date.now() + LOGIN_LOCK_DURATION_MS).toISOString();
  }
  db.prepare("UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?").run(attempts, lockedUntil, id);
  return getUserById(id);
}
function resetLoginAttempts(id) {
  db.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?").run(id);
}

/* ============================================================
   SAUVEGARDE COMPLÈTE (administrateur général)
   ============================================================ */
function fullBackup() {
  return listSections().map((s) => ({
    section: s,
    config: getConfig(s.id),
    transactions: listTransactions(s.id)
  }));
}

module.exports = {
  db,
  listSections, getSectionById, createSection, renameSection, deleteSection, sectionHasData,
  getConfig, setConfig,
  listTransactions, createTransaction, updateTransaction, deleteTransaction,
  countUsers, getUserByUsername, getUserById, listUsers, createUser, updateUser, deleteUser,
  countSuperAdmins, countSectionAdmins,
  LOGIN_LOCK_THRESHOLD, isUserLocked, recordFailedLogin, resetLoginAttempts,
  fullBackup
};
