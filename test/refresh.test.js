import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DATA_DIR = path.join(__dirname, 'fixtures', 'refresh-test');

describe('refreshDb', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('calls fetchTransactions then importTransactions and returns success', async () => {
    // We test the full pipeline by mocking fetch at the network level
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        data: {
          allTransactions: {
            totalCount: 1,
            results: [{
              id: 'txn-refresh-1', amount: -10, date: '2026-01-15',
              originalDate: null, plaidName: 'TEST', notes: null,
              pending: false, hideFromReports: false, needsReview: false,
              isRecurring: false, isSplitTransaction: false, hasSplitTransactions: false,
              originalTransaction: null,
              merchant: { id: 'm1', name: 'Test' },
              category: { id: 'c1', name: 'Shopping', group: { id: 'g1', name: 'Shopping', type: 'expense' } },
              account: { id: 'a1', displayName: 'Checking' },
              tags: [],
            }],
          },
        },
      }),
    });

    try {
      const { refreshDb } = await import('../src/refresh.js');
      const result = await refreshDb('test-token', { dataDir: TEST_DATA_DIR, mode: 'recent' });
      assert.equal(result.success, true);
      assert.ok(result.message);
      assert.ok(fs.existsSync(path.join(TEST_DATA_DIR, 'monarch.db')));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns structured result with imported count', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        data: {
          allTransactions: {
            totalCount: 2,
            results: [
              {
                id: 'txn-1', amount: -10, date: '2026-01-15',
                originalDate: null, plaidName: 'A', notes: null,
                pending: false, hideFromReports: false, needsReview: false,
                isRecurring: false, isSplitTransaction: false, hasSplitTransactions: false,
                originalTransaction: null,
                merchant: { id: 'm1', name: 'A' },
                category: { id: 'c1', name: 'X', group: { id: 'g1', name: 'X', type: 'expense' } },
                account: { id: 'a1', displayName: 'Chk' },
                tags: [],
              },
              {
                id: 'txn-2', amount: -20, date: '2026-01-16',
                originalDate: null, plaidName: 'B', notes: null,
                pending: false, hideFromReports: false, needsReview: false,
                isRecurring: false, isSplitTransaction: false, hasSplitTransactions: false,
                originalTransaction: null,
                merchant: { id: 'm2', name: 'B' },
                category: { id: 'c2', name: 'Y', group: { id: 'g1', name: 'Y', type: 'expense' } },
                account: { id: 'a1', displayName: 'Chk' },
                tags: [],
              },
            ],
          },
        },
      }),
    });

    try {
      const { refreshDb } = await import('../src/refresh.js');
      const result = await refreshDb('test-token', { dataDir: TEST_DATA_DIR, mode: 'full' });
      assert.equal(result.imported, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('passes mode through correctly', async () => {
    let capturedBody;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          data: { allTransactions: { totalCount: 0, results: [] } },
        }),
      });
    };

    try {
      const { refreshDb } = await import('../src/refresh.js');
      await refreshDb('test-token', { dataDir: TEST_DATA_DIR, mode: 'full' });
      assert.deepEqual(capturedBody.variables.filters, {});
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
