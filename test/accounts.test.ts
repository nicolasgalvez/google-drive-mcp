import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  slugifyEmail,
  listAccounts,
  addAccount,
  getDefaultAccount,
  setDefaultAccount,
  getAccountDir,
  getAccountCredentialsPath,
  getAccountTokenPath,
} from '../src/accounts.js';

// ---------------------------------------------------------------------------
// slugifyEmail
// ---------------------------------------------------------------------------
test('slugifyEmail converts email to filesystem-safe slug', () => {
  assert.equal(slugifyEmail('nick@simaccweb.com'), 'nick-at-simaccweb-com');
});

test('slugifyEmail handles gmail', () => {
  assert.equal(slugifyEmail('nicholas.galvez@gmail.com'), 'nicholas-galvez-at-gmail-com');
});

test('slugifyEmail handles uppercase', () => {
  assert.equal(slugifyEmail('Nick@Example.COM'), 'nick-at-example-com');
});

test('slugifyEmail handles subdomains', () => {
  assert.equal(slugifyEmail('user@mail.company.co.uk'), 'user-at-mail-company-co-uk');
});

test('slugifyEmail handles plus addressing', () => {
  assert.equal(slugifyEmail('user+tag@gmail.com'), 'user-tag-at-gmail-com');
});

// ---------------------------------------------------------------------------
// Account registry (uses temp dir)
// ---------------------------------------------------------------------------
const TEMP_CONFIG = join(tmpdir(), `accounts-test-${Date.now()}`);
mkdirSync(TEMP_CONFIG, { recursive: true });

// Override config dir for testing
const origEnv = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = TEMP_CONFIG;

test('listAccounts returns empty when no accounts.json exists', () => {
  const accounts = listAccounts();
  assert.deepEqual(accounts, []);
});

test('addAccount creates registry and returns slug', () => {
  const slug = addAccount('nick@simaccweb.com');
  assert.equal(slug, 'nick-at-simaccweb-com');
});

test('addAccount sets first account as default', () => {
  const accounts = listAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].email, 'nick@simaccweb.com');
  assert.equal(accounts[0].default, true);
});

test('addAccount adds second account without making it default', () => {
  addAccount('work@company.com');
  const accounts = listAccounts();
  assert.equal(accounts.length, 2);
  const work = accounts.find(a => a.email === 'work@company.com');
  assert.equal(work?.default, false);
});

test('addAccount is idempotent — adding same email again does not duplicate', () => {
  addAccount('nick@simaccweb.com');
  const accounts = listAccounts();
  assert.equal(accounts.length, 2);
});

test('getDefaultAccount returns the default account slug', () => {
  const slug = getDefaultAccount();
  assert.equal(slug, 'nick-at-simaccweb-com');
});

test('setDefaultAccount changes the default', () => {
  setDefaultAccount('work@company.com');
  const slug = getDefaultAccount();
  assert.equal(slug, 'work-at-company-com');

  // Previous default is no longer default
  const accounts = listAccounts();
  const nick = accounts.find(a => a.email === 'nick@simaccweb.com');
  assert.equal(nick?.default, false);
});

test('setDefaultAccount throws for unknown email', () => {
  assert.throws(() => setDefaultAccount('unknown@example.com'), /not found/);
});

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------
test('getAccountDir returns path under accounts/', () => {
  const dir = getAccountDir('nick-at-simaccweb-com');
  assert.ok(dir.includes('google-drive-mcp'));
  assert.ok(dir.includes('accounts'));
  assert.ok(dir.includes('nick-at-simaccweb-com'));
});

test('getAccountCredentialsPath returns gcp-oauth.keys.json in account dir', () => {
  const p = getAccountCredentialsPath('nick-at-simaccweb-com');
  assert.ok(p.endsWith('gcp-oauth.keys.json'));
  assert.ok(p.includes('nick-at-simaccweb-com'));
});

test('getAccountTokenPath returns tokens.json in account dir', () => {
  const p = getAccountTokenPath('nick-at-simaccweb-com');
  assert.ok(p.endsWith('tokens.json'));
  assert.ok(p.includes('nick-at-simaccweb-com'));
});

// Cleanup
test('cleanup accounts test', () => {
  rmSync(TEMP_CONFIG, { recursive: true, force: true });
  if (origEnv !== undefined) {
    process.env.XDG_CONFIG_HOME = origEnv;
  } else {
    delete process.env.XDG_CONFIG_HOME;
  }
});
