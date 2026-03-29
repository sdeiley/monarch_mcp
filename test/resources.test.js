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

describe('MCP Resources registration', () => {
  let client, close;

  before(async () => {
    ({ client, close } = await createTestPair());
  });

  after(async () => { await close(); });

  it('lists all four expected resources', async () => {
    const result = await client.listResources();
    const uris = result.resources.map(r => r.uri);

    assert.ok(uris.includes('monarch://accounts'), 'should have accounts resource');
    assert.ok(uris.includes('monarch://categories'), 'should have categories resource');
    assert.ok(uris.includes('monarch://tags'), 'should have tags resource');
    assert.ok(uris.includes('monarch://schema'), 'should have schema resource');
    assert.equal(result.resources.length, 4, 'should have exactly 4 resources');
  });

  it('each resource has a description and mimeType', async () => {
    const result = await client.listResources();
    for (const resource of result.resources) {
      assert.ok(resource.description, `${resource.uri} should have a description`);
      assert.equal(resource.mimeType, 'application/json',
        `${resource.uri} should have JSON mimeType`);
    }
  });
});

describe('monarch://schema resource', () => {
  let client, close;

  before(async () => { ({ client, close } = await createTestPair()); });
  after(async () => { await close(); });

  it('returns schema text with table definition', async () => {
    const result = await client.readResource({ uri: 'monarch://schema' });

    assert.ok(result.contents.length > 0, 'should return contents');
    const text = result.contents[0].text;
    assert.ok(text.includes('TABLE: transactions'), 'should include table definition');
    assert.ok(text.includes('amount'), 'should include amount column');
    assert.ok(text.includes('category_name'), 'should include category_name column');
    assert.ok(text.includes('Metadata:'), 'should include metadata section');
  });
});

describe('monarch://accounts resource', () => {
  let client, close;

  before(async () => { ({ client, close } = await createTestPair()); });
  after(async () => { await close(); });

  it('returns JSON array of accounts with txn counts', async () => {
    const result = await client.readResource({ uri: 'monarch://accounts' });
    const data = JSON.parse(result.contents[0].text);

    assert.ok(Array.isArray(data), 'should return an array');
    assert.ok(data.length > 0, 'should have at least one account');
    assert.ok('account_name' in data[0], 'each row should have account_name');
    assert.ok('txn_count' in data[0], 'each row should have txn_count');
    assert.equal(typeof data[0].txn_count, 'number', 'txn_count should be a number');
  });

  it('accounts are sorted by txn count descending', async () => {
    const result = await client.readResource({ uri: 'monarch://accounts' });
    const data = JSON.parse(result.contents[0].text);

    for (let i = 1; i < data.length; i++) {
      assert.ok(data[i - 1].txn_count >= data[i].txn_count,
        `account ${i - 1} (${data[i - 1].txn_count}) should have >= txns than account ${i} (${data[i].txn_count})`);
    }
  });
});

describe('monarch://categories resource', () => {
  let client, close;

  before(async () => { ({ client, close } = await createTestPair()); });
  after(async () => { await close(); });

  it('returns JSON array of categories with type info', async () => {
    const result = await client.readResource({ uri: 'monarch://categories' });
    const data = JSON.parse(result.contents[0].text);

    assert.ok(Array.isArray(data), 'should return an array');
    assert.ok(data.length > 0, 'should have at least one category');
    assert.ok('category_name' in data[0], 'should have category_name');
    assert.ok('category_type' in data[0], 'should have category_type');
  });

  it('categories include all three types', async () => {
    const result = await client.readResource({ uri: 'monarch://categories' });
    const data = JSON.parse(result.contents[0].text);
    const types = new Set(data.map(c => c.category_type));

    assert.ok(types.has('expense'), 'should have expense categories');
    assert.ok(types.has('income'), 'should have income categories');
    assert.ok(types.has('transfer'), 'should have transfer categories');
  });
});

describe('monarch://tags resource', () => {
  let client, close;

  before(async () => { ({ client, close } = await createTestPair()); });
  after(async () => { await close(); });

  it('returns JSON array of unique tag names', async () => {
    const result = await client.readResource({ uri: 'monarch://tags' });
    const data = JSON.parse(result.contents[0].text);

    assert.ok(Array.isArray(data), 'should return an array');
    for (const tag of data) {
      assert.equal(typeof tag, 'string', 'each tag should be a string');
    }
    const unique = new Set(data);
    assert.equal(unique.size, data.length, 'tags should be unique');
  });

  it('tags are sorted alphabetically', async () => {
    const result = await client.readResource({ uri: 'monarch://tags' });
    const data = JSON.parse(result.contents[0].text);
    const sorted = [...data].sort((a, b) => a.localeCompare(b));

    assert.deepEqual(data, sorted, 'tags should be alphabetically sorted');
  });
});
