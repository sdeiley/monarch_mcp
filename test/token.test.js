import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_TOKEN_PATH = path.join(__dirname, 'fixtures', 'test-token.json');

describe('token module', () => {
  let token;
  let savedEnv;

  before(async () => {
    token = await import('../src/token.js');
  });

  afterEach(() => {
    // Restore env
    if (savedEnv !== undefined) {
      process.env.MONARCH_TOKEN = savedEnv;
    } else {
      delete process.env.MONARCH_TOKEN;
    }
    // Clean up fixture token file
    if (fs.existsSync(FIXTURE_TOKEN_PATH)) {
      fs.unlinkSync(FIXTURE_TOKEN_PATH);
    }
  });

  describe('loadToken', () => {
    it('returns MONARCH_TOKEN env var when set', () => {
      savedEnv = process.env.MONARCH_TOKEN;
      process.env.MONARCH_TOKEN = 'env-token-123';
      assert.equal(token.loadToken(FIXTURE_TOKEN_PATH), 'env-token-123');
    });

    it('reads token from JSON file at tokenPath', () => {
      savedEnv = process.env.MONARCH_TOKEN;
      delete process.env.MONARCH_TOKEN;
      fs.writeFileSync(FIXTURE_TOKEN_PATH, JSON.stringify({ token: 'file-token-456' }));
      assert.equal(token.loadToken(FIXTURE_TOKEN_PATH), 'file-token-456');
    });

    it('env var takes priority over file', () => {
      savedEnv = process.env.MONARCH_TOKEN;
      process.env.MONARCH_TOKEN = 'env-wins';
      fs.writeFileSync(FIXTURE_TOKEN_PATH, JSON.stringify({ token: 'file-loses' }));
      assert.equal(token.loadToken(FIXTURE_TOKEN_PATH), 'env-wins');
    });

    it('throws when no env var and no file exists', () => {
      savedEnv = process.env.MONARCH_TOKEN;
      delete process.env.MONARCH_TOKEN;
      assert.throws(
        () => token.loadToken('/nonexistent/path/token.json'),
        /No auth token found/
      );
    });

    it('throws when file exists but has no token field', () => {
      savedEnv = process.env.MONARCH_TOKEN;
      delete process.env.MONARCH_TOKEN;
      fs.writeFileSync(FIXTURE_TOKEN_PATH, JSON.stringify({ source: 'test' }));
      assert.throws(
        () => token.loadToken(FIXTURE_TOKEN_PATH),
        /no token field/
      );
    });
  });

  describe('tokenStatus', () => {
    it('returns source MONARCH_TOKEN when env var set', () => {
      savedEnv = process.env.MONARCH_TOKEN;
      process.env.MONARCH_TOKEN = 'abcdefghijklmnop';
      const status = token.tokenStatus(FIXTURE_TOKEN_PATH);
      assert.equal(status.source, 'MONARCH_TOKEN environment variable');
      assert.ok(status.token.startsWith('abcdefgh'));
    });

    it('returns source none when neither env var nor file exists', () => {
      savedEnv = process.env.MONARCH_TOKEN;
      delete process.env.MONARCH_TOKEN;
      const status = token.tokenStatus('/nonexistent/path/token.json');
      assert.equal(status.source, 'none');
      assert.equal(status.token, null);
    });
  });
});
