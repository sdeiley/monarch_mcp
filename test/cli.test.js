import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'src', 'bin', 'cli.js');
const TEST_DATA_DIR = path.join(__dirname, 'fixtures', 'cli-test-data');

function run(args, env = {}) {
  return execSync(`node ${CLI} ${args}`, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 5000,
  }).trim();
}

describe('CLI', () => {
  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    }
  });

  it('--help prints usage with available commands', () => {
    const output = run('--help');
    assert.ok(output.includes('monarch-mcp'), 'should mention monarch-mcp');
    assert.ok(output.includes('init'), 'should list init command');
    assert.ok(output.includes('refresh'), 'should list refresh command');
    assert.ok(output.includes('serve'), 'should list serve command');
  });

  it('unknown command prints help', () => {
    const output = run('bogus');
    assert.ok(output.includes('monarch-mcp'), 'should print help for unknown command');
  });

  it('init creates data directory', () => {
    run('init', { MONARCH_DATA_DIR: TEST_DATA_DIR });
    assert.ok(fs.existsSync(TEST_DATA_DIR), 'data dir should be created');
  });

  it('init is idempotent', () => {
    run('init', { MONARCH_DATA_DIR: TEST_DATA_DIR });
    run('init', { MONARCH_DATA_DIR: TEST_DATA_DIR });
    assert.ok(fs.existsSync(TEST_DATA_DIR), 'data dir should still exist');
  });

  it('init prints setup instructions', () => {
    const output = run('init', { MONARCH_DATA_DIR: TEST_DATA_DIR });
    assert.ok(output.includes('MONARCH_TOKEN') || output.includes('token'),
      'should mention token setup');
  });

  it('refresh without token prints error', () => {
    // Ensure no token is available
    assert.throws(
      () => run('refresh', {
        MONARCH_DATA_DIR: TEST_DATA_DIR,
        MONARCH_TOKEN: '',
        HOME: '/tmp/nonexistent-home',
      }),
      /token|error/i
    );
  });
});
