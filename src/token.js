/**
 * Monarch auth token loading.
 * Reads from MONARCH_TOKEN env var or token file.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const defaultTokenPath = path.join(os.homedir(), '.monarch-token');

/**
 * Load the Monarch auth token. Priority: env var > file.
 * @param {string} [tokenPath] - Override token file path (defaults to ~/.monarch-token)
 * @returns {string} The auth token
 * @throws {Error} If no token is found
 */
export function loadToken(tokenPath) {
  if (process.env.MONARCH_TOKEN) {
    return process.env.MONARCH_TOKEN;
  }

  const p = tokenPath ?? defaultTokenPath;

  if (!fs.existsSync(p)) {
    throw new Error(
      'No auth token found.\n' +
      '  - Set MONARCH_TOKEN environment variable\n' +
      '  - Or create a token file at ' + p
    );
  }

  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!data.token) {
    throw new Error(`${p} exists but has no token field`);
  }

  return data.token;
}

/**
 * Get token status info as a structured object.
 * @param {string} [tokenPath] - Override token file path
 * @returns {{ source: string, token: string, capturedAt?: string, age?: string, path?: string }}
 */
export function tokenStatus(tokenPath) {
  if (process.env.MONARCH_TOKEN) {
    return {
      source: 'MONARCH_TOKEN environment variable',
      token: process.env.MONARCH_TOKEN.substring(0, 8) + '...',
    };
  }

  const p = tokenPath ?? defaultTokenPath;

  if (!fs.existsSync(p)) {
    return { source: 'none', token: null };
  }

  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const age = Date.now() - new Date(data.capturedAt).getTime();
  const mins = Math.floor(age / 60000);
  const hours = Math.floor(mins / 60);

  return {
    source: data.source || 'unknown',
    token: data.token.substring(0, 8) + '...',
    capturedAt: data.capturedAt,
    age: hours > 0 ? `${hours}h ${mins % 60}m` : `${mins}m`,
    path: p,
  };
}
