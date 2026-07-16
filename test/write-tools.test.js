import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Write tools sync the mirror after each write, so point MONARCH_DATA_DIR at
// a throwaway COPY of the fixture DB — never the committed fixture itself.
// Also inject a fake token so loadToken() never touches ~/.monarch-token.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monarch-write-tools-'));
fs.copyFileSync(
  path.join(__dirname, 'fixtures', 'monarch.db'),
  path.join(tmpDataDir, 'monarch.db')
);
process.env.MONARCH_DATA_DIR = tmpDataDir;
process.env.MONARCH_TOKEN = 'fake-test-token';
process.on('exit', () => {
  try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Read a row straight out of the temp mirror DB. */
function mirrorRow(id) {
  const db = new DatabaseSync(path.join(tmpDataDir, 'monarch.db'));
  try {
    return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  } finally {
    db.close();
  }
}

async function createTestPair() {
  const { createServer } = await import('../src/server.js');
  const server = createServer();
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { server, client, close: () => Promise.all([server.close(), client.close()]) };
}

/** Record fetch calls; reply with queued GraphQL data payloads in order. */
function installMockFetch(calls, ...dataPayloads) {
  let i = 0;
  globalThis.fetch = (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    const data = dataPayloads[Math.min(i, dataPayloads.length - 1)];
    i++;
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ data }),
    });
  };
}

describe('Write tools registration', () => {
  let client, close;

  before(async () => { ({ client, close } = await createTestPair()); });
  after(async () => { await close(); });

  it('lists the update_transaction write tool', async () => {
    const result = await client.listTools();
    const names = result.tools.map(t => t.name);
    assert.ok(names.includes('update_transaction'), 'should have update_transaction');
  });

  it('write tool descriptions warn about live account mutation and describe verification', async () => {
    const result = await client.listTools();
    const tool = result.tools.find(t => t.name === 'update_transaction');
    assert.match(tool.description, /live/i, 'should mention live account');
    assert.match(tool.description, /verif/i, 'should mention read-back verification');
    assert.match(tool.description, /mirror/i, 'should mention the mirror sync');
    assert.match(tool.description, /refresh_transactions/, 'should mention the fallback refresh');
  });
});

