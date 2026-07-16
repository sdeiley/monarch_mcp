/**
 * Monarch Money MCP Server.
 *
 * Exposes local transaction data as MCP resources and tools.
 * Reads from local SQLite database and auth token for API access.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { queryDb, getSchema } from './db.js';
import { loadToken } from './token.js';
import { refreshDb } from './refresh.js';
import * as api from './api.js';
import {
  syncTransactionToMirror, verifyTransactionUpdate,
  verifyTransactionTags, verifyTransactionSplits,
} from './mirror.js';

export const SERVER_NAME = 'monarch-money';
export const SERVER_VERSION = '0.6.1';

/**
 * Standard suffix for write tool descriptions (rules/tags — writes whose
 * effect on the mirror cannot be confirmed by re-fetching one transaction).
 */
const WRITE_WARNING =
  ' WRITES TO THE LIVE MONARCH ACCOUNT — confirm with the user before calling. ' +
  'The local SQLite mirror becomes stale for affected transactions until refresh_transactions is run.';

/**
 * Suffix for transaction write tools that self-verify: after the mutation
 * the tool re-fetches the transaction from the live API, verifies the
 * requested changes took effect, and syncs the local mirror.
 */
const VERIFIED_WRITE_WARNING =
  ' WRITES TO THE LIVE MONARCH ACCOUNT — confirm with the user before calling. ' +
  'After the write, the tool re-fetches the transaction from the live API, verifies the change, ' +
  'and syncs it into the local mirror. Check the result: if verification.verified is true and ' +
  'mirror.synced is true, no refresh_transactions is needed; otherwise surface the ' +
  'verification.warning/mismatches to the user, and treat the mirror as stale until ' +
  'refresh_transactions is run.';

/**
 * Wrap a write tool handler: loads the token, runs the mutation, and
 * formats success/error as MCP tool results. Never includes the token
 * in error output.
 */
function writeHandler(fn) {
  return async (args) => {
    try {
      const token = loadToken();
      const result = await fn(token, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: err.message }],
      };
    }
  };
}

/**
 * Create and configure the MCP server instance.
 * Resources and tools are registered here; transport is handled by the caller.
 * @returns {McpServer}
 */
export function createServer() {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      instructions:
        'Monarch Money personal finance server backed by a local SQLite mirror, ' +
        'with write tools that mutate the live Monarch account.\n\n' +
        'RESOURCES vs TOOLS:\n' +
        '- For lists of accounts, categories, or tags → read the monarch:// resource (fast, pre-computed)\n' +
        '- For filtered/aggregated transaction queries → use query_transactions tool with SQL\n' +
        '- To update the local mirror from the live API → use refresh_transactions tool\n\n' +
        'WRITE TOOLS (update_transaction, split_transaction, create_tag, set_transaction_tags, ' +
        'create_rule, update_rule, delete_rule) mutate the user\'s REAL Monarch account. ' +
        'Confirm with the user before calling them. The transaction write tools ' +
        '(update_transaction, split_transaction, set_transaction_tags) self-verify: after the ' +
        'mutation they re-fetch the transaction from the live API, confirm the change took ' +
        'effect, and sync the local mirror — check `verification` and `mirror` in the result; ' +
        'when both succeed no refresh_transactions is needed, and when either fails the result ' +
        'says so and the mirror is stale for that transaction until refresh_transactions is run. ' +
        'Rule writes (especially applyToExistingTransactions) can change many transactions at ' +
        'once and still require refresh_transactions to update the mirror. ' +
        'Transaction/category/tag IDs come from the local mirror (query_transactions and ' +
        'monarch:// resources); rule IDs come from list_rules.\n\n' +
        'The transactions table has columns: id, amount, date, merchant_name, plaid_name, ' +
        'category_name, category_group, category_type, account_name, notes, tags, ' +
        'is_split, parent_id, pending, is_recurring. ' +
        'Amounts are negative for expenses, positive for income.',
    }
  );

  registerResources(server);
  registerTools(server);

  return server;
}

// ─── Resources ─────────────────────────────────────────────────────────

