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
  openQueueDb, listRecords, getRecord, getStatsData,
  updateStatus, applyRecord, sweep, QUEUE_STATUSES,
} from './queue.js';

export const SERVER_NAME = 'monarch-money';
export const SERVER_VERSION = '0.4.0';

/**
 * Standard suffix for write tool descriptions.
 */
const WRITE_WARNING =
  ' WRITES TO THE LIVE MONARCH ACCOUNT — confirm with the user before calling. ' +
  'The local SQLite mirror becomes stale for affected transactions until refresh_transactions is run.';

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
 * @param {{queueDb?: import('node:sqlite').DatabaseSync}} [options]
 *   queueDb: injectable queue database handle (tests pass ':memory:');
 *   defaults to lazily opening <dataDir>/queue.db on first queue tool use.
 * @returns {McpServer}
 */
export function createServer(options = {}) {
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
        'Confirm with the user before calling them. After a write, the local mirror is stale ' +
        'for the affected transactions until refresh_transactions is run. ' +
        'Transaction/category/tag IDs come from the local mirror (query_transactions and ' +
        'monarch:// resources); rule IDs come from list_rules.\n\n' +
        'RECOMMENDATION QUEUE (queue_list, queue_get, queue_update_status, queue_apply, ' +
        'queue_sweep; resource monarch://queue/stats): the browser extension pipeline captures ' +
        'proposed transaction changes (splits, renames, categorizations) into a local queue.db. ' +
        'Review workflow: queue_list with status=pending → present items to the user grouped by ' +
        'group_key with confidence and reasoning → after the user approves, queue_apply each ' +
        'approved id (dry_run=true first to preview) → queue_sweep for housekeeping. For queued ' +
        'items always use queue_apply instead of the raw write tools — it preflights the live ' +
        'transaction, sets the "Ext Processed" tag, and keeps queue status consistent.\n\n' +
        'The transactions table has columns: id, amount, date, merchant_name, plaid_name, ' +
        'category_name, category_group, category_type, account_name, notes, tags, ' +
        'is_split, parent_id, pending, is_recurring. ' +
        'Amounts are negative for expenses, positive for income.',
    }
  );

  // Queue database: injected in tests, opened lazily (created on first
  // access) in production so a missing queue.db never crashes the server.
  let queueDb = options.queueDb ?? null;
  const getQueueDb = () => (queueDb ??= openQueueDb());

  registerResources(server, getQueueDb);
  registerTools(server, getQueueDb);

  return server;
}

// ─── Resources ─────────────────────────────────────────────────────────