describe('update_transaction tool', () => {
  let client, close, calls, originalFetch;

  before(async () => { ({ client, close } = await createTestPair()); });
  after(async () => { await close(); });
  beforeEach(() => { calls = []; originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('mutates, reads back, verifies, and syncs the mirror', async () => {
    // txn-002 exists in the fixture mirror as Netflix / Subscriptions.
    const readBack = {
      id: 'txn-002', amount: -15.99, date: '2026-01-16', originalDate: '2026-01-16',
      pending: false, hideFromReports: false, needsReview: false, isRecurring: true,
      plaidName: 'NETFLIX.COM', notes: 'note here',
      isSplitTransaction: false, hasSplitTransactions: false, originalTransaction: null,
      category: { id: 'cat-001', name: 'Groceries', group: { id: 'g1', name: 'Food & Dining', type: 'expense' } },
      merchant: { id: 'm-1', name: 'Renamed Merchant' },
      account: { id: 'acc-001', displayName: 'Checking (...1234)' },
      tags: [], splitTransactions: [],
    };
    installMockFetch(
      calls,
      {
        updateTransaction: {
          transaction: {
            id: 'txn-002', notes: 'note here', hideFromReports: false, needsReview: false,
            category: { id: 'cat-001', name: 'Groceries' },
            merchant: { id: 'm-1', name: 'Renamed Merchant' },
          },
          errors: null,
        },
      },
      { getTransaction: readBack }
    );

    const result = await client.callTool({
      name: 'update_transaction',
      arguments: {
        id: 'txn-002',
        categoryId: 'cat-001',
        merchantName: 'Renamed Merchant',
        notes: 'note here',
        needsReview: false,
      },
    });

    assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
    assert.equal(calls.length, 2, 'mutation then read-back');
    const { body, opts } = calls[0];
    assert.match(opts.headers['Authorization'], /^Token /);
    assert.match(body.query, /Web_TransactionDrawerUpdateTransaction/);
    assert.deepEqual(body.variables, {
      input: {
        id: 'txn-002',
        category: 'cat-001',
        name: 'Renamed Merchant',
        notes: 'note here',
        needsReview: false,
      },
    });
    assert.match(calls[1].body.query, /GetTransactionDrawer/);
    assert.deepEqual(calls[1].body.variables, { id: 'txn-002' });

    const data = JSON.parse(result.content[0].text);
    assert.equal(data.transaction.id, 'txn-002');
    assert.equal(data.transaction.merchant.name, 'Renamed Merchant');
    assert.deepEqual(data.verification, { verified: true });
    assert.equal(data.mirror.synced, true);

    // The local mirror now holds the live state — no refresh needed.
    const row = mirrorRow('txn-002');
    assert.equal(row.merchant_name, 'Renamed Merchant');
    assert.equal(row.category_id, 'cat-001');
    assert.equal(row.category_name, 'Groceries');
    assert.equal(row.category_group, 'Food & Dining');
    assert.equal(row.notes, 'note here');
  });

  it('reports mismatches (but still syncs the live state) when the read-back differs', async () => {
    installMockFetch(
      calls,
      {
        updateTransaction: {
          transaction: { id: 'txn-002', category: { id: 'cat-001', name: 'Groceries' } },
          errors: null,
        },
      },
      // A Monarch rule "won": the live category is not the one we set.
      {
        getTransaction: {
          id: 'txn-002', amount: -15.99, date: '2026-01-16',
          category: { id: 'cat-999', name: 'Entertainment', group: { id: 'g9', name: 'Fun', type: 'expense' } },
          merchant: { id: 'm-1', name: 'Netflix' },
          tags: [], splitTransactions: [],
        },
      }
    );

    const result = await client.callTool({
      name: 'update_transaction',
      arguments: { id: 'txn-002', categoryId: 'cat-001' },
    });

    assert.ok(!result.isError, 'a mismatch is a warning, not a tool error');
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.verification.verified, false);
    assert.deepEqual(data.verification.mismatches, [
      { field: 'categoryId', expected: 'cat-001', actual: 'cat-999' },
    ]);
    assert.match(data.verification.warning, /does not match/i);
    assert.equal(data.mirror.synced, true, 'mirror is synced to the LIVE state');
    assert.equal(mirrorRow('txn-002').category_id, 'cat-999');
  });

  it('returns success with a stale-mirror warning when the read-back fails', async () => {
    let n = 0;
    globalThis.fetch = (url, opts) => {
      calls.push({ url, opts, body: JSON.parse(opts.body) });
      n++;
      if (n === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: { updateTransaction: { transaction: { id: 'txn-002', notes: 'x' }, errors: null } },
          }),
        });
      }
      return Promise.reject(new Error('network down'));
    };

    const result = await client.callTool({
      name: 'update_transaction',
      arguments: { id: 'txn-002', notes: 'x' },
    });

    assert.ok(!result.isError, 'the write itself succeeded and must not be masked');
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.transaction.id, 'txn-002', 'falls back to the mutation payload');
    assert.equal(data.verification.verified, false);
    assert.match(data.verification.warning, /read-back failed/i);
    assert.match(data.verification.warning, /refresh_transactions/);
    assert.equal(data.mirror.synced, false);
  });

  it('sends date through to the mutation input when provided', async () => {
    installMockFetch(
      calls,
      {
        updateTransaction: {
          transaction: { id: 'txn-3', date: '2026-03-14' },
          errors: null,
        },
      },
      { getTransaction: { id: 'txn-3', amount: -1, date: '2026-03-14' } }
    );

    const result = await client.callTool({
      name: 'update_transaction',
      arguments: { id: 'txn-3', date: '2026-03-14' },
    });

    assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
    assert.deepEqual(calls[0].body.variables, {
      input: { id: 'txn-3', date: '2026-03-14' },
    });
    const data = JSON.parse(result.content[0].text);
    assert.deepEqual(data.verification, { verified: true });
  });

  it('rejects a malformed date at the tool layer without calling the API', async () => {
    installMockFetch(calls, {});

    let errorText;
    try {
      const result = await client.callTool({
        name: 'update_transaction',
        arguments: { id: 'txn-3', date: '03/14/2026' },
      });
      assert.ok(result.isError, 'should be an error');
      errorText = result.content[0].text;
    } catch (err) {
      // SDK may surface schema validation as a protocol-level error
      errorText = err.message;
    }

    assert.match(errorText, /YYYY-MM-DD/, 'error should explain the expected format');
    assert.equal(calls.length, 0, 'must not hit the API');
  });

  it('sends hideFromReports when provided', async () => {
    installMockFetch(
      calls,
      { updateTransaction: { transaction: { id: 'txn-2', hideFromReports: true }, errors: null } },
      { getTransaction: { id: 'txn-2', amount: -1, date: '2026-01-01', hideFromReports: true } }
    );

    const result = await client.callTool({
      name: 'update_transaction',
      arguments: { id: 'txn-2', hideFromReports: true },
    });

    assert.ok(!result.isError);
    assert.deepEqual(calls[0].body.variables, {
      input: { id: 'txn-2', hideFromReports: true },
    });
  });

  it('errors without calling the API when no update fields are provided', async () => {
    installMockFetch(calls, {});

    const result = await client.callTool({
      name: 'update_transaction',
      arguments: { id: 'txn-1' },
    });

    assert.ok(result.isError, 'should be an error');
    assert.equal(calls.length, 0, 'should not hit the API');
  });

  it('surfaces API payload errors as tool errors', async () => {
    installMockFetch(calls, {
      updateTransaction: {
        transaction: null,
        errors: [{ message: 'Category not found', code: 'not_found', fieldErrors: null }],
      },
    });

    const result = await client.callTool({
      name: 'update_transaction',
      arguments: { id: 'txn-1', categoryId: 'bogus' },
    });

    assert.ok(result.isError, 'should be an error');
    assert.match(result.content[0].text, /Category not found/);
  });
});

