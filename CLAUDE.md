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
  server.js        # MCP server factory: 4 resources + 10 tools
  bin/
    stdio.js       # stdio transport entry point
    cli.js         # CLI: init, refresh, serve
test/
  *.test.js        # node:test suite (135 tests)
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
npm test                          # All 135 tests
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

Rule API quirks (both verified live 2026-07-15): (1) `deleteTransactionRule` returns `deleted: false` even on successful deletes — `deleteRule` treats the absence of payload errors as success and only echoes the raw field as `apiDeletedField`. (2) `updateTransactionRuleV2` silently ignores partial inputs while reporting success — `update_rule` therefore does fetch-merge-write: it loads the rule via `getRules`, merges the caller's fields over the full current state, converts read shapes to write shapes (`setCategoryAction` object → category ID, `setMerchantAction` object → merchant NAME, `addTagsAction` objects → tag IDs), and sends the complete input. Fields outside the `getRules` selection (goal-link, business-entity, notification, needs-review-by-user actions) are not round-tripped.

The recommendation queue (queue.db + `queue_*` tools) moved out of this server in v0.6.0: it is extension-specific and now lives in the monarch_chrome_extension repo's `mcp-queue/` server, alongside its producer.