function registerResources(server) {

  server.registerResource(
    'schema',
    'monarch://schema',
    {
      description: 'SQLite database schema and metadata for the transactions table',
      mimeType: 'application/json',
    },
    async (uri) => {
      const { schema, metadata } = getSchema();
      const text = schema + '\n\nMetadata:\n' +
        metadata.map(m => `  ${m.key}: ${m.value}`).join('\n');
      return { contents: [{ uri: uri.href, text }] };
    }
  );

  server.registerResource(
    'accounts',
    'monarch://accounts',
    {
      description: 'All financial accounts with transaction counts, sorted by activity',
      mimeType: 'application/json',
    },
    async (uri) => {
      const rows = queryDb(
        `SELECT account_id, account_name, COUNT(*) AS txn_count
         FROM transactions
         GROUP BY account_id, account_name
         ORDER BY txn_count DESC`
      );
      return { contents: [{ uri: uri.href, text: JSON.stringify(rows) }] };
    }
  );

  server.registerResource(
    'categories',
    'monarch://categories',
    {
      description: 'All Monarch categories with group and type (expense/income/transfer)',
      mimeType: 'application/json',
    },
    async (uri) => {
      const rows = queryDb(
        `SELECT DISTINCT category_id, category_name, category_group, category_type
         FROM transactions
         WHERE category_id IS NOT NULL
         ORDER BY category_type, category_group, category_name`
      );
      return { contents: [{ uri: uri.href, text: JSON.stringify(rows) }] };
    }
  );

  server.registerResource(
    'tags',
    'monarch://tags',
    {
      description: 'All unique transaction tag names, sorted alphabetically',
      mimeType: 'application/json',
    },
    async (uri) => {
      const rows = queryDb(
        `SELECT DISTINCT tags FROM transactions WHERE tags IS NOT NULL`
      );
      // Tags are comma-separated in each row; flatten and deduplicate
      const tagSet = new Set();
      for (const row of rows) {
        for (const tag of row.tags.split(',')) {
          const trimmed = tag.trim();
          if (trimmed) tagSet.add(trimmed);
        }
      }
      const sorted = [...tagSet].sort((a, b) => a.localeCompare(b));
      return { contents: [{ uri: uri.href, text: JSON.stringify(sorted) }] };
    }
  );
}

// ─── Tools ──────────────────────────────────────────────────────────────

function registerTools(server) {

  server.registerTool(
    'query_transactions',
    {
      description: 'Execute a read-only SQL query against the local Monarch transactions database. ' +
        'Supports SELECT and WITH (CTE) queries. The table is "transactions" with columns: ' +
        'id, amount, date, merchant_name, category_name, category_group, category_type, ' +
        'account_name, plaid_name, notes, tags, is_split, parent_id, etc.',
      inputSchema: z.object({
        sql: z.string().describe('Read-only SQL query (SELECT or WITH only)'),
      }),
    },
    async ({ sql }) => {
      try {
        const rows = queryDb(sql);
        return {
          content: [{ type: 'text', text: JSON.stringify(rows) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err.message }],
        };
      }
    }
  );

  server.registerTool(
    'refresh_transactions',
    {
      description: 'Refresh the local transaction database by fetching from the Monarch Money API. ' +
        'Requires a valid auth token (MONARCH_TOKEN env var or ~/.monarch-token file). ' +
        'Use "recent" for last 3 months (fast) or "full" for complete history (slow).',
      inputSchema: z.object({
        mode: z.enum(['recent', 'full']).default('recent')
          .describe('recent = last 3 months, full = all history'),
      }),
    },
    async ({ mode }) => {
      try {
        const token = loadToken();
        const result = await refreshDb(token, { mode });
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err.message }],
        };
      }
    }
  );

  registerWriteTools(server);
}

// ─── Write tools (live Monarch API mutations) ───────────────────────────

/**
 * Post-write confirmation: re-fetch the transaction from the live API,
 * verify the requested changes took effect, and sync the live state into
 * the local mirror.
 *
 * A read-back or sync failure is reported inside the result, never thrown —
 * the remote mutation already succeeded and must not be masked as a failure.
 *
 * @param {string} token
 * @param {string} transactionId
 * @param {(live: object) => Array} verify - Returns mismatches for the live txn
 * @param {object} mutationResult - Fallback transaction from the mutation payload
 * @returns {Promise<{transaction: object, verification: object, mirror: object}>}
 */
