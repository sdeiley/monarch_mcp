import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Point to fixture DB
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.MONARCH_DATA_DIR = path.join(__dirname, 'fixtures');

async function createTestPair() {
  const { createServer } = await import('../src/server.js');
  const server = createServer();
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { server, client, close: () => Promise.all([server.close(), client.close()]) };
}

describe('MCP Tools registration', () => {
  let client, close;

  before(async () => { ({ client, close } = await createTestPair()); });
  after(async () => { await close(); });

  it('lists both expected tools', async () => {
    const result = await client.listTools();
    const names = result.tools.map(t => t.name);

    assert.ok(names.includes('query_transactions'), 'should have query_transactions');
    assert.ok(names.includes('refresh_transactions'), 'should have refresh_transactions');
    assert.equal(result.tools.length, 2, 'should have exactly 2 tools');
  });

  it('each tool has a description and inputSchema', async () => {
    const result = await client.listTools();
    for (const tool of result.tools) {
      assert.ok(tool.description, `${tool.name} should have a description`);
      assert.ok(tool.inputSchema, `${tool.name} should have an inputSchema`);
    }
  });
});

describe('query_transactions tool', () => {
  let client, close;

  before(async () => { ({ client, close } = await createTestPair()); });
  after(async () => { await close(); });

  it('executes a simple SELECT and returns JSON results', async () => {
    const result = await client.callTool({
      name: 'query_transactions',
      arguments: { sql: 'SELECT COUNT(*) AS n FROM transactions' },
    });

    assert.ok(!result.isError, 'should not be an error');
    const text = result.content[0].text;
    const data = JSON.parse(text);
    assert.ok(Array.isArray(data), 'should return an array');
    assert.equal(data.length, 1, 'COUNT should return one row');
    assert.ok(data[0].n > 0, 'should have transactions');
  });

  it('supports complex queries with WHERE, GROUP BY, ORDER BY', async () => {
    const result = await client.callTool({
      name: 'query_transactions',
      arguments: {
        sql: `SELECT category_name, COUNT(*) AS n
              FROM transactions
              WHERE category_type = 'expense'
              GROUP BY category_name
              ORDER BY n DESC
              LIMIT 3`,
      },
    });

    const data = JSON.parse(result.content[0].text);
    assert.ok(data.length > 0, 'should return rows');
    assert.ok('category_name' in data[0], 'should have category_name');
    assert.ok('n' in data[0], 'should have count');
  });

  it('supports WITH (CTE) queries', async () => {
    const result = await client.callTool({
      name: 'query_transactions',
      arguments: {
        sql: `WITH monthly AS (
                SELECT SUBSTR(date, 1, 7) AS month, SUM(amount) AS total
                FROM transactions
                WHERE category_type = 'expense'
                GROUP BY month
              )
              SELECT month, total FROM monthly ORDER BY month DESC LIMIT 1`,
      },
    });

    const data = JSON.parse(result.content[0].text);
    assert.equal(data.length, 1);
    assert.ok('month' in data[0]);
    assert.ok('total' in data[0]);
  });

  it('rejects INSERT statements', async () => {
    const result = await client.callTool({
      name: 'query_transactions',
      arguments: { sql: "INSERT INTO transactions (id) VALUES ('evil')" },
    });

    assert.ok(result.isError, 'should be an error');
    const text = result.content[0].text;
    assert.ok(text.includes('SELECT') || text.includes('Only'), 'should mention SELECT restriction');
  });

  it('rejects DELETE statements', async () => {
    const result = await client.callTool({
      name: 'query_transactions',
      arguments: { sql: 'DELETE FROM transactions' },
    });

    assert.ok(result.isError, 'should be an error');
  });

  it('rejects DROP statements', async () => {
    const result = await client.callTool({
      name: 'query_transactions',
      arguments: { sql: 'DROP TABLE transactions' },
    });

    assert.ok(result.isError, 'should be an error');
  });

  it('returns empty array for queries with no results', async () => {
    const result = await client.callTool({
      name: 'query_transactions',
      arguments: {
        sql: "SELECT * FROM transactions WHERE merchant_name = 'XYZNONEXISTENT999' LIMIT 1",
      },
    });

    const data = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 0);
  });

  it('returns a helpful error for malformed SQL', async () => {
    const result = await client.callTool({
      name: 'query_transactions',
      arguments: { sql: 'SELECT FROM WHERE BROKEN' },
    });

    assert.ok(result.isError, 'should be an error');
  });
});

describe('refresh_transactions tool', () => {
  let client, close;

  before(async () => { ({ client, close } = await createTestPair()); });
  after(async () => { await close(); });

  it('has mode parameter accepting recent or full', async () => {
    const result = await client.listTools();
    const tool = result.tools.find(t => t.name === 'refresh_transactions');
    const props = tool.inputSchema.properties;

    assert.ok('mode' in props, 'should have mode parameter');
  });
});
