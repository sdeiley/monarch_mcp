/**
 * Local-mirror sync + read-back verification for write tools.
 *
 * After a write tool mutates the live Monarch account, the server re-fetches
 * the affected transaction from the API, verifies the requested changes took
 * effect, and upserts the live state into the local monarch.db mirror so the
 * mirror never goes stale for tool-driven writes.
 *
 * The row mapping here is the single source of truth for how a fetched
 * Monarch transaction becomes a mirror row — import.js (bulk refresh) uses
 * the same UPSERT_TRANSACTION_SQL and transactionToRow so the two paths can
 * never drift.
 */

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolveDbPath } from './config.js';

export const UPSERT_TRANSACTION_SQL = `
  INSERT OR REPLACE INTO transactions (
    id, amount, date, original_date, plaid_name, notes,
    pending, hide_from_reports, needs_review, is_recurring,
    is_split, has_splits, parent_id,
    merchant_id, merchant_name,
    category_id, category_name, category_group, category_type,
    account_id, account_name, tags
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Map a Monarch API transaction object to mirror row values (positional,
 * matching UPSERT_TRANSACTION_SQL).
 * @param {object} t - Transaction in the API shape (fetch.js / getTransaction)
 * @returns {Array} Bind values for UPSERT_TRANSACTION_SQL
 */
export function transactionToRow(t) {
  const tags = t.tags?.length > 0
    ? t.tags.map(tag => tag.name).join(',')
    : null;

  return [
    t.id,
    t.amount,
    t.date,
    t.originalDate || null,
    t.plaidName || null,
    t.notes || null,
    t.pending ? 1 : 0,
    t.hideFromReports ? 1 : 0,
    t.needsReview ? 1 : 0,
    t.isRecurring ? 1 : 0,
    t.isSplitTransaction ? 1 : 0,
    t.hasSplitTransactions ? 1 : 0,
    t.originalTransaction?.id || null,
    t.merchant?.id || null,
    t.merchant?.name || null,
    t.category?.id || null,
    t.category?.name || null,
    t.category?.group?.name || null,
    t.category?.group?.type || null,
    t.account?.id || null,
    t.account?.displayName || null,
    tags,
  ];
}

/**
 * Lift a nested splitTransactions entry into a full transaction shape.
 * The nested entries carry only their own fields (amount, notes, merchant,
 * category, tags); date, account, and statement fields are inherited from
 * the parent, matching how Monarch's list API reports split children.
 */
function splitChildToTransaction(split, parent) {
  return {
    id: split.id,
    amount: split.amount,
    date: parent.date,
    originalDate: parent.originalDate,
    plaidName: parent.plaidName,
    notes: split.notes,
    pending: parent.pending,
    hideFromReports: split.hideFromReports ?? parent.hideFromReports,
    needsReview: split.needsReview ?? false,
    isRecurring: parent.isRecurring,
    isSplitTransaction: true,
    hasSplitTransactions: false,
    originalTransaction: { id: parent.id },
    merchant: split.merchant,
    category: split.category,
    account: parent.account,
    tags: split.tags,
  };
}

/**
 * Upsert a live transaction (and its split children) into the local mirror.
 * Split children no longer present on the live transaction are pruned so a
 * re-split or un-split never leaves orphan child rows.
 *
 * Never throws: a missing or unwritable mirror is reported as
 * `{ synced: false, reason }` because the remote write already succeeded and
 * the caller must not surface it as a failure.
 *
 * @param {object} live - Transaction from api.getTransaction()
 * @param {string} [dbPath] - Override mirror path (defaults to resolveDbPath())
 * @returns {{synced: boolean, upserted?: number, prunedSplits?: number, reason?: string}}
 */
export function syncTransactionToMirror(live, dbPath) {
  const p = dbPath ?? resolveDbPath();
  if (!fs.existsSync(p)) {
    return {
      synced: false,
      reason: `local mirror not found at ${p} — run refresh_transactions to create it`,
    };
  }

  let db;
  try {
    db = new DatabaseSync(p);
  } catch (err) {
    return { synced: false, reason: `could not open local mirror (${err.message})` };
  }

  try {
    const upsert = db.prepare(UPSERT_TRANSACTION_SQL);
    const splits = live.splitTransactions ?? [];

    db.exec('BEGIN');
    try {
      upsert.run(...transactionToRow(live));
      for (const split of splits) {
        upsert.run(...transactionToRow(splitChildToTransaction(split, live)));
      }
      let prunedSplits;
      if (splits.length > 0) {
        const placeholders = splits.map(() => '?').join(', ');
        prunedSplits = db.prepare(
          `DELETE FROM transactions WHERE parent_id = ? AND id NOT IN (${placeholders})`
        ).run(live.id, ...splits.map(s => s.id)).changes;
      } else {
        prunedSplits = db.prepare(
          'DELETE FROM transactions WHERE parent_id = ?'
        ).run(live.id).changes;
      }
      db.exec('COMMIT');
      return { synced: true, upserted: 1 + splits.length, prunedSplits };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } catch (err) {
    return {
      synced: false,
      reason: `mirror update failed (${err.message}) — run refresh_transactions`,
    };
  } finally {
    db.close();
  }
}

// ─── Read-back verification ──────────────────────────────────────────────

/** Notes come back as null when cleared; treat '' and null as equal. */
const normalizeText = (v) => (v == null || v === '' ? null : v);

/**
 * Compare an UpdateTransactionMutationInput against the read-back live
 * transaction. Only fields present in the input are checked.
 * @param {object} input - The mutation input that was sent
 * @param {object} live - Transaction from api.getTransaction()
 * @returns {Array<{field: string, expected: *, actual: *}>} Mismatches
 */
export function verifyTransactionUpdate(input, live) {
  const checks = [];
  if ('category' in input) {
    checks.push(['categoryId', input.category, live.category?.id ?? null]);
  }
  if ('name' in input) {
    checks.push(['merchantName', input.name, live.merchant?.name ?? null]);
  }
  if ('notes' in input) {
    checks.push(['notes', normalizeText(input.notes), normalizeText(live.notes)]);
  }
  if ('date' in input) {
    checks.push(['date', input.date, live.date]);
  }
  if ('hideFromReports' in input) {
    checks.push(['hideFromReports', Boolean(input.hideFromReports), Boolean(live.hideFromReports)]);
  }
  if ('needsReview' in input) {
    checks.push(['needsReview', Boolean(input.needsReview), Boolean(live.needsReview)]);
  }
  return checks
    .filter(([, expected, actual]) => expected !== actual)
    .map(([field, expected, actual]) => ({ field, expected, actual }));
}

/**
 * Compare a requested replacement tag set against the read-back tags
 * (order-insensitive).
 * @param {string[]} tagIds
 * @param {object} live
 * @returns {Array<{field: string, expected: string[], actual: string[]}>}
 */
export function verifyTransactionTags(tagIds, live) {
  const expected = [...new Set(tagIds)].sort();
  const actual = [...new Set((live.tags ?? []).map(t => t.id))].sort();
  if (expected.length === actual.length && expected.every((id, i) => id === actual[i])) {
    return [];
  }
  return [{ field: 'tags', expected, actual }];
}

const splitKey = (amount, categoryId, merchantName) =>
  `${Math.round(amount * 100)}|${categoryId ?? ''}|${merchantName ?? ''}`;

/**
 * Compare a requested split set against the read-back splitTransactions as
 * a multiset of (amount, categoryId, merchantName) — split IDs are assigned
 * server-side and order is not guaranteed.
 * @param {Array<{amount: number, categoryId: string, merchantName: string}>} splits
 * @param {object} live
 * @returns {Array<{field: string, expected: *, actual: *}>}
 */
export function verifyTransactionSplits(splits, live) {
  const liveSplits = live.splitTransactions ?? [];

  if (splits.length === 0) {
    if (liveSplits.length === 0 && !live.hasSplitTransactions) return [];
    return [{
      field: 'splits',
      expected: 'no splits',
      actual: `${liveSplits.length} split(s) still present`,
    }];
  }

  const expected = splits
    .map(s => splitKey(s.amount, s.categoryId, s.merchantName))
    .sort();
  const actual = liveSplits
    .map(s => splitKey(s.amount, s.category?.id, s.merchant?.name))
    .sort();
  if (expected.length === actual.length && expected.every((k, i) => k === actual[i])) {
    return [];
  }
  return [{
    field: 'splits',
    expected: splits.map(s => ({
      amount: s.amount, categoryId: s.categoryId, merchantName: s.merchantName,
    })),
    actual: liveSplits.map(s => ({
      amount: s.amount, categoryId: s.category?.id ?? null, merchantName: s.merchant?.name ?? null,
    })),
  }];
}
