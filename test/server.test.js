import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Point to fixture DB
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.MONARCH_DATA_DIR = path.join(__dirname, 'fixtures');

describe('MCP Server module', () => {
  it('exports a createServer function', async () => {
    const mod = await import('../src/server.js');
    assert.equal(typeof mod.createServer, 'function');
  });

  it('createServer returns an McpServer instance', async () => {
    const { createServer } = await import('../src/server.js');
    const server = createServer();
    assert.ok(server);
    assert.equal(typeof server.connect, 'function');
  });

  it('server has the expected name and version', async () => {
    const { SERVER_NAME, SERVER_VERSION } = await import('../src/server.js');
    assert.equal(SERVER_NAME, 'monarch-money');
    assert.equal(SERVER_VERSION, '0.7.0');
  });
});

describe('MCP stdio entry point', () => {
  it('bin/stdio.js exists and is importable', async () => {
    const mod = await import('../src/bin/stdio.js');
    assert.equal(typeof mod.main, 'function');
  });
});
