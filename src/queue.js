/**
 * Recommendation queue store (Track B3).
 *
 * `queue.db` is the system of record for extension-generated recommendations
 * (splits, renames, categorizations, ...). The extension writes records
 * through its native-messaging bridge; this module gives the MCP server
 * read/act access to the same database.
 *
 * The DDL and the canTransition() rules are copied verbatim from the
 * authoritative design doc (monarch_chrome_extension/docs/queue-design.md)
 * and must stay byte-compatible with the sibling implementation in
 * `extension/lib/recommendation-engine.js` / `native-host/lib/queue-store.js`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveQueueDbPath } from './config.js';
import { queryDb } from './db.js';
import * as api from './api.js';

export const SCHEMA_VERSION = 1;
export const EXT_PROCESSED_TAG = 'Ext Processed';

export const QUEUE_STATUSES = [
  'pending', 'approved', 'saved-for-agent',
  'applied', 'dismissed', 'stale', 'failed',
];

/** Retention windows (days) per terminal-ish status, per queue-design.md. */
export const RETENTION_DAYS = { applied: 7, dismissed: 30, stale: 7, failed: 14 };

/** Soft cap on total records; oldest terminal records purged beyond it. */
export const SOFT_CAP = 500;

const TERMINAL_STATUSES = ['applied', 'dismissed', 'stale', 'failed'];
const ACTIVE_STATUSES = ['pending', 'approved', 'saved-for-agent'];

// DDL copied VERBATIM from docs/queue-design.md — do not reformat.
const DDL = `CREATE TABLE IF NOT EXISTS recommendations (
  id            TEXT PRIMARY KEY,   -- stable: "{type}_{invoiceId}_{txnId}"
  type          TEXT NOT NULL,      -- 'split'|'update'|'rename'|'categorize'|'return-reconcile'|'tag'|'rule-suggest'
  source_merchant TEXT NOT NULL,    -- 'apple'|'venmo'|...
  target_txn_id TEXT NOT NULL,      -- Monarch UUID
  status        TEXT NOT NULL,      -- lifecycle below
  confidence    REAL, confidence_level TEXT,
  priority      INTEGER DEFAULT 100,
  group_key     TEXT,               -- e.g. "apple_2026-02-07"
  origin        TEXT NOT NULL,      -- 'extension'|'agent' (creator)
  applied_by    TEXT,               -- 'extension'|'agent'|'external'
  revision      INTEGER NOT NULL DEFAULT 1,  -- optimistic concurrency
  error         TEXT,               -- last failure message
  created_at TEXT, updated_at TEXT, applied_at TEXT,
  payload       TEXT NOT NULL       -- JSON: { source, target, diff, reasoning, usedAI } per ux-architecture.md
);
CREATE INDEX idx_rec_status ON recommendations(status);
CREATE INDEX idx_rec_target ON recommendations(target_txn_id);
CREATE TABLE IF NOT EXISTS queue_meta (key TEXT PRIMARY KEY, value TEXT);  -- schema_version=1, stats counters`;

// ─── Schema / open ───────────────────────────────────────────────────────

/**
 * Ensure the queue schema exists and is a supported version.
 * Sets WAL journaling and a busy_timeout for cross-process write contention.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function ensureSchema(db) {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');

  const hasTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recommendations'"
  ).get();

  if (!hasTable) {
    // Fresh database: run the verbatim DDL and stamp the schema version.
    db.exec(DDL);
    db.prepare(
      "INSERT OR REPLACE INTO queue_meta (key, value) VALUES ('schema_version', ?)"
    ).run(String(SCHEMA_VERSION));
    return;
  }

  const row = db.prepare(
    "SELECT value FROM queue_meta WHERE key = 'schema_version'"
  ).get();
  const version = row ? Number(row.value) : NaN;
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported queue schema version ${row ? row.value : '(missing)'} — this build expects ${SCHEMA_VERSION}`
    );
  }
}

/**
 * Open (creating lazily if absent) the queue database at the given path.
 * @param {string} [dbPath] - Defaults to `<dataDir>/queue.db`
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openQueueDb(dbPath) {
  const p = dbPath ?? resolveQueueDbPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  ensureSchema(db);
  return db;
}

// ─── Status lifecycle ────────────────────────────────────────────────────

// to → { from → [actors allowed] }, per the lifecycle in queue-design.md.
const TRANSITIONS = {
  approved: { pending: ['extension'] },
  'saved-for-agent': { pending: ['extension'] },
  applied: {
    approved: ['extension'],
    pending: ['agent'],
    'saved-for-agent': ['agent'],
  },
  dismissed: {
    pending: ['extension', 'agent'],
    approved: ['extension', 'agent'],
    'saved-for-agent': ['extension', 'agent'],
  },
  stale: {
    pending: ['sweep'],
    approved: ['sweep'],
    'saved-for-agent': ['sweep'],
  },
  failed: {
    pending: ['agent'],
    approved: ['extension'],
    'saved-for-agent': ['agent'],
  },
  pending: { failed: ['extension', 'agent'] },
};

/**
 * Pure lifecycle guard: may `actor` move a record from `from` to `to`?
 * Implemented identically in extension/lib/recommendation-engine.js.
 * @param {string} from
 * @param {string} to
 * @param {'extension'|'agent'|'sweep'} actor
 * @returns {boolean}
 */
