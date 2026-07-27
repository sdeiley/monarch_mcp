/**
 * Monarch Money GraphQL write client.
 *
 * All functions here hit the LIVE Monarch API and mutate the user's real
 * account. After any successful write, the local SQLite mirror is stale for
 * the affected transaction(s) until refresh_transactions is run.
 *
 * Operations and payload shapes are ported from the HAR-validated reference
 * in the monarch_chrome_extension repo (docs/api-reference.md).
 *
 * Security: never log or include the auth token in error messages.
 */

export const API_URL = 'https://api.monarch.com/graphql';

const PAYLOAD_ERROR_FIELDS = `
  errors {
    fieldErrors { field messages }
    message code
  }
`;

const TRANSACTION_FIELDS = `
  id amount pending date hideFromReports needsReview
  plaidName notes isSplitTransaction hasSplitTransactions
  category { id name }
  merchant { id name }
  account { id displayName }
  tags { id name color order }
`;

// ─── Core request ────────────────────────────────────────────────────────

/**
 * Execute a GraphQL request against the Monarch API.
 * @param {string} token - Monarch auth token
 * @param {string} query - GraphQL query/mutation document
 * @param {object} [variables]
 * @returns {Promise<object>} The `data` field of the GraphQL response
 */
export async function graphqlRequest(token, query, variables = {}) {
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${token}`,
      'Content-Type': 'application/json',
      'Client-Platform': 'web',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!resp.ok) {
    let detail = '';
    try { detail = await resp.text(); } catch { /* ignore */ }
    throw new Error(
      `Monarch API HTTP ${resp.status}${detail ? ': ' + detail.substring(0, 300) : ''}`
    );
  }

  const json = await resp.json();

  if (json.errors && json.errors.length > 0) {
    throw new Error(
      `Monarch GraphQL error: ${json.errors.map(e => e.message).join('; ')}`
    );
  }
  if (!json.data) {
    throw new Error('Monarch GraphQL response missing data field');
  }

  return json.data;
}

/**
 * Throw if a mutation payload carries API-level errors.
 * @param {object} result - Mutation payload (may contain `errors`)
 * @param {string} opName - Operation name for the error message
 */
function assertNoPayloadErrors(result, opName) {
  if (result?.errors && result.errors.length > 0) {
    const msg = result.errors
      .map(e => e.message || JSON.stringify(e.fieldErrors))
      .join('; ');
    throw new Error(`${opName} failed: ${msg}`);
  }
}

// ─── Queries (used to validate/confirm writes) ───────────────────────────

/**
 * Fetch a single transaction. Used to validate split sums against the live
 * parent amount before splitting, and as the read-back after every write
 * tool to verify the change and sync the local mirror — so the selection
 * covers every field the mirror row needs (same fields as fetch.js).
 */
export async function getTransaction(token, id) {
  const data = await graphqlRequest(token, `
    query GetTransactionDrawer($id: UUID!) {
      getTransaction(id: $id) {
        ${TRANSACTION_FIELDS}
        originalDate isRecurring
        category { id name group { id name type } }
        originalTransaction { id }
        splitTransactions {
          id amount notes hideFromReports
          merchant { id name }
          category { id name group { id name type } }
          tags { id name color order }
        }
      }
    }
  `, { id });
  return data.getTransaction;
}

/** Fetch all household transaction tags. */
export async function getTags(token) {
  const data = await graphqlRequest(token, `{
    householdTransactionTags { id name color order }
  }`);
  return data.householdTransactionTags;
}

/** Fetch all transaction rules (TransactionRuleV2). */
export async function getRules(token) {
  const data = await graphqlRequest(token, `{
    transactionRules {
      id order merchantCriteriaUseOriginalStatement
      merchantCriteria { operator value }
      merchantNameCriteria { operator value }
      originalStatementCriteria { operator value }
      amountCriteria { operator isExpense value valueRange { lower upper } }
      categoryIds accountIds
      categories { id name }
      setCategoryAction { id name }
      setMerchantAction { id name }
      addTagsAction { id name color }
      reviewStatusAction
      setHideFromReportsAction
      splitTransactionsAction {
        amountType
        splitsInfo {
          categoryId merchantName amount goalId savingsGoalId
          tags hideFromReports reviewStatus needsReviewByUserId
          ownerUserId ownerIsJoint businessEntityId
        }
      }
      recentApplicationCount lastAppliedAt
    }
  }`);
  return data.transactionRules;
}

// ─── Transaction mutations ───────────────────────────────────────────────

/**
 * Update a transaction's fields.
 * @param {string} token
 * @param {object} input - UpdateTransactionMutationInput: `id` (required),
 *   plus any of `category` (category ID), `name` (merchant name), `notes`,
 *   `hideFromReports`, `needsReview`, `amount`, `date`, `goalId`.
 * @returns {Promise<object>} The updated transaction
 */
export async function updateTransaction(token, input) {
  const data = await graphqlRequest(token, `
    mutation Web_TransactionDrawerUpdateTransaction($input: UpdateTransactionMutationInput!) {
      updateTransaction(input: $input) {
        transaction {
          ${TRANSACTION_FIELDS}
        }
        ${PAYLOAD_ERROR_FIELDS}
      }
    }
  `, { input });

  const result = data.updateTransaction;
  assertNoPayloadErrors(result, 'updateTransaction');
  return result.transaction;
}

/**
 * Replace a transaction's splits. Empty splitData removes all splits.
 * NOTE: caller is responsible for validating that split amounts sum to the
 * parent transaction amount (Monarch rejects mismatches).
 * @param {string} token
 * @param {string} transactionId
 * @param {Array<{merchantName: string, amount: number, categoryId: string, notes?: string}>} splitData
 * @returns {Promise<object>} Parent transaction with `splitTransactions`
 */
export async function splitTransaction(token, transactionId, splitData) {
  const data = await graphqlRequest(token, `
    mutation Common_SplitTransactionMutation($input: UpdateTransactionSplitMutationInput!) {
      updateTransactionSplit(input: $input) {
        transaction {
          id amount hasSplitTransactions
          splitTransactions {
            id amount notes
            merchant { id name }
            category { id name }
          }
        }
        ${PAYLOAD_ERROR_FIELDS}
      }
    }
  `, { input: { transactionId, splitData } });

  const result = data.updateTransactionSplit;
  assertNoPayloadErrors(result, 'splitTransaction');
  return result.transaction;
}

/**
 * Replace the full tag set on a transaction.
 * @param {string} token
 * @param {string} transactionId
 * @param {string[]} tagIds - Complete list of tag IDs (replaces existing tags)
 * @returns {Promise<object>} Transaction with updated tags
 */
export async function setTransactionTags(token, transactionId, tagIds) {
  const data = await graphqlRequest(token, `
    mutation Web_SetTransactionTags($input: SetTransactionTagsInput!) {
      setTransactionTags(input: $input) {
        transaction { id tags { id name color order } }
        ${PAYLOAD_ERROR_FIELDS}
      }
    }
  `, { input: { transactionId, tagIds } });

  const result = data.setTransactionTags;
  assertNoPayloadErrors(result, 'setTransactionTags');
  return result.transaction;
}

/**
 * Create a household transaction tag. The mutation does not return the tag
 * object, so we re-fetch tags and return the created one by name.
 * @param {string} token
 * @param {string} name
 * @param {string} [color] - Hex color, e.g. "#e07a5f"
 * @returns {Promise<object>} The created tag ({ id, name, color, order })
 */
export async function createTag(token, name, color) {
  await graphqlRequest(token, `
    mutation Common_CreateTransactionTag($input: CreateTransactionTagInput!) {
      createTransactionTag(input: $input) {
        __typename
      }
    }
  `, { input: { name, color } });

  const tags = await getTags(token);
  return tags.find(t => t.name === name) || { name, color };
}

// ─── Budget (operations extracted from the Monarch web app bundle,
//     read path verified live 2026-07-18) ────────────────────────────────

const BUDGET_MONTHLY_AMOUNTS_FIELDS = `
  month plannedCashFlowAmount plannedSetAsideAmount actualAmount
  remainingAmount previousMonthRolloverAmount rolloverType
  cumulativeActualAmount rolloverTargetAmount
`;

const BUDGET_DATA_QUERY = `
query Common_BudgetDataQuery($startDate: Date!, $endDate: Date!) {
  budgetSystem
  budgetStatus { hasBudget hasTransactions }
  budgetData(startMonth: $startDate, endMonth: $endDate) {
    monthlyAmountsByCategory {
      category { id }
      monthlyAmounts { ${BUDGET_MONTHLY_AMOUNTS_FIELDS} }
    }
    monthlyAmountsByCategoryGroup {
      categoryGroup { id }
      monthlyAmounts { ${BUDGET_MONTHLY_AMOUNTS_FIELDS} }
    }
    monthlyAmountsForFlexExpense {
      budgetVariability
      monthlyAmounts { ${BUDGET_MONTHLY_AMOUNTS_FIELDS} }
    }
    totalsByMonth {
      month
      totalIncome { ...BudgetTotalsFields }
      totalExpenses { ...BudgetTotalsFields }
      totalFixedExpenses { ...BudgetTotalsFields }
      totalNonMonthlyExpenses { ...BudgetTotalsFields }
      totalFlexibleExpenses { ...BudgetTotalsFields }
    }
  }
  categoryGroups {
    id name order type budgetVariability groupLevelBudgetingEnabled
    categories {
      id name order budgetVariability excludeFromBudget isSystemCategory
      rolloverPeriod { id startMonth endMonth startingBalance targetAmount frequency type }
    }
    rolloverPeriod { id type startMonth endMonth startingBalance frequency targetAmount }
  }
  goalsV2 {
    id name archivedAt completedAt priority
    plannedContributions(startMonth: $startDate, endMonth: $endDate) { id month amount }
    monthlyContributionSummaries(startMonth: $startDate, endMonth: $endDate) { month sum }
  }
}
fragment BudgetTotalsFields on BudgetTotals {
  actualAmount plannedAmount previousMonthRolloverAmount remainingAmount
}
`;

/**
 * Fetch budget data for a month range. Months are the first-of-month in
 * YYYY-MM-DD form (e.g. "2026-07-01").
 * @returns {Promise<object>} { budgetSystem, budgetStatus, budgetData,
 *   categoryGroups, goalsV2 }
 */
export async function getBudgetData(token, startMonth, endMonth) {
  return graphqlRequest(token, BUDGET_DATA_QUERY, {
    startDate: startMonth,
    endDate: endMonth,
  });
}

/** Fetch household budget settings. */
export async function getBudgetSettings(token) {
  return graphqlRequest(token, `{
    budgetSystem
    budgetApplyToFutureMonthsDefault
    flexExpenseRolloverPeriod { id startMonth startingBalance }
  }`);
}

/**
 * Set the planned budget amount for a category or category group.
 * @param {string} token
 * @param {object} input - UpdateOrCreateBudgetItemMutationInput:
 *   `startDate` (first of month, YYYY-MM-DD), `timeframe` ("month"),
 *   `amount`, `applyToFuture`, and exactly one of `categoryId` /
 *   `categoryGroupId`.
 * @returns {Promise<object>} The budget item ({ id, plannedCashFlowAmount })
 */
export async function updateBudgetItem(token, input) {
  const data = await graphqlRequest(token, `
    mutation Common_UpdateBudgetItem($input: UpdateOrCreateBudgetItemMutationInput!) {
      updateOrCreateBudgetItem(input: $input) {
        budgetItem { id plannedCashFlowAmount }
      }
    }
  `, { input });
  return data.updateOrCreateBudgetItem?.budgetItem ?? null;
}

/**
 * Set the planned flex-expense budget amount (fixed_and_flex budget system).
 * @param {string} token
 * @param {object} input - UpdateOrCreateFlexBudgetItemMutationInput:
 *   `startDate` (first of month), `amount`, `applyToFuture`.
 * @returns {Promise<object>} The budget item ({ id, budgetAmount })
 */
export async function updateFlexBudgetItem(token, input) {
  const data = await graphqlRequest(token, `
    mutation Common_UpdateFlexBudgetMutation($input: UpdateOrCreateFlexBudgetItemMutationInput!) {
      updateOrCreateFlexBudgetItem(input: $input) {
        budgetItem { id budgetAmount }
      }
    }
  `, { input });
  return data.updateOrCreateFlexBudgetItem?.budgetItem ?? null;
}

// ─── Rule mutations (TransactionRuleV2, HAR-validated) ───────────────────

/**
 * Create a transaction rule.
 * @param {string} token
 * @param {object} input - CreateTransactionRuleInput (see api-reference.md)
 * @returns {Promise<{created: boolean}>} The mutation payload returns no
 *   rule entity — only errors. Use getRules() to see the created rule.
 */
export async function createRule(token, input) {
  const data = await graphqlRequest(token, `
    mutation Common_CreateTransactionRuleMutationV2($input: CreateTransactionRuleInput!) {
      createTransactionRuleV2(input: $input) {
        ${PAYLOAD_ERROR_FIELDS}
      }
    }
  `, { input });

  assertNoPayloadErrors(data.createTransactionRuleV2, 'createRule');
  return { created: true };
}

/**
 * Update a transaction rule.
 * @param {string} token
 * @param {object} input - UpdateTransactionRuleInput: `id` required, plus
 *   the same fields as CreateTransactionRuleInput.
 * @returns {Promise<{updated: boolean}>}
 */
export async function updateRule(token, input) {
  const data = await graphqlRequest(token, `
    mutation Common_UpdateTransactionRuleMutationV2($input: UpdateTransactionRuleInput!) {
      updateTransactionRuleV2(input: $input) {
        ${PAYLOAD_ERROR_FIELDS}
      }
    }
  `, { input });

  assertNoPayloadErrors(data.updateTransactionRuleV2, 'updateRule');
  return { updated: true };
}

/**
 * Delete a transaction rule.
 *
 * Monarch's `deleted` response field is UNRELIABLE: it comes back false (or
 * null) even when the rule was actually deleted (verified live 2026-07-15 —
 * 50 successful deletes, every one reporting `deleted: false` while the rules
 * disappeared from the rules list). Payload `errors` are the real failure
 * signal: assertNoPayloadErrors throws on genuine failures, so once it passes
 * the delete succeeded. The raw field is passed through as `apiDeletedField`
 * for debugging only — do not branch on it.
 *
 * @param {string} token
 * @param {string} id - Rule ID
 * @returns {Promise<{deleted: true, apiDeletedField: boolean|null}>}
 */
export async function deleteRule(token, id) {
  const data = await graphqlRequest(token, `
    mutation Common_DeleteTransactionRule($id: ID!) {
      deleteTransactionRule(id: $id) {
        deleted
        ${PAYLOAD_ERROR_FIELDS}
      }
    }
  `, { id });

  const result = data.deleteTransactionRule;
  assertNoPayloadErrors(result, 'deleteRule');
  return { deleted: true, apiDeletedField: result.deleted ?? null };
}

// ─── Recurring streams (read-only) ───────────────────────────────────────
//
// Monarch models recurring as first-class merchant-level streams
// (RecurringTransactionStream: frequency, expected amount, baseDate,
// reviewStatus, isActive); each transaction's isRecurring boolean is derived
// from stream membership. Documents extracted from the web app's JS bundle
// (introspection is disabled) and validated live 2026-07-27.

/**
 * Fetch recurring stream metadata: review status, frequency, expected
 * amount, base date, and recurring type per stream. (The web app's
 * Common_GetRecurringStreams — the Recurring settings list.)
 * @returns {Promise<Array>} [{ stream: {...} }]
 */
export async function getRecurringStreams(token) {
  const data = await graphqlRequest(token, `
    query Common_GetRecurringStreams($includeLiabilities: Boolean) {
      recurringTransactionStreams(includePending: true, includeLiabilities: $includeLiabilities) {
        stream {
          id reviewStatus frequency amount baseDate dayOfTheMonth isApproximate
          name logoUrl recurringType
          merchant { id }
          creditReportLiabilityAccount { id account { id } lastStatement { id dueDate } }
        }
      }
    }
  `, { includeLiabilities: true });
  return data.recurringTransactionStreams;
}

/**
 * Fetch recurring streams with their next forecasted occurrence, category,
 * and account. (The web app's Common_GetAllRecurringTransactionItems.)
 * @returns {Promise<Array>} [{ stream, nextForecastedTransaction, category, account }]
 */
export async function getRecurringStreamsOverview(token) {
  const data = await graphqlRequest(token, `
    query Common_GetAllRecurringTransactionItems($includeLiabilities: Boolean, $includePending: Boolean) {
      recurringTransactionStreams(includeLiabilities: $includeLiabilities, includePending: $includePending) {
        stream {
          id frequency isActive isApproximate name
          merchant { id name }
          creditReportLiabilityAccount { id account { id } }
        }
        nextForecastedTransaction { date amount }
        category { id name }
        account { id displayName }
      }
    }
  `, { includeLiabilities: true, includePending: true });
  return data.recurringTransactionStreams;
}

/**
 * Fetch per-occurrence recurring items in a date range, grouped by status
 * (upcoming/complete), with per-item late/missed flags, matched transaction
 * id, and expected-vs-actual amount diff. (The web app's
 * Common_GetAggregatedRecurringItems — the Recurring calendar page.)
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @returns {Promise<object>} { groups, aggregatedSummary }
 */
export async function getRecurringItems(token, startDate, endDate) {
  const data = await graphqlRequest(token, `
    query Common_GetAggregatedRecurringItems($startDate: Date!, $endDate: Date!) {
      aggregatedRecurringItems(startDate: $startDate, endDate: $endDate, groupBy: "status") {
        groups {
          groupBy { status }
          results {
            stream { id frequency isActive amount isApproximate name merchant { id name } }
            date isPast isLate isMissed markedPaidAt isCompleted transactionId
            amount amountDiff isAmountDifferentThanOriginal
            category { id name }
            account { id displayName }
          }
        }
        aggregatedSummary {
          expense { completed remaining total count pendingAmountCount }
          creditCard { completed remaining total count pendingAmountCount }
          income { completed remaining total }
        }
      }
    }
  `, { startDate, endDate });
  return data.aggregatedRecurringItems;
}
