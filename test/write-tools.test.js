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