export function canTransition(from, to, actor) {
  const actors = TRANSITIONS[to]?.[from];
  return Boolean(actors && actors.includes(actor));
}

// ─── Record access ───────────────────────────────────────────────────────

function parseRow(row) {
  if (!row) return null;
  const rec = { ...row };
  try {
    rec.payload = JSON.parse(row.payload);
  } catch {
    // Leave the raw string if the producer wrote malformed JSON.
  }
  return rec;
}

/**
 * Fetch a single recommendation by id (payload parsed).
 * @returns {object|null}
 */
export function getRecord(db, id) {
  const row = db.prepare('SELECT * FROM recommendations WHERE id = ?').get(id);
  return parseRow(row);
}

function countsByStatus(db) {
  const rows = db.prepare(
    'SELECT status, COUNT(*) AS n FROM recommendations GROUP BY status'
  ).all();
  return Object.fromEntries(rows.map(r => [r.status, r.n]));
}

/**
 * List recommendations with optional filters.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{status?: string, type?: string, merchant?: string,
 *          minConfidence?: number, limit?: number}} filters
 * @returns {{items: object[], counts: object}}
 */
export function listRecords(db, { status, type, merchant, minConfidence, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (status !== undefined) { where.push('status = ?'); params.push(status); }
  if (type !== undefined) { where.push('type = ?'); params.push(type); }
  if (merchant !== undefined) { where.push('source_merchant = ?'); params.push(merchant); }
  if (minConfidence !== undefined) { where.push('confidence >= ?'); params.push(minConfidence); }

  const sql =
    'SELECT * FROM recommendations' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY priority ASC, created_at DESC LIMIT ?';
  params.push(limit);

  const items = db.prepare(sql).all(...params).map(parseRow);
  return { items, counts: countsByStatus(db) };
}

/**
 * Aggregate queue stats for the monarch://queue/stats resource.
 * @returns {{total: number, counts: {byStatus, byType, byMerchant}, lastGeneratedAt: string|null}}
 */
export function getStatsData(db) {
  const group = (col) => Object.fromEntries(
    db.prepare(`SELECT ${col} AS k, COUNT(*) AS n FROM recommendations GROUP BY ${col}`)
      .all().map(r => [r.k, r.n])
  );
  const total = db.prepare('SELECT COUNT(*) AS n FROM recommendations').get().n;
  const last = db.prepare('SELECT MAX(created_at) AS t FROM recommendations').get().t;
  return {
    total,
    counts: {
      byStatus: group('status'),
      byType: group('type'),
      byMerchant: group('source_merchant'),
    },
    lastGeneratedAt: last ?? null,
  };
}

// ─── Guarded status transitions ──────────────────────────────────────────

/**
 * Transition a record's status with the lifecycle guard applied atomically:
 * `UPDATE ... SET status=?, revision=revision+1 WHERE id=? AND status IN
 * (<allowed-from>)` — a concurrent terminal transition can never be
 * resurrected because the WHERE clause no longer matches.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} id
 * @param {string} to - Target status
 * @param {'extension'|'agent'|'sweep'} actor
 * @param {{error?: string, appliedBy?: string, now?: Date}} [opts]
 * @returns {object} The updated record
 * @throws on unknown id or invalid transition
 */
export function updateStatus(db, id, to, actor, { error, appliedBy, now } = {}) {
  const allowedFrom = QUEUE_STATUSES.filter(s => canTransition(s, to, actor));
  const current = getRecord(db, id);
  if (!current) {
    throw new Error(`Recommendation '${id}' not found in the queue`);
  }
  if (allowedFrom.length === 0) {
    throw new Error(`Invalid transition: actor '${actor}' may never set status '${to}'`);
  }

  const nowIso = (now ?? new Date()).toISOString();
  const sets = ['status = ?', 'revision = revision + 1', 'updated_at = ?'];
  const params = [to, nowIso];
  if (error !== undefined) { sets.push('error = ?'); params.push(error); }
  if (to === 'applied') {
    sets.push('applied_at = ?', 'applied_by = ?');
    params.push(nowIso, appliedBy ?? actor);
  }

  const placeholders = allowedFrom.map(() => '?').join(', ');
  const result = db.prepare(
    `UPDATE recommendations SET ${sets.join(', ')}
     WHERE id = ? AND status IN (${placeholders})`
  ).run(...params, id, ...allowedFrom);

  if (result.changes === 0) {
    const after = getRecord(db, id);
    throw new Error(
      `Invalid transition: '${after?.status ?? current.status}' → '${to}' by '${actor}' ` +
      `(allowed from: ${allowedFrom.join(', ')})`
    );
  }
  return getRecord(db, id);
}

// ─── Sweep (staleness + retention) ───────────────────────────────────────

function staleReason(rec, mirrorTxn) {
  if (!mirrorTxn) return 'target transaction missing from mirror';
  const tags = String(mirrorTxn.tags ?? '').split(',').map(s => s.trim());
  if (tags.includes(EXT_PROCESSED_TAG)) return 'already processed externally';
  if (mirrorTxn.has_splits) return 'already split externally';
  const capturedCategory = rec.payload?.target?.categoryId ?? rec.payload?.target?.category_id;
  if (capturedCategory && mirrorTxn.category_id && capturedCategory !== mirrorTxn.category_id) {
    return 'category changed externally';
  }
  return null;
}

/**
 * Sweep the queue: mark active records stale against the monarch.db mirror,
 * then purge per-status retention windows and enforce the soft cap.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{lookupMirrorTxns: (ids: string[]) => Map<string, object>, now?: Date}} deps
 *   lookupMirrorTxns returns a Map of txn id → { id, category_id, has_splits, tags }.
 * @returns {{staled: number, purged: number, remaining: number, mirrorNote?: string}}
 */
export function sweep(db, { lookupMirrorTxns, now } = {}) {
  const nowDate = now ?? new Date();
  let staled = 0;
  let mirrorNote;

  // Staleness pass over non-terminal records.
  const activePlaceholders = ACTIVE_STATUSES.map(() => '?').join(', ');
  const active = db.prepare(
    `SELECT * FROM recommendations WHERE status IN (${activePlaceholders})`
  ).all(...ACTIVE_STATUSES).map(parseRow);

  if (active.length > 0) {
    let mirror = null;
    try {
      mirror = lookupMirrorTxns(active.map(r => r.target_txn_id));
    } catch (err) {
      mirrorNote = `mirror unavailable — staleness check skipped (${err.message})`;
    }
    if (mirror) {
      for (const rec of active) {
        const reason = staleReason(rec, mirror.get(rec.target_txn_id));
        if (!reason) continue;
        try {
          updateStatus(db, rec.id, 'stale', 'sweep', { error: reason, now: nowDate });
          staled++;
        } catch {
          // Lost a race with another writer — the guard did its job.
        }
      }
    }
  }

  // Retention purge per status.
  let purged = 0;
  for (const [status, days] of Object.entries(RETENTION_DAYS)) {
    const cutoff = new Date(nowDate.getTime() - days * 86400e3).toISOString();
    purged += db.prepare(
      `DELETE FROM recommendations
       WHERE status = ? AND COALESCE(applied_at, updated_at, created_at) < ?`
    ).run(status, cutoff).changes;
  }

  // Soft cap: purge oldest terminal records beyond SOFT_CAP.
  const total = db.prepare('SELECT COUNT(*) AS n FROM recommendations').get().n;
  if (total > SOFT_CAP) {
    const terminalPlaceholders = TERMINAL_STATUSES.map(() => '?').join(', ');
    purged += db.prepare(
      `DELETE FROM recommendations WHERE id IN (
         SELECT id FROM recommendations WHERE status IN (${terminalPlaceholders})
         ORDER BY COALESCE(updated_at, created_at) ASC LIMIT ?
       )`
    ).run(...TERMINAL_STATUSES, total - SOFT_CAP).changes;
  }

  const remaining = db.prepare('SELECT COUNT(*) AS n FROM recommendations').get().n;
  const result = { staled, purged, remaining };
  if (mirrorNote) result.mirrorNote = mirrorNote;
  return result;
}

// ─── Apply (agent path) ──────────────────────────────────────────────────

function summarizePreflight(live) {
  if (!live) return { transactionFound: false };
  return {
    transactionFound: true,
    amount: live.amount,
    date: live.date,
    notes: live.notes ?? null,
    hasSplitTransactions: Boolean(live.hasSplitTransactions),
    tags: (live.tags ?? []).map(t => t.name),
    extProcessed: (live.tags ?? []).some(t => t.name === EXT_PROCESSED_TAG),
  };
}

/**
 * Resolve category names → ids against the monarch.db mirror's categories
 * (exact case-insensitive name match). AI/static-categorized diffs arrive
 * from the extension with categoryId: null and only a categoryName — the
 * id resolution that used to happen in the sidebar DOM now happens here,
 * at apply time.
 *
 * @param {object} diff - payload.diff
 * @returns {{diff: object, unresolved: string[], note?: string}}
 *   A resolved copy of the diff plus any names with no mirror match.
 */
function resolveDiffCategories(diff) {
  const needsResolution = [];
  if (Array.isArray(diff.splits)) {
    for (const s of diff.splits) {
      if (s.categoryId == null && s.categoryName != null) needsResolution.push(s.categoryName);
    }
  }
  if (diff.newCategoryId == null && diff.newCategoryName != null) {
    needsResolution.push(diff.newCategoryName);
  }
  if (needsResolution.length === 0) return { diff, unresolved: [] };

  let byName;
  try {
    const rows = queryDb(
      `SELECT DISTINCT category_id, category_name FROM transactions
       WHERE category_id IS NOT NULL AND category_name IS NOT NULL`
    );
    byName = new Map(rows.map(r => [String(r.category_name).trim().toLowerCase(), r.category_id]));
  } catch (err) {
    return {
      diff,
      unresolved: [...new Set(needsResolution)],
      note: `mirror category lookup unavailable (${err.message})`,
    };
  }

  const unresolved = new Set();
  const lookup = (name) => {
    const id = byName.get(String(name).trim().toLowerCase());
    if (id == null) unresolved.add(name);
    return id ?? null;
  };

  const resolved = { ...diff };
  if (Array.isArray(diff.splits)) {
    resolved.splits = diff.splits.map(s => (
      s.categoryId == null && s.categoryName != null
        ? { ...s, categoryId: lookup(s.categoryName) }
        : s
    ));
  }
  if (diff.newCategoryId == null && diff.newCategoryName != null) {
    resolved.newCategoryId = lookup(diff.newCategoryName);
  }
  return { diff: resolved, unresolved: [...unresolved] };
}

/** Build the ordered mutation plan from a record's payload.diff. */
function buildMutationPlan(record, live) {
  const diff = record.payload?.diff ?? {};
  const txnId = record.target_txn_id;
  const plan = [];

  if (Array.isArray(diff.splits) && diff.splits.length > 0) {
    const splitData = diff.splits.map(s => {
      const item = {
        amount: s.amount,
        categoryId: s.categoryId,
        merchantName: s.merchantName,
      };
      if (s.notes !== undefined) item.notes = s.notes;
      return item;
    });
    plan.push({ op: 'split_transaction', input: { transactionId: txnId, splitData } });
  }

  // != null (not !== undefined): the extension's toQueueRecord scaffolds
  // newName/newCategoryId as null on split records — null carries no intent
  // and must never become updateTransaction({ name: null, category: null }).
  const update = {};
  if (diff.newName != null) update.name = diff.newName;
  if (diff.newCategoryId != null) update.category = diff.newCategoryId;
  if (diff.addNotes) {
    update.notes = live.notes ? `${live.notes}\n${diff.addNotes}` : diff.addNotes;
  }
  if (Object.keys(update).length > 0) {
    plan.push({ op: 'update_transaction', input: { id: txnId, ...update } });
  }

  plan.push({
    op: 'set_transaction_tags',
    input: { transactionId: txnId, ensureTag: EXT_PROCESSED_TAG },
  });
  return plan;
}

/** Find-or-create the "Ext Processed" tag, then set it on the transaction. */
async function ensureExtProcessedTag(token, transactionId, liveTags) {
  const tags = await api.getTags(token);
  let tag = tags.find(t => t.name === EXT_PROCESSED_TAG);
  if (!tag) {
    tag = await api.createTag(token, EXT_PROCESSED_TAG);
  }
  if (!tag?.id) {
    throw new Error(`Could not resolve an id for the "${EXT_PROCESSED_TAG}" tag`);
  }
  const tagIds = [...new Set([...(liveTags ?? []).map(t => t.id), tag.id])];
  await api.setTransactionTags(token, transactionId, tagIds);
}

/**
 * Apply a queued recommendation against the live Monarch account.
 *
 * Preflight per queue-design.md: re-fetch the target; if it carries the
 * "Ext Processed" tag or already has splits, refuse and mark the record
 * stale. On success the tag is set and the record is marked applied
 * (applied_by='agent'); on mutation error the record is marked failed.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} token - Monarch auth token (never logged)
 * @param {{id: string, dryRun?: boolean, now?: Date}} args
 * @returns {Promise<{ok: boolean, dryRun?: boolean, refused?: string,
 *   error?: string, preflight: object, mutations: object[], record: object}>}
 * @throws on unknown id or a status the agent may not apply from
 */
export async function applyRecord(db, token, { id, dryRun = false, now } = {}) {
  let record = getRecord(db, id);
  if (!record) {
    throw new Error(`Recommendation '${id}' not found in the queue`);
  }
  if (!canTransition(record.status, 'applied', 'agent')) {
    throw new Error(
      `Cannot apply recommendation '${id}' from status '${record.status}' — ` +
      "the agent may only apply 'pending' or 'saved-for-agent' records" +
      (record.status === 'failed'
        ? " (retry by first setting it back to 'pending' via queue_update_status)"
        : '')
    );
  }

  // Preflight: Monarch itself is the source of truth.
  const live = await api.getTransaction(token, record.target_txn_id);
  const preflight = summarizePreflight(live);

  if (!live) {
    const refused = 'target transaction not found in Monarch';
    if (!dryRun) {
      record = updateStatus(db, id, 'stale', 'sweep', { error: refused, now });
    }
    return { ok: false, refused, preflight, mutations: [], record };
  }

  if (preflight.extProcessed || preflight.hasSplitTransactions) {
    const refused = 'already processed externally';
    if (!dryRun) {
      record = updateStatus(db, id, 'stale', 'sweep', { error: refused, now });
    }
    return { ok: false, refused, preflight, mutations: [], record };
  }

  // Resolve categoryName-only entries against the mirror before planning.
  // An unresolvable name is a structured failure (retryable after fixing
  // the record or refreshing the mirror), never a silent null category.
  const { diff, unresolved, note } = resolveDiffCategories(record.payload?.diff ?? {});
  if (unresolved.length > 0) {
    const error =
      `cannot resolve category name(s) ${unresolved.map(n => `'${n}'`).join(', ')} ` +
      'against the local monarch.db mirror' + (note ? ` — ${note}` : '');
    if (!dryRun) {
      record = updateStatus(db, id, 'failed', 'agent', { error, now });
    }
    return { ok: false, error, preflight, mutations: [], record };
  }

  const mutations = buildMutationPlan(
    { ...record, payload: { ...record.payload, diff } },
    live
  );
  if (mutations.length === 1) {
    // Only the tag mutation — the diff carries no applicable change.
    throw new Error(
      `Recommendation '${id}' has no applicable changes in payload.diff ` +
      '(expected splits or newName/newCategoryId/addNotes)'
    );
  }

  // Validate split sums against the live amount before mutating.
  const splitMutation = mutations.find(m => m.op === 'split_transaction');
  if (splitMutation) {
    const sumCents = Math.round(
      splitMutation.input.splitData.reduce((t, s) => t + Math.round(s.amount * 100), 0)
    );
    const liveCents = Math.round(live.amount * 100);
    if (sumCents !== liveCents) {
      const error =
        `split amounts sum to ${(sumCents / 100).toFixed(2)} but the live transaction ` +
        `amount is ${(liveCents / 100).toFixed(2)}`;
      if (!dryRun) {
        record = updateStatus(db, id, 'failed', 'agent', { error, now });
      }
      return { ok: false, error, preflight, mutations, record };
    }
  }

  if (dryRun) {
    return { ok: true, dryRun: true, preflight, mutations, record };
  }

  try {
    for (const mutation of mutations) {
      if (mutation.op === 'split_transaction') {
        await api.splitTransaction(token, mutation.input.transactionId, mutation.input.splitData);
      } else if (mutation.op === 'update_transaction') {
        await api.updateTransaction(token, mutation.input);
      } else if (mutation.op === 'set_transaction_tags') {
        await ensureExtProcessedTag(token, record.target_txn_id, live.tags);
      }
    }
  } catch (err) {
    record = updateStatus(db, id, 'failed', 'agent', { error: err.message, now });
    return { ok: false, error: err.message, preflight, mutations, record };
  }

  record = updateStatus(db, id, 'applied', 'agent', { appliedBy: 'agent', now });
  return { ok: true, preflight, mutations, record };
}
