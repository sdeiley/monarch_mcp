import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { makeQueueDb, seed, extensionSplitRecord, seedExtensionSplitRecord } from './helpers/queue-seed.js';
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

// ─── queue_update_status ────────────────────────────────────────────────

describe('queue_update_status tool', () => {
  it('is registered', async () => {
    const { client, close } = await createTestPair(makeQueueDb());
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.some(t => t.name === 'queue_update_status'));
    } finally {
      await close();
    }
  });

  it('performs a valid agent transition and returns the updated record', async () => {
    const db = makeQueueDb();
    seed(db, { id: 'r1', status: 'pending' });
    const { client, close } = await createTestPair(db);
    try {
      const result = await client.callTool({
        name: 'queue_update_status',
        arguments: { id: 'r1', status: 'dismissed', note: 'user said skip it' },
      });
      assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
      const data = parseResult(result);
      assert.equal(data.ok, true);
      assert.equal(data.record.status, 'dismissed');
      assert.equal(data.record.revision, 2);
      assert.equal(data.record.error, 'user said skip it');
    } finally {
      await close();
    }
  });

  it('allows retrying a failed record back to pending', async () => {
    const db = makeQueueDb();
    seed(db, { id: 'r1', status: 'failed', error: 'boom' });
    const { client, close } = await createTestPair(db);
    try {
      const result = await client.callTool({
        name: 'queue_update_status',
        arguments: { id: 'r1', status: 'pending' },
      });
      assert.ok(!result.isError);
      assert.equal(parseResult(result).record.status, 'pending');
    } finally {
      await close();
    }
  });

  it('rejects extension-only transitions (actor is fixed to agent)', async () => {
    const db = makeQueueDb();
    seed(db, { id: 'r1', status: 'pending' });
    const { client, close } = await createTestPair(db);
    try {
      for (const status of ['approved', 'saved-for-agent', 'stale']) {
        const result = await client.callTool({
          name: 'queue_update_status',
          arguments: { id: 'r1', status },
        });
        assert.ok(result.isError, `agent should not be able to set '${status}'`);
        assert.match(result.content[0].text, /transition/i);
      }
      assert.equal(getRecord(db, 'r1').status, 'pending', 'record untouched');
    } finally {
      await close();
    }
  });

  it('never resurrects an applied record', async () => {
    const db = makeQueueDb();
    seed(db, { id: 'r1', status: 'applied' });
    const { client, close } = await createTestPair(db);
    try {
      const result = await client.callTool({
        name: 'queue_update_status',
        arguments: { id: 'r1', status: 'pending' },
      });
      assert.ok(result.isError, 'should be an error');
      assert.equal(getRecord(db, 'r1').status, 'applied');
    } finally {
      await close();
    }
  });

  it('errors on unknown ids', async () => {
    const { client, close } = await createTestPair(makeQueueDb());
    try {
      const result = await client.callTool({
        name: 'queue_update_status',
        arguments: { id: 'nope', status: 'dismissed' },
      });
      assert.ok(result.isError);
      assert.match(result.content[0].text, /not found/i);
    } finally {
      await close();
    }
  });
});

// ─── queue_apply ────────────────────────────────────────────────────────

