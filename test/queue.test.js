import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { resolveQueueDbPath } from '../src/config.js';
import {
  ensureSchema,
  canTransition,
  getRecord,
  listRecords,
  updateStatus,
  getStatsData,
  sweep,
  QUEUE_STATUSES,
  SCHEMA_VERSION,
  SOFT_CAP,
  EXT_PROCESSED_TAG,
} from '../src/queue.js';
import { makeQueueDb, seed } from './helpers/queue-seed.js';

// ─── config: resolveQueueDbPath ─────────────────────────────────────────

describe('resolveQueueDbPath', () => {
  it('resolves queue.db inside the resolved data dir', () => {
    const p = resolveQueueDbPath('/some/dir');
    assert.equal(p, path.join('/some/dir', 'queue.db'));
  });

  it('defaults to the MONARCH_DATA_DIR data dir', () => {
    // Test env sets MONARCH_DATA_DIR (or falls back to ~/.monarch)
    const prev = process.env.MONARCH_DATA_DIR;
    process.env.MONARCH_DATA_DIR = '/env/dir';
    try {
      assert.equal(resolveQueueDbPath(), path.join('/env/dir', 'queue.db'));
    } finally {
      if (prev === undefined) delete process.env.MONARCH_DATA_DIR;
      else process.env.MONARCH_DATA_DIR = prev;
    }
  });
});

// ─── ensureSchema ───────────────────────────────────────────────────────

describe('ensureSchema', () => {
  it('creates the recommendations and queue_meta tables with indexes', () => {
    const db = new DatabaseSync(':memory:');
    ensureSchema(db);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).all().map(r => r.name);
    assert.ok(tables.includes('recommendations'));
    assert.ok(tables.includes('queue_meta'));

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_rec_%' ORDER BY name"
    ).all().map(r => r.name);
    assert.deepEqual(indexes, ['idx_rec_status', 'idx_rec_target']);
  });

  it('records schema_version=1 in queue_meta', () => {
    const db = new DatabaseSync(':memory:');
    ensureSchema(db);
    const row = db.prepare("SELECT value FROM queue_meta WHERE key = 'schema_version'").get();
    assert.equal(Number(row.value), SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 1);
  });

  it('is idempotent (safe to call twice)', () => {
    const db = new DatabaseSync(':memory:');
    ensureSchema(db);
    seed(db);
    ensureSchema(db); // must not throw or wipe data
    const n = db.prepare('SELECT COUNT(*) AS n FROM recommendations').get().n;
    assert.equal(n, 1);
  });

  it('sets a busy_timeout for write contention', () => {
    const db = new DatabaseSync(':memory:');
    ensureSchema(db);
    const { timeout } = db.prepare('PRAGMA busy_timeout').get();
    assert.ok(timeout >= 1000, `busy_timeout should be set, got ${timeout}`);
  });

  it('rejects a database with an unsupported schema version', () => {
    const db = new DatabaseSync(':memory:');
    ensureSchema(db);
    db.prepare("UPDATE queue_meta SET value = '99' WHERE key = 'schema_version'").run();
    assert.throws(() => ensureSchema(db), /schema version/i);
  });
});

// ─── canTransition ──────────────────────────────────────────────────────

