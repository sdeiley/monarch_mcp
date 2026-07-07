import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { makeQueueDb, seed } from './helpers/queue-seed.js';
import { getRecord } from '../src/queue.js';

// Point to fixture DB (mirror) and inject a fake token so loadToken()
// never touches the real ~/.monarch-token.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.MONARCH_DATA_DIR = path.join(__dirname, 'fixtures');
process.env.MONARCH_TOKEN = 'fake-test-token';

/** Spin up a linked client/server pair with an injected in-memory queue db. */
async function createTestPair(queueDb) {
  const { createServer } = await import('../src/server.js');
  const server = createServer({ queueDb });
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { server, client, close: () => Promise.all([server.close(), client.close()]) };
}

function parseResult(result) {
  return JSON.parse(result.content[0].text);
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

// ─── Registration ───────────────────────────────────────────────────────

describe('queue tool registration', () => {
  let client, close;

  before(async () => { ({ client, close } = await createTestPair(makeQueueDb())); });
  after(async () => { await close(); });

  it('lists the queue read tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    for (const name of ['queue_list', 'queue_get']) {
      assert.ok(names.includes(name), `should have ${name}`);
    }
  });

  it('exposes the monarch://queue/stats resource', async () => {
    const { resources } = await client.listResources();
    const uris = resources.map(r => r.uri);
    assert.ok(uris.includes('monarch://queue/stats'), 'should list queue/stats');
  });
});

// ─── queue_list / queue_get ─────────────────────────────────────────────

describe('queue_list tool', () => {
  it('returns a friendly result on an empty queue (no crash)', async () => {
    const { client, close } = await createTestPair(makeQueueDb());
    try {
      const result = await client.callTool({ name: 'queue_list', arguments: {} });
      assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
      const data = parseResult(result);
      assert.deepEqual(data.items, []);
      assert.match(data.message, /empty/i);
    } finally {
      await close();
    }
  });

  it('lists records with counts by status', async () => {
    const db = makeQueueDb();
    seed(db, { id: 'r1', status: 'pending', type: 'split', source_merchant: 'apple', confidence: 0.95 });
    seed(db, { id: 'r2', status: 'pending', type: 'categorize', source_merchant: 'apple', confidence: 0.4 });
    seed(db, { id: 'r3', status: 'applied', type: 'split', source_merchant: 'venmo', confidence: 0.8 });
    const { client, close } = await createTestPair(db);
    try {
      const result = await client.callTool({ name: 'queue_list', arguments: {} });
      const data = parseResult(result);
      assert.equal(data.items.length, 3);
      assert.deepEqual(data.counts, { pending: 2, applied: 1 });
      assert.equal(typeof data.items[0].payload, 'object', 'payload should be parsed JSON');
    } finally {
      await close();
    }
  });

  it('applies status, type, merchant, min_confidence, and limit filters', async () => {
    const db = makeQueueDb();
    seed(db, { id: 'r1', status: 'pending', type: 'split', source_merchant: 'apple', confidence: 0.95 });
    seed(db, { id: 'r2', status: 'pending', type: 'categorize', source_merchant: 'apple', confidence: 0.4 });
    seed(db, { id: 'r3', status: 'applied', type: 'split', source_merchant: 'venmo', confidence: 0.8 });
    const { client, close } = await createTestPair(db);
    try {
      const byStatus = parseResult(await client.callTool({
        name: 'queue_list', arguments: { status: 'pending' },
      }));
      assert.deepEqual(byStatus.items.map(i => i.id).sort(), ['r1', 'r2']);

      const byConf = parseResult(await client.callTool({
        name: 'queue_list', arguments: { min_confidence: 0.75 },
      }));
      assert.deepEqual(byConf.items.map(i => i.id).sort(), ['r1', 'r3']);

      const byMerchant = parseResult(await client.callTool({
        name: 'queue_list', arguments: { merchant: 'venmo', type: 'split' },
      }));
      assert.deepEqual(byMerchant.items.map(i => i.id), ['r3']);

      const limited = parseResult(await client.callTool({
        name: 'queue_list', arguments: { limit: 1 },
      }));
      assert.equal(limited.items.length, 1);
    } finally {
      await close();
    }
  });
});

describe('queue_get tool', () => {
  it('returns the full record with parsed payload', async () => {
    const db = makeQueueDb();
    seed(db, {
      id: 'r1',
      payload: { source: { invoiceId: 'inv-1' }, target: {}, diff: { newName: 'Apple One' }, reasoning: 'why', usedAI: true },
    });
    const { client, close } = await createTestPair(db);
    try {
      const result = await client.callTool({ name: 'queue_get', arguments: { id: 'r1' } });
      assert.ok(!result.isError);
      const rec = parseResult(result);
      assert.equal(rec.id, 'r1');
      assert.equal(rec.revision, 1);
      assert.deepEqual(rec.payload.diff, { newName: 'Apple One' });
    } finally {
      await close();
    }
  });

  it('returns a friendly error for unknown ids', async () => {
    const { client, close } = await createTestPair(makeQueueDb());
    try {
      const result = await client.callTool({ name: 'queue_get', arguments: { id: 'nope' } });
      assert.ok(result.isError, 'should be an error');
      assert.match(result.content[0].text, /not found/i);
    } finally {
      await close();
    }
  });
});

// ─── monarch://queue/stats resource ─────────────────────────────────────

describe('queue/stats resource', () => {
  it('returns counts by status/type/merchant and lastGeneratedAt', async () => {
    const db = makeQueueDb();
    seed(db, { id: 'r1', status: 'pending', type: 'split', source_merchant: 'apple', created_at: '2026-07-02T00:00:00.000Z' });
    seed(db, { id: 'r2', status: 'applied', type: 'rename', source_merchant: 'apple', created_at: '2026-07-04T00:00:00.000Z' });
    const { client, close } = await createTestPair(db);
    try {
      const result = await client.readResource({ uri: 'monarch://queue/stats' });
      const data = JSON.parse(result.contents[0].text);
      assert.equal(data.total, 2);
      assert.deepEqual(data.counts.byStatus, { pending: 1, applied: 1 });
      assert.deepEqual(data.counts.byType, { split: 1, rename: 1 });
      assert.deepEqual(data.counts.byMerchant, { apple: 2 });
      assert.equal(data.lastGeneratedAt, '2026-07-04T00:00:00.000Z');
    } finally {
      await close();
    }
  });

  it('reads cleanly on an empty queue', async () => {
    const { client, close } = await createTestPair(makeQueueDb());
    try {
      const result = await client.readResource({ uri: 'monarch://queue/stats' });
      const data = JSON.parse(result.contents[0].text);
      assert.equal(data.total, 0);
      assert.equal(data.lastGeneratedAt, null);
    } finally {
      await close();
    }
  });
});
