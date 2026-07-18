import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Budget tools never touch the mirror DB, but server startup resolves the
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

/** A minimal Common_BudgetDataQuery response for July 2026. */
function budgetDataPayload({ groceriesPlanned = 445 } = {}) {
  const months = (planned, actual) => [{
    month: '2026-07-01',
    plannedCashFlowAmount: planned,
    plannedSetAsideAmount: 0,
    actualAmount: actual,
    remainingAmount: planned - actual,
    previousMonthRolloverAmount: null,
    rolloverType: null,
    cumulativeActualAmount: 0,
    rolloverTargetAmount: null,
  }];
  return {
    budgetSystem: 'fixed_and_flex',
    budgetStatus: { hasBudget: true, hasTransactions: true },
    budgetData: {
      monthlyAmountsByCategory: [
        { category: { id: 'cat-groceries' }, monthlyAmounts: months(groceriesPlanned, 263.7) },
        { category: { id: 'cat-unknown' }, monthlyAmounts: months(20, 0) },
      ],
      monthlyAmountsByCategoryGroup: [
        { categoryGroup: { id: 'grp-food' }, monthlyAmounts: months(600, 300) },
      ],
      monthlyAmountsForFlexExpense: {
        budgetVariability: 'flexible',
        monthlyAmounts: months(6000, 8722.47),
      },
      totalsByMonth: [{
        month: '2026-07-01',
        totalIncome: { actualAmount: 13364.97, plannedAmount: 12330, previousMonthRolloverAmount: 0, remainingAmount: -1034.97 },
        totalExpenses: { actualAmount: 10253.74, plannedAmount: 11769.89, previousMonthRolloverAmount: 16.55, remainingAmount: 1532.7 },
        totalFixedExpenses: { actualAmount: 1518.08, plannedAmount: 5689.89, previousMonthRolloverAmount: 0, remainingAmount: 4171.81 },
        totalNonMonthlyExpenses: { actualAmount: 13.19, plannedAmount: 80, previousMonthRolloverAmount: 16.55, remainingAmount: 83.36 },
        totalFlexibleExpenses: { actualAmount: 8722.47, plannedAmount: 6000, previousMonthRolloverAmount: 0, remainingAmount: -2722.47 },
      }],
    },
    categoryGroups: [{
      id: 'grp-food',
      name: 'Food',
      order: 1,
      type: 'expense',
      budgetVariability: 'flexible',
      groupLevelBudgetingEnabled: false,
      categories: [{
        id: 'cat-groceries',
        name: 'Groceries',
        order: 1,
        budgetVariability: 'flexible',
        excludeFromBudget: false,
        isSystemCategory: false,
        rolloverPeriod: null,
      }],
      rolloverPeriod: null,
    }],
    goalsV2: [
      {
        id: 'goal-1', name: 'Emergency Fund', archivedAt: null, completedAt: null, priority: 1,
        plannedContributions: [{ id: 'pc-1', month: '2026-07-01', amount: 500 }],
        monthlyContributionSummaries: [{ month: '2026-07-01', sum: 500 }],
      },
      {
        id: 'goal-2', name: 'Old Goal', archivedAt: '2025-01-01', completedAt: null, priority: 2,
        plannedContributions: [],
        monthlyContributionSummaries: [],
      },
    ],
  };
}

