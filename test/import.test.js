import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB = path.join(__dirname, 'fixtures', 'import-test.db');

function makeTestData(txns, mode = 'full') {
  return {
    fetchedAt: '2026-01-20T00:00:00.000Z',
    totalCount: txns.length,
    mode,
    startDate: null,
    transactions: txns,
  };
}

function makeTxn(overrides = {}) {
  return {
    id: 'txn-test-1',
    amount: -10.00,
    date: '2026-01-15',
    originalDate: null,
    plaidName: 'TEST MERCHANT',
    notes: null,
    pending: false,
    hideFromReports: false,
    needsReview: false,
    isRecurring: false,
    isSplitTransaction: false,
    hasSplitTransactions: false,
    originalTransaction: null,
    merchant: { id: 'merch-1', name: 'Test Merchant' },
    category: { id: 'cat-1', name: 'Shopping', group: { id: 'g1', name: 'Shopping', type: 'expense' } },
    account: { id: 'acct-1', displayName: 'Checking' },
    tags: [],
    ...overrides,
  };
}

describe('importTransactions', () => {
  let importTransactions;

  afterEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('creates a new DB with correct schema', async () => {
    const mod = await import('../src/import.js');
    importTransactions = mod.importTransactions;

    const data = makeTestData([makeTxn()]);
    importTransactions(data, TEST_DB);

    const db = new DatabaseSync(TEST_DB);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const tableNames = tables.map(t => t.name);
    assert.ok(tableNames.includes('transactions'));
    assert.ok(tableNames.includes('metadata'));
    db.close();
  });

  it('inserts all transactions from payload', async () => {
    const mod = await import('../src/import.js');
    importTransactions = mod.importTransactions;

    const txns = [
      makeTxn({ id: 'txn-1' }),
      makeTxn({ id: 'txn-2', amount: -20.00 }),
      makeTxn({ id: 'txn-3', amount: -30.00 }),
    ];
    const result = importTransactions(makeTestData(txns), TEST_DB);

    assert.equal(result.imported, 3);
    const db = new DatabaseSync(TEST_DB);
    const count = db.prepare('SELECT COUNT(*) AS n FROM transactions').get();
    assert.equal(count.n, 3);
    db.close();
  });

  it('writes metadata rows', async () => {
    const mod = await import('../src/import.js');
    importTransactions = mod.importTransactions;

    importTransactions(makeTestData([makeTxn()]), TEST_DB);

    const db = new DatabaseSync(TEST_DB);
    const meta = db.prepare('SELECT * FROM metadata').all();
    const keys = meta.map(m => m.key);
    assert.ok(keys.includes('fetchedAt'));
    assert.ok(keys.includes('total_count'));
    assert.ok(keys.includes('imported_at'));
    assert.ok(keys.includes('last_refresh_mode'));
    db.close();
  });

  it('upserts with mode partial into existing DB', async () => {
    const mod = await import('../src/import.js');
    importTransactions = mod.importTransactions;

    // First: full import
    importTransactions(makeTestData([makeTxn({ id: 'txn-1', amount: -10 })]), TEST_DB);

    // Then: partial with updated amount + new txn
    const partialData = makeTestData([
      makeTxn({ id: 'txn-1', amount: -15 }),
      makeTxn({ id: 'txn-2', amount: -20 }),
    ], 'partial');
    const result = importTransactions(partialData, TEST_DB);

    assert.equal(result.imported, 2);
    const db = new DatabaseSync(TEST_DB);
    const rows = db.prepare('SELECT * FROM transactions ORDER BY id').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].amount, -15); // updated
    assert.equal(rows[1].amount, -20); // new
    db.close();
  });

  it('prunes stale pending transactions', async () => {
    const mod = await import('../src/import.js');
    importTransactions = mod.importTransactions;

    const txns = [
      makeTxn({ id: 'txn-pending', pending: true, amount: -50, date: '2026-01-15' }),
      makeTxn({ id: 'txn-posted', pending: false, amount: -50, date: '2026-01-15' }),
    ];
    const result = importTransactions(makeTestData(txns), TEST_DB);

    assert.equal(result.pruned, 1);
    const db = new DatabaseSync(TEST_DB);
    const rows = db.prepare('SELECT * FROM transactions').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'txn-posted');
    db.close();
  });
});
