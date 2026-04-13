import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  REQUIRED_APIS,
  API_DISPLAY_NAMES,
  REQUIRED_SCOPES,
  apiLibraryUrl,
  consentBrandingUrl,
  consentAudienceUrl,
  consentScopesUrl,
  credentialsUrl,
  projectCreateUrl,
  validateCredentialsJson,
  parseAccountList,
  resolveFilePath,
  findMatchingFiles,
  buildSetupSteps,
  // Step functions
  resolveGcloudAccount,
  resolveProject,
  enableApis,
  resolveCredentials,
  storeCredentials,
} from '../src/setup.js';

// ---------------------------------------------------------------------------
// REQUIRED_APIS & API_DISPLAY_NAMES
// ---------------------------------------------------------------------------
test('REQUIRED_APIS has 5 entries', () => {
  assert.equal(REQUIRED_APIS.length, 5);
});

test('API_DISPLAY_NAMES has matching count', () => {
  assert.equal(API_DISPLAY_NAMES.length, REQUIRED_APIS.length);
});

test('REQUIRED_APIS contains drive, docs, sheets, slides, calendar', () => {
  assert.ok(REQUIRED_APIS.some(a => a.includes('drive')));
  assert.ok(REQUIRED_APIS.some(a => a.includes('docs')));
  assert.ok(REQUIRED_APIS.some(a => a.includes('sheets')));
  assert.ok(REQUIRED_APIS.some(a => a.includes('slides')));
  assert.ok(REQUIRED_APIS.some(a => a.includes('calendar')));
});

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------
test('apiLibraryUrl includes project ID', () => {
  const url = apiLibraryUrl('my-project');
  assert.ok(url.includes('project=my-project'));
  assert.ok(url.includes('console.cloud.google.com'));
});

test('consentBrandingUrl includes project ID', () => {
  const url = consentBrandingUrl('test-proj');
  assert.ok(url.includes('project=test-proj'));
  assert.ok(url.includes('/auth/branding'));
});

test('consentAudienceUrl includes project ID', () => {
  const url = consentAudienceUrl('test-proj');
  assert.ok(url.includes('project=test-proj'));
  assert.ok(url.includes('/auth/audience'));
});

test('consentScopesUrl includes project ID', () => {
  const url = consentScopesUrl('test-proj');
  assert.ok(url.includes('project=test-proj'));
  assert.ok(url.includes('/auth/scopes'));
});

test('credentialsUrl includes project ID', () => {
  const url = credentialsUrl('test-proj');
  assert.ok(url.includes('project=test-proj'));
  assert.ok(url.includes('oauthclient'));
});

test('projectCreateUrl returns console URL', () => {
  const url = projectCreateUrl();
  assert.ok(url.includes('console.cloud.google.com'));
  assert.ok(url.includes('projectcreate'));
});

test('URL builders handle special characters in project IDs', () => {
  const url = apiLibraryUrl('my-project-123');
  assert.ok(url.includes('project=my-project-123'));
});

// ---------------------------------------------------------------------------
// validateCredentialsJson
// ---------------------------------------------------------------------------
test('validates "installed" format credentials', () => {
  const result = validateCredentialsJson({
    installed: {
      client_id: '123.apps.googleusercontent.com',
      client_secret: 'secret',
      redirect_uris: ['http://localhost'],
    },
  });
  assert.deepEqual(result, { valid: true });
});

test('validates "web" format credentials', () => {
  const result = validateCredentialsJson({
    web: {
      client_id: '123.apps.googleusercontent.com',
      client_secret: 'secret',
    },
  });
  assert.deepEqual(result, { valid: true });
});

test('validates flat format with client_id at top level', () => {
  const result = validateCredentialsJson({
    client_id: '123.apps.googleusercontent.com',
  });
  assert.deepEqual(result, { valid: true });
});

test('rejects null', () => {
  const result = validateCredentialsJson(null);
  assert.equal(result.valid, false);
  assert.ok('reason' in result && result.reason.includes('not a JSON object'));
});

test('rejects non-object', () => {
  const result = validateCredentialsJson('string');
  assert.equal(result.valid, false);
});