describe('Budget API client', () => {
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

  it('getBudgetData sends month range variables', async () => {
    installMockFetch(calls, budgetDataPayload());
    const data = await api.getBudgetData('fake-test-token', '2026-07-01', '2026-08-01');

    const { body } = calls[0];
    assert.deepEqual(body.variables, { startDate: '2026-07-01', endDate: '2026-08-01' });
    assert.match(body.query, /budgetData\(startMonth: \$startDate, endMonth: \$endDate\)/);
    assert.equal(data.budgetSystem, 'fixed_and_flex');
  });

  it('updateBudgetItem sends UpdateOrCreateBudgetItemMutationInput and returns the item', async () => {
    installMockFetch(calls, {
      updateOrCreateBudgetItem: { budgetItem: { id: 'bi-1', plannedCashFlowAmount: 300 } },
    });

    const item = await api.updateBudgetItem('fake-test-token', {
      startDate: '2026-07-01', timeframe: 'month', amount: 300,
      applyToFuture: false, categoryId: 'cat-groceries', categoryGroupId: undefined,
    });

    const { body } = calls[0];
    assert.match(body.query, /updateOrCreateBudgetItem\(input: \$input\)/);
    assert.equal(body.variables.input.timeframe, 'month');
    assert.equal(body.variables.input.categoryId, 'cat-groceries');
    assert.deepEqual(item, { id: 'bi-1', plannedCashFlowAmount: 300 });
  });

  it('updateFlexBudgetItem sends UpdateOrCreateFlexBudgetItemMutationInput', async () => {
    installMockFetch(calls, {
      updateOrCreateFlexBudgetItem: { budgetItem: { id: 'fbi-1', budgetAmount: 5500 } },
    });

    const item = await api.updateFlexBudgetItem('fake-test-token', {
      startDate: '2026-07-01', amount: 5500, applyToFuture: true,
    });

    const { body } = calls[0];
    assert.match(body.query, /updateOrCreateFlexBudgetItem\(input: \$input\)/);
    assert.deepEqual(body.variables.input, {
      startDate: '2026-07-01', amount: 5500, applyToFuture: true,
    });
    assert.equal(item.budgetAmount, 5500);
  });

  it('getBudgetSettings queries budget settings fields', async () => {
    installMockFetch(calls, {
      budgetSystem: 'fixed_and_flex',
      budgetApplyToFutureMonthsDefault: true,
      flexExpenseRolloverPeriod: null,
    });

    const settings = await api.getBudgetSettings('fake-test-token');
    assert.equal(settings.budgetApplyToFutureMonthsDefault, true);
  });
});

describe('get_budget tool', () => {
  let client, close;
  let originalFetch;
  let calls;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    calls = [];
    ({ client, close } = await createTestPair());
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await close();
  });

  it('is registered alongside set_budget_amount', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    assert.ok(names.includes('get_budget'));
    assert.ok(names.includes('set_budget_amount'));
  });

  it('resolves category and group names and compacts monthly amounts', async () => {
    installMockFetch(calls, budgetDataPayload());

    const result = await client.callTool({
      name: 'get_budget',
      arguments: { startMonth: '2026-07', endMonth: '2026-07' },
    });
    const budget = parseResult(result);

    assert.equal(budget.budgetSystem, 'fixed_and_flex');

    const groceries = budget.categories.find(c => c.categoryId === 'cat-groceries');
    assert.equal(groceries.name, 'Groceries');
    assert.equal(groceries.group, 'Food');
    assert.deepEqual(groceries.months, [
      { month: '2026-07-01', planned: 445, actual: 263.7, remaining: 181.3 },
    ]);

    // Category missing from categoryGroups still appears, with null name
    const unknown = budget.categories.find(c => c.categoryId === 'cat-unknown');
    assert.equal(unknown.name, null);

    const foodGroup = budget.categoryGroups.find(g => g.categoryGroupId === 'grp-food');
    assert.equal(foodGroup.name, 'Food');
    assert.equal(foodGroup.groupLevelBudgetingEnabled, false);

    assert.equal(budget.flexExpense.budgetVariability, 'flexible');
    assert.equal(budget.flexExpense.months[0].planned, 6000);
    assert.equal(budget.totalsByMonth[0].totalExpenses.plannedAmount, 11769.89);
  });

  it('normalizes YYYY-MM months and defaults endMonth to startMonth', async () => {
    installMockFetch(calls, budgetDataPayload());

    await client.callTool({
      name: 'get_budget',
      arguments: { startMonth: '2026-07' },
    });

    assert.deepEqual(calls[0].body.variables, {
      startDate: '2026-07-01', endDate: '2026-07-01',
    });
  });

  it('filters archived goals', async () => {
    installMockFetch(calls, budgetDataPayload());

    const result = await client.callTool({
      name: 'get_budget',
      arguments: { startMonth: '2026-07' },
    });
    const budget = parseResult(result);

    assert.equal(budget.goals.length, 1);
    assert.equal(budget.goals[0].name, 'Emergency Fund');
  });

  it('rejects an invalid month string', async () => {
    installMockFetch(calls, budgetDataPayload());

    const result = await client.callTool({
      name: 'get_budget',
      arguments: { startMonth: 'July 2026' },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid month/);
    assert.equal(calls.length, 0, 'must not hit the API with an invalid month');
  });
});