describe('queue_apply tool', () => {
  let calls, originalFetch;
  beforeEach(() => { calls = []; originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const LIVE_CLEAN = {
    id: 'txn-1', amount: -15.5, date: '2026-07-01', notes: null,
    hasSplitTransactions: false,
    tags: [{ id: 'tag-a', name: 'Apple', color: '#f00', order: 1 }],
  };

  const SPLIT_DIFF = {
    splits: [
      { amount: -10.00, categoryId: 'c1', merchantName: 'Item A', notes: 'first', categorySource: 'ai' },
      { amount: -5.50, categoryId: 'c2', merchantName: 'Item B' },
    ],
  };

  function seedSplitRec(db, overrides = {}) {
    return seed(db, {
      id: 'r1', type: 'split', status: 'pending', target_txn_id: 'txn-1',
      payload: { source: {}, target: { categoryId: 'c0' }, diff: SPLIT_DIFF },
      ...overrides,
    });
  }

  it('is registered', async () => {
    const { client, close } = await createTestPair(makeQueueDb());
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.some(t => t.name === 'queue_apply'));
    } finally {
      await close();
    }
  });

  it('dry_run returns the preflight and mutation plan without writing anything', async () => {
    const db = makeQueueDb();
    seedSplitRec(db);
    const { client, close } = await createTestPair(db);
    try {
      installMockFetch(calls, { getTransaction: LIVE_CLEAN });

      const result = await client.callTool({
        name: 'queue_apply',
        arguments: { id: 'r1', dry_run: true },
      });

      assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
      const data = parseResult(result);
      assert.equal(data.ok, true);
      assert.equal(data.dryRun, true);
      assert.equal(data.preflight.transactionFound, true);
      assert.equal(data.preflight.extProcessed, false);
      assert.deepEqual(data.mutations.map(m => m.op), ['split_transaction', 'set_transaction_tags']);
      assert.equal(calls.length, 1, 'only the preflight fetch runs');
      assert.match(calls[0].body.query, /GetTransactionDrawer/);
      assert.equal(getRecord(db, 'r1').status, 'pending', 'no status change on dry run');
      assert.equal(getRecord(db, 'r1').revision, 1);
    } finally {
      await close();
    }
  });

  it('applies a split record: mutation, Ext Processed tag, then marks applied by agent', async () => {
    const db = makeQueueDb();
    seedSplitRec(db);
    const { client, close } = await createTestPair(db);
    try {
      installMockFetch(
        calls,
        { getTransaction: LIVE_CLEAN },
        {
          updateTransactionSplit: {
            transaction: { id: 'txn-1', amount: -15.5, hasSplitTransactions: true, splitTransactions: [] },
            errors: null,
          },
        },
        { householdTransactionTags: [
          { id: 'tag-a', name: 'Apple', color: '#f00', order: 1 },
          { id: 'tag-ext', name: 'Ext Processed', color: '#0f0', order: 2 },
        ] },
        {
          setTransactionTags: {
            transaction: { id: 'txn-1', tags: [] },
            errors: null,
          },
        }
      );

      const result = await client.callTool({ name: 'queue_apply', arguments: { id: 'r1' } });

      assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
      const data = parseResult(result);
      assert.equal(data.ok, true);
      assert.equal(calls.length, 4);

      // Split mutation strips extension-side split metadata (categorySource, ...)
      assert.match(calls[1].body.query, /Common_SplitTransactionMutation/);
      assert.deepEqual(calls[1].body.variables.input, {
        transactionId: 'txn-1',
        splitData: [
          { amount: -10.00, categoryId: 'c1', merchantName: 'Item A', notes: 'first' },
          { amount: -5.50, categoryId: 'c2', merchantName: 'Item B' },
        ],
      });

      // Ext Processed is added while existing tags are preserved
      assert.match(calls[3].body.query, /Web_SetTransactionTags/);
      assert.deepEqual(calls[3].body.variables.input, {
        transactionId: 'txn-1',
        tagIds: ['tag-a', 'tag-ext'],
      });

      const rec = getRecord(db, 'r1');
      assert.equal(rec.status, 'applied');
      assert.equal(rec.applied_by, 'agent');
      assert.ok(rec.applied_at, 'applied_at should be set');
      assert.equal(rec.revision, 2);
    } finally {
      await close();
    }
  });

  it('a split record in the extension toQueueRecord shape yields a split-only plan (null diff scaffolding is not an update)', async () => {
    const db = makeQueueDb();
    seedExtensionSplitRecord(db, { id: 'r-ext' });
    const { client, close } = await createTestPair(db);
    try {
      installMockFetch(calls, { getTransaction: LIVE_CLEAN });

      const result = await client.callTool({
        name: 'queue_apply',
        arguments: { id: 'r-ext', dry_run: true },
      });

      assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
      const data = parseResult(result);
      assert.equal(data.ok, true);
      assert.deepEqual(
        data.mutations.map(m => m.op),
        ['split_transaction', 'set_transaction_tags'],
        'diff.newName/newCategoryId scaffolded as null must not produce an update_transaction mutation'
      );
    } finally {
      await close();
    }
  });

  // AI/static-categorized splits arrive with categoryId: null and only a
  // categoryName (id resolution used to happen in the sidebar DOM). The
  // apply path must resolve names against the monarch.db mirror's
  // categories (exact case-insensitive match; fixture mirror has
  // cat-001 Groceries and cat-002 Subscriptions).
  it('resolves null split categoryIds from categoryName via the mirror (dry_run shows the ids)', async () => {
    const db = makeQueueDb();
    const rec = extensionSplitRecord();
    rec.payload.diff.splits[0].categoryId = null;
    rec.payload.diff.splits[0].categoryName = 'Subscriptions';
    rec.payload.diff.splits[1].categoryId = null;
    rec.payload.diff.splits[1].categoryName = 'groceries'; // case-insensitive
    seed(db, rec);
    const { client, close } = await createTestPair(db);
    try {
      installMockFetch(calls, { getTransaction: LIVE_CLEAN });

      const result = await client.callTool({
        name: 'queue_apply',
        arguments: { id: rec.id, dry_run: true },
      });

      assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
      const data = parseResult(result);
      assert.equal(data.ok, true);
      const split = data.mutations.find(m => m.op === 'split_transaction');
      assert.deepEqual(
        split.input.splitData.map(s => s.categoryId),
        ['cat-002', 'cat-001'],
        'dry_run must show the mirror-resolved category ids'
      );
    } finally {
      await close();
    }
  });

  it('resolves a null newCategoryId from newCategoryName on update records', async () => {
    const db = makeQueueDb();
    seed(db, {
      id: 'r-upd', type: 'update', status: 'pending', target_txn_id: 'txn-1',
      payload: {
        source: {}, target: {},
        diff: { newName: 'Apple One', newCategoryId: null, newCategoryName: 'Subscriptions', addNotes: null },
      },
    });
    const { client, close } = await createTestPair(db);
    try {
      installMockFetch(calls, { getTransaction: LIVE_CLEAN });

      const result = await client.callTool({
        name: 'queue_apply',
        arguments: { id: 'r-upd', dry_run: true },
      });

      assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
      const data = parseResult(result);
      const update = data.mutations.find(m => m.op === 'update_transaction');
      assert.equal(update.input.category, 'cat-002');
    } finally {
      await close();
    }
  });

  it('fails the record with a clear error when a categoryName cannot be resolved', async () => {
    const db = makeQueueDb();
    const rec = extensionSplitRecord();
    rec.payload.diff.splits[0].categoryId = null;
    rec.payload.diff.splits[0].categoryName = 'Imaginary Category';
    seed(db, rec);
    const { client, close } = await createTestPair(db);
    try {
      installMockFetch(calls, { getTransaction: LIVE_CLEAN });

      const result = await client.callTool({ name: 'queue_apply', arguments: { id: rec.id } });

      assert.ok(!result.isError, 'refusal is a structured result, not a protocol error');
      const data = parseResult(result);
      assert.equal(data.ok, false);
      assert.match(data.error, /Imaginary Category/);
      assert.equal(calls.length, 1, 'no mutation may run past the preflight fetch');
      const after = getRecord(db, rec.id);
      assert.equal(after.status, 'failed');
      assert.match(after.error, /Imaginary Category/);
    } finally {
      await close();
    }
  });

  it('creates the Ext Processed tag when it does not exist yet', async () => {
    const db = makeQueueDb();
    seedSplitRec(db);
    const { client, close } = await createTestPair(db);
    try {
      installMockFetch(
        calls,
        { getTransaction: LIVE_CLEAN },
        { updateTransactionSplit: { transaction: { id: 'txn-1', hasSplitTransactions: true, splitTransactions: [] }, errors: null } },
        { householdTransactionTags: [{ id: 'tag-a', name: 'Apple', color: '#f00', order: 1 }] },
        { createTransactionTag: { __typename: 'CreateTransactionTagPayload' } },
        { householdTransactionTags: [
          { id: 'tag-a', name: 'Apple', color: '#f00', order: 1 },
          { id: 'tag-ext', name: 'Ext Processed', color: null, order: 2 },
        ] },
        { setTransactionTags: { transaction: { id: 'txn-1', tags: [] }, errors: null } }
      );

      const result = await client.callTool({ name: 'queue_apply', arguments: { id: 'r1' } });

      assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
      assert.equal(calls.length, 6);
      assert.match(calls[3].body.query, /Common_CreateTransactionTag/);
      assert.equal(calls[3].body.variables.input.name, 'Ext Processed');
      assert.deepEqual(calls[5].body.variables.input.tagIds, ['tag-a', 'tag-ext']);
      assert.equal(getRecord(db, 'r1').status, 'applied');
    } finally {
      await close();
    }
  });

  it('refuses and marks stale when the live target already carries Ext Processed', async () => {
    const db = makeQueueDb();
    seedSplitRec(db);
    const { client, close } = await createTestPair(db);
    try {
      installMockFetch(calls, {
        getTransaction: {
          ...LIVE_CLEAN,
          tags: [{ id: 'tag-ext', name: 'Ext Processed', color: null, order: 1 }],
        },
      });

      const result = await client.callTool({ name: 'queue_apply', arguments: { id: 'r1' } });

      assert.ok(!result.isError, 'refusal is a structured result, not a protocol error');
      const data = parseResult(result);
      assert.equal(data.ok, false);
      assert.match(data.refused, /already processed/i);
      assert.equal(calls.length, 1, 'no mutations may run');
      const rec = getRecord(db, 'r1');
      assert.equal(rec.status, 'stale');
      assert.match(rec.error, /already processed/i);
    } finally {
      await close();
    }
  });

  it('refuses and marks stale when the live target already has splits', async () => {
    const db = makeQueueDb();
    seedSplitRec(db);
    const { client, close } = await createTestPair(db);
    try {
      installMockFetch(calls, { getTransaction: { ...LIVE_CLEAN, hasSplitTransactions: true } });

      const result = await client.callTool({ name: 'queue_apply', arguments: { id: 'r1' } });

      const data = parseResult(result);
      assert.equal(data.ok, false);
      assert.equal(calls.length, 1);
      assert.equal(getRecord(db, 'r1').status, 'stale');
    } finally {
      await close();
    }
  });

  it('marks stale when the target transaction no longer exists', async () => {
    const db = makeQueueDb();
    seedSplitRec(db);
    const { client, close } = await createTestPair(db);
    try {
      installMockFetch(calls, { getTransaction: null });

      const result = await client.callTool({ name: 'queue_apply', arguments: { id: 'r1' } });

      const data = parseResult(result);
      assert.equal(data.ok, false);
      assert.equal(data.preflight.transactionFound, false);
      assert.equal(getRecord(db, 'r1').status, 'stale');
    } finally {
      await close();
    }
  });

  it('applies an update-type record via updateTransaction, appending notes', async () => {
    const db = makeQueueDb();
    seed(db, {
      id: 'r2', type: 'update', status: 'saved-for-agent', target_txn_id: 'txn-1',
      payload: {
        source: {}, target: {},
        diff: { newName: 'Apple One', newCategoryId: 'c9', addNotes: 'Subscription bundle' },
      },
    });
    const { client, close } = await createTestPair(db);
    try {
      installMockFetch(
        calls,
        { getTransaction: { ...LIVE_CLEAN, notes: 'existing note' } },
        { updateTransaction: { transaction: { id: 'txn-1' }, errors: null } },
        { householdTransactionTags: [{ id: 'tag-ext', name: 'Ext Processed', color: null, order: 1 }] },
        { setTransactionTags: { transaction: { id: 'txn-1', tags: [] }, errors: null } }
      );

      const result = await client.callTool({ name: 'queue_apply', arguments: { id: 'r2' } });

      assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
      assert.match(calls[1].body.query, /Web_TransactionDrawerUpdateTransaction/);
      assert.deepEqual(calls[1].body.variables.input, {
        id: 'txn-1',
        name: 'Apple One',
        category: 'c9',
        notes: 'existing note\nSubscription bundle',
      });
      const rec = getRecord(db, 'r2');
      assert.equal(rec.status, 'applied');
      assert.equal(rec.applied_by, 'agent');
    } finally {
      await close();
    }
  });

  it('marks the record failed with the error message when a mutation fails', async () => {
    const db = makeQueueDb();
    seedSplitRec(db);
    const { client, close } = await createTestPair(db);
    try {
      installMockFetch(
        calls,
        { getTransaction: LIVE_CLEAN },
        {
          updateTransactionSplit: {
            transaction: null,
            errors: [{ message: 'Split failed upstream', code: 'error', fieldErrors: null }],
          },
        }
      );

      const result = await client.callTool({ name: 'queue_apply', arguments: { id: 'r1' } });

      const data = parseResult(result);
      assert.equal(data.ok, false);
      assert.match(data.error, /Split failed upstream/);
      const rec = getRecord(db, 'r1');
      assert.equal(rec.status, 'failed');
      assert.match(rec.error, /Split failed upstream/);
    } finally {
      await close();
    }
  });

  it('rejects split diffs whose amounts do not sum to the live amount, marking failed', async () => {
    const db = makeQueueDb();
    seedSplitRec(db);
    const { client, close } = await createTestPair(db);
    try {
      installMockFetch(calls, { getTransaction: { ...LIVE_CLEAN, amount: -20.00 } });

      const result = await client.callTool({ name: 'queue_apply', arguments: { id: 'r1' } });

      const data = parseResult(result);
      assert.equal(data.ok, false);
      assert.match(data.error, /-15\.50/);
      assert.match(data.error, /-20\.00/);
      assert.equal(calls.length, 1, 'no mutation may run');
      assert.equal(getRecord(db, 'r1').status, 'failed');
    } finally {
      await close();
    }
  });

  it('refuses to apply from statuses the agent may not apply from', async () => {
    const db = makeQueueDb();
    seed(db, { id: 'r-applied', status: 'applied' });
    seed(db, { id: 'r-dismissed', status: 'dismissed' });
    seed(db, { id: 'r-failed', status: 'failed' });
    seed(db, { id: 'r-approved', status: 'approved' });
    const { client, close } = await createTestPair(db);
    try {
      installMockFetch(calls, {});
      for (const id of ['r-applied', 'r-dismissed', 'r-failed', 'r-approved']) {
        const result = await client.callTool({ name: 'queue_apply', arguments: { id } });
        assert.ok(result.isError, `should error for ${id}`);
      }
      assert.equal(calls.length, 0, 'no API calls for refused statuses');
      // failed records point the agent at the retry path
      const failedResult = await client.callTool({ name: 'queue_apply', arguments: { id: 'r-failed' } });
      assert.match(failedResult.content[0].text, /pending/);
    } finally {
      await close();
    }
  });

  it('double-apply is impossible: the second apply errors and nothing mutates', async () => {
    const db = makeQueueDb();
    seedSplitRec(db);
    const { client, close } = await createTestPair(db);
    try {
      installMockFetch(
        calls,
        { getTransaction: LIVE_CLEAN },
        { updateTransactionSplit: { transaction: { id: 'txn-1', hasSplitTransactions: true, splitTransactions: [] }, errors: null } },
        { householdTransactionTags: [{ id: 'tag-ext', name: 'Ext Processed', color: null, order: 1 }] },
        { setTransactionTags: { transaction: { id: 'txn-1', tags: [] }, errors: null } }
      );
      const first = await client.callTool({ name: 'queue_apply', arguments: { id: 'r1' } });
      assert.equal(parseResult(first).ok, true);
      const callsAfterFirst = calls.length;

      const second = await client.callTool({ name: 'queue_apply', arguments: { id: 'r1' } });
      assert.ok(second.isError, 'second apply must error');
      assert.equal(calls.length, callsAfterFirst, 'no further API calls');
      assert.equal(getRecord(db, 'r1').revision, 2, 'revision bumped exactly once');
    } finally {
      await close();
    }
  });

  it('errors on unknown ids', async () => {
    const { client, close } = await createTestPair(makeQueueDb());
    try {
      installMockFetch(calls, {});
      const result = await client.callTool({ name: 'queue_apply', arguments: { id: 'nope' } });
      assert.ok(result.isError);
      assert.match(result.content[0].text, /not found/i);
      assert.equal(calls.length, 0);
    } finally {
      await close();
    }
  });
});

