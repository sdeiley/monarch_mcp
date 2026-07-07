/**
 * Configuration module.
 * Resolves data directory and database path from environment or defaults.
 */

import os from 'node:os';
import path from 'node:path';

export const defaultDataDir = path.join(os.homedir(), '.monarch');

/**
 * Resolve the data directory path.
 * Priority: MONARCH_DATA_DIR env var > ~/.monarch
 * @returns {string}
 */
export function resolveDataDir() {
  return process.env.MONARCH_DATA_DIR || defaultDataDir;
}

/**
 * Resolve the full path to the SQLite database.
 * @param {string} [dataDir] - Override data directory (defaults to resolveDataDir())
 * @returns {string}
 */
export function resolveDbPath(dataDir) {
  return path.join(dataDir ?? resolveDataDir(), 'monarch.db');
}

/**
 * Resolve the full path to the recommendation queue database.
 * @param {string} [dataDir] - Override data directory (defaults to resolveDataDir())
 * @returns {string}
 */
export function resolveQueueDbPath(dataDir) {
  return path.join(dataDir ?? resolveDataDir(), 'queue.db');
}
