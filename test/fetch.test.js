import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

describe('fetchTransactions', () => {
  let fetchTransactions, BATCH_SIZE;
  let originalFetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    const mod = await import('../src/fetch.js');
    fetchTransactions = mod.fetchTransactions;
    BATCH_SIZE = mod.BATCH_SIZE;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetchResponse(totalCount, results) {
    return () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        data: { allTransactions: { totalCount, results } },
      }),
    });
  }

  it('calls API with startDate filter in recent mode', async () => {
    let capturedBody;
    globalThis.fetch = (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          data: { allTransactions: { totalCount: 1, results: [{ id: 'txn-1' }] } },
        }),
      });
    };

    const result = await fetchTransactions({ token: 'test-token', mode: 'recent' });
    assert.ok(capturedBody.variables.filters.startDate, 'should have startDate filter');
    assert.equal(result.transactions.length, 1);
    assert.equal(result.mode, 'partial');
  });

  it('calls API without startDate filter in full mode', async () => {
    let capturedBody;
    globalThis.fetch = (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          data: { allTransactions: { totalCount: 1, results: [{ id: 'txn-1' }] } },
        }),
      });
    };

    const result = await fetchTransactions({ token: 'test-token', mode: 'full' });
    assert.deepEqual(capturedBody.variables.filters, {}, 'should have empty filters');
    assert.equal(result.mode, 'full');
  });

  it('paginates when totalCount exceeds batch size', async () => {
    let callCount = 0;
    globalThis.fetch = () => {
      callCount++;
      const isFirst = callCount === 1;
      const results = isFirst
        ? Array.from({ length: BATCH_SIZE }, (_, i) => ({ id: `txn-${i}` }))
        : [{ id: `txn-${BATCH_SIZE}` }];
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          data: { allTransactions: { totalCount: BATCH_SIZE + 1, results } },
        }),
      });
    };

    const result = await fetchTransactions({ token: 'test-token', mode: 'full' });
    assert.equal(callCount, 2, 'should make 2 API calls');
    assert.equal(result.transactions.length, BATCH_SIZE + 1);
  });

  it('throws on HTTP error', async () => {
    globalThis.fetch = () => Promise.resolve({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });

    await assert.rejects(
      () => fetchTransactions({ token: 'bad-token', mode: 'recent' }),
      /HTTP 401/
    );
  });
});
