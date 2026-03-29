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

export const SERVER_NAME = 'monarch-money';
export const SERVER_VERSION = '0.2.0';

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
        'Monarch Money personal finance server backed by a local SQLite mirror.\n\n' +
        'RESOURCES vs TOOLS:\n' +
        '- For lists of accounts, categories, or tags → read the monarch:// resource (fast, pre-computed)\n' +
        '- For filtered/aggregated transaction queries → use query_transactions tool with SQL\n' +
        '- To update the local mirror from the live API → use refresh_transactions tool\n\n' +
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
}
