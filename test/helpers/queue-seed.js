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

/**
 * A split record in the EXACT shape the extension's
 * `RecommendationEngine.toQueueRecord()` produces (see
 * monarch_chrome_extension/extension/lib/recommendation-engine.js).
 * Notably: `payload.diff` scaffolds `newName`/`newCategoryId`/
 * `newCategoryName`/`addNotes` as null on split records, and each split
 * carries the extension-side metadata fields (categorySource, ruleId,
 * createRule, matchOnPrice).
 */
export function extensionSplitRecord(overrides = {}) {
  return {
    id: 'split_inv-ext-1_txn-1',
    type: 'split',
    source_merchant: 'apple',
    target_txn_id: 'txn-1',
    status: 'pending',
    confidence: null,
    confidence_level: null,
    priority: 100,
    group_key: 'apple_2026-07-01',
    origin: 'extension',
    applied_by: null,
    revision: 1,
    error: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    applied_at: null,
    payload: {
      source: {
        merchant: 'apple',
        invoiceId: 'inv-ext-1',
        invoiceDate: '2026-07-01',
        invoiceTotal: 15.50,
        orderId: 'MABC123',
        items: [
          { id: 'item-1', title: 'Item A', amount: -10.00 },
          { id: 'item-2', title: 'Item B', amount: -5.50 },
        ],
      },
      target: {
        transactionId: 'txn-1',
        amount: -15.50,
        date: '2026-07-02',
        merchantName: 'Apple',
        categoryId: 'cat-old',
        categoryName: 'Shopping',
        hasSplitTransactions: false,
        tags: [],
      },
      diff: {
        splits: [
          {
            merchantName: 'Item A',
            amount: -10.00,
            categoryId: 'c1',
            categoryName: 'Subscriptions',
            notes: 'first',
            categorySource: 'rule',
            ruleId: 'rule-1',
            createRule: true,
            matchOnPrice: false,
          },
          {
            merchantName: 'Item B',
            amount: -5.50,
            categoryId: 'c2',
            categoryName: null,
            notes: null,
            categorySource: null,
            ruleId: null,
            createRule: true,
            matchOnPrice: false,
          },
        ],
        newName: null,
        newCategoryId: null,
        newCategoryName: null,
        addNotes: null,
      },
      reasoning: ['matched invoice MABC123 by amount+date gates (deterministic)'],
      usedAI: false,
    },
    ...overrides,
  };
}

/** Seed an extension-shaped split record (see extensionSplitRecord). */
export function seedExtensionSplitRecord(db, overrides = {}) {
  return seed(db, extensionSplitRecord(overrides));
}

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