describe('canTransition', () => {
  // [from, to, actor, expected]
  const cases = [
    // pending → approved: extension only (interactive Approve)
    ['pending', 'approved', 'extension', true],
    ['pending', 'approved', 'agent', false],
    ['pending', 'approved', 'sweep', false],

    // pending → saved-for-agent: extension defers
    ['pending', 'saved-for-agent', 'extension', true],
    ['pending', 'saved-for-agent', 'agent', false],
    ['pending', 'saved-for-agent', 'sweep', false],

    // approved → applied: extension only
    ['approved', 'applied', 'extension', true],
    ['approved', 'applied', 'agent', false],

    // pending|saved-for-agent → applied: agent
    ['pending', 'applied', 'agent', true],
    ['pending', 'applied', 'extension', false],
    ['saved-for-agent', 'applied', 'agent', true],
    ['saved-for-agent', 'applied', 'extension', false],
    ['pending', 'applied', 'sweep', false],

    // pending|approved|saved-for-agent → dismissed: either actor (not sweep)
    ['pending', 'dismissed', 'extension', true],
    ['pending', 'dismissed', 'agent', true],
    ['approved', 'dismissed', 'extension', true],
    ['approved', 'dismissed', 'agent', true],
    ['saved-for-agent', 'dismissed', 'extension', true],
    ['saved-for-agent', 'dismissed', 'agent', true],
    ['pending', 'dismissed', 'sweep', false],

    // pending|approved|saved-for-agent → stale: sweep only
    ['pending', 'stale', 'sweep', true],
    ['approved', 'stale', 'sweep', true],
    ['saved-for-agent', 'stale', 'sweep', true],
    ['pending', 'stale', 'agent', false],
    ['pending', 'stale', 'extension', false],

    // apply attempt error → failed (by whoever can apply from that status)
    ['pending', 'failed', 'agent', true],
    ['saved-for-agent', 'failed', 'agent', true],
    ['approved', 'failed', 'extension', true],
    ['pending', 'failed', 'sweep', false],

    // failed → pending: retry allowed by either actor
    ['failed', 'pending', 'extension', true],
    ['failed', 'pending', 'agent', true],
    ['failed', 'pending', 'sweep', false],

    // applied|dismissed are terminal — never back to pending (or anywhere)
    ['applied', 'pending', 'extension', false],
    ['applied', 'pending', 'agent', false],
    ['applied', 'pending', 'sweep', false],
    ['applied', 'applied', 'agent', false],
    ['applied', 'dismissed', 'agent', false],
    ['dismissed', 'pending', 'agent', false],
    ['dismissed', 'applied', 'agent', false],

    // stale is not retryable (only failed → pending is)
    ['stale', 'pending', 'agent', false],
    ['stale', 'applied', 'agent', false],

    // unknown statuses/actors
    ['bogus', 'applied', 'agent', false],
    ['pending', 'bogus', 'agent', false],
    ['pending', 'applied', 'bogus', false],
  ];

  for (const [from, to, actor, expected] of cases) {
    it(`${from} → ${to} by ${actor} is ${expected ? 'allowed' : 'denied'}`, () => {
      assert.equal(canTransition(from, to, actor), expected);
    });
  }

  it('exports the full status list', () => {
    assert.deepEqual(
      [...QUEUE_STATUSES].sort(),
      ['applied', 'approved', 'dismissed', 'failed', 'pending', 'saved-for-agent', 'stale'].sort()
    );
  });
});

// ─── updateStatus (guarded transition) ──────────────────────────────────

describe('updateStatus', () => {
  it('applies a valid transition, bumping revision and updated_at', () => {
    const db = makeQueueDb();
    const rec = seed(db, { status: 'pending' });

    const updated = updateStatus(db, rec.id, 'dismissed', 'agent', {
      now: new Date('2026-07-06T12:00:00.000Z'),
    });

    assert.equal(updated.status, 'dismissed');
    assert.equal(updated.revision, 2);
    assert.equal(updated.updated_at, '2026-07-06T12:00:00.000Z');
  });

  it('sets applied_at and applied_by on transition to applied', () => {
    const db = makeQueueDb();
    const rec = seed(db, { status: 'saved-for-agent' });

    const updated = updateStatus(db, rec.id, 'applied', 'agent', {
      now: new Date('2026-07-06T12:00:00.000Z'),
    });

    assert.equal(updated.status, 'applied');
    assert.equal(updated.applied_by, 'agent');
    assert.equal(updated.applied_at, '2026-07-06T12:00:00.000Z');
  });

  it('records an error message when provided', () => {
    const db = makeQueueDb();
    const rec = seed(db, { status: 'pending' });
    const updated = updateStatus(db, rec.id, 'failed', 'agent', { error: 'Monarch API HTTP 500' });
    assert.equal(updated.status, 'failed');
    assert.equal(updated.error, 'Monarch API HTTP 500');
  });

  it('rejects an invalid transition and leaves the record untouched', () => {
    const db = makeQueueDb();
    const rec = seed(db, { status: 'pending' });

    assert.throws(
      () => updateStatus(db, rec.id, 'approved', 'agent'),
      /transition/i
    );
    const after = getRecord(db, rec.id);
    assert.equal(after.status, 'pending');
    assert.equal(after.revision, 1);
  });

  it('never resurrects a terminal record (applied → pending)', () => {
    const db = makeQueueDb();
    const rec = seed(db, { status: 'applied' });
    for (const actor of ['extension', 'agent', 'sweep']) {
      assert.throws(() => updateStatus(db, rec.id, 'pending', actor), /transition/i);
    }
  });

  it('guards against concurrent transitions (double-apply)', () => {
    const db = makeQueueDb();
    const rec = seed(db, { status: 'pending' });

    updateStatus(db, rec.id, 'applied', 'agent');
    // Second apply must fail: status is no longer in the allowed-from set.
    assert.throws(() => updateStatus(db, rec.id, 'applied', 'agent'), /transition/i);
    assert.equal(getRecord(db, rec.id).revision, 2, 'revision bumped exactly once');
  });

  it('guards against a racing writer changing status underneath', () => {
    const db = makeQueueDb();
    const rec = seed(db, { status: 'pending' });

    // Simulate another writer dismissing the record out-of-band.
    db.prepare("UPDATE recommendations SET status = 'dismissed' WHERE id = ?").run(rec.id);

    assert.throws(() => updateStatus(db, rec.id, 'applied', 'agent'), /transition/i);
    assert.equal(getRecord(db, rec.id).status, 'dismissed');
  });

  it('throws a not-found error for unknown ids', () => {
    const db = makeQueueDb();
    assert.throws(() => updateStatus(db, 'nope', 'dismissed', 'agent'), /not found/i);
  });
});

