import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Recurring tools never touch the mirror DB, but server startup resolves the
// data dir — point it at the committed fixture. Fake token so loadToken()
// never reads ~/.monarch-token.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.MONARCH_DATA_DIR = path.join(__dirname, 'fixtures');
process.env.MONARCH_TOKEN = 'fake-test-token';

async function createTestPair() {
  const { createServer } = await import('../src/server.js');
  const server = createServer();
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { server, client, close: () => Promise.all([server.close(), client.close()]) };
}

/** Record fetch calls; reply with queued GraphQL data payloads in order. */
function installMockFetch(calls, ...dataPayloads) {
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

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

/** Common_GetRecurringStreams payload: stream metadata. */
function streamsMetaPayload() {
  return {
    recurringTransactionStreams: [
      {
        stream: {
          id: 's1', reviewStatus: 'approved', frequency: 'monthly', amount: -118.98,
          baseDate: '2026-07-02', dayOfTheMonth: null, isApproximate: false,
          name: 'Comcast', logoUrl: null, recurringType: 'expense',
          merchant: { id: 'm1' }, creditReportLiabilityAccount: null,
        },
      },
      {
        stream: {
          id: 's2', reviewStatus: 'pending', frequency: 'yearly', amount: -65,
          baseDate: '2026-07-01', dayOfTheMonth: null, isApproximate: false,
          name: 'Costco', logoUrl: null, recurringType: 'expense',
          merchant: { id: 'm2' }, creditReportLiabilityAccount: null,
        },
      },
    ],
  };
}

/** Common_GetAllRecurringTransactionItems payload: forecast + category/account. */
function streamsOverviewPayload() {
  return {
    recurringTransactionStreams: [
      {
        stream: {
          id: 's1', frequency: 'monthly', isActive: true, isApproximate: false,
          name: 'Comcast', merchant: { id: 'm1', name: 'Comcast' },
          creditReportLiabilityAccount: null,
        },
        nextForecastedTransaction: { date: '2026-08-02', amount: -118.98 },
        category: { id: 'c1', name: 'TV & Internet' },
        account: { id: 'a1', displayName: '360 Checking' },
      },
      // s2 intentionally absent from the overview — merge must tolerate it.
    ],
  };
}

/** Common_GetAggregatedRecurringItems payload: one complete, one upcoming. */
function aggregatedItemsPayload() {
  return {
    aggregatedRecurringItems: {
      groups: [
        {
          groupBy: { status: 'upcoming' },
          results: [{
            stream: { id: 's1', frequency: 'monthly', isActive: true, amount: -118.98, isApproximate: false, name: 'Comcast', merchant: { id: 'm1', name: 'Comcast' } },
            date: '2026-08-02', isPast: false, isLate: false, isMissed: false,
            markedPaidAt: null, isCompleted: false, transactionId: null,
            amount: -118.98, amountDiff: null, isAmountDifferentThanOriginal: null,
            category: { id: 'c1', name: 'TV & Internet' },
            account: { id: 'a1', displayName: '360 Checking' },
          }],
        },
        {
          groupBy: { status: 'complete' },
          results: [{
            stream: { id: 's2', frequency: 'yearly', isActive: true, amount: -65, isApproximate: false, name: 'Costco', merchant: { id: 'm2', name: 'Costco' } },
            date: '2026-07-01', isPast: true, isLate: false, isMissed: false,
            markedPaidAt: null, isCompleted: true, transactionId: 't-costco',
            amount: -130, amountDiff: -65, isAmountDifferentThanOriginal: null,
            category: { id: 'c2', name: 'Groceries' },
            account: { id: 'a2', displayName: 'Costco Visa' },
          }],
        },
      ],
      aggregatedSummary: {
        expense: { completed: -130, remaining: -118.98, total: -248.98, count: 2, pendingAmountCount: 0 },
        creditCard: { completed: 0, remaining: 0, total: 0, count: 0, pendingAmountCount: 0 },
        income: { completed: 0, remaining: 0, total: 0 },
      },
    },
  };
}

describe('get_recurring', () => {
  const realFetch = globalThis.fetch;
  let pair;

  beforeEach(async () => { pair = await createTestPair(); });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    await pair.close();
  });

  it('merges stream metadata with forecast/category/account by stream id', async () => {
    const calls = [];
    installMockFetch(calls, streamsMetaPayload(), streamsOverviewPayload());

    const result = parseResult(await pair.client.callTool({
      name: 'get_recurring', arguments: {},
    }));

    assert.equal(calls.length, 2);
    assert.equal(result.streams.length, 2);
    assert.equal(result.items, undefined);

    const comcast = result.streams.find(s => s.streamId === 's1');
    assert.equal(comcast.name, 'Comcast');
    assert.equal(comcast.merchantName, 'Comcast');
    assert.equal(comcast.reviewStatus, 'approved');
    assert.equal(comcast.frequency, 'monthly');
    assert.equal(comcast.expectedAmount, -118.98);
    assert.equal(comcast.isActive, true);
    assert.deepEqual(comcast.nextForecasted, { date: '2026-08-02', amount: -118.98 });
    assert.equal(comcast.category.name, 'TV & Internet');
    assert.equal(comcast.account.displayName, '360 Checking');
  });

  it('tolerates streams missing from the overview response', async () => {
    installMockFetch([], streamsMetaPayload(), streamsOverviewPayload());

    const result = parseResult(await pair.client.callTool({
      name: 'get_recurring', arguments: {},
    }));

    const costco = result.streams.find(s => s.streamId === 's2');
    assert.equal(costco.reviewStatus, 'pending');
    assert.equal(costco.isActive, null);
    assert.equal(costco.nextForecasted, null);
    assert.equal(costco.category, null);
  });

  it('returns date-sorted per-occurrence items with status when a range is given', async () => {
    const calls = [];
    installMockFetch(calls,
      streamsMetaPayload(), streamsOverviewPayload(), aggregatedItemsPayload());

    const result = parseResult(await pair.client.callTool({
      name: 'get_recurring',
      arguments: { startDate: '2026-07-01', endDate: '2026-08-31' },
    }));

    assert.equal(calls.length, 3);
    assert.equal(calls[2].body.variables.startDate, '2026-07-01');
    assert.equal(calls[2].body.variables.endDate, '2026-08-31');

    assert.equal(result.items.length, 2);
    // Sorted by date: the July Costco completion precedes the August forecast.
    assert.equal(result.items[0].name, 'Costco');
    assert.equal(result.items[0].status, 'complete');
    assert.equal(result.items[0].transactionId, 't-costco');
    assert.equal(result.items[0].expectedAmount, -65);
    assert.equal(result.items[0].actualAmount, -130);
    assert.equal(result.items[0].amountDiff, -65);
    assert.equal(result.items[1].name, 'Comcast');
    assert.equal(result.items[1].status, 'upcoming');
    assert.equal(result.summary.expense.total, -248.98);
  });

  it('rejects a startDate without an endDate', async () => {
    installMockFetch([], {});

    const result = await pair.client.callTool({
      name: 'get_recurring', arguments: { startDate: '2026-07-01' },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /both startDate and endDate/);
  });
});

