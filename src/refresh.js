/**
 * Monarch database refresh pipeline.
 * Fetches transactions from Monarch API and imports into local SQLite.
 */

import { fetchTransactions } from './fetch.js';
import { importTransactions } from './import.js';
import { resolveDataDir, resolveDbPath } from './config.js';

/**
 * Refresh the local SQLite database by fetching from Monarch API and importing.
 * @param {string} token - Monarch auth token
 * @param {object} [options]
 * @param {'recent'|'full'} [options.mode='recent'] - Fetch mode
 * @param {string} [options.dataDir] - Override data directory
 * @param {string} [options.since] - Fetch from a specific date (YYYY-MM-DD)
 * @param {number} [options.months] - Fetch last N months
 * @param {function} [options.onBatch] - Progress callback
 * @returns {Promise<{success: boolean, message: string, imported: number, pruned: number}>}
 */
export async function refreshDb(token, options = {}) {
  const { mode = 'recent', dataDir, since, months, onBatch } = options;
  const dir = dataDir ?? resolveDataDir();
  const dbPath = resolveDbPath(dir);

  const data = await fetchTransactions({
    token,
    mode,
    since,
    months,
    onBatch,
  });

  const result = importTransactions(data, dbPath);

  const message = mode === 'full'
    ? `Full database rebuilt with ${result.imported} transactions`
    : `Database updated with ${result.imported} recent transactions`;

  return {
    success: true,
    message,
    imported: result.imported,
    pruned: result.pruned,
  };
}