test('rejects object without client_id', () => {
  const result = validateCredentialsJson({ installed: { project_id: 'test' } });
  assert.equal(result.valid, false);
  assert.ok('reason' in result && result.reason.includes('client_id'));
});

test('rejects empty object', () => {
  const result = validateCredentialsJson({});
  assert.equal(result.valid, false);
});

test('rejects client_id that is not a string', () => {
  const result = validateCredentialsJson({ client_id: 123 });
  assert.equal(result.valid, false);
});

// ---------------------------------------------------------------------------
// parseAccountList
// ---------------------------------------------------------------------------
test('parseAccountList splits newline-separated accounts', () => {
  const result = parseAccountList('alice@gmail.com\nbob@gmail.com\n');
  assert.deepEqual(result, ['alice@gmail.com', 'bob@gmail.com']);
});

test('parseAccountList handles single account', () => {
  const result = parseAccountList('alice@gmail.com');
  assert.deepEqual(result, ['alice@gmail.com']);
});

test('parseAccountList filters blank lines', () => {
  const result = parseAccountList('\n\nalice@gmail.com\n\n');
  assert.deepEqual(result, ['alice@gmail.com']);
});

test('parseAccountList returns empty for empty string', () => {
  const result = parseAccountList('');
  assert.deepEqual(result, []);
});

test('parseAccountList trims whitespace', () => {
  const result = parseAccountList('  alice@gmail.com  \n  bob@gmail.com  ');
  assert.deepEqual(result, ['alice@gmail.com', 'bob@gmail.com']);
});

// ---------------------------------------------------------------------------
// resolveFilePath & findMatchingFiles
// ---------------------------------------------------------------------------

const TEMP_DIR = join(tmpdir(), `setup-test-${Date.now()}`);
mkdirSync(TEMP_DIR, { recursive: true });

const testFile = join(TEMP_DIR, 'test-creds.json');
writeFileSync(testFile, '{}');

test('resolveFilePath resolves absolute path to existing file', () => {
  assert.equal(resolveFilePath(testFile), testFile);
});

test('resolveFilePath returns null for non-existent file', () => {
  assert.equal(resolveFilePath(join(TEMP_DIR, 'nope.json')), null);
});

test('resolveFilePath trims whitespace', () => {
  assert.equal(resolveFilePath(`  ${testFile}  `), testFile);
});

test('resolveFilePath resolves glob matching a file', () => {
  assert.equal(resolveFilePath(join(TEMP_DIR, 'test-*.json')), testFile);
});

test('resolveFilePath returns null for glob with no matches', () => {
  assert.equal(resolveFilePath(join(TEMP_DIR, 'nope-*.json')), null);
});

test('findMatchingFiles returns matching files', () => {
  const result = findMatchingFiles(join(TEMP_DIR, 'test-*.json'));
  assert.equal(result.length, 1);
  assert.equal(result[0], testFile);
});

test('findMatchingFiles returns empty for no matches', () => {
  assert.deepEqual(findMatchingFiles(join(TEMP_DIR, 'nope-*.json')), []);
});

test('findMatchingFiles returns multiple files sorted by mtime', () => {
  const file2 = join(TEMP_DIR, 'test-second.json');
  writeFileSync(file2, '{}');
  const result = findMatchingFiles(join(TEMP_DIR, 'test-*.json'));
  assert.equal(result.length, 2);
  assert.equal(result[0], file2);
});

// ---------------------------------------------------------------------------
// buildSetupSteps
// ---------------------------------------------------------------------------
test('buildSetupSteps returns all 5 steps', () => {
  const steps = buildSetupSteps('my-project', 'user@test.com');
  assert.equal(steps.length, 5);
  assert.equal(steps[0].id, 'enable-apis');
  assert.equal(steps[1].id, 'branding');
  assert.equal(steps[2].id, 'audience');
  assert.equal(steps[3].id, 'scopes');
  assert.equal(steps[4].id, 'credentials');
});

test('buildSetupSteps includes project in URLs', () => {
  const steps = buildSetupSteps('test-proj-123', 'user@test.com');
  for (const step of steps) {
    assert.ok(step.url.includes('test-proj-123'));
  }
});

