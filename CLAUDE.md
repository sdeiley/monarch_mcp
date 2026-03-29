# Monarch MCP Server

Standalone MCP server for Monarch Money personal finance data. Extracted from [monarch_chrome_extension](https://github.com/sdeiley/monarch_chrome_extension).

## Repository Structure

```
src/
  config.js        # Data dir + DB path resolution (MONARCH_DATA_DIR env var)
  db.js            # SQLite read-only query layer (node:sqlite DatabaseSync)
  token.js         # Auth token loader (env var or ~/.monarch-token file)
  fetch.js         # Monarch GraphQL API transaction fetcher
  import.js        # JSON → SQLite importer with upsert + pending prune
  refresh.js       # Async orchestrator: fetch → import
  server.js        # MCP server factory: 4 resources + 2 tools
  bin/
    stdio.js       # stdio transport entry point
    cli.js         # CLI: init, refresh, serve
test/
  *.test.js        # node:test suite (62 tests)
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
npm test                          # All 62 tests
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

- `query_transactions(sql)` — Read-only SQL (SELECT/WITH only)
- `refresh_transactions(mode)` — `recent` (3 months) or `full` (all history)