describe('split_transaction tool', () => {
  let client, close, calls, originalFetch;

  before(async () => { ({ client, close } = await createTestPair()); });
  after(async () => { await close(); });
  beforeEach(() => { calls = []; originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const SPLITS = [
    { amount: -10.00, categoryId: 'c1', merchantName: 'Item A', notes: 'first' },
    { amount: -5.50, categoryId: 'c2', merchantName: 'Item B' },
  ];

  it('validates split sum against the live parent amount, applies, verifies, and syncs children', async () => {
    const readBack = {
      id: 'txn-1', amount: -15.50, date: '2026-07-01', pending: false,
      plaidName: 'CARD PURCHASE', isSplitTransaction: false, hasSplitTransactions: true,
      account: { id: 'acc-9', displayName: 'Card' },
      merchant: { id: 'm0', name: 'Store' },
      category: { id: 'c0', name: 'Shopping', group: { id: 'g0', name: 'Shopping', type: 'expense' } },
      tags: [],
      splitTransactions: [
        { id: 's1', amount: -10.00, notes: 'first', merchant: { id: 'm1', name: 'Item A' }, category: { id: 'c1', name: 'Software', group: { id: 'g1', name: 'Tech', type: 'expense' } }, tags: [] },
        { id: 's2', amount: -5.50, notes: null, merchant: { id: 'm2', name: 'Item B' }, category: { id: 'c2', name: 'Games', group: { id: 'g1', name: 'Tech', type: 'expense' } }, tags: [] },
      ],
    };
    installMockFetch(
      calls,
      // 1st call: getTransaction for validation
      { getTransaction: { id: 'txn-1', amount: -15.50, hasSplitTransactions: false } },
      // 2nd call: the split mutation
      {
        updateTransactionSplit: {
          transaction: {
            id: 'txn-1',
            hasSplitTransactions: true,
            splitTransactions: [
              { id: 's1', amount: -10.00, notes: 'first', merchant: { id: 'm1', name: 'Item A' }, category: { id: 'c1', name: 'Software' } },
              { id: 's2', amount: -5.50, notes: null, merchant: { id: 'm2', name: 'Item B' }, category: { id: 'c2', name: 'Games' } },
            ],
          },
          errors: null,
        },
      },
      // 3rd call: confirmation read-back
      { getTransaction: readBack }
    );

    const result = await client.callTool({
      name: 'split_transaction',
      arguments: { transactionId: 'txn-1', splits: SPLITS },
    });

    assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
    assert.equal(calls.length, 3, 'should fetch parent, mutate, then read back');
    assert.match(calls[0].body.query, /GetTransactionDrawer/);
    assert.match(calls[1].body.query, /Common_SplitTransactionMutation/);
    assert.deepEqual(calls[1].body.variables, {
      input: { transactionId: 'txn-1', splitData: SPLITS },
    });
    assert.match(calls[2].body.query, /GetTransactionDrawer/);

    const data = JSON.parse(result.content[0].text);
    assert.equal(data.transaction.hasSplitTransactions, true);
    assert.equal(data.transaction.splitTransactions.length, 2);
    assert.deepEqual(data.verification, { verified: true });
    assert.equal(data.mirror.synced, true);
    assert.equal(data.mirror.upserted, 3, 'parent + two children');

    // Parent and split children land in the mirror.
    assert.equal(mirrorRow('txn-1').has_splits, 1);
    const child = mirrorRow('s1');
    assert.equal(child.parent_id, 'txn-1');
    assert.equal(child.is_split, 1);
    assert.equal(child.amount, -10.00);
    assert.equal(child.category_name, 'Software');
    assert.equal(child.account_name, 'Card', 'children inherit the parent account');
    assert.equal(child.date, '2026-07-01', 'children inherit the parent date');
  });

  it('flags a verification mismatch when the live splits differ from the request', async () => {
    installMockFetch(
      calls,
      { getTransaction: { id: 'txn-1', amount: -15.50, hasSplitTransactions: false } },
      {
        updateTransactionSplit: {
          transaction: { id: 'txn-1', hasSplitTransactions: true, splitTransactions: [] },
          errors: null,
        },
      },
      // Read-back shows only ONE split survived.
      {
        getTransaction: {
          id: 'txn-1', amount: -15.50, date: '2026-07-01', hasSplitTransactions: true,
          splitTransactions: [
            { id: 's1', amount: -15.50, merchant: { id: 'm1', name: 'Item A' }, category: { id: 'c1', name: 'Software' }, tags: [] },
          ],
        },
      }
    );

    const result = await client.callTool({
      name: 'split_transaction',
      arguments: { transactionId: 'txn-1', splits: SPLITS },
    });

    assert.ok(!result.isError, 'a mismatch is a warning, not a tool error');
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.verification.verified, false);
    assert.equal(data.verification.mismatches[0].field, 'splits');
    assert.match(data.verification.warning, /does not match/i);
  });

  it('rejects splits whose amounts do not sum to the parent amount, without mutating', async () => {
    installMockFetch(
      calls,
      { getTransaction: { id: 'txn-1', amount: -20.00, hasSplitTransactions: false } }
    );

    const result = await client.callTool({
      name: 'split_transaction',
      arguments: { transactionId: 'txn-1', splits: SPLITS },
    });

    assert.ok(result.isError, 'should be an error');
    assert.match(result.content[0].text, /-15\.5/, 'should include the split sum');
    assert.match(result.content[0].text, /-20/, 'should include the parent amount');
    assert.equal(calls.length, 1, 'must not call the split mutation');
  });

  it('accepts amounts that match to the cent despite float rounding', async () => {
    installMockFetch(
      calls,
      { getTransaction: { id: 'txn-1', amount: -0.30, hasSplitTransactions: false } },
      {
        updateTransactionSplit: {
          transaction: { id: 'txn-1', hasSplitTransactions: true, splitTransactions: [] },
          errors: null,
        },
      },
      {
        getTransaction: {
          id: 'txn-1', amount: -0.30, date: '2026-07-01', hasSplitTransactions: true,
          splitTransactions: [
            { id: 's1', amount: -0.1, merchant: { id: 'm1', name: 'A' }, category: { id: 'c1', name: 'X' }, tags: [] },
            { id: 's2', amount: -0.2, merchant: { id: 'm2', name: 'B' }, category: { id: 'c2', name: 'Y' }, tags: [] },
          ],
        },
      }
    );

    const result = await client.callTool({
      name: 'split_transaction',
      arguments: {
        transactionId: 'txn-1',
        splits: [
          { amount: -0.1, categoryId: 'c1', merchantName: 'A' },
          { amount: -0.2, categoryId: 'c2', merchantName: 'B' },
        ],
      },
    });

    // -0.1 + -0.2 === -0.30000000000000004 in floats; must still pass
    assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
    assert.equal(calls.length, 3);
  });

  it('clears splits with an empty array, skipping sum validation, and prunes mirror children', async () => {
    // txn-001 is the fixture split parent whose child txn-005 is in the mirror.
    installMockFetch(
      calls,
      {
        updateTransactionSplit: {
          transaction: { id: 'txn-001', hasSplitTransactions: false, splitTransactions: [] },
          errors: null,
        },
      },
      {
        getTransaction: {
          id: 'txn-001', amount: -42.50, date: '2026-01-15',
          hasSplitTransactions: false, splitTransactions: [],
          merchant: { id: 'm-wf', name: 'Whole Foods' },
          category: { id: 'cat-001', name: 'Groceries', group: { id: 'g1', name: 'Food & Dining', type: 'expense' } },
          account: { id: 'acc-001', displayName: 'Checking (...1234)' },
          tags: [],
        },
      }
    );

    assert.ok(mirrorRow('txn-005'), 'fixture child row exists before the un-split');

    const result = await client.callTool({
      name: 'split_transaction',
      arguments: { transactionId: 'txn-001', splits: [] },
    });

    assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
    assert.equal(calls.length, 2, 'no parent pre-fetch needed, just mutate + read back');
    assert.deepEqual(calls[0].body.variables, {
      input: { transactionId: 'txn-001', splitData: [] },
    });

    const data = JSON.parse(result.content[0].text);
    assert.deepEqual(data.verification, { verified: true });
    assert.equal(data.mirror.synced, true);
    assert.equal(data.mirror.prunedSplits, 1, 'stale child row is pruned');
    assert.equal(mirrorRow('txn-005'), undefined, 'child gone from the mirror');
    assert.equal(mirrorRow('txn-001').has_splits, 0);
  });

  it('surfaces API payload errors as tool errors', async () => {
    installMockFetch(
      calls,
      { getTransaction: { id: 'txn-1', amount: -15.50, hasSplitTransactions: false } },
      {
        updateTransactionSplit: {
          transaction: null,
          errors: [{ message: 'Something went wrong', code: 'error', fieldErrors: null }],
        },
      }
    );

    const result = await client.callTool({
      name: 'split_transaction',
      arguments: { transactionId: 'txn-1', splits: SPLITS },
    });

    assert.ok(result.isError, 'should be an error');
    assert.match(result.content[0].text, /Something went wrong/);
  });
});

describe('create_tag tool', () => {
  let client, close, calls, originalFetch;

  before(async () => { ({ client, close } = await createTestPair()); });
  after(async () => { await close(); });
  beforeEach(() => { calls = []; originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('creates a tag and returns the created tag with its ID', async () => {
    installMockFetch(
      calls,
      { createTransactionTag: { __typename: 'CreateTransactionTagPayload' } },
      { householdTransactionTags: [
        { id: 'tag-9', name: 'Reimbursable', color: '#e07a5f', order: 5 },
      ] }
    );

    const result = await client.callTool({
      name: 'create_tag',
      arguments: { name: 'Reimbursable', color: '#e07a5f' },
    });

    assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
    assert.match(calls[0].body.query, /Common_CreateTransactionTag/);
    assert.deepEqual(calls[0].body.variables, { input: { name: 'Reimbursable', color: '#e07a5f' } });

    const tag = JSON.parse(result.content[0].text);
    assert.equal(tag.id, 'tag-9');
    assert.equal(tag.name, 'Reimbursable');
  });

  it('surfaces GraphQL errors as tool errors', async () => {
    globalThis.fetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        errors: [{ message: 'Tag name already exists' }],
      }),
    });

    const result = await client.callTool({
      name: 'create_tag',
      arguments: { name: 'Duplicate' },
    });

    assert.ok(result.isError, 'should be an error');
    assert.match(result.content[0].text, /Tag name already exists/);
  });
});

