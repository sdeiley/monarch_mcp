import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

describe('config module', () => {
  let config;

  before(async () => {
    config = await import('../src/config.js');
  });

  it('exports defaultDataDir as ~/.monarch', () => {
    assert.equal(config.defaultDataDir, path.join(os.homedir(), '.monarch'));
  });

  it('resolveDataDir returns ~/.monarch by default', () => {
    const saved = process.env.MONARCH_DATA_DIR;
    delete process.env.MONARCH_DATA_DIR;
    try {
      assert.equal(config.resolveDataDir(), path.join(os.homedir(), '.monarch'));
    } finally {
      if (saved !== undefined) process.env.MONARCH_DATA_DIR = saved;
    }
  });

  it('resolveDataDir returns MONARCH_DATA_DIR env var when set', () => {
    const saved = process.env.MONARCH_DATA_DIR;
    process.env.MONARCH_DATA_DIR = '/tmp/test-monarch';
    try {
      assert.equal(config.resolveDataDir(), '/tmp/test-monarch');
    } finally {
      if (saved !== undefined) process.env.MONARCH_DATA_DIR = saved;
      else delete process.env.MONARCH_DATA_DIR;
    }
  });

  it('resolveDbPath returns <dataDir>/monarch.db', () => {
    assert.equal(
      config.resolveDbPath('/some/dir'),
      path.join('/some/dir', 'monarch.db')
    );
  });

  it('resolveDbPath with no arg uses resolveDataDir()', () => {
    const saved = process.env.MONARCH_DATA_DIR;
    delete process.env.MONARCH_DATA_DIR;
    try {
      assert.equal(
        config.resolveDbPath(),
        path.join(os.homedir(), '.monarch', 'monarch.db')
      );
    } finally {
      if (saved !== undefined) process.env.MONARCH_DATA_DIR = saved;
    }
  });
});
