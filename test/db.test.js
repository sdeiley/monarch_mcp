import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DB = path.join(__dirname, 'fixtures', 'monarch.db');

describe('db module', () => {
  let db;

  before(async () => {
    db = await import('../src/db.js');
  });

  describe('queryDb', () => {
    it('returns array of row objects for a SELECT', () => {
      const rows = db.queryDb('SELECT * FROM transactions', FIXTURE_DB);
      assert.ok(Array.isArray(rows));
      assert.equal(rows.length, 5);
    });

    it('filters correctly with WHERE clause', () => {
      const rows = db.queryDb(
        "SELECT * FROM transactions WHERE category_type = 'expense'",
        FIXTURE_DB
      );
      assert.equal(rows.length, 3);
      for (const row of rows) {
        assert.equal(row.category_type, 'expense');
      }
    });

    it('supports WITH (CTE) queries', () => {
      const rows = db.queryDb(
        `WITH summary AS (
           SELECT category_type, COUNT(*) AS n FROM transactions GROUP BY category_type
         )
         SELECT * FROM summary ORDER BY n DESC`,
        FIXTURE_DB
      );
      assert.ok(rows.length > 0);
      assert.ok('category_type' in rows[0]);
      assert.ok('n' in rows[0]);
    });

    it('rejects INSERT statements', () => {
      assert.throws(
        () => db.queryDb("INSERT INTO transactions (id) VALUES ('evil')", FIXTURE_DB),
        /Only SELECT/
      );
    });

    it('rejects DELETE statements', () => {
      assert.throws(
        () => db.queryDb('DELETE FROM transactions', FIXTURE_DB),
        /Only SELECT/
      );
    });

    it('throws when DB file not found', () => {
      assert.throws(
        () => db.queryDb('SELECT 1', '/nonexistent/path/monarch.db'),
        /Database not found/
      );
    });
  });

  describe('getSchema', () => {
    it('returns schema string containing TABLE: transactions', () => {
      const result = db.getSchema(FIXTURE_DB);
      assert.ok(result.schema.includes('TABLE: transactions'));
      assert.ok(result.schema.includes('amount'));
      assert.ok(result.schema.includes('category_name'));
    });

    it('returns metadata array with expected keys', () => {
      const result = db.getSchema(FIXTURE_DB);
      assert.ok(Array.isArray(result.metadata));
      const keys = result.metadata.map(m => m.key);
      assert.ok(keys.includes('fetchedAt'));
      assert.ok(keys.includes('total_count'));
      assert.ok(keys.includes('imported_at'));
    });
  });
});
