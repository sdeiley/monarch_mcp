# monarch-mcp

MCP server for querying and managing [Monarch Money](https://www.monarch.com/) personal finance data.

Provides read-only SQL access to your transactions via a local SQLite mirror, a refresh tool to sync from the Monarch API, and write tools to update, split, tag, and rule-manage transactions in your live Monarch account. Works with Claude Code, Claude Desktop, and any MCP-compatible client.

## What Makes This Different

Most Monarch Money MCP servers are **API passthroughs** — each tool call hits the live Monarch API and returns the full response. This server takes a fundamentally different approach:

- **Local SQLite mirror** — transactions are synced to a local database, so queries are instant with zero API latency. No other Monarch MCP does this.
- **Arbitrary SQL** — instead of fixed-parameter tools like `get_transactions(start_date, end_date, limit)`, you get `query_transactions(sql)` and can write any SELECT query: JOINs, CTEs, window functions, aggregations. The AI writes the query it needs, not the query a tool designer anticipated.
- **MCP Resources** — the only Monarch MCP that exposes schema, accounts, categories, and tags as MCP resources. This gives AI clients the metadata they need to write good queries without burning tool calls.
- **Token-efficient** — pre-computed resources and SQL-level filtering mean only relevant data crosses the wire. Other servers return full API payloads on every call.
- **Zero native dependencies** — uses Node.js built-in `node:sqlite`, no compiled extensions. Just `npm install` and go.
- **212 tests** — fixture-based test suite with no dependency on real financial data; write tools are tested against a mocked API.
- **Write tools** — update, split, and tag transactions, and manage auto-categorization rules, directly against the live Monarch API. Designed for the "extension/mirror as read-only sensor, agent as sole writer" architecture.
- **Recommendation queue** — review and apply extension-generated transaction proposals (splits, renames, categorizations) from a shared local `queue.db`, with a guarded status lifecycle and double-apply protection.

**Trade-off:** This server focuses on transactions (SQL analysis + write operations). For budgets, investments, or cashflow, pair it with an API-passthrough MCP like [robcerda/monarch-mcp-server](https://github.com/robcerda/monarch-mcp-server).

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

The server exposes 5 read-only resources:

| Resource | Description |
|----------|-------------|
| `monarch://schema` | Database schema and metadata |
| `monarch://accounts` | All accounts with transaction counts |
| `monarch://categories` | All categories with group/type |
| `monarch://tags` | Deduplicated, sorted tag list |
| `monarch://queue/stats` | Recommendation queue counts by status/type/merchant |

## Tools

| Tool | Description |
|------|-------------|
| `query_transactions` | Execute read-only SQL (SELECT/WITH) against the transactions table |
| `refresh_transactions` | Refresh local DB from Monarch API (`recent` = 3 months, `full` = all history) |
| `update_transaction` | Set category, merchant name, notes, hide-from-reports, needs-review on a transaction (write) |
| `split_transaction` | Replace a transaction's splits; amounts must sum exactly to the parent; empty array clears splits (write) |
| `create_tag` | Create a new transaction tag, returns the tag with its ID (write) |
| `set_transaction_tags` | Replace the full tag set on a transaction (write) |
| `list_rules` | List all transaction rules with criteria/actions (live API read) |
| `create_rule` | Create an auto-categorization rule (criteria + actions) (write) |
| `update_rule` | Update an existing rule by ID (write) |
| `delete_rule` | Delete a rule by ID (write) |
| `queue_list` | List recommendation-queue records with status/type/merchant/confidence filters |
| `queue_get` | Fetch one queue record with its full payload (diff, reasoning) |
| `queue_update_status` | Transition a queue record (agent actor): dismiss, or reset failed → pending |
| `queue_apply` | Preflight and execute a queued recommendation against the live account; supports `dry_run` (write) |
| `queue_sweep` | Mark stale records against the local mirror and purge old terminal records (local only) |

### Write tools

The tools marked "(write)" **mutate your live Monarch Money account** — they are not sandboxed and there is no undo. AI agents should confirm with the user before calling any of them.

Notes:

- After a successful write, the tool returns the mutated entity from the API response so the result can be verified.
- The local SQLite mirror is **not** updated by writes — it is stale for affected transactions until you run `refresh_transactions`.
- `split_transaction` validates that split amounts sum exactly to the live parent transaction amount (to the cent) before calling the API. Amounts are negative for expenses.
- `set_transaction_tags` replaces the complete tag set; include existing tag IDs you want to keep.
- Rule create/update mutations return no rule entity (Monarch API limitation); use `list_rules` to confirm.

### Recommendation Queue

The `queue_*` tools operate on `queue.db` in the data directory — a local recommendation queue shared with the [Monarch Chrome extension](https://github.com/sdeiley/monarch_chrome_extension), whose parsing pipeline is the producer: it captures proposed transaction changes (invoice-based splits, merchant renames, categorizations) as queue records with a payload diff, confidence, and reasoning.

The agent-side review workflow:

1. `queue_list` with `status: "pending"` — present items to the user grouped by `group_key`, with confidence and reasoning.
2. After the user approves, `queue_apply` each approved id (`dry_run: true` first to preview the mutation plan).
3. `queue_sweep` occasionally to mark stale records and purge old terminal ones.

`queue_apply` is safer than the raw write tools for queued items: it re-fetches the live transaction and refuses (marking the record `stale`) if the transaction already carries the `"Ext Processed"` tag or has splits, validates split sums against the live amount, sets `"Ext Processed"` on success, and records the outcome (`applied` / `failed`) with a guarded status transition so double-apply is impossible — even if the extension raced it. Status lifecycle: `pending → applied|dismissed|stale`, `failed → pending` for retry; `applied`/`dismissed` are terminal.

The queue database is created lazily; if the extension side isn't installed the queue tools simply report an empty queue.

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
| `MONARCH_TOKEN` | Auth token (required for refresh and all write tools) | — |
| `MONARCH_DATA_DIR` | Data directory path (holds `monarch.db` and `queue.db`) | `~/.monarch` |

## Development

```bash
npm test              # Run all tests
node --test test/db.test.js  # Run specific test file
```

## License

MIT
