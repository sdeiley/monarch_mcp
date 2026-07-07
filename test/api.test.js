import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const FAKE_TOKEN = 'fake-test-token';

describe('Monarch API write client', () => {
  let api;
  let originalFetch;
  let calls;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    calls = [];
    api = await import('../src/api.js');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Install a mock fetch that records calls and replies with the queued
   * GraphQL data payloads (one per call, in order).
   */
  function mockFetch(...dataPayloads) {
    let i = 0;
    globalThis.fetch = (url, opts) => {
      calls.push({ url, opts, body: JSON.parse(opts.body) });
      const data = dataPayloads[Math.min(i, dataPayloads.length - 1)];
      i++;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data }),
      });
    };
  }

  function lastCall() {
    return calls[calls.length - 1];
  }

  describe('request plumbing', () => {
    it('sends auth token, content type, and client platform headers', async () => {
      mockFetch({
        updateTransaction: { transaction: { id: 't1' }, errors: null },
      });

      await api.updateTransaction(FAKE_TOKEN, { id: 't1', notes: 'x' });

      const { url, opts } = lastCall();
      assert.equal(url, api.API_URL);
      assert.equal(opts.method, 'POST');
      assert.equal(opts.headers['Authorization'], `Token ${FAKE_TOKEN}`);
      assert.equal(opts.headers['Content-Type'], 'application/json');
      assert.equal(opts.headers['Client-Platform'], 'web');
    });

    it('throws on HTTP error without echoing the token', async () => {
      globalThis.fetch = () => Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      });

      await assert.rejects(
        () => api.updateTransaction(FAKE_TOKEN, { id: 't1', notes: 'x' }),
        (err) => {
          assert.match(err.message, /HTTP 401/);
          assert.ok(!err.message.includes(FAKE_TOKEN), 'must not echo token');
          return true;
        }
      );
    });

    it('throws on top-level GraphQL errors array', async () => {
      globalThis.fetch = () => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          errors: [{ message: 'Variable $input got invalid value' }],
        }),
      });

      await assert.rejects(
        () => api.updateTransaction(FAKE_TOKEN, { id: 't1', notes: 'x' }),
        /Variable \$input got invalid value/
      );
    });
  });

  describe('updateTransaction', () => {
    it('sends the Web_TransactionDrawerUpdateTransaction operation with input variables', async () => {
      mockFetch({
        updateTransaction: {
          transaction: { id: 't1', notes: 'hello', category: { id: 'c1', name: 'Software' } },
          errors: null,
        },
      });

      const input = { id: 't1', category: 'c1', name: 'New Name', notes: 'hello' };
      const txn = await api.updateTransaction(FAKE_TOKEN, input);

      const { body } = lastCall();
      assert.match(body.query, /mutation Web_TransactionDrawerUpdateTransaction\(\$input: UpdateTransactionMutationInput!\)/);
      assert.match(body.query, /updateTransaction\(input: \$input\)/);
      assert.deepEqual(body.variables, { input });
      assert.equal(txn.id, 't1');
      assert.equal(txn.notes, 'hello');
    });

    it('throws when the payload contains API-level errors', async () => {
      mockFetch({
        updateTransaction: {
          transaction: null,
          errors: [{ message: 'Category not found', code: 'not_found', fieldErrors: null }],
        },
      });

      await assert.rejects(
        () => api.updateTransaction(FAKE_TOKEN, { id: 't1', category: 'bogus' }),
        /updateTransaction failed: Category not found/
      );
    });

    it('surfaces fieldErrors when no message is present', async () => {
      mockFetch({
        updateTransaction: {
          transaction: null,
          errors: [{ message: null, code: null, fieldErrors: [{ field: 'category', messages: ['Invalid ID'] }] }],
        },
      });

      await assert.rejects(
        () => api.updateTransaction(FAKE_TOKEN, { id: 't1', category: 'bogus' }),
        /category/
      );
    });
  });

  describe('splitTransaction', () => {
    it('sends the Common_SplitTransactionMutation operation with transactionId and splitData', async () => {
      mockFetch({
        updateTransactionSplit: {
          transaction: {
            id: 't1',
            hasSplitTransactions: true,
            splitTransactions: [
              { id: 's1', amount: -10.00, notes: 'a', merchant: { id: 'm1', name: 'Item A' }, category: { id: 'c1', name: 'Software' } },
              { id: 's2', amount: -5.50, notes: 'b', merchant: { id: 'm2', name: 'Item B' }, category: { id: 'c2', name: 'Games' } },
            ],
          },
          errors: null,
        },
      });

      const splitData = [
        { merchantName: 'Item A', amount: -10.00, categoryId: 'c1', notes: 'a' },
        { merchantName: 'Item B', amount: -5.50, categoryId: 'c2', notes: 'b' },
      ];
      const txn = await api.splitTransaction(FAKE_TOKEN, 't1', splitData);

      const { body } = lastCall();
      assert.match(body.query, /mutation Common_SplitTransactionMutation\(\$input: UpdateTransactionSplitMutationInput!\)/);
      assert.match(body.query, /updateTransactionSplit\(input: \$input\)/);
      assert.deepEqual(body.variables, { input: { transactionId: 't1', splitData } });
      assert.equal(txn.hasSplitTransactions, true);
      assert.equal(txn.splitTransactions.length, 2);
    });

    it('sends an empty splitData array to clear splits', async () => {
      mockFetch({
        updateTransactionSplit: {
          transaction: { id: 't1', hasSplitTransactions: false, splitTransactions: [] },
          errors: null,
        },
      });

      const txn = await api.splitTransaction(FAKE_TOKEN, 't1', []);

      assert.deepEqual(lastCall().body.variables, { input: { transactionId: 't1', splitData: [] } });
      assert.equal(txn.hasSplitTransactions, false);
    });

    it('throws when the payload contains API-level errors', async () => {
      mockFetch({
        updateTransactionSplit: {
          transaction: null,
          errors: [{ message: 'Split amounts must sum to transaction amount', code: 'invalid', fieldErrors: null }],
        },
      });

      await assert.rejects(
        () => api.splitTransaction(FAKE_TOKEN, 't1', [{ merchantName: 'X', amount: -1, categoryId: 'c1' }]),
        /splitTransaction failed: Split amounts must sum/
      );
    });
  });

  describe('getTransaction', () => {
    it('queries getTransaction by UUID id', async () => {
      mockFetch({
        getTransaction: { id: 't1', amount: -15.50, hasSplitTransactions: false },
      });

      const txn = await api.getTransaction(FAKE_TOKEN, 't1');

      const { body } = lastCall();
      assert.match(body.query, /query GetTransactionDrawer\(\$id: UUID!\)/);
      assert.match(body.query, /getTransaction\(id: \$id\)/);
      assert.deepEqual(body.variables, { id: 't1' });
      assert.equal(txn.amount, -15.50);
    });
  });
});
