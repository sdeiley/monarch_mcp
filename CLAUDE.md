# Monarch MCP Server

Standalone MCP server for Monarch Money personal finance data.

## Repository Structure

```
src/
  config.js        # Data dir + DB path resolution (MONARCH_DATA_DIR env var)
  db.js            # SQLite read-only query layer (node:sqlite DatabaseSync)
  token.js         # Auth token loader (env var or ~/.monarch-token file)
  fetch.js         # Monarch GraphQL API transaction fetcher
  import.js        # JSON → SQLite importer with upsert + pending prune
  refresh.js       # Async orchestrator: fetch → import
  api.js           # Monarch GraphQL write client (mutations + live reads)
  mirror.js        # Post-write read-back verification + local-mirror sync (shared row mapping)
  queue.js         # Recommendation queue store (queue.db): schema, lifecycle, apply, sweep
  server.js        # MCP server factory: 5 resources + 15 tools
  bin/
    stdio.js       # stdio transport entry point
    cli.js         # CLI: init, refresh, serve
test/
  *.test.js        # node:test suite (241 tests)
  fixtures/
    monarch.db     # Committed 5-row fixture DB
    create-fixture-db.js  # Regenerates the fixture
```

## Tech Stack

- **Node.js ESM** — `"type": "module"`, requires Node >= 22.0.0 for `node:sqlite`
- **MCP SDK** — `@modelcontextprotocol/sdk` with `zod` for tool schemas
- **SQLite** — `node:sqlite` `DatabaseSync` (no native dependencies)
- **Tests** — `node:test` runner, all tests use fixture DB or mocked fetch

## Running Tests

```bash
npm test                          # All 241 tests
node --test test/db.test.js       # Single file
```

## Key Design Decisions

- **Configurable data dir:** `MONARCH_DATA_DIR` env var or `~/.monarch` default. Every DB function accepts optional `dbPath` override for testability.
- **Token at `~/.monarch-token`:** JSON file with `{ "token": "..." }` field. `MONARCH_TOKEN` env var takes priority.
- **`fetchTransactions` returns data, not files.** The caller (refresh.js) decides where to persist.
- **`refreshDb` is async** — no `execSync`, direct function calls.
- **Fixture DB committed.** 5 deterministic rows spanning 3 accounts, 3 category types, tags, and splits. Tests never touch real financial data.

## MCP Resources

- `monarch://schema` — DB schema + metadata
- `monarch://accounts` — Accounts with transaction counts
- `monarch://categories` — Categories with group/type
- `monarch://tags` — Deduplicated, sorted tag names
- `monarch://queue/stats` — Recommendation queue counts by status/type/merchant

## MCP Tools

Read:

- `query_transactions(sql)` — Read-only SQL (SELECT/WITH only)
- `refresh_transactions(mode)` — `recent` (3 months) or `full` (all history)
- `list_rules()` — All TransactionRuleV2 rules (live API read)

Write (mutate the LIVE Monarch account; agents must confirm with the user first):

- `update_transaction(id, ...)` — category, merchant name, notes, date (YYYY-MM-DD), hideFromReports, needsReview
- `split_transaction(transactionId, splits)` — replace splits; amounts must sum exactly to parent; `[]` clears
- `create_tag(name, color?)` — returns created tag with ID
- `set_transaction_tags(transactionId, tagIds)` — replaces the full tag set
- `create_rule(...)` / `update_rule(id, ...)` / `delete_rule(id)` — TransactionRuleV2 CRUD

Transaction write tools self-verify (`src/mirror.js`): after the mutation they re-fetch the
transaction via `getTransaction`, verify the requested changes took effect, and upsert the live
state (parent + split children, pruning removed children) into monarch.db. They return
`{ transaction, verification, mirror }`; when `verification.verified` and `mirror.synced` are both
true no `refresh_transactions` is needed, otherwise the result carries a warning/mismatches and the
mirror is stale for that transaction. A read-back or sync failure is reported in the result, never
thrown — the remote write already succeeded. Rule writes (especially
`applyToExistingTransactions`) can touch many transactions and still require
`refresh_transactions`. The row mapping (`UPSERT_TRANSACTION_SQL` + `transactionToRow`) is shared
between mirror.js and import.js so the sync and bulk-refresh paths cannot drift. Tests that
exercise writes must point `MONARCH_DATA_DIR` at a temp COPY of the fixture DB, never the
committed fixture.

Write-tool conventions (`src/api.js`): endpoint `https://api.monarch.com/graphql`, header `Authorization: Token <token>` (not Bearer) + `Client-Platform: web`. Payload-level `errors` arrays are surfaced as thrown errors. Never log or echo the token.

Recommendation queue (Track B3; authoritative spec: `monarch_chrome_extension/docs/queue-design.md`):

- `queue_list(status?, type?, merchant?, min_confidence?, limit)` — items + counts by status
- `queue_get(id)` — full record with parsed payload
- `queue_update_status(id, status, note?)` — agent-actor transition; invalid transitions error
- `queue_apply(id, dry_run?)` — preflight (Ext Processed tag / splits → mark stale), execute payload.diff via `src/api.js`, tag, mark applied, then read back + sync the mirror; mutation errors mark failed
- `queue_sweep()` — staleness vs the monarch.db mirror + retention purge (applied 7d, dismissed 30d, stale 7d, failed 14d; soft cap 500)

Queue conventions (`src/queue.js`): the DDL and `canTransition(from, to, actor)` rules are copied verbatim from the design doc and must stay byte-compatible with the sibling implementation in the extension repo. Status updates use the guarded pattern `UPDATE ... SET status=?, revision=revision+1 WHERE id=? AND status IN (<allowed-from>)` so terminal records can never be resurrected. `queue.db` lives next to `monarch.db` in the data dir and is created lazily; tests inject a `':memory:'` handle via `createServer({ queueDb })`.
