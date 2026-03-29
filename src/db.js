/**
 * Monarch SQLite database query module.
 * Uses node:sqlite DatabaseSync for synchronous read-only queries.
 */

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolveDbPath } from './config.js';

/**
 * Execute a read-only SQL query against the transactions database.
 * @param {string} sql - The SQL query (must be SELECT, WITH, or PRAGMA)
 * @param {string} [dbPath] - Override database path (defaults to resolveDbPath())
 * @returns {object[]} Array of row objects
 */
export function queryDb(sql, dbPath) {
  const p = dbPath ?? resolveDbPath();
  if (!fs.existsSync(p)) {
    throw new Error(`Database not found at ${p}. Run refresh first.`);
  }

  const trimmed = sql.trim().toUpperCase();
  if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('WITH') && !trimmed.startsWith('PRAGMA')) {
    throw new Error('Only SELECT, WITH (CTE), and PRAGMA queries are allowed.');
  }

  const db = new DatabaseSync(p);
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

/**
 * Get the database schema description.
 * @param {string} [dbPath] - Override database path
 * @returns {{ schema: string, metadata: object[] }}
 */
export function getSchema(dbPath) {
  const p = dbPath ?? resolveDbPath();
  if (!fs.existsSync(p)) {
    throw new Error(`Database not found at ${p}. Run refresh first.`);
  }

  const schema = `TABLE: transactions
  id              TEXT PRIMARY KEY   -- Monarch UUID
  amount          REAL              -- Negative = expense, positive = income/credit
  date            TEXT              -- YYYY-MM-DD
  original_date   TEXT              -- Original posting date
  plaid_name      TEXT              -- Raw bank descriptor
  notes           TEXT              -- User or extension notes
  pending         INTEGER (0/1)
  hide_from_reports INTEGER (0/1)
  needs_review    INTEGER (0/1)
  is_recurring    INTEGER (0/1)
  is_split        INTEGER (0/1)     -- This is a split child
  has_splits      INTEGER (0/1)     -- This is a split parent (hidden, children visible)
  parent_id       TEXT              -- FK to parent transaction (if is_split = 1)
  merchant_id     TEXT
  merchant_name   TEXT              -- Monarch's cleaned merchant name
  category_id     TEXT
  category_name   TEXT              -- e.g. "Groceries", "Subscriptions"
  category_group  TEXT              -- e.g. "Food & Dining", "Travel & Lifestyle"
  category_type   TEXT              -- "expense", "income", or "transfer"
  account_id      TEXT
  account_name    TEXT              -- e.g. "Checking (...1234)"
  tags            TEXT              -- Comma-separated tag names (or NULL)`;

  const db = new DatabaseSync(p);
  let metadata;
  try {
    metadata = db.prepare('SELECT * FROM metadata').all();
  } finally {
    db.close();
  }

  return { schema, metadata };
}

/**
 * Get quick stats about the database.
 * @param {string} [dbPath] - Override database path
 * @returns {object} Stats keyed by label
 */
export function getStats(dbPath) {
  const p = dbPath ?? resolveDbPath();
  if (!fs.existsSync(p)) {
    throw new Error(`Database not found at ${p}. Run refresh first.`);
  }

  const statQueries = [
    ['total', 'SELECT COUNT(*) AS n FROM transactions'],
    ['dateRange', "SELECT MIN(date) || ' to ' || MAX(date) AS range FROM transactions"],
    ['byCategoryType', "SELECT category_type, COUNT(*) AS n, ROUND(SUM(amount), 2) AS total FROM transactions GROUP BY category_type ORDER BY n DESC"],
    ['topCategories', 'SELECT category_name, COUNT(*) AS n, ROUND(SUM(amount), 2) AS total FROM transactions GROUP BY category_name ORDER BY n DESC LIMIT 15'],
    ['topMerchants', 'SELECT merchant_name, COUNT(*) AS n, ROUND(SUM(amount), 2) AS total FROM transactions GROUP BY merchant_name ORDER BY n DESC LIMIT 10'],
    ['byYear', "SELECT SUBSTR(date, 1, 4) AS year, COUNT(*) AS n, ROUND(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 2) AS spending FROM transactions GROUP BY year ORDER BY year"],
    ['accounts', 'SELECT account_name, COUNT(*) AS n FROM transactions GROUP BY account_name ORDER BY n DESC'],
  ];

  const db = new DatabaseSync(p);
  const stats = {};
  try {
    for (const [label, sql] of statQueries) {
      stats[label] = db.prepare(sql).all();
    }
  } finally {
    db.close();
  }

  return stats;
}