async function confirmTransactionWrite(token, transactionId, verify, mutationResult) {
  let live;
  try {
    live = await api.getTransaction(token, transactionId);
  } catch (err) {
    return {
      transaction: mutationResult,
      verification: {
        verified: false,
        warning: 'The write succeeded, but the confirmation read-back failed ' +
          `(${err.message}). The local mirror was NOT updated — run refresh_transactions ` +
          'before relying on it for this transaction.',
      },
      mirror: { synced: false, reason: 'read-back failed' },
    };
  }

  if (!live) {
    return {
      transaction: mutationResult,
      verification: {
        verified: false,
        warning: `The write succeeded, but transaction ${transactionId} was not found on ` +
          'read-back. The local mirror was NOT updated — run refresh_transactions.',
      },
      mirror: { synced: false, reason: 'transaction not found on read-back' },
    };
  }

  const mismatches = verify(live);
  const verification = mismatches.length === 0
    ? { verified: true }
    : {
        verified: false,
        mismatches,
        warning: 'The live transaction does not match the requested changes — a Monarch ' +
          'rule or concurrent edit may have overridden them. The mirror was synced to the ' +
          'LIVE state shown in `transaction`. Inform the user before retrying.',
      };

  return { transaction: live, verification, mirror: syncTransactionToMirror(live) };
}

