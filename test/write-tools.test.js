import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Point to fixture DB and inject a fake token so loadToken() never
// touches the real ~/.monarch-token.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.MONARCH_DATA_DIR = path.join(__dirname, 'fixtures');
process.env.MONARCH_TOKEN = 'fake-test-token';

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

  it('write tool descriptions warn about live account mutation and stale mirror', async () => {
    const result = await client.listTools();
    const tool = result.tools.find(t => t.name === 'update_transaction');
    assert.match(tool.description, /live/i, 'should mention live account');
    assert.match(tool.description, /refresh_transactions/, 'should mention mirror refresh');
  });
});

describe('update_transaction tool', () => {
  let client, close, calls, originalFetch;

  before(async () => { ({ client, close } = await createTestPair()); });
  after(async () => { await close(); });
  beforeEach(() => { calls = []; originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('maps tool args to UpdateTransactionMutationInput and returns the mutated transaction', async () => {
    installMockFetch(calls, {
      updateTransaction: {
        transaction: {
          id: 'txn-1', notes: 'note here', hideFromReports: false, needsReview: false,
          category: { id: 'cat-1', name: 'Software' },
          merchant: { id: 'm-1', name: 'Renamed Merchant' },
        },
        errors: null,
      },
    });

    const result = await client.callTool({
      name: 'update_transaction',
      arguments: {
        id: 'txn-1',
        categoryId: 'cat-1',
        merchantName: 'Renamed Merchant',
        notes: 'note here',
        needsReview: false,
      },
    });

    assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
    assert.equal(calls.length, 1);
    const { body, opts } = calls[0];
    assert.match(opts.headers['Authorization'], /^Token /);
    assert.match(body.query, /Web_TransactionDrawerUpdateTransaction/);
    assert.deepEqual(body.variables, {
      input: {
        id: 'txn-1',
        category: 'cat-1',
        name: 'Renamed Merchant',
        notes: 'note here',
        needsReview: false,
      },
    });

    const txn = JSON.parse(result.content[0].text);
    assert.equal(txn.id, 'txn-1');
    assert.equal(txn.merchant.name, 'Renamed Merchant');
  });

  it('sends hideFromReports when provided', async () => {
    installMockFetch(calls, {
      updateTransaction: { transaction: { id: 'txn-2', hideFromReports: true }, errors: null },
    });

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

  it('validates split sum against the live parent amount, then applies the split', async () => {
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
      }
    );

    const result = await client.callTool({
      name: 'split_transaction',
      arguments: { transactionId: 'txn-1', splits: SPLITS },
    });

    assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
    assert.equal(calls.length, 2, 'should fetch parent then mutate');
    assert.match(calls[0].body.query, /GetTransactionDrawer/);
    assert.match(calls[1].body.query, /Common_SplitTransactionMutation/);
    assert.deepEqual(calls[1].body.variables, {
      input: { transactionId: 'txn-1', splitData: SPLITS },
    });

    const txn = JSON.parse(result.content[0].text);
    assert.equal(txn.hasSplitTransactions, true);
    assert.equal(txn.splitTransactions.length, 2);
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
    assert.equal(calls.length, 2);
  });

  it('clears splits with an empty array, skipping sum validation', async () => {
    installMockFetch(calls, {
      updateTransactionSplit: {
        transaction: { id: 'txn-1', hasSplitTransactions: false, splitTransactions: [] },
        errors: null,
      },
    });

    const result = await client.callTool({
      name: 'split_transaction',
      arguments: { transactionId: 'txn-1', splits: [] },
    });

    assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
    assert.equal(calls.length, 1, 'should not need to fetch the parent');
    assert.deepEqual(calls[0].body.variables, {
      input: { transactionId: 'txn-1', splitData: [] },
    });
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
