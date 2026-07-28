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
- **149 tests** — fixture-based test suite with no dependency on real financial data; write tools are tested against a mocked API.
- **Write tools** — update, split, and tag transactions, and manage auto-categorization rules, directly against the live Monarch API. Designed for the "extension/mirror as read-only sensor, agent as sole writer" architecture.

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
| `update_transaction` | Set category, merchant name, notes, date, hide-from-reports, needs-review on a transaction (write) |
| `split_transaction` | Replace a transaction's splits; amounts must sum exactly to the parent; empty array clears splits (write) |
| `create_tag` | Create a new transaction tag, returns the tag with its ID (write) |
| `set_transaction_tags` | Replace the full tag set on a transaction (write) |
| `list_rules` | List all transaction rules with criteria/actions (live API read) |
| `create_rule` | Create an auto-categorization rule (criteria + actions) (write) |
| `update_rule` | Update an existing rule by ID; supports partial updates via fetch-merge-write (write) |
| `delete_rule` | Delete a rule by ID (write) |
| `get_budget` | Budget for a month range: planned/actual/remaining per category and group, flex totals, goal contributions (live API read) |
| `set_budget_amount` | Set the planned monthly budget amount for a category, group, or the flex budget (write) |
| `get_recurring` | Recurring streams (frequency, expected amount, review status, next forecasted date, category, account); optional date range adds per-occurrence items with late/missed flags and expected-vs-actual amount diffs (live API read) |
| `review_recurring_stream` | Approve or dismiss a recurring stream, optionally correcting its expected amount/frequency/base date (write) |
| `mark_stream_not_recurring` | Remove a stream from the recurring list; self-verifies the stream is gone from the live list (write) |

### Write tools

The tools marked "(write)" **mutate your live Monarch Money account** — they are not sandboxed and there is no undo. AI agents should confirm with the user before calling any of them.

Notes:

- The transaction write tools (`update_transaction`, `split_transaction`, `set_transaction_tags`) **self-verify and self-sync**: after the mutation, the tool re-fetches the transaction from the live API, verifies the requested changes took effect, and upserts the live state (including split children) into the local mirror. The result is `{ transaction, verification, mirror }` — when `verification.verified` and `mirror.synced` are both true, no `refresh_transactions` is needed; otherwise the result carries a warning (and mismatch details) and the mirror is stale for that transaction until `refresh_transactions` is run. A mismatch usually means a Monarch rule or concurrent edit overrode the change.
- Rule writes (`create_rule` / `update_rule` / `delete_rule`, especially with `applyToExistingTransactions`) can affect many transactions at once and still leave the mirror stale until `refresh_transactions`.
- `split_transaction` validates that split amounts sum exactly to the live parent transaction amount (to the cent) before calling the API. Amounts are negative for expenses.
- `set_transaction_tags` replaces the complete tag set; include existing tag IDs you want to keep.
- Rule create/update mutations return no rule entity (Monarch API limitation); use `list_rules` to confirm.
- `update_rule` genuinely supports partial updates: the Monarch update mutation silently ignores partial inputs (while reporting success), so the tool fetches the rule's current state, merges your fields over it, converts read shapes to write shapes (category/tag objects → IDs, merchant object → name), and sends the complete input. Goal-link, business-entity, notification, and needs-review-by-user actions are not round-tripped and may be reset by an update.
- `delete_rule` treats the absence of API errors as success: Monarch's `deleted` response field is unreliable (it reports `false` even for successful deletes) and is echoed only as `apiDeletedField` for debugging.
- Recurring streams have no local mirror table — all three recurring tools talk to the live API (Monarch models recurring as merchant-level `RecurringTransactionStream`s; the mirror's per-transaction `is_recurring` flag is derived from stream membership). The stream write tools self-verify: `review_recurring_stream` checks the mutation's returned `reviewStatus`, and `mark_stream_not_recurring` re-fetches the stream list and confirms the stream is gone. Note: Monarch's stream resolvers silently no-op on unknown IDs (no GraphQL error; `success: false` / `stream: null`) — both tools surface that as a failed `verification` rather than success.
- Budgets have no local mirror table — `get_budget` and `set_budget_amount` both talk to the live API. Budget amounts use the **positive-spend** convention (planned `445` = plan to spend $445), the opposite of transaction amounts. `set_budget_amount` self-verifies by re-reading the month's budget after the write and comparing the planned amount (`verification.verified` in the result). Group-level targets require `groupLevelBudgetingEnabled` on the group; `flex: true` requires the fixed_and_flex budget system.

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
| `MONARCH_DATA_DIR` | Data directory path (holds `monarch.db`) | `~/.monarch` |

## Development

```bash
npm test              # Run all tests
node --test test/db.test.js  # Run specific test file
```

## License

MIT
