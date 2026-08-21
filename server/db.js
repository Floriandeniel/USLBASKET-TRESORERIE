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

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  updated_at TEXT
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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

const DEFAULT_CONFIG = require("./default-config.js");

function getConfig() {
  const row = db.prepare("SELECT data FROM config WHERE id = 1").get();
  if (!row) {
    const data = JSON.stringify(DEFAULT_CONFIG);
    db.prepare("INSERT INTO config (id, data, updated_at) VALUES (1, ?, ?)").run(data, new Date().toISOString());
    return JSON.parse(data);
  }
  try {
    return JSON.parse(row.data);
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

function setConfig(cfg) {
  const data = JSON.stringify(cfg);
  const now = new Date().toISOString();
  const row = db.prepare("SELECT id FROM config WHERE id = 1").get();
  if (row) {
    db.prepare("UPDATE config SET data = ?, updated_at = ? WHERE id = 1").run(data, now);
  } else {
    db.prepare("INSERT INTO config (id, data, updated_at) VALUES (1, ?, ?)").run(data, now);
  }
}

function rowToTx(r) {
  if (!r) return null;
  return {
    id: r.id,
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

function listTransactions() {
  const rows = db.prepare("SELECT * FROM transactions ORDER BY date_op DESC, id DESC").all();
  return rows.map(rowToTx);
}

function createTransaction(tx, who) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`INSERT INTO transactions
    (type, montant, account_id, to_account_id, cat_id, sub_id, date_op, date_saisie, fournisseur, salarie, description, evenement, reference, commentaire, valide, created_by, updated_by, created_at, updated_at)
    VALUES (@type,@montant,@accountId,@toAccountId,@catId,@subId,@dateOp,@dateSaisie,@fournisseur,@salarie,@description,@evenement,@reference,@commentaire,@valide,@createdBy,@updatedBy,@createdAt,@updatedAt)`);
  const info = stmt.run({
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

function updateTransaction(id, tx, who) {
  const existing = db.prepare("SELECT * FROM transactions WHERE id = ?").get(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const stmt = db.prepare(`UPDATE transactions SET
    type=@type, montant=@montant, account_id=@accountId, to_account_id=@toAccountId,
    cat_id=@catId, sub_id=@subId, date_op=@dateOp, date_saisie=@dateSaisie,
    fournisseur=@fournisseur, salarie=@salarie, description=@description, evenement=@evenement,
    reference=@reference, commentaire=@commentaire, valide=@valide, updated_by=@updatedBy, updated_at=@updatedAt
    WHERE id=@id`);
  stmt.run({
    id,
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

function deleteTransaction(id) {
  const info = db.prepare("DELETE FROM transactions WHERE id = ?").run(id);
  return info.changes > 0;
}

function countUsers() {
  return db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
}
function getUserByUsername(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
}
function getUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}
function listUsers() {
  return db.prepare("SELECT id, username, display_name, role, created_at FROM users ORDER BY id ASC").all();
}
function createUser({ username, passwordHash, displayName, role }) {
  const now = new Date().toISOString();
  const info = db.prepare("INSERT INTO users (username, password, display_name, role, created_at) VALUES (?,?,?,?,?)")
    .run(username, passwordHash, displayName, role, now);
  return getUserById(info.lastInsertRowid);
}
function updateUser(id, fields) {
  const existing = getUserById(id);
  if (!existing) return null;
  const displayName = fields.displayName != null ? fields.displayName : existing.display_name;
  const role = fields.role != null ? fields.role : existing.role;
  const passwordHash = fields.passwordHash != null ? fields.passwordHash : existing.password;
  db.prepare("UPDATE users SET display_name=?, role=?, password=? WHERE id=?").run(displayName, role, passwordHash, id);
  return getUserById(id);
}
function deleteUser(id) {
  const info = db.prepare("DELETE FROM users WHERE id = ?").run(id);
  return info.changes > 0;
}
function countAdmins() {
  return db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
}

module.exports = {
  db, getConfig, setConfig,
  listTransactions, createTransaction, updateTransaction, deleteTransaction,
  countUsers, getUserByUsername, getUserById, listUsers, createUser, updateUser, deleteUser, countAdmins
};
