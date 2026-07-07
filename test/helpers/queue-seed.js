/**
 * Test helpers for the recommendation queue: in-memory DB + record seeding.
 */

import { DatabaseSync } from 'node:sqlite';
import { ensureSchema } from '../../src/queue.js';

/** Create a fresh in-memory queue database with the schema applied. */
export function makeQueueDb() {
  const db = new DatabaseSync(':memory:');
  ensureSchema(db);
  return db;
}

let seedCounter = 0;

/** Insert a recommendation record, with sensible defaults, and return it. */
export function seed(db, overrides = {}) {
  seedCounter++;
  const rec = {
    id: `split_inv${seedCounter}_txn-100`,
    type: 'split',
    source_merchant: 'apple',
    target_txn_id: 'txn-100',
    status: 'pending',
    confidence: 0.9,
    confidence_level: 'high',
    priority: 100,
    group_key: 'apple_2026-07-01',
    origin: 'extension',
    applied_by: null,
    revision: 1,
    error: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    applied_at: null,
    payload: { source: { merchant: 'apple' }, target: {}, diff: {}, reasoning: 'test', usedAI: false },
    ...overrides,
  };
  const payloadText = typeof rec.payload === 'string' ? rec.payload : JSON.stringify(rec.payload);
  db.prepare(
    `INSERT INTO recommendations (
       id, type, source_merchant, target_txn_id, status,
       confidence, confidence_level, priority, group_key, origin,
       applied_by, revision, error, created_at, updated_at, applied_at, payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    rec.id, rec.type, rec.source_merchant, rec.target_txn_id, rec.status,
    rec.confidence, rec.confidence_level, rec.priority, rec.group_key, rec.origin,
    rec.applied_by, rec.revision, rec.error, rec.created_at, rec.updated_at, rec.applied_at,
    payloadText
  );
  return rec;
}