describe('set_budget_amount tool', () => {
  let client, close;
  let originalFetch;
  let calls;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    calls = [];
    ({ client, close } = await createTestPair());
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await close();
  });

  it('sets a category budget and verifies via read-back', async () => {
    installMockFetch(calls,
      { updateOrCreateBudgetItem: { budgetItem: { id: 'bi-1', plannedCashFlowAmount: 300 } } },
      budgetDataPayload({ groceriesPlanned: 300 }),
    );

    const result = await client.callTool({
      name: 'set_budget_amount',
      arguments: { categoryId: 'cat-groceries', amount: 300, month: '2026-07' },
    });
    const out = parseResult(result);

    // First call: mutation with the full input shape
    const input = calls[0].body.variables.input;
    assert.deepEqual(input, {
      startDate: '2026-07-01', timeframe: 'month', amount: 300,
      applyToFuture: false, categoryId: 'cat-groceries',
    });
    // Second call: read-back
    assert.match(calls[1].body.query, /budgetData/);
    assert.deepEqual(out.verification, { verified: true });
    assert.equal(out.budgetItem.plannedCashFlowAmount, 300);
  });

  it('reports a verification mismatch when the live amount differs', async () => {
    installMockFetch(calls,
      { updateOrCreateBudgetItem: { budgetItem: { id: 'bi-1', plannedCashFlowAmount: 300 } } },
      budgetDataPayload({ groceriesPlanned: 445 }),  // read-back shows old value
    );

    const result = await client.callTool({
      name: 'set_budget_amount',
      arguments: { categoryId: 'cat-groceries', amount: 300, month: '2026-07' },
    });
    const out = parseResult(result);

    assert.equal(out.verification.verified, false);
    assert.equal(out.verification.livePlanned, 445);
    assert.match(out.verification.warning, /reads back as 445/);
  });

  it('sets the flex budget via the flex mutation', async () => {
    const flexPayload = budgetDataPayload();
    flexPayload.budgetData.monthlyAmountsForFlexExpense.monthlyAmounts[0].plannedCashFlowAmount = 5500;
    installMockFetch(calls,
      { updateOrCreateFlexBudgetItem: { budgetItem: { id: 'fbi-1', budgetAmount: 5500 } } },
      flexPayload,
    );

    const result = await client.callTool({
      name: 'set_budget_amount',
      arguments: { flex: true, amount: 5500, month: '2026-07-01', applyToFuture: true },
    });
    const out = parseResult(result);

    assert.match(calls[0].body.query, /updateOrCreateFlexBudgetItem/);
    assert.deepEqual(calls[0].body.variables.input, {
      startDate: '2026-07-01', amount: 5500, applyToFuture: true,
    });
    assert.deepEqual(out.verification, { verified: true });
  });

  it('requires exactly one target', async () => {
    installMockFetch(calls, {});

    const none = await client.callTool({
      name: 'set_budget_amount',
      arguments: { amount: 100, month: '2026-07' },
    });
    assert.equal(none.isError, true);
    assert.match(none.content[0].text, /exactly one/);

    const both = await client.callTool({
      name: 'set_budget_amount',
      arguments: { amount: 100, month: '2026-07', categoryId: 'c1', flex: true },
    });
    assert.equal(both.isError, true);
    assert.match(both.content[0].text, /exactly one/);

    assert.equal(calls.length, 0, 'must not hit the API without a valid target');
  });

  it('surfaces a read-back failure as an unverified write', async () => {
    let i = 0;
    globalThis.fetch = (url, opts) => {
      calls.push({ url, opts, body: JSON.parse(opts.body) });
      if (i++ === 0) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: { updateOrCreateBudgetItem: { budgetItem: { id: 'bi-1', plannedCashFlowAmount: 300 } } },
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('boom') });
    };

    const result = await client.callTool({
      name: 'set_budget_amount',
      arguments: { categoryId: 'cat-groceries', amount: 300, month: '2026-07' },
    });
    const out = parseResult(result);

    assert.equal(out.verification.verified, false);
    assert.match(out.verification.warning, /read-back failed/);
    assert.equal(out.budgetItem.plannedCashFlowAmount, 300);
  });
});
