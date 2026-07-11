import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  syncTransactionToMirror, transactionToRow, UPSERT_TRANSACTION_SQL,
  verifyTransactionUpdate, verifyTransactionTags, verifyTransactionSplits,
} from '../src/mirror.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DB = path.join(__dirname, 'fixtures', 'monarch.db');

/** A full live transaction in the getTransaction read-back shape. */
function liveTxn(overrides = {}) {
  return {
    id: 'txn-live', amount: -30.00, date: '2026-07-02', originalDate: '2026-07-01',
    pending: false, hideFromReports: false, needsReview: true, isRecurring: false,
    plaidName: 'STORE 123', notes: 'a note',
    isSplitTransaction: false, hasSplitTransactions: false, originalTransaction: null,
    merchant: { id: 'm-9', name: 'Store' },
    category: { id: 'cat-9', name: 'Shopping', group: { id: 'g-9', name: 'Lifestyle', type: 'expense' } },
    account: { id: 'acc-9', displayName: 'Card (...9999)' },
    tags: [{ id: 't-1', name: 'Alpha' }, { id: 't-2', name: 'Beta' }],
    splitTransactions: [],
    ...overrides,
  };
}

describe('syncTransactionToMirror', () => {
  let tmpDir, dbPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monarch-mirror-'));
    dbPath = path.join(tmpDir, 'monarch.db');
    fs.copyFileSync(FIXTURE_DB, dbPath);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function row(id) {
    const db = new DatabaseSync(dbPath);
    try {
      return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    } finally {
      db.close();
    }
  }

  it('upserts a live transaction with the full column mapping', () => {
    const result = syncTransactionToMirror(liveTxn(), dbPath);

    assert.deepEqual(result, { synced: true, upserted: 1, prunedSplits: 0 });
    const r = row('txn-live');
    assert.equal(r.amount, -30.00);
    assert.equal(r.date, '2026-07-02');
    assert.equal(r.original_date, '2026-07-01');
    assert.equal(r.plaid_name, 'STORE 123');
    assert.equal(r.notes, 'a note');
    assert.equal(r.needs_review, 1);
    assert.equal(r.merchant_name, 'Store');
    assert.equal(r.category_id, 'cat-9');
    assert.equal(r.category_group, 'Lifestyle');
    assert.equal(r.category_type, 'expense');
    assert.equal(r.account_name, 'Card (...9999)');
    assert.equal(r.tags, 'Alpha,Beta');
  });

  it('replaces an existing mirror row on conflict', () => {
    // txn-002 exists in the fixture as Netflix / Subscriptions.
    syncTransactionToMirror(liveTxn({ id: 'txn-002' }), dbPath);
    const r = row('txn-002');
    assert.equal(r.merchant_name, 'Store');
    assert.equal(r.category_name, 'Shopping');
  });

  it('writes split children with inherited parent fields and prunes removed ones', () => {
    // Fixture: txn-001 has child txn-005. Live state replaces it with s-a/s-b.
    const result = syncTransactionToMirror(liveTxn({
      id: 'txn-001', amount: -42.50, date: '2026-01-15', plaidName: 'WHOLEFDS',
      hasSplitTransactions: true,
      splitTransactions: [
        { id: 's-a', amount: -20.00, notes: null, merchant: { id: 'm-a', name: 'Part A' }, category: { id: 'cat-001', name: 'Groceries', group: { id: 'g1', name: 'Food & Dining', type: 'expense' } }, tags: [] },
        { id: 's-b', amount: -22.50, notes: 'b', merchant: { id: 'm-b', name: 'Part B' }, category: { id: 'cat-005', name: 'Home Supplies', group: { id: 'g5', name: 'Home', type: 'expense' } }, tags: [{ id: 't-x', name: 'Tagged' }] },
      ],
    }), dbPath);

    assert.deepEqual(result, { synced: true, upserted: 3, prunedSplits: 1 });
    assert.equal(row('txn-005'), undefined, 'old fixture child is pruned');

    const a = row('s-a');
    assert.equal(a.parent_id, 'txn-001');
    assert.equal(a.is_split, 1);
    assert.equal(a.has_splits, 0);
    assert.equal(a.date, '2026-01-15', 'inherits parent date');
    assert.equal(a.plaid_name, 'WHOLEFDS', 'inherits parent statement text');
    assert.equal(a.account_name, 'Card (...9999)', 'inherits parent account');
    assert.equal(row('s-b').tags, 'Tagged');
    assert.equal(row('txn-001').has_splits, 1);
  });

  it('prunes all children when the live transaction has no splits', () => {
    const result = syncTransactionToMirror(liveTxn({
      id: 'txn-001', amount: -42.50, date: '2026-01-15',
    }), dbPath);

    assert.equal(result.prunedSplits, 1);
    assert.equal(row('txn-005'), undefined);
  });

  it('reports synced:false with a refresh hint when the mirror is missing', () => {
    const result = syncTransactionToMirror(liveTxn(), path.join(tmpDir, 'nope.db'));
    assert.equal(result.synced, false);
    assert.match(result.reason, /refresh_transactions/);
  });

  it('reports synced:false instead of throwing on a constraint failure', () => {
    // date is NOT NULL in the mirror schema.
    const result = syncTransactionToMirror(liveTxn({ date: null }), dbPath);
    assert.equal(result.synced, false);
    assert.match(result.reason, /refresh_transactions/);
    assert.ok(row('txn-002'), 'existing rows are untouched (transaction rolled back)');
  });
});