test('buildSetupSteps scopes step lists all required scopes', () => {
  const steps = buildSetupSteps('my-project', 'user@test.com');
  const scopeStep = steps.find(s => s.id === 'scopes')!;
  for (const scope of REQUIRED_SCOPES) {
    assert.ok(
      scopeStep.actions.some(a => a.includes(scope)),
      `Missing scope: ${scope}`,
    );
  }
});

test('buildSetupSteps includes account email in branding and audience steps', () => {
  const steps = buildSetupSteps('my-project', 'test@example.com');
  const branding = steps.find(s => s.id === 'branding')!;
  const audience = steps.find(s => s.id === 'audience')!;

  assert.ok(branding.actions.some(a => a.includes('test@example.com')),
    'branding should include account email for support email');
  assert.ok(audience.actions.some(a => a.includes('test@example.com')),
    'audience should include account email as test user');
});

// ===========================================================================
// STEP FUNCTION TESTS
// ===========================================================================

// ---------------------------------------------------------------------------
// resolveGcloudAccount
// ---------------------------------------------------------------------------
test('resolveGcloudAccount returns provided account immediately', async () => {
  const result = await resolveGcloudAccount({ gcloudAccount: 'test@example.com' });
  assert.equal(result, 'test@example.com');
});

test('resolveGcloudAccount returns null when skipGcloud is true', async () => {
  const result = await resolveGcloudAccount({ skipGcloud: true });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// resolveProject
// ---------------------------------------------------------------------------
test('resolveProject returns provided projectId immediately', async () => {
  const result = await resolveProject({ projectId: 'my-existing-project' });
  assert.equal(result, 'my-existing-project');
});

// ---------------------------------------------------------------------------
// enableApis
// ---------------------------------------------------------------------------
test('enableApis returns success when skipGcloud is true', async () => {
  const result = await enableApis('test-project', { skipGcloud: true, skipBrowser: true });
  assert.equal(result.success, true);
  assert.equal(result.skipped, true);
});

// ---------------------------------------------------------------------------
// resolveCredentials
// ---------------------------------------------------------------------------
test('resolveCredentials returns provided path immediately', async () => {
  const result = await resolveCredentials('test-project', { credentialsPath: '/tmp/creds.json' });
  assert.equal(result, '/tmp/creds.json');
});

// ---------------------------------------------------------------------------
// storeCredentials
// ---------------------------------------------------------------------------

const STORE_TEMP = join(tmpdir(), `setup-store-test-${Date.now()}`);
mkdirSync(STORE_TEMP, { recursive: true });

test('storeCredentials copies valid credentials to dest', () => {
  const src = join(STORE_TEMP, 'source-creds.json');
  const destDir = join(STORE_TEMP, 'config');
  const dest = join(destDir, 'gcp-oauth.keys.json');
  writeFileSync(src, JSON.stringify({
    installed: { client_id: '123.apps.googleusercontent.com', client_secret: 'secret' },
  }));

  const result = storeCredentials(src, dest);
  assert.equal(result, dest);
  assert.ok(existsSync(dest));

  const content = JSON.parse(readFileSync(dest, 'utf-8'));
  assert.equal(content.installed.client_id, '123.apps.googleusercontent.com');
});

test('storeCredentials throws for invalid credentials JSON', () => {
  const src = join(STORE_TEMP, 'bad-creds.json');
  const dest = join(STORE_TEMP, 'config2', 'gcp-oauth.keys.json');
  writeFileSync(src, JSON.stringify({ foo: 'bar' }));

  assert.throws(() => storeCredentials(src, dest), /client_id/);
});

test('storeCredentials throws for non-existent source file', () => {
  const dest = join(STORE_TEMP, 'config3', 'gcp-oauth.keys.json');
  assert.throws(() => storeCredentials('/tmp/nonexistent-xyz.json', dest));
});

// Cleanup temp directories
test('cleanup temp dirs', () => {
  rmSync(TEMP_DIR, { recursive: true, force: true });
  rmSync(STORE_TEMP, { recursive: true, force: true });
});
