#!/usr/bin/env node
/**
 * Creates a minimal test fixture database for unit tests.
 * Run once: node test/fixtures/create-fixture-db.js
 * Output: test/fixtures/monarch.db (committed to repo)
 */

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, 'monarch.db');

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

// 5 seed transactions: 3 accounts, 3 category types, 2 merchants, 1 tagged, 1 split
const transactions = [
  {
    id: 'txn-001', amount: -42.50, date: '2026-01-15', original_date: '2026-01-15',
    plaid_name: 'WHOLE FOODS #1234', notes: null,
    pending: 0, hide_from_reports: 0, needs_review: 0, is_recurring: 0,
    is_split: 0, has_splits: 1, parent_id: null,
    merchant_id: 'merch-001', merchant_name: 'Whole Foods',
    category_id: 'cat-001', category_name: 'Groceries', category_group: 'Food & Dining', category_type: 'expense',
    account_id: 'acct-001', account_name: 'Checking (...1234)', tags: 'Grocery',
  },
  {
    id: 'txn-002', amount: -15.99, date: '2026-01-16', original_date: '2026-01-16',
    plaid_name: 'NETFLIX.COM', notes: 'Monthly subscription',
    pending: 0, hide_from_reports: 0, needs_review: 0, is_recurring: 1,
    is_split: 0, has_splits: 0, parent_id: null,
    merchant_id: 'merch-002', merchant_name: 'Netflix',
    category_id: 'cat-002', category_name: 'Subscriptions', category_group: 'Travel & Lifestyle', category_type: 'expense',
    account_id: 'acct-002', account_name: 'Credit Card (...5678)', tags: null,
  },
  {
    id: 'txn-003', amount: 2500.00, date: '2026-01-17', original_date: '2026-01-17',
    plaid_name: 'DIRECT DEPOSIT', notes: null,
    pending: 0, hide_from_reports: 0, needs_review: 0, is_recurring: 1,
    is_split: 0, has_splits: 0, parent_id: null,
    merchant_id: null, merchant_name: 'Employer Inc',
    category_id: 'cat-003', category_name: 'Paychecks', category_group: 'Income', category_type: 'income',
    account_id: 'acct-001', account_name: 'Checking (...1234)', tags: null,
  },
  {
    id: 'txn-004', amount: -500.00, date: '2026-01-18', original_date: '2026-01-18',
    plaid_name: 'TRANSFER TO SAVINGS', notes: null,
    pending: 0, hide_from_reports: 0, needs_review: 0, is_recurring: 0,
    is_split: 0, has_splits: 0, parent_id: null,
    merchant_id: null, merchant_name: null,
    category_id: 'cat-004', category_name: 'Transfers', category_group: 'Transfers', category_type: 'transfer',
    account_id: 'acct-003', account_name: 'Savings (...9012)', tags: null,
  },
  {
    id: 'txn-005', amount: -22.50, date: '2026-01-15', original_date: '2026-01-15',
    plaid_name: 'WHOLE FOODS #1234', notes: 'Split: household items',
    pending: 0, hide_from_reports: 0, needs_review: 0, is_recurring: 0,
    is_split: 1, has_splits: 0, parent_id: 'txn-001',
    merchant_id: 'merch-001', merchant_name: 'Whole Foods',
    category_id: 'cat-005', category_name: 'Home Supplies', category_group: 'Home', category_type: 'expense',
    account_id: 'acct-001', account_name: 'Checking (...1234)', tags: null,
  },
];

for (const t of transactions) {
  insert.run(
    t.id, t.amount, t.date, t.original_date, t.plaid_name, t.notes,
    t.pending, t.hide_from_reports, t.needs_review, t.is_recurring,
    t.is_split, t.has_splits, t.parent_id,
    t.merchant_id, t.merchant_name,
    t.category_id, t.category_name, t.category_group, t.category_type,
    t.account_id, t.account_name, t.tags,
  );
}

const metaInsert = db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)');
metaInsert.run('fetchedAt', '2026-01-20T00:00:00.000Z');
metaInsert.run('total_count', '5');
metaInsert.run('imported_at', '2026-01-20T00:00:00.000Z');
metaInsert.run('last_refresh_mode', 'full');

db.close();

console.log(`Fixture DB created at ${dbPath} with 5 transactions`);