// ─── getRecord / listRecords ────────────────────────────────────────────

describe('getRecord', () => {
  it('returns the record with payload parsed as an object', () => {
    const db = makeQueueDb();
    const rec = seed(db, {
      payload: { source: {}, target: { categoryId: 'cat-1' }, diff: { newName: 'X' } },
    });
    const got = getRecord(db, rec.id);
    assert.equal(got.id, rec.id);
    assert.deepEqual(got.payload.diff, { newName: 'X' });
  });

  it('returns null for unknown ids', () => {
    const db = makeQueueDb();
    assert.equal(getRecord(db, 'missing'), null);
  });
});

describe('listRecords', () => {
  function seedSet(db) {
    seed(db, { id: 'r1', status: 'pending', type: 'split', source_merchant: 'apple', confidence: 0.95 });
    seed(db, { id: 'r2', status: 'pending', type: 'categorize', source_merchant: 'apple', confidence: 0.5 });
    seed(db, { id: 'r3', status: 'applied', type: 'split', source_merchant: 'venmo', confidence: 0.8 });
    seed(db, { id: 'r4', status: 'dismissed', type: 'rename', source_merchant: 'apple', confidence: null });
  }

  it('returns all records with counts by status when unfiltered', () => {
    const db = makeQueueDb();
    seedSet(db);
    const { items, counts } = listRecords(db, {});
    assert.equal(items.length, 4);
    assert.deepEqual(counts, { pending: 2, applied: 1, dismissed: 1 });
  });

  it('filters by status', () => {
    const db = makeQueueDb();
    seedSet(db);
    const { items } = listRecords(db, { status: 'pending' });
    assert.deepEqual(items.map(i => i.id).sort(), ['r1', 'r2']);
  });

  it('filters by type and merchant', () => {
    const db = makeQueueDb();
    seedSet(db);
    assert.deepEqual(
      listRecords(db, { type: 'split' }).items.map(i => i.id).sort(),
      ['r1', 'r3']
    );
    assert.deepEqual(
      listRecords(db, { merchant: 'venmo' }).items.map(i => i.id),
      ['r3']
    );
  });

  it('filters by min_confidence', () => {
    const db = makeQueueDb();
    seedSet(db);
    const { items } = listRecords(db, { minConfidence: 0.75 });
    assert.deepEqual(items.map(i => i.id).sort(), ['r1', 'r3']);
  });

  it('applies the limit', () => {
    const db = makeQueueDb();
    seedSet(db);
    const { items } = listRecords(db, { limit: 2 });
    assert.equal(items.length, 2);
  });

  it('parses payload JSON on each item', () => {
    const db = makeQueueDb();
    seed(db, { id: 'r1', payload: { diff: { splits: [] } } });
    const { items } = listRecords(db, {});
    assert.deepEqual(items[0].payload.diff, { splits: [] });
  });
});

