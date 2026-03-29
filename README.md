# monarch-mcp

MCP server for querying and managing [Monarch Money](https://www.monarch.com/) personal finance data.

Provides read-only SQL access to your transactions via a local SQLite mirror, plus a refresh tool to sync from the Monarch API. Works with Claude Code, Claude Desktop, and any MCP-compatible client.

## What Makes This Different

Most Monarch Money MCP servers are **API passthroughs** — each tool call hits the live Monarch API and returns the full response. This server takes a fundamentally different approach:

- **Local SQLite mirror** — transactions are synced to a local database, so queries are instant with zero API latency. No other Monarch MCP does this.
- **Arbitrary SQL** — instead of fixed-parameter tools like `get_transactions(start_date, end_date, limit)`, you get `query_transactions(sql)` and can write any SELECT query: JOINs, CTEs, window functions, aggregations. The AI writes the query it needs, not the query a tool designer anticipated.
- **MCP Resources** — the only Monarch MCP that exposes schema, accounts, categories, and tags as MCP resources. This gives AI clients the metadata they need to write good queries without burning tool calls.
- **Token-efficient** — pre-computed resources and SQL-level filtering mean only relevant data crosses the wire. Other servers return full API payloads on every call.
- **Zero native dependencies** — uses Node.js built-in `node:sqlite`, no compiled extensions. Just `npm install` and go.
- **62 tests** — fixture-based test suite with no dependency on real financial data.

**Trade-off:** This server focuses on transaction analysis (read-only SQL). For budgets, investments, cashflow, or write operations, pair it with an API-passthrough MCP like [robcerda/monarch-mcp-server](https://github.com/robcerda/monarch-mcp-server).

## Requirements

- Node.js >= 22.0.0 (uses `node:sqlite`)
- A [Monarch Money](https://www.monarch.com/) account with an auth token

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/sdeiley/monarch_mcp.git
cd monarch_mcp
npm install

# 2. Initialize data directory
node src/bin/cli.js init

# 3. Set your auth token
export MONARCH_TOKEN=<your-token>

# 4. Fetch your transactions
node src/bin/cli.js refresh

# 5. Start the MCP server
node src/bin/cli.js serve
```

## Getting Your Auth Token

You need a Monarch Money auth token. Options:

1. **Environment variable:** `export MONARCH_TOKEN=<token>`
2. **Token file:** Create `~/.monarch-token` with contents: `{"token": "<token>"}`

To get a token, log into [app.monarch.com](https://app.monarch.com), open browser DevTools, and find the `Authorization: Token <value>` header on any GraphQL request.

## MCP Configuration

Add to your `.mcp.json` (Claude Code, Dispatch):

```json
{
  "mcpServers": {
    "monarch": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/monarch_mcp/src/bin/stdio.js"]
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "monarch": {
      "type": "stdio",
      "command": "npx",
      "args": ["monarch-mcp", "serve"]
    }
  }
}
```

## Resources

The server exposes 4 read-only resources:

| Resource | Description |
|----------|-------------|
| `monarch://schema` | Database schema and metadata |
| `monarch://accounts` | All accounts with transaction counts |
| `monarch://categories` | All categories with group/type |
| `monarch://tags` | Deduplicated, sorted tag list |

## Tools

| Tool | Description |
|------|-------------|
| `query_transactions` | Execute read-only SQL (SELECT/WITH) against the transactions table |
| `refresh_transactions` | Refresh local DB from Monarch API (`recent` = 3 months, `full` = all history) |

### Transaction Table Columns

`id`, `amount`, `date`, `merchant_name`, `plaid_name`, `category_name`, `category_group`, `category_type`, `account_name`, `notes`, `tags`, `is_split`, `parent_id`, `pending`, `is_recurring`

Amounts are negative for expenses, positive for income.

### Example Queries

```sql
-- Spending by category this month
SELECT category_name, COUNT(*) AS n, ROUND(SUM(amount), 2) AS total
FROM transactions
WHERE date >= '2026-03-01' AND category_type = 'expense'
GROUP BY category_name ORDER BY total

-- Uncategorized transactions
SELECT date, merchant_name, amount FROM transactions
WHERE category_name = 'Uncategorized' AND date >= '2026-01-01'

-- Top merchants by spend
SELECT merchant_name, COUNT(*) AS n, ROUND(SUM(amount), 2) AS total
FROM transactions WHERE amount < 0
GROUP BY merchant_name ORDER BY total LIMIT 10
```

## CLI Commands

```bash
monarch-mcp init      # Create ~/.monarch/ data directory
monarch-mcp refresh   # Fetch recent transactions (3 months)
monarch-mcp refresh --full  # Fetch all transaction history
monarch-mcp serve     # Start stdio MCP server
monarch-mcp --help    # Show help
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MONARCH_TOKEN` | Auth token (required for refresh) | — |
| `MONARCH_DATA_DIR` | Data directory path | `~/.monarch` |

## Development

```bash
npm test              # Run all tests
node --test test/db.test.js  # Run specific test file
```

## License

MIT