// ─── queue_sweep ────────────────────────────────────────────────────────

describe('queue_sweep tool', () => {
  it('is registered', async () => {
    const { client, close } = await createTestPair(makeQueueDb());
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.some(t => t.name === 'queue_sweep'));
    } finally {
      await close();
    }
  });

  it('stales records against the monarch.db mirror and purges per retention', async () => {
    const db = makeQueueDb();
    const old = (days) => new Date(Date.now() - days * 86400e3).toISOString();
    // Fixture mirror: txn-001 has has_splits=1; txn-002 is clean with cat-002.
    seed(db, { id: 'sw1', status: 'pending', target_txn_id: 'txn-001' });
    seed(db, { id: 'sw2', status: 'pending', target_txn_id: 'ghost-txn' });
    seed(db, {
      id: 'sw3', status: 'pending', target_txn_id: 'txn-002',
      payload: { target: { categoryId: 'cat-002' }, diff: {} },
    });
    seed(db, { id: 'sw4', status: 'applied', target_txn_id: 'txn-003', updated_at: old(60), applied_at: old(60) });

    const { client, close } = await createTestPair(db);
    try {
      const result = await client.callTool({ name: 'queue_sweep', arguments: {} });
      assert.ok(!result.isError, `should not error: ${result.content?.[0]?.text}`);
      const data = parseResult(result);
      assert.equal(data.staled, 2, 'split target + missing target stale');
      assert.equal(data.purged, 1, 'old applied record purged');
      assert.equal(data.remaining, 3);

      assert.equal(getRecord(db, 'sw1').status, 'stale');
      assert.equal(getRecord(db, 'sw2').status, 'stale');
      assert.equal(getRecord(db, 'sw3').status, 'pending', 'clean record untouched');
      assert.equal(getRecord(db, 'sw4'), null);
    } finally {
      await close();
    }
  });

  it('returns cleanly on an empty queue', async () => {
    const { client, close } = await createTestPair(makeQueueDb());
    try {
      const result = await client.callTool({ name: 'queue_sweep', arguments: {} });
      assert.ok(!result.isError);
      const data = parseResult(result);
      assert.deepEqual(
        { staled: data.staled, purged: data.purged, remaining: data.remaining },
        { staled: 0, purged: 0, remaining: 0 }
      );
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