describe('set_transaction_tags tool', () => {
  let client, close, calls, originalFetch;

  before(async () => { ({ client, close } = await createTestPair()); });
  after(async () => { await close(); });
  beforeEach(() => { calls = []; originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('replaces the tag set, verifies the read-back, and syncs tag names to the mirror', async () => {
    installMockFetch(
      calls,
      {
        setTransactionTags: {
          transaction: { id: 'txn-002', tags: [{ id: 'tag-1', name: 'Apple', color: '#f00', order: 1 }] },
          errors: null,
        },
      },
      {
        getTransaction: {
          id: 'txn-002', amount: -15.99, date: '2026-01-16',
          merchant: { id: 'm-1', name: 'Netflix' },
          category: { id: 'cat-002', name: 'Subscriptions', group: { id: 'g2', name: 'Bills', type: 'expense' } },
          tags: [{ id: 'tag-1', name: 'Apple', color: '#f00', order: 1 }],
          splitTransactions: [],
        },
      }
    );

    const result = await client.callTool({
      name: 'set_transaction_tags',
      arguments: { transactionId: 'txn-002', tagIds: ['tag-1'] },
    });

    assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
    assert.equal(calls.length, 2, 'mutation then read-back');
    assert.match(calls[0].body.query, /Web_SetTransactionTags/);
    assert.deepEqual(calls[0].body.variables, {
      input: { transactionId: 'txn-002', tagIds: ['tag-1'] },
    });

    const data = JSON.parse(result.content[0].text);
    assert.equal(data.transaction.tags[0].id, 'tag-1');
    assert.deepEqual(data.verification, { verified: true });
    assert.equal(data.mirror.synced, true);
    assert.equal(mirrorRow('txn-002').tags, 'Apple');
  });

  it('accepts an empty tagIds array to clear tags', async () => {
    installMockFetch(
      calls,
      {
        setTransactionTags: {
          transaction: { id: 'txn-1', tags: [] },
          errors: null,
        },
      },
      { getTransaction: { id: 'txn-1', amount: -1, date: '2026-01-01', tags: [], splitTransactions: [] } }
    );

    const result = await client.callTool({
      name: 'set_transaction_tags',
      arguments: { transactionId: 'txn-1', tagIds: [] },
    });

    assert.ok(!result.isError);
    assert.deepEqual(calls[0].body.variables, {
      input: { transactionId: 'txn-1', tagIds: [] },
    });
    const data = JSON.parse(result.content[0].text);
    assert.deepEqual(data.verification, { verified: true });
  });

  it('flags a mismatch when the live tags differ from the requested set', async () => {
    installMockFetch(
      calls,
      {
        setTransactionTags: {
          transaction: { id: 'txn-1', tags: [] },
          errors: null,
        },
      },
      { getTransaction: { id: 'txn-1', amount: -1, date: '2026-01-01', tags: [], splitTransactions: [] } }
    );

    const result = await client.callTool({
      name: 'set_transaction_tags',
      arguments: { transactionId: 'txn-1', tagIds: ['tag-1'] },
    });

    assert.ok(!result.isError, 'a mismatch is a warning, not a tool error');
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.verification.verified, false);
    assert.deepEqual(data.verification.mismatches, [
      { field: 'tags', expected: ['tag-1'], actual: [] },
    ]);
  });

  it('surfaces API payload errors as tool errors', async () => {
    installMockFetch(calls, {
      setTransactionTags: {
        transaction: null,
        errors: [{ message: 'Tag not found', code: 'not_found', fieldErrors: null }],
      },
    });

    const result = await client.callTool({
      name: 'set_transaction_tags',
      arguments: { transactionId: 'txn-1', tagIds: ['bogus'] },
    });

    assert.ok(result.isError, 'should be an error');
    assert.match(result.content[0].text, /Tag not found/);
  });
});

describe('rule tools', () => {
  let client, close, calls, originalFetch;

  before(async () => { ({ client, close } = await createTestPair()); });
  after(async () => { await close(); });
  beforeEach(() => { calls = []; originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('list_rules returns all transaction rules from the live API', async () => {
    installMockFetch(calls, {
      transactionRules: [
        { id: 'r1', order: 0, merchantNameCriteria: [{ operator: 'contains', value: 'Apple' }], setCategoryAction: { id: 'c1', name: 'Software' } },
      ],
    });

    const result = await client.callTool({ name: 'list_rules', arguments: {} });

    assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
    const rules = JSON.parse(result.content[0].text);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].id, 'r1');
  });

  it('create_rule requires at least one criteria and one action', async () => {
    installMockFetch(calls, {});

    const noCriteria = await client.callTool({
      name: 'create_rule',
      arguments: { setCategoryAction: 'cat-1' },
    });
    assert.ok(noCriteria.isError, 'should error without criteria');

    const noAction = await client.callTool({
      name: 'create_rule',
      arguments: { merchantNameCriteria: [{ operator: 'contains', value: 'Apple' }] },
    });
    assert.ok(noAction.isError, 'should error without an action');

    assert.equal(calls.length, 0, 'must not hit the API');
  });

  it('create_rule passes criteria and actions through to the mutation input', async () => {
    installMockFetch(calls, { createTransactionRuleV2: { errors: null } });

    const result = await client.callTool({
      name: 'create_rule',
      arguments: {
        merchantNameCriteria: [{ operator: 'contains', value: 'Apple' }],
        amountCriteria: { operator: 'eq', isExpense: true, value: 9.99 },
        setCategoryAction: 'cat-1',
        addTagsAction: ['tag-1'],
        applyToExistingTransactions: true,
      },
    });

    assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
    assert.match(calls[0].body.query, /Common_CreateTransactionRuleMutationV2/);
    assert.deepEqual(calls[0].body.variables.input, {
      merchantNameCriteria: [{ operator: 'contains', value: 'Apple' }],
      amountCriteria: { operator: 'eq', isExpense: true, value: 9.99 },
      setCategoryAction: 'cat-1',
      addTagsAction: ['tag-1'],
      applyToExistingTransactions: true,
    });
  });

  it('create_rule surfaces payload errors as tool errors', async () => {
    installMockFetch(calls, {
      createTransactionRuleV2: {
        errors: [{ message: 'Invalid split configuration', code: 'invalid', fieldErrors: null }],
      },
    });

    const result = await client.callTool({
      name: 'create_rule',
      arguments: {
        merchantNameCriteria: [{ operator: 'eq', value: 'X' }],
        setCategoryAction: 'cat-1',
      },
    });

    assert.ok(result.isError, 'should be an error');
    assert.match(result.content[0].text, /Invalid split configuration/);
  });

  // A rule as getRules returns it: action fields are OBJECTS on read but
  // must be written back as bare strings (category ID, merchant NAME, tag IDs).
  const CURRENT_RULE = {
    id: 'r1',
    order: 0,
    merchantCriteriaUseOriginalStatement: null,
    merchantCriteria: null,
    merchantNameCriteria: [{ operator: 'eq', value: 'Old Merchant' }],
    originalStatementCriteria: null,
    amountCriteria: { operator: 'eq', isExpense: true, value: 9.99, valueRange: null },
    categoryIds: null,
    accountIds: ['acc-1'],
    categories: [],
    setCategoryAction: { id: 'cat-1', name: 'Software' },
    setMerchantAction: { id: 'm-77', name: 'Apple' },
    addTagsAction: [{ id: 'tag-1', name: 'Apple', color: '#f00' }],
    reviewStatusAction: null,
    setHideFromReportsAction: false,
    splitTransactionsAction: null,
    recentApplicationCount: 3,
    lastAppliedAt: '2026-07-01T00:00:00Z',
  };

  // Regression (2026-07-15): the live update mutation silently ignores
  // partial inputs while reporting success. update_rule must fetch the
  // current rule, merge the caller's fields over it, and send the COMPLETE
  // input with read-shapes converted to write-shapes.
  it('update_rule merges partial input over the full current rule with read→write conversion', async () => {
    installMockFetch(
      calls,
      { transactionRules: [CURRENT_RULE] },
      { updateTransactionRuleV2: { errors: null } }
    );

    const result = await client.callTool({
      name: 'update_rule',
      arguments: {
        id: 'r1',
        merchantNameCriteria: [{ operator: 'eq', value: 'New Merchant' }],
        applyToExistingTransactions: true,
      },
    });

    assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
    assert.equal(calls.length, 2, 'fetch rules, then update');
    assert.match(calls[0].body.query, /transactionRules/);
    assert.match(calls[1].body.query, /Common_UpdateTransactionRuleMutationV2/);
    assert.deepEqual(calls[1].body.variables.input, {
      id: 'r1',
      // Caller's fields
      merchantNameCriteria: [{ operator: 'eq', value: 'New Merchant' }],
      applyToExistingTransactions: true,
      // Preserved from the current rule, converted to write shape
      amountCriteria: { operator: 'eq', isExpense: true, value: 9.99, valueRange: null },
      accountIds: ['acc-1'],
      setCategoryAction: 'cat-1',      // { id, name } → ID string
      setMerchantAction: 'Apple',      // { id, name } → NAME string
      addTagsAction: ['tag-1'],        // tag objects → ID strings
      setHideFromReportsAction: false, // falsy but meaningful — must survive
    });

    const data = JSON.parse(result.content[0].text);
    assert.equal(data.updated, true);
    assert.equal(data.input.setMerchantAction, 'Apple', 'result echoes the merged input');
  });

  it('update_rule lets caller fields override the preserved state', async () => {
    installMockFetch(
      calls,
      { transactionRules: [CURRENT_RULE] },
      { updateTransactionRuleV2: { errors: null } }
    );

    const result = await client.callTool({
      name: 'update_rule',
      arguments: { id: 'r1', setCategoryAction: 'cat-2', addTagsAction: [] },
    });

    assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
    const input = calls[1].body.variables.input;
    assert.equal(input.setCategoryAction, 'cat-2', 'override wins over current cat-1');
    assert.deepEqual(input.addTagsAction, [], 'explicit empty array clears the action');
    assert.equal(input.setMerchantAction, 'Apple', 'untouched action is preserved');
    assert.deepEqual(input.merchantNameCriteria, [{ operator: 'eq', value: 'Old Merchant' }],
      'untouched criteria are preserved');
  });

  it('update_rule preserves legacy merchantCriteria unless new criteria replace it', async () => {
    const legacyRule = {
      ...CURRENT_RULE,
      id: 'r2',
      merchantCriteria: [{ operator: 'contains', value: 'AMZN' }],
      merchantCriteriaUseOriginalStatement: true,
      merchantNameCriteria: null,
    };
    installMockFetch(
      calls,
      { transactionRules: [legacyRule] },
      { updateTransactionRuleV2: { errors: null } },
      { transactionRules: [legacyRule] },
      { updateTransactionRuleV2: { errors: null } }
    );

    // Untouched criteria: the legacy representation must round-trip.
    await client.callTool({
      name: 'update_rule',
      arguments: { id: 'r2', setCategoryAction: 'cat-9' },
    });
    let input = calls[1].body.variables.input;
    assert.deepEqual(input.merchantCriteria, [{ operator: 'contains', value: 'AMZN' }]);
    assert.equal(input.merchantCriteriaUseOriginalStatement, true);

    // Providing new-style criteria supersedes the legacy representation.
    await client.callTool({
      name: 'update_rule',
      arguments: { id: 'r2', merchantNameCriteria: [{ operator: 'eq', value: 'Amazon' }] },
    });
    input = calls[3].body.variables.input;
    assert.equal(input.merchantCriteria, undefined, 'legacy criteria dropped');
    assert.equal(input.merchantCriteriaUseOriginalStatement, undefined);
    assert.deepEqual(input.merchantNameCriteria, [{ operator: 'eq', value: 'Amazon' }]);
  });

  it('update_rule errors on an unknown rule ID without calling the mutation', async () => {
    installMockFetch(calls, { transactionRules: [CURRENT_RULE] });

    const result = await client.callTool({
      name: 'update_rule',
      arguments: { id: 'r-bogus', setCategoryAction: 'cat-2' },
    });

    assert.ok(result.isError, 'should be an error');
    assert.match(result.content[0].text, /r-bogus not found/);
    assert.match(result.content[0].text, /list_rules/);
    assert.equal(calls.length, 1, 'only the rules fetch — no mutation');
  });

  it('delete_rule deletes by id and reports deletion', async () => {
    installMockFetch(calls, { deleteTransactionRule: { deleted: true, errors: null } });

    const result = await client.callTool({
      name: 'delete_rule',
      arguments: { id: 'r1' },
    });

    assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
    assert.match(calls[0].body.query, /Common_DeleteTransactionRule/);
    assert.deepEqual(calls[0].body.variables, { id: 'r1' });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.deleted, true);
  });

  // Regression (2026-07-15): Monarch returns deleted:false for SUCCESSFUL
  // deletes. The tool must report success when there are no payload errors.
  it('delete_rule reports success even when the API says deleted:false', async () => {
    installMockFetch(calls, { deleteTransactionRule: { deleted: false, errors: null } });

    const result = await client.callTool({
      name: 'delete_rule',
      arguments: { id: 'r1' },
    });

    assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.deleted, true, 'success is the absence of payload errors');
    assert.equal(data.apiDeletedField, false, 'raw unreliable field kept for debugging');
  });

  it('delete_rule surfaces payload errors as tool errors, never as deleted:true', async () => {
    installMockFetch(calls, {
      deleteTransactionRule: {
        deleted: false,
        errors: [{ message: 'Rule not found', code: 'not_found', fieldErrors: null }],
      },
    });

    const result = await client.callTool({
      name: 'delete_rule',
      arguments: { id: 'r-bogus' },
    });

    assert.ok(result.isError, 'should be an error');
    assert.match(result.content[0].text, /Rule not found/);
  });
});