function registerWriteTools(server) {

  server.registerTool(
    'update_transaction',
    {
      description: 'Update a Monarch transaction: set category, merchant name, notes, date, ' +
        'hide-from-reports, or needs-review. Returns { transaction, verification, mirror }.' +
        VERIFIED_WRITE_WARNING,
      inputSchema: z.object({
        id: z.string().describe('Monarch transaction ID (UUID)'),
        categoryId: z.string().optional()
          .describe('Category ID to assign (see monarch://categories)'),
        merchantName: z.string().optional()
          .describe('New merchant/display name for the transaction'),
        notes: z.string().optional().describe('Notes text (replaces existing notes)'),
        date: z.string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be in YYYY-MM-DD format')
          .optional()
          .describe('Move the transaction to this date (used e.g. to re-date return credits to the original purchase date)'),
        hideFromReports: z.boolean().optional().describe('Hide transaction from reports'),
        needsReview: z.boolean().optional().describe('Mark as needing review'),
      }),
    },
    writeHandler(async (token, { id, categoryId, merchantName, notes, date, hideFromReports, needsReview }) => {
      const input = { id };
      if (categoryId !== undefined) input.category = categoryId;
      if (merchantName !== undefined) input.name = merchantName;
      if (notes !== undefined) input.notes = notes;
      if (date !== undefined) input.date = date;
      if (hideFromReports !== undefined) input.hideFromReports = hideFromReports;
      if (needsReview !== undefined) input.needsReview = needsReview;

      if (Object.keys(input).length === 1) {
        throw new Error(
          'No update fields provided. Supply at least one of: categoryId, merchantName, notes, date, hideFromReports, needsReview.'
        );
      }

      const mutated = await api.updateTransaction(token, input);
      return confirmTransactionWrite(
        token, id, live => verifyTransactionUpdate(input, live), mutated
      );
    })
  );

  server.registerTool(
    'split_transaction',
    {
      description: 'Replace a Monarch transaction\'s splits. Each split gets its own amount, ' +
        'category, merchant name, and optional notes. Split amounts MUST sum exactly to the ' +
        'parent transaction amount (amounts are negative for expenses) — validated against the ' +
        'live parent amount before applying. Pass an empty splits array to remove all splits. ' +
        'Returns { transaction, verification, mirror } with the parent transaction and its splitTransactions.' +
        VERIFIED_WRITE_WARNING,
      inputSchema: z.object({
        transactionId: z.string().describe('Parent Monarch transaction ID (UUID)'),
        splits: z.array(z.object({
          amount: z.number().describe('Split amount (negative for expenses); all splits must sum to the parent amount'),
          categoryId: z.string().describe('Category ID for this split'),
          merchantName: z.string().describe('Display name for this split item'),
          notes: z.string().optional().describe('Notes for this split'),
        })).describe('Complete replacement set of splits; empty array clears existing splits'),
      }),
    },
    writeHandler(async (token, { transactionId, splits }) => {
      if (splits.length > 0) {
        // Validate against the live parent amount, not the local mirror.
        const parent = await api.getTransaction(token, transactionId);
        if (!parent) {
          throw new Error(`Transaction ${transactionId} not found`);
        }
        const sumCents = Math.round(
          splits.reduce((total, s) => total + Math.round(s.amount * 100), 0)
        );
        const parentCents = Math.round(parent.amount * 100);
        if (sumCents !== parentCents) {
          throw new Error(
            `Split amounts sum to ${(sumCents / 100).toFixed(2)} but the transaction amount is ` +
            `${(parentCents / 100).toFixed(2)}. Splits must sum exactly to the parent amount ` +
            '(remember: amounts are negative for expenses).'
          );
        }
      }

      const mutated = await api.splitTransaction(token, transactionId, splits);
      return confirmTransactionWrite(
        token, transactionId, live => verifyTransactionSplits(splits, live), mutated
      );
    })
  );

  server.registerTool(
    'create_tag',
    {
      description: 'Create a new Monarch transaction tag. Returns the created tag with its ID.' +
        WRITE_WARNING,
      inputSchema: z.object({
        name: z.string().describe('Tag name'),
        color: z.string().optional().describe('Hex color, e.g. "#e07a5f"'),
      }),
    },
    writeHandler(async (token, { name, color }) => {
      return api.createTag(token, name, color);
    })
  );

  server.registerTool(
    'set_transaction_tags',
    {
      description: 'Replace the complete set of tags on a Monarch transaction. ' +
        'Pass ALL desired tag IDs — existing tags not included are removed; an empty array clears all tags. ' +
        'Returns { transaction, verification, mirror } with the updated tags.' +
        VERIFIED_WRITE_WARNING,
      inputSchema: z.object({
        transactionId: z.string().describe('Monarch transaction ID (UUID)'),
        tagIds: z.array(z.string())
          .describe('Complete replacement list of tag IDs (see monarch://tags for names; create_tag returns IDs)'),
      }),
    },
    writeHandler(async (token, { transactionId, tagIds }) => {
      const mutated = await api.setTransactionTags(token, transactionId, tagIds);
      return confirmTransactionWrite(
        token, transactionId, live => verifyTransactionTags(tagIds, live), mutated
      );
    })
  );

  registerRuleTools(server);
}

// ─── Rule tools (TransactionRuleV2 CRUD) ────────────────────────────────

const ruleCriteriaSchema = z.object({
  operator: z.enum(['contains', 'eq']),
  value: z.string(),
});

/** Shared criteria + action fields for create_rule / update_rule. */
const ruleFieldsSchema = {
  // Filter criteria
  merchantNameCriteria: z.array(ruleCriteriaSchema).optional()
    .describe('Match on merchant display name'),
  originalStatementCriteria: z.array(ruleCriteriaSchema).optional()
    .describe('Match on raw bank statement text'),
  amountCriteria: z.object({
    operator: z.enum(['eq', 'gt', 'lt', 'between']),
    isExpense: z.boolean(),
    value: z.number().nullable().optional(),
    valueRange: z.object({ lower: z.number(), upper: z.number() }).nullable().optional()
      .describe('Required when operator is "between"'),
  }).optional(),
  categoryIds: z.array(z.string()).optional()
    .describe('Only apply to transactions currently in these categories'),
  accountIds: z.array(z.string()).optional()
    .describe('Only apply to transactions in these accounts'),

  // Actions
  setCategoryAction: z.string().optional().describe('Category ID to assign'),
  setMerchantAction: z.string().optional().describe('Merchant NAME to assign (renames the transaction). Must be an existing merchant name — passing an ID or unknown name silently creates a new merchant with that literal string as its name'),
  addTagsAction: z.array(z.string()).optional().describe('Tag IDs to add'),
  reviewStatusAction: z.enum(['reviewed', 'needs_review']).optional(),
  setHideFromReportsAction: z.boolean().optional(),
  splitTransactionsAction: z.object({
    amountType: z.enum(['PERCENTAGE', 'ABSOLUTE'])
      .describe('PERCENTAGE splits use decimal fractions summing to 1.0; ABSOLUTE splits use dollar amounts (negative for expenses) and require amountCriteria with operator "eq"'),
    splitsInfo: z.array(z.object({
      merchantName: z.string(),
      categoryId: z.string(),
      amount: z.number(),
      tags: z.array(z.string()).nullable().optional(),
      hideFromReports: z.boolean().optional(),
      reviewStatus: z.string().nullable().optional(),
    })),
  }).optional(),
  applyToExistingTransactions: z.boolean().optional()
    .describe('Apply the rule retroactively to existing transactions'),
};

