#!/usr/bin/env node

/**
 * Monarch MCP CLI entry point.
 * Usage: monarch-mcp <command>
 *
 * Commands:
 *   init      Create data directory and show setup instructions
 *   refresh   Fetch transactions from Monarch API and update local DB
 *   serve     Start the MCP server (stdio transport)
 */

import fs from 'node:fs';
import { resolveDataDir } from '../config.js';
import { loadToken } from '../token.js';
import { refreshDb } from '../refresh.js';

const command = process.argv[2];

switch (command) {
  case 'init':
    runInit();
    break;
  case 'refresh':
    await runRefresh();
    break;
  case 'serve':
    await runServe();
    break;
  default:
    printHelp();
}

function printHelp() {
  console.log(`monarch-mcp — MCP server for Monarch Money

Usage: monarch-mcp <command>

Commands:
  init      Create data directory and show setup instructions
  refresh   Fetch transactions from Monarch API and update local DB
  serve     Start the MCP server (stdio transport)

Environment:
  MONARCH_TOKEN      Auth token (required for refresh)
  MONARCH_DATA_DIR   Data directory (default: ~/.monarch)`);
}

function runInit() {
  const dataDir = resolveDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  console.log(`Data directory ready: ${dataDir}`);
  console.log(`
Next steps:
  1. Set your Monarch auth token:
     export MONARCH_TOKEN=<your-token>
     Or create ~/.monarch-token with: {"token": "<your-token>"}

  2. Fetch your transactions:
     monarch-mcp refresh

  3. Add to your MCP config (.mcp.json):
     {"mcpServers": {"monarch": {"type": "stdio", "command": "npx", "args": ["monarch-mcp", "serve"]}}}`);
}

async function runRefresh() {
  const mode = process.argv.includes('--full') ? 'full' : 'recent';
  const token = loadToken();
  console.error(mode === 'full' ? 'Fetching ALL transactions...' : 'Fetching recent transactions...');
  const result = await refreshDb(token, {
    mode,
    onBatch: (batch, fetched, total) => {
      console.error(`  Batch ${batch}: ${fetched}/${total}`);
    },
  });
  console.log(result.message);
}

async function runServe() {
  const { main } = await import('./stdio.js');
  await main();
}