describe('transactionToRow / UPSERT_TRANSACTION_SQL', () => {
  it('binds one value per SQL placeholder', () => {
    const placeholders = (UPSERT_TRANSACTION_SQL.match(/\?/g) || []).length;
    assert.equal(transactionToRow(liveTxn()).length, placeholders);
  });
});

describe('verifyTransactionUpdate', () => {
  it('passes when every requested field matches the live transaction', () => {
    const input = {
      id: 'txn-live', category: 'cat-9', name: 'Store', notes: 'a note',
      date: '2026-07-02', hideFromReports: false, needsReview: true,
    };
    assert.deepEqual(verifyTransactionUpdate(input, liveTxn()), []);
  });

  it('only checks fields present in the input', () => {
    assert.deepEqual(verifyTransactionUpdate({ id: 'txn-live', notes: 'a note' }, liveTxn()), []);
  });

  it('reports each mismatching field with expected and actual values', () => {
    const mismatches = verifyTransactionUpdate(
      { id: 'txn-live', category: 'cat-1', date: '2026-07-09' },
      liveTxn()
    );
    assert.deepEqual(mismatches, [
      { field: 'categoryId', expected: 'cat-1', actual: 'cat-9' },
      { field: 'date', expected: '2026-07-09', actual: '2026-07-02' },
    ]);
  });

  it('treats empty-string and null notes as equal', () => {
    assert.deepEqual(
      verifyTransactionUpdate({ id: 'x', notes: '' }, liveTxn({ notes: null })),
      []
    );
  });
});

describe('verifyTransactionTags', () => {
  it('passes on the same tag set regardless of order', () => {
    assert.deepEqual(verifyTransactionTags(['t-2', 't-1'], liveTxn()), []);
  });

  it('reports a mismatch with both sets', () => {
    const mismatches = verifyTransactionTags(['t-1', 't-3'], liveTxn());
    assert.deepEqual(mismatches, [
      { field: 'tags', expected: ['t-1', 't-3'], actual: ['t-1', 't-2'] },
    ]);
  });
});

describe('verifyTransactionSplits', () => {
  const LIVE_SPLIT = liveTxn({
    hasSplitTransactions: true,
    splitTransactions: [
      { id: 's1', amount: -10.00, merchant: { id: 'm1', name: 'A' }, category: { id: 'c1', name: 'X' } },
      { id: 's2', amount: -20.00, merchant: { id: 'm2', name: 'B' }, category: { id: 'c2', name: 'Y' } },
    ],
  });

  it('passes when amounts, categories, and names match as a multiset', () => {
    const splits = [
      { amount: -20.00, categoryId: 'c2', merchantName: 'B' },
      { amount: -10.00, categoryId: 'c1', merchantName: 'A' },
    ];
    assert.deepEqual(verifyTransactionSplits(splits, LIVE_SPLIT), []);
  });

  it('reports a mismatch when the live splits differ', () => {
    const splits = [{ amount: -30.00, categoryId: 'c1', merchantName: 'A' }];
    const mismatches = verifyTransactionSplits(splits, LIVE_SPLIT);
    assert.equal(mismatches.length, 1);
    assert.equal(mismatches[0].field, 'splits');
  });

  it('passes an empty request only when the live transaction has no splits', () => {
    assert.deepEqual(verifyTransactionSplits([], liveTxn()), []);
    const mismatches = verifyTransactionSplits([], LIVE_SPLIT);
    assert.equal(mismatches.length, 1);
    assert.match(String(mismatches[0].actual), /2 split/);
  });
});