const RULE_CRITERIA_KEYS = [
  'merchantNameCriteria', 'originalStatementCriteria', 'amountCriteria',
  'categoryIds', 'accountIds',
];
const RULE_ACTION_KEYS = [
  'setCategoryAction', 'setMerchantAction', 'addTagsAction',
  'reviewStatusAction', 'setHideFromReportsAction', 'splitTransactionsAction',
];

/** Copy only defined rule fields from tool args into a mutation input. */
function pickRuleInput(args) {
  const input = {};
  for (const key of [...RULE_CRITERIA_KEYS, ...RULE_ACTION_KEYS, 'applyToExistingTransactions']) {
    if (args[key] !== undefined) input[key] = args[key];
  }
  return input;
}

/**
 * Convert a rule as read from getRules (read shape) into the write shape
 * accepted by UpdateTransactionRuleInput, so the caller's partial update can
 * be merged over the rule's full current state. The Monarch update mutation
 * silently ignores partial inputs (verified live 2026-07-15: an input with
 * only criteria + applyToExistingTransactions returned success but changed
 * nothing), so every update must resend the complete rule.
 *
 * Read → write conversions (per docs/api-reference.md, HAR-validated):
 * - setCategoryAction  { id, name }        → category ID string
 * - setMerchantAction  { id, name }        → merchant NAME string (the API
 *   creates a new merchant for unknown names, so reuse the name exactly)
 * - addTagsAction      [{ id, name, ... }] → [tag ID strings]
 * - criteria fields (merchantNameCriteria, originalStatementCriteria,
 *   amountCriteria, categoryIds, accountIds, legacy merchantCriteria +
 *   merchantCriteriaUseOriginalStatement) read and write in the same shape.
 * - splitTransactionsAction's read selection matches its write shape.
 *
 * NOT round-tripped (not in the getRules selection; write shape unverified):
 * goal-link, business-entity, notification, and needs-review-by-user actions.
 */
function ruleToWriteInput(rule) {
  const input = {};
  const copy = (key, value) => {
    if (value !== null && value !== undefined) input[key] = value;
  };

  // Criteria — read shape === write shape.
  copy('merchantCriteria', rule.merchantCriteria);
  copy('merchantCriteriaUseOriginalStatement', rule.merchantCriteriaUseOriginalStatement);
  copy('merchantNameCriteria', rule.merchantNameCriteria);
  copy('originalStatementCriteria', rule.originalStatementCriteria);
  copy('amountCriteria', rule.amountCriteria);
  copy('categoryIds', rule.categoryIds);
  copy('accountIds', rule.accountIds);

  // Actions — objects read back must be written as bare strings.
  copy('setCategoryAction', rule.setCategoryAction?.id);
  copy('setMerchantAction', rule.setMerchantAction?.name);
  if (rule.addTagsAction != null) {
    input.addTagsAction = rule.addTagsAction.map(t => t.id);
  }
  copy('reviewStatusAction', rule.reviewStatusAction);
  copy('setHideFromReportsAction', rule.setHideFromReportsAction);
  copy('splitTransactionsAction', rule.splitTransactionsAction);

  return input;
}