describe('review_recurring_stream', () => {
  const realFetch = globalThis.fetch;
  let pair;

  beforeEach(async () => { pair = await createTestPair(); });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    await pair.close();
  });

  it('sends only provided fields and verifies the returned reviewStatus', async () => {
    const calls = [];
    installMockFetch(calls, {
      reviewRecurringStream: { stream: { id: 's1', reviewStatus: 'approved' }, errors: null },
    });

    const result = parseResult(await pair.client.callTool({
      name: 'review_recurring_stream',
      arguments: { streamId: 's1', reviewStatus: 'approved', amount: -12.99 },
    }));

    assert.deepEqual(calls[0].body.variables.input,
      { streamId: 's1', reviewStatus: 'approved', amount: -12.99 });
    assert.equal(result.stream.reviewStatus, 'approved');
    assert.equal(result.verification.verified, true);
  });

  it('flags a reviewStatus mismatch instead of claiming success', async () => {
    installMockFetch([], {
      reviewRecurringStream: { stream: { id: 's1', reviewStatus: 'pending' }, errors: null },
    });

    const result = parseResult(await pair.client.callTool({
      name: 'review_recurring_stream',
      arguments: { streamId: 's1', reviewStatus: 'ignored' },
    }));

    assert.equal(result.verification.verified, false);
    assert.match(result.verification.warning, /"pending" instead of the requested "ignored"/);
  });

  it('surfaces payload errors as tool errors', async () => {
    installMockFetch([], {
      reviewRecurringStream: {
        stream: null,
        errors: [{ fieldErrors: null, message: 'Not found', code: 'not_found' }],
      },
    });

    const result = await pair.client.callTool({
      name: 'review_recurring_stream',
      arguments: { streamId: 'bogus', reviewStatus: 'ignored' },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Not found/);
  });
});

describe('mark_stream_not_recurring', () => {
  const realFetch = globalThis.fetch;
  let pair;

  beforeEach(async () => { pair = await createTestPair(); });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    await pair.close();
  });

  it('verifies removal by re-fetching the stream list', async () => {
    const calls = [];
    installMockFetch(calls,
      { markStreamAsNotRecurring: { success: true, errors: null } },
      // read-back: s1 gone, only s2 remains
      { recurringTransactionStreams: [{ stream: { id: 's2' } }] });

    const result = parseResult(await pair.client.callTool({
      name: 'mark_stream_not_recurring', arguments: { streamId: 's1' },
    }));

    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.variables.streamId, 's1');
    assert.equal(result.success, true);
    assert.equal(result.verification.verified, true);
  });

  it('treats API success=false as not-removed without trusting the read-back', async () => {
    const calls = [];
    installMockFetch(calls, { markStreamAsNotRecurring: { success: false, errors: null } });

    const result = parseResult(await pair.client.callTool({
      name: 'mark_stream_not_recurring', arguments: { streamId: 'bogus' },
    }));

    assert.equal(calls.length, 1); // no read-back on failure
    assert.equal(result.success, false);
    assert.equal(result.verification.verified, false);
    assert.match(result.verification.warning, /not removed/);
  });

  it('flags the stream still being present on read-back', async () => {
    installMockFetch([],
      { markStreamAsNotRecurring: { success: true, errors: null } },
      { recurringTransactionStreams: [{ stream: { id: 's1' } }] });

    const result = parseResult(await pair.client.callTool({
      name: 'mark_stream_not_recurring', arguments: { streamId: 's1' },
    }));

    assert.equal(result.verification.verified, false);
    assert.match(result.verification.warning, /still appears/);
  });
});