// ─── getStatsData ───────────────────────────────────────────────────────

describe('getStatsData', () => {
  it('returns counts by status, type, and merchant plus lastGeneratedAt', () => {
    const db = makeQueueDb();
    seed(db, { id: 'r1', status: 'pending', type: 'split', source_merchant: 'apple', created_at: '2026-07-01T00:00:00.000Z' });
    seed(db, { id: 'r2', status: 'applied', type: 'split', source_merchant: 'apple', created_at: '2026-07-03T00:00:00.000Z' });
    seed(db, { id: 'r3', status: 'pending', type: 'rename', source_merchant: 'venmo', created_at: '2026-07-02T00:00:00.000Z' });

    const stats = getStatsData(db);
    assert.equal(stats.total, 3);
    assert.deepEqual(stats.counts.byStatus, { pending: 2, applied: 1 });
    assert.deepEqual(stats.counts.byType, { split: 2, rename: 1 });
    assert.deepEqual(stats.counts.byMerchant, { apple: 2, venmo: 1 });
    assert.equal(stats.lastGeneratedAt, '2026-07-03T00:00:00.000Z');
  });

  it('handles an empty queue', () => {
    const db = makeQueueDb();
    const stats = getStatsData(db);
    assert.equal(stats.total, 0);
    assert.deepEqual(stats.counts.byStatus, {});
    assert.equal(stats.lastGeneratedAt, null);
  });
});

// ─── sweep ──────────────────────────────────────────────────────────────