function registerRuleTools(server) {

  server.registerTool(
    'list_rules',
    {
      description: 'List all Monarch transaction rules (TransactionRuleV2) from the live API, ' +
        'including criteria, actions, and application stats. Read-only. ' +
        'Use this to find rule IDs for update_rule/delete_rule.',
      inputSchema: z.object({}),
    },
    writeHandler(async (token) => {
      return api.getRules(token);
    })
  );

  server.registerTool(
    'create_rule',
    {
      description: 'Create a Monarch transaction rule that auto-applies actions (set category, ' +
        'add tags, rename, hide, split) to transactions matching criteria (merchant name, ' +
        'statement text, amount, category, account). Requires at least one criteria field and ' +
        'one action field. The API returns no rule entity on success — call list_rules to see ' +
        'the created rule.' +
        WRITE_WARNING,
      inputSchema: z.object(ruleFieldsSchema),
    },
    writeHandler(async (token, args) => {
      const input = pickRuleInput(args);
      if (!RULE_CRITERIA_KEYS.some(k => input[k] !== undefined)) {
        throw new Error(
          'At least one criteria field is required: merchantNameCriteria, originalStatementCriteria, amountCriteria, categoryIds, or accountIds.'
        );
      }
      if (!RULE_ACTION_KEYS.some(k => input[k] !== undefined)) {
        throw new Error(
          'At least one action field is required: setCategoryAction, setMerchantAction, addTagsAction, reviewStatusAction, setHideFromReportsAction, or splitTransactionsAction.'
        );
      }
      return api.createRule(token, input);
    })
  );

  server.registerTool(
    'update_rule',
    {
      description: 'Update an existing Monarch transaction rule by ID. Provide only the fields ' +
        'to change (same shape as create_rule): the tool fetches the rule\'s current state, ' +
        'merges your fields over it, and writes the complete input — required because the ' +
        'Monarch API silently ignores partial inputs while reporting success. Errors if the ' +
        'rule ID does not exist. Provided fields REPLACE the current value wholesale (e.g. ' +
        'addTagsAction replaces the full tag-action list); providing merchantNameCriteria or ' +
        'originalStatementCriteria also replaces any legacy merchantCriteria on the rule. ' +
        'Not preserved across updates (rare; not returned by list_rules): goal-link, ' +
        'business-entity, notification, and needs-review-by-user actions. The API returns no ' +
        'rule entity on success — the result echoes the merged input actually sent; call ' +
        'list_rules to confirm.' +
        WRITE_WARNING,
      inputSchema: z.object({
        id: z.string().describe('Rule ID (from list_rules)'),
        ...ruleFieldsSchema,
      }),
    },
    writeHandler(async (token, args) => {
      // Fetch-merge-write: the update mutation silently no-ops on partial
      // input, so merge the caller's fields over the rule's current state
      // and always send the complete rule.
      const rules = await api.getRules(token);
      const current = rules.find(r => r.id === args.id);
      if (!current) {
        throw new Error(
          `Rule ${args.id} not found. Call list_rules to get valid rule IDs.`
        );
      }

      const base = ruleToWriteInput(current);
      const overrides = pickRuleInput(args);
      // New-style merchant/statement criteria supersede the legacy
      // representation — keeping both would AND the two criteria sets.
      if (overrides.merchantNameCriteria !== undefined ||
          overrides.originalStatementCriteria !== undefined) {
        delete base.merchantCriteria;
        delete base.merchantCriteriaUseOriginalStatement;
      }

      const input = { ...base, ...overrides, id: args.id };
      const result = await api.updateRule(token, input);
      return { ...result, input };
    })
  );

  server.registerTool(
    'delete_rule',
    {
      description: 'Delete a Monarch transaction rule by ID. Success is determined by the ' +
        'absence of API errors: Monarch\'s own `deleted` response field is unreliable (it ' +
        'reports false even for successful deletes) and is echoed as apiDeletedField for ' +
        'debugging only — trust `deleted` in the result, not apiDeletedField.' +
        WRITE_WARNING,
      inputSchema: z.object({
        id: z.string().describe('Rule ID (from list_rules)'),
      }),
    },
    writeHandler(async (token, { id }) => {
      return api.deleteRule(token, id);
    })
  );
}
