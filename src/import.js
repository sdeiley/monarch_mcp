/**
 * Monarch transaction importer.
 * Takes fetched transaction data and writes to a SQLite database.
 */

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * Import transactions into a SQLite database.
 * @param {object} data - Fetched transaction data
 * @param {object[]} data.transactions - Array of Monarch transaction objects
 * @param {string} data.mode - 'full' or 'partial'
 * @param {string} data.fetchedAt - ISO timestamp
 * @param {number} data.totalCount - Total transaction count
 * @param {string} dbPath - Full path to the output .db file
 * @returns {{ imported: number, pruned: number, dbPath: string }}
 */
export function importTransactions(data, dbPath) {
  const { transactions, mode, fetchedAt, totalCount } = data;
  const isPartial = mode === 'partial';
  const dbExists = fs.existsSync(dbPath);

  // Only drop the DB for full rebuilds
  if (!isPartial || !dbExists) {
    if (dbExists) fs.unlinkSync(dbPath);
  }

  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      amount REAL NOT NULL,
      date TEXT NOT NULL,
      original_date TEXT,
      plaid_name TEXT,
      notes TEXT,
      pending INTEGER DEFAULT 0,
      hide_from_reports INTEGER DEFAULT 0,
      needs_review INTEGER DEFAULT 0,
      is_recurring INTEGER DEFAULT 0,
      is_split INTEGER DEFAULT 0,
      has_splits INTEGER DEFAULT 0,
      parent_id TEXT,
      merchant_id TEXT,
      merchant_name TEXT,
      category_id TEXT,
      category_name TEXT,
      category_group TEXT,
      category_type TEXT,
      account_id TEXT,
      account_name TEXT,
      tags TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_category ON transactions(category_name);
    CREATE INDEX IF NOT EXISTS idx_merchant ON transactions(merchant_name);
    CREATE INDEX IF NOT EXISTS idx_account ON transactions(account_name);
    CREATE INDEX IF NOT EXISTS idx_parent ON transactions(parent_id);
    CREATE INDEX IF NOT EXISTS idx_plaid ON transactions(plaid_name);

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO transactions (
      id, amount, date, original_date, plaid_name, notes,
      pending, hide_from_reports, needs_review, is_recurring,
      is_split, has_splits, parent_id,
      merchant_id, merchant_name,
      category_id, category_name, category_group, category_type,
      account_id, account_name, tags
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let imported = 0;

  db.exec('BEGIN TRANSACTION');

  for (const t of transactions) {
    const tags = t.tags?.length > 0
      ? t.tags.map(tag => tag.name).join(',')
      : null;

    insert.run(
      t.id,
      t.amount,
      t.date,
      t.originalDate || null,
      t.plaidName || null,
      t.notes || null,
      t.pending ? 1 : 0,
      t.hideFromReports ? 1 : 0,
      t.needsReview ? 1 : 0,
      t.isRecurring ? 1 : 0,
      t.isSplitTransaction ? 1 : 0,
      t.hasSplitTransactions ? 1 : 0,
      t.originalTransaction?.id || null,
      t.merchant?.id || null,
      t.merchant?.name || null,
      t.category?.id || null,
      t.category?.name || null,
      t.category?.group?.name || null,
      t.category?.group?.type || null,
      t.account?.id || null,
      t.account?.displayName || null,
      tags,
    );
    imported++;
  }

  // Store metadata
  const metaInsert = db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)');
  metaInsert.run('fetchedAt', fetchedAt);
  metaInsert.run('total_count', String(
    isPartial ? db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n : totalCount
  ));
  metaInsert.run('imported_at', new Date().toISOString());
  metaInsert.run('last_refresh_mode', isPartial ? 'partial' : 'full');

  db.exec('COMMIT');

  // Prune stale pending records
  const pruneResult = db.prepare(`
    DELETE FROM transactions
    WHERE pending = 1
      AND EXISTS (
        SELECT 1 FROM transactions t2
        WHERE t2.pending = 0
          AND t2.date      = transactions.date
          AND t2.amount    = transactions.amount
          AND t2.account_id = transactions.account_id
      )
  `).run();
  const pruned = pruneResult.changes;

  db.close();

  return { imported, pruned, dbPath };
}
