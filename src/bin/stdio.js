#!/usr/bin/env node

/**
 * Monarch MCP Server — stdio transport entry point.
 * Used by Claude Code CLI via MCP configuration.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../server.js';

export async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Monarch MCP server running on stdio');
}

// Only auto-run when executed directly, not when imported by tests
const isDirectRun = process.argv[1]?.endsWith('stdio.js') &&
                    !process.argv[1]?.includes('test');
if (isDirectRun) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