describe('sweep', () => {
  const NOW = new Date('2026-07-06T00:00:00.000Z');

  function mirrorOf(rows) {
    const map = new Map(rows.map(r => [r.id, r]));
    return (ids) => map;
  }

  it('marks records stale when the target is missing from the mirror', () => {
    const db = makeQueueDb();
    const rec = seed(db, { status: 'pending', target_txn_id: 'gone' });
    const result = sweep(db, { lookupMirrorTxns: mirrorOf([]), now: NOW });
    assert.equal(result.staled, 1);
    const after = getRecord(db, rec.id);
    assert.equal(after.status, 'stale');
    assert.match(after.error, /missing/i);
  });

  it('marks records stale when the target carries the Ext Processed tag', () => {
    const db = makeQueueDb();
    const rec = seed(db, { status: 'pending', target_txn_id: 't1' });
    const result = sweep(db, {
      lookupMirrorTxns: mirrorOf([{ id: 't1', category_id: 'c1', has_splits: 0, tags: `Apple, ${EXT_PROCESSED_TAG}` }]),
      now: NOW,
    });
    assert.equal(result.staled, 1);
    assert.match(getRecord(db, rec.id).error, /processed/i);
  });

  it('marks records stale when the target is already split', () => {
    const db = makeQueueDb();
    seed(db, { id: 'r1', status: 'approved', target_txn_id: 't1' });
    const result = sweep(db, {
      lookupMirrorTxns: mirrorOf([{ id: 't1', category_id: 'c1', has_splits: 1, tags: null }]),
      now: NOW,
    });
    assert.equal(result.staled, 1);
    assert.equal(getRecord(db, 'r1').status, 'stale');
  });

  it('marks records stale on category drift against the captured target', () => {
    const db = makeQueueDb();
    seed(db, {
      id: 'r1', status: 'pending', target_txn_id: 't1',
      payload: { target: { categoryId: 'cat-old' }, diff: {} },
    });
    const result = sweep(db, {
      lookupMirrorTxns: mirrorOf([{ id: 't1', category_id: 'cat-new', has_splits: 0, tags: null }]),
      now: NOW,
    });
    assert.equal(result.staled, 1);
    assert.match(getRecord(db, 'r1').error, /categor/i);
  });

  it('leaves clean non-terminal records untouched', () => {
    const db = makeQueueDb();
    seed(db, {
      id: 'r1', status: 'pending', target_txn_id: 't1',
      payload: { target: { categoryId: 'c1' }, diff: {} },
    });
    const result = sweep(db, {
      lookupMirrorTxns: mirrorOf([{ id: 't1', category_id: 'c1', has_splits: 0, tags: 'Apple' }]),
      now: NOW,
    });
    assert.equal(result.staled, 0);
    assert.equal(getRecord(db, 'r1').status, 'pending');
  });

  it('does not staleness-check terminal records', () => {
    const db = makeQueueDb();
    seed(db, { id: 'r1', status: 'applied', target_txn_id: 'gone', updated_at: NOW.toISOString(), applied_at: NOW.toISOString() });
    const result = sweep(db, { lookupMirrorTxns: mirrorOf([]), now: NOW });
    assert.equal(result.staled, 0);
    assert.equal(getRecord(db, 'r1').status, 'applied');
  });

  it('purges per-status retention windows (applied 7d, dismissed 30d, stale 7d, failed 14d)', () => {
    const db = makeQueueDb();
    const old = (days) => new Date(NOW.getTime() - days * 86400e3).toISOString();

    seed(db, { id: 'a-old', status: 'applied', updated_at: old(8), applied_at: old(8) });
    seed(db, { id: 'a-new', status: 'applied', updated_at: old(6), applied_at: old(6) });
    seed(db, { id: 'd-old', status: 'dismissed', updated_at: old(31) });
    seed(db, { id: 'd-new', status: 'dismissed', updated_at: old(29) });
    seed(db, { id: 's-old', status: 'stale', updated_at: old(8) });
    seed(db, { id: 'f-old', status: 'failed', updated_at: old(15) });
    seed(db, { id: 'f-new', status: 'failed', updated_at: old(13) });
    seed(db, { id: 'p-ancient', status: 'pending', updated_at: old(100), target_txn_id: 't1' });

    const result = sweep(db, {
      lookupMirrorTxns: mirrorOf([{ id: 't1', category_id: 'c1', has_splits: 0, tags: null }]),
      now: NOW,
    });

    assert.equal(result.purged, 4, 'a-old, d-old, s-old, f-old purged');
    assert.equal(getRecord(db, 'a-old'), null);
    assert.equal(getRecord(db, 'd-old'), null);
    assert.equal(getRecord(db, 's-old'), null);
    assert.equal(getRecord(db, 'f-old'), null);
    assert.ok(getRecord(db, 'a-new'));
    assert.ok(getRecord(db, 'd-new'));
    assert.ok(getRecord(db, 'f-new'));
    assert.ok(getRecord(db, 'p-ancient'), 'pending records are never purged');
    assert.equal(result.remaining, 4);
  });

  it('enforces the soft cap by purging the oldest terminal records only', () => {
    const db = makeQueueDb();
    assert.equal(SOFT_CAP, 500);
    const recent = NOW.toISOString();
    // 503 recent applied (inside retention) + 2 pending = 505 total
    for (let i = 0; i < 503; i++) {
      seed(db, {
        id: `cap-${String(i).padStart(3, '0')}`,
        status: 'applied',
        target_txn_id: 't-cap',
        created_at: new Date(NOW.getTime() - (503 - i) * 60000).toISOString(),
        updated_at: new Date(NOW.getTime() - (503 - i) * 60000).toISOString(),
        applied_at: recent,
      });
    }
    seed(db, { id: 'pend-1', status: 'pending', target_txn_id: 't1' });
    seed(db, { id: 'pend-2', status: 'pending', target_txn_id: 't1' });

    const result = sweep(db, {
      lookupMirrorTxns: mirrorOf([{ id: 't1', category_id: 'c1', has_splits: 0, tags: null }]),
      now: NOW,
    });

    assert.equal(result.remaining, 500);
    assert.equal(result.purged, 5);
    assert.ok(getRecord(db, 'pend-1'), 'non-terminal records survive the cap');
    assert.ok(getRecord(db, 'pend-2'));
    assert.equal(getRecord(db, 'cap-000'), null, 'oldest terminal records purged first');
    assert.ok(getRecord(db, 'cap-502'));
  });

  it('skips the staleness pass gracefully when the mirror is unavailable', () => {
    const db = makeQueueDb();
    seed(db, { id: 'r1', status: 'pending' });
    const result = sweep(db, {
      lookupMirrorTxns: () => { throw new Error('Database not found at /nowhere. Run refresh first.'); },
      now: NOW,
    });
    assert.equal(result.staled, 0);
    assert.match(result.mirrorNote, /mirror/i);
    assert.equal(getRecord(db, 'r1').status, 'pending');
  });
});
