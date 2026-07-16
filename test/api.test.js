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

    it('carries date through to the GraphQL input', async () => {
      mockFetch({
        updateTransaction: {
          transaction: { id: 't1', date: '2026-03-14' },
          errors: null,
        },
      });

      const input = { id: 't1', date: '2026-03-14' };
      const txn = await api.updateTransaction(FAKE_TOKEN, input);

      const { body } = lastCall();
      assert.deepEqual(body.variables, { input: { id: 't1', date: '2026-03-14' } });
      assert.equal(txn.date, '2026-03-14');
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

  describe('setTransactionTags', () => {
    it('sends the Web_SetTransactionTags operation with transactionId and tagIds', async () => {
      mockFetch({
        setTransactionTags: {
          transaction: { id: 't1', tags: [{ id: 'tag1', name: 'Apple', color: '#f00', order: 1 }] },
          errors: null,
        },
      });

      const txn = await api.setTransactionTags(FAKE_TOKEN, 't1', ['tag1']);

      const { body } = lastCall();
      assert.match(body.query, /mutation Web_SetTransactionTags\(\$input: SetTransactionTagsInput!\)/);
      assert.match(body.query, /setTransactionTags\(input: \$input\)/);
      assert.deepEqual(body.variables, { input: { transactionId: 't1', tagIds: ['tag1'] } });
      assert.equal(txn.tags[0].name, 'Apple');
    });

    it('throws when the payload contains API-level errors', async () => {
      mockFetch({
        setTransactionTags: {
          transaction: null,
          errors: [{ message: 'Tag not found', code: 'not_found', fieldErrors: null }],
        },
      });

      await assert.rejects(
        () => api.setTransactionTags(FAKE_TOKEN, 't1', ['bogus']),
        /setTransactionTags failed: Tag not found/
      );
    });
  });

  describe('createTag', () => {
    it('creates the tag then re-fetches tags to return the created one', async () => {
      mockFetch(
        { createTransactionTag: { __typename: 'CreateTransactionTagPayload' } },
        { householdTransactionTags: [
          { id: 'tag1', name: 'Existing', color: '#0f0', order: 1 },
          { id: 'tag2', name: 'NewTag', color: '#e07a5f', order: 2 },
        ] }
      );

      const tag = await api.createTag(FAKE_TOKEN, 'NewTag', '#e07a5f');

      assert.equal(calls.length, 2, 'create then fetch');
      assert.match(calls[0].body.query, /mutation Common_CreateTransactionTag\(\$input: CreateTransactionTagInput!\)/);
      assert.deepEqual(calls[0].body.variables, { input: { name: 'NewTag', color: '#e07a5f' } });
      assert.match(calls[1].body.query, /householdTransactionTags/);
      assert.deepEqual(tag, { id: 'tag2', name: 'NewTag', color: '#e07a5f', order: 2 });
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

  describe('rules', () => {
    it('getRules queries transactionRules', async () => {
      mockFetch({
        transactionRules: [{ id: 'r1', order: 0, merchantNameCriteria: [{ operator: 'contains', value: 'Apple' }] }],
      });

      const rules = await api.getRules(FAKE_TOKEN);

      assert.match(lastCall().body.query, /transactionRules/);
      assert.equal(rules.length, 1);
      assert.equal(rules[0].id, 'r1');
    });

    it('createRule sends Common_CreateTransactionRuleMutationV2 with input', async () => {
      mockFetch({ createTransactionRuleV2: { errors: null } });

      const input = {
        merchantNameCriteria: [{ operator: 'contains', value: 'Apple' }],
        setCategoryAction: 'cat-1',
        applyToExistingTransactions: false,
      };
      const result = await api.createRule(FAKE_TOKEN, input);

      const { body } = lastCall();
      assert.match(body.query, /mutation Common_CreateTransactionRuleMutationV2\(\$input: CreateTransactionRuleInput!\)/);
      assert.match(body.query, /createTransactionRuleV2\(input: \$input\)/);
      assert.deepEqual(body.variables, { input });
      assert.deepEqual(result, { created: true });
    });

    it('createRule throws on payload errors', async () => {
      mockFetch({
        createTransactionRuleV2: {
          errors: [{ message: 'Invalid criteria', code: 'invalid', fieldErrors: null }],
        },
      });

      await assert.rejects(
        () => api.createRule(FAKE_TOKEN, {}),
        /createRule failed: Invalid criteria/
      );
    });

    it('updateRule sends Common_UpdateTransactionRuleMutationV2 with id in input', async () => {
      mockFetch({ updateTransactionRuleV2: { errors: null } });

      const input = { id: 'r1', setCategoryAction: 'cat-2' };
      const result = await api.updateRule(FAKE_TOKEN, input);

      const { body } = lastCall();
      assert.match(body.query, /mutation Common_UpdateTransactionRuleMutationV2\(\$input: UpdateTransactionRuleInput!\)/);
      assert.deepEqual(body.variables, { input });
      assert.deepEqual(result, { updated: true });
    });

    it('deleteRule sends Common_DeleteTransactionRule with the rule id', async () => {
      mockFetch({ deleteTransactionRule: { deleted: true, errors: null } });

      const result = await api.deleteRule(FAKE_TOKEN, 'r1');

      const { body } = lastCall();
      assert.match(body.query, /mutation Common_DeleteTransactionRule\(\$id: ID!\)/);
      assert.match(body.query, /deleteTransactionRule\(id: \$id\)/);
      assert.deepEqual(body.variables, { id: 'r1' });
      assert.deepEqual(result, { deleted: true, apiDeletedField: true });
    });

    // Regression: the live API returns deleted:false (or null) even for
    // SUCCESSFUL deletes (verified 2026-07-15, 50/50 deletions). Success is
    // the absence of payload errors, never the `deleted` field.
    it('deleteRule reports success despite the API\'s unreliable deleted:false', async () => {
      mockFetch({ deleteTransactionRule: { deleted: false, errors: null } });

      const result = await api.deleteRule(FAKE_TOKEN, 'r1');

      assert.deepEqual(result, { deleted: true, apiDeletedField: false });
    });

    it('deleteRule reports success when the deleted field is null', async () => {
      mockFetch({ deleteTransactionRule: { deleted: null, errors: null } });

      const result = await api.deleteRule(FAKE_TOKEN, 'r1');

      assert.deepEqual(result, { deleted: true, apiDeletedField: null });
    });

    it('deleteRule throws on payload errors and never reports deleted:true', async () => {
      mockFetch({
        deleteTransactionRule: {
          deleted: false,
          errors: [{ message: 'Rule not found', code: 'not_found', fieldErrors: null }],
        },
      });

      await assert.rejects(
        () => api.deleteRule(FAKE_TOKEN, 'r-bogus'),
        /deleteRule failed: Rule not found/
      );
    });
  });
});