function registerResources(server, getQueueDb) {

  server.registerResource(
    'queue-stats',
    'monarch://queue/stats',
    {
      description: 'Recommendation queue stats: counts by status/type/merchant and lastGeneratedAt',
      mimeType: 'application/json',
    },
    async (uri) => {
      const stats = getStatsData(getQueueDb());
      return { contents: [{ uri: uri.href, text: JSON.stringify(stats) }] };
    }
  );

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

function registerTools(server, getQueueDb) {

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
  registerQueueTools(server, getQueueDb);
}

// ─── Queue tools (recommendation queue, Track B3) ────────────────────────

const EMPTY_QUEUE_MESSAGE =
  'The recommendation queue is empty — no recommendations have been captured yet. ' +
  'Records are produced by the browser extension pipeline (queue.db in the Monarch data directory).';

/** Wrap a queue tool handler with uniform JSON/error formatting. */
function queueHandler(fn) {
  return async (args) => {
    try {
      const result = await fn(args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
  };
}

function registerQueueTools(server, getQueueDb) {

  server.registerTool(
    'queue_list',
    {
      description: 'List recommendation-queue records (extension-generated proposals to split, ' +
        'rename, categorize, or tag Monarch transactions). Returns matching items plus overall ' +
        'counts by status. Present pending items to the user grouped by group_key before applying.',
      inputSchema: z.object({
        status: z.enum(QUEUE_STATUSES).optional().describe('Filter by lifecycle status'),
        type: z.string().optional().describe("Filter by record type, e.g. 'split', 'categorize', 'rename'"),
        merchant: z.string().optional().describe("Filter by source merchant, e.g. 'apple'"),
        min_confidence: z.number().min(0).max(1).optional().describe('Minimum confidence (0-1)'),
        limit: z.number().int().positive().max(200).default(50),
      }),
    },
    queueHandler(({ status, type, merchant, min_confidence, limit }) => {
      const { items, counts } = listRecords(getQueueDb(), {
        status, type, merchant, minConfidence: min_confidence, limit,
      });
      const result = { items, counts };
      if (items.length === 0) {
        result.message = Object.keys(counts).length === 0
          ? EMPTY_QUEUE_MESSAGE
          : 'No recommendations match the given filters.';
      }
      return result;
    })
  );

  server.registerTool(
    'queue_get',
    {
      description: 'Fetch a single recommendation-queue record by id, including its full payload ' +
        '(source invoice data, captured target transaction, proposed diff, and reasoning).',
      inputSchema: z.object({
        id: z.string().describe('Recommendation id (from queue_list)'),
      }),
    },
    queueHandler(({ id }) => {
      const record = getRecord(getQueueDb(), id);
      if (!record) {
        throw new Error(`Recommendation '${id}' not found in the queue`);
      }
      return record;
    })
  );

  server.registerTool(
    'queue_update_status',
    {
      description: 'Transition a recommendation-queue record to a new lifecycle status as the ' +
        "agent actor: dismiss a proposal ('dismissed') or reset a failed one for retry " +
        "('pending'). Transitions the agent is not allowed to make (e.g. resurrecting an " +
        'applied/dismissed record, or extension-only statuses) return an error. ' +
        'To actually execute a recommendation, use queue_apply instead.',
      inputSchema: z.object({
        id: z.string().describe('Recommendation id (from queue_list)'),
        status: z.enum(QUEUE_STATUSES).describe('Target status'),
        note: z.string().optional()
          .describe("Optional annotation recorded on the record (e.g. why it was dismissed)"),
      }),
    },
    queueHandler(({ id, status, note }) => {
      const record = updateStatus(getQueueDb(), id, status, 'agent', { error: note });
      return { ok: true, record };
    })
  );

  server.registerTool(
    'queue_apply',
    {
      description: 'Execute a queued recommendation against the live Monarch account: preflights ' +
        'the target transaction (refuses and marks the record stale if it already carries the ' +
        '"Ext Processed" tag or has splits), runs the proposed diff (split and/or update), sets ' +
        'the "Ext Processed" tag, and marks the record applied by the agent. On mutation error ' +
        'the record is marked failed (reset to pending via queue_update_status to retry). ' +
        'Use dry_run to see the preflight and mutation plan without writing.' +
        WRITE_WARNING,
      inputSchema: z.object({
        id: z.string().describe('Recommendation id (from queue_list)'),
        dry_run: z.boolean().default(false)
          .describe('Preflight and plan only — no mutations, no status change'),
      }),
    },
    queueHandler(async ({ id, dry_run }) => {
      const token = loadToken();
      return applyRecord(getQueueDb(), token, { id, dryRun: dry_run });
    })
  );

  server.registerTool(
    'queue_sweep',
    {
      description: 'Housekeep the recommendation queue: mark active records stale when their ' +
        'target transaction in the local monarch.db mirror is missing, already tagged ' +
        '"Ext Processed", already split, or recategorized; then purge old terminal records ' +
        '(applied 7d, dismissed 30d, stale 7d, failed 14d; 500-record soft cap). ' +
        'Only touches the local queue database, never the live Monarch account. ' +
        'Run refresh_transactions first for an up-to-date staleness check.',
      inputSchema: z.object({}),
    },
    queueHandler(() => {
      return sweep(getQueueDb(), { lookupMirrorTxns: lookupMirrorTransactions });
    })
  );
}

/**
 * Default mirror lookup for queue_sweep: fetch target transactions from the
 * local monarch.db mirror. Ids are quoted (not interpolated raw) because
 * queryDb only accepts a SQL string.
 * @param {string[]} ids
 * @returns {Map<string, object>}
 */
function lookupMirrorTransactions(ids) {
  if (ids.length === 0) return new Map();
  const quoted = ids.map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');
  const rows = queryDb(
    `SELECT id, category_id, has_splits, tags FROM transactions WHERE id IN (${quoted})`
  );
  return new Map(rows.map(r => [r.id, r]));
}

// ─── Write tools (live Monarch API mutations) ───────────────────────────

function registerWriteTools(server) {

  server.registerTool(
    'update_transaction',
    {
      description: 'Update a Monarch transaction: set category, merchant name, notes, ' +
        'hide-from-reports, or needs-review. Returns the updated transaction.' +
        WRITE_WARNING,
      inputSchema: z.object({
        id: z.string().describe('Monarch transaction ID (UUID)'),
        categoryId: z.string().optional()
          .describe('Category ID to assign (see monarch://categories)'),
        merchantName: z.string().optional()
          .describe('New merchant/display name for the transaction'),
        notes: z.string().optional().describe('Notes text (replaces existing notes)'),
        hideFromReports: z.boolean().optional().describe('Hide transaction from reports'),
        needsReview: z.boolean().optional().describe('Mark as needing review'),
      }),
    },
    writeHandler(async (token, { id, categoryId, merchantName, notes, hideFromReports, needsReview }) => {
      const input = { id };
      if (categoryId !== undefined) input.category = categoryId;
      if (merchantName !== undefined) input.name = merchantName;
      if (notes !== undefined) input.notes = notes;
      if (hideFromReports !== undefined) input.hideFromReports = hideFromReports;
      if (needsReview !== undefined) input.needsReview = needsReview;

      if (Object.keys(input).length === 1) {
        throw new Error(
          'No update fields provided. Supply at least one of: categoryId, merchantName, notes, hideFromReports, needsReview.'
        );
      }

      return api.updateTransaction(token, input);
    })
  );

  server.registerTool(
    'split_transaction',
    {
      description: 'Replace a Monarch transaction\'s splits. Each split gets its own amount, ' +
        'category, merchant name, and optional notes. Split amounts MUST sum exactly to the ' +
        'parent transaction amount (amounts are negative for expenses) — validated against the ' +
        'live parent amount before applying. Pass an empty splits array to remove all splits. ' +
        'Returns the parent transaction with its splitTransactions.' +
        WRITE_WARNING,
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

      return api.splitTransaction(token, transactionId, splits);
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
        'Returns the transaction with its updated tags.' +
        WRITE_WARNING,
      inputSchema: z.object({
        transactionId: z.string().describe('Monarch transaction ID (UUID)'),
        tagIds: z.array(z.string())
          .describe('Complete replacement list of tag IDs (see monarch://tags for names; create_tag returns IDs)'),
      }),
    },
    writeHandler(async (token, { transactionId, tagIds }) => {
      return api.setTransactionTags(token, transactionId, tagIds);
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
  setMerchantAction: z.string().optional().describe('Merchant ID to assign (renames the transaction)'),
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
      description: 'Update an existing Monarch transaction rule by ID. Provide the fields to ' +
        'change (same shape as create_rule). Note: action fields read as objects via list_rules ' +
        'but are written as bare ID strings here. The API returns no rule entity on success — ' +
        'call list_rules to confirm.' +
        WRITE_WARNING,
      inputSchema: z.object({
        id: z.string().describe('Rule ID (from list_rules)'),
        ...ruleFieldsSchema,
      }),
    },
    writeHandler(async (token, args) => {
      const input = { id: args.id, ...pickRuleInput(args) };
      return api.updateRule(token, input);
    })
  );

  server.registerTool(
    'delete_rule',
    {
      description: 'Delete a Monarch transaction rule by ID.' + WRITE_WARNING,
      inputSchema: z.object({
        id: z.string().describe('Rule ID (from list_rules)'),
      }),
    },
    writeHandler(async (token, { id }) => {
      const deleted = await api.deleteRule(token, id);
      return { deleted };
    })
  );
}
