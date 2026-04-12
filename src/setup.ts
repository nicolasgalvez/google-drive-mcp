/**
 * Interactive setup wizard for Google Drive MCP.
 *
 * Each step is an exported async function that accepts optional params.
 * When params are provided, interactive prompts are skipped — enabling
 * both TDD and non-interactive automation (e.g. Claude-assisted mode).
 *
 * runSetup(opts?) orchestrates all steps. Pass SetupOptions to pre-fill
 * any prompt answer.
 */

import { input, confirm, select } from '@inquirer/prompts';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { homedir } from 'os';
import {
  slugifyEmail, addAccount,
  getAccountCredentialsPath, getAccountTokenPath,
} from './accounts.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SetupOptions {
  mode?: 'manual' | 'claude';
  account?: string;  // email address for account namespacing
  gcloudAccount?: string;
  skipGcloud?: boolean;
  projectId?: string;
  createProject?: boolean;
  credentialsPath?: string;
  runAuth?: boolean;
  skipBrowser?: boolean;
}

// ── Exported constants ──────────────────────────────────────────────────────

export const REQUIRED_APIS = [
  'drive.googleapis.com',
  'docs.googleapis.com',
  'sheets.googleapis.com',
  'slides.googleapis.com',
  'calendar-json.googleapis.com',
];

export const API_DISPLAY_NAMES = ['Drive', 'Docs', 'Sheets', 'Slides', 'Calendar'];

export const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
];

// ── URL builders ────────────────────────────────────────────────────────────

export function apiLibraryUrl(project: string): string {
  return `https://console.cloud.google.com/apis/library?project=${project}`;
}

export function consentBrandingUrl(project: string): string {
  return `https://console.cloud.google.com/auth/branding?project=${project}`;
}

export function consentAudienceUrl(project: string): string {
  return `https://console.cloud.google.com/auth/audience?project=${project}`;
}

export function consentScopesUrl(project: string): string {
  return `https://console.cloud.google.com/auth/scopes?project=${project}`;
}

export function credentialsUrl(project: string): string {
  return `https://console.cloud.google.com/apis/credentials/oauthclient?project=${project}`;
}

export function projectCreateUrl(): string {
  return 'https://console.cloud.google.com/projectcreate';
}

// ── Pure helpers ────────────────────────────────────────────────────────────

export function validateCredentialsJson(content: unknown): { valid: true } | { valid: false; reason: string } {
  if (typeof content !== 'object' || content === null) {
    return { valid: false, reason: 'File is not a JSON object' };
  }
  const obj = content as Record<string, unknown>;
  const creds = obj.installed || obj.web || obj;
  if (typeof creds !== 'object' || creds === null) {
    return { valid: false, reason: 'Missing "installed" or "web" object' };
  }
  const inner = creds as Record<string, unknown>;
  if (!inner.client_id || typeof inner.client_id !== 'string') {
    return { valid: false, reason: 'No client_id found in credentials file' };
  }
  return { valid: true };
}

export function parseAccountList(output: string): string[] {
  return output.split('\n').map(a => a.trim()).filter(Boolean);
}

export function findMatchingFiles(pattern: string): string[] {
  const expanded = pattern.trim().replace(/^~/, homedir());
  try {
    const result = execSync(`ls -t ${expanded} 2>/dev/null`, { encoding: 'utf-8' }).trim();
    return result.split('\n').filter(f => f && existsSync(f));
  } catch { return []; }
}

export function resolveFilePath(input: string): string | null {
  const p = input.trim().replace(/^~/, homedir());
  if (p.includes('*')) {
    const matches = findMatchingFiles(p);
    return matches[0] ?? null;
  }
  const abs = resolve(p);
  return existsSync(abs) ? abs : null;
}

export function buildClaudeAssistedPlan(projectId: string, accountEmail?: string): object {
  const email = accountEmail || 'the logged-in user\'s email';
  return {
    description: 'Google Drive MCP — browser setup steps for Claude Code to automate via Chrome extension',
    project: projectId,
    accountEmail: accountEmail || null,
    credentialsDestination: getDefaultCredentialsPath(),
    steps: [
      {
        id: 'enable-apis',
        name: 'Enable Required APIs',
        url: apiLibraryUrl(projectId),
        actions: [
          ...API_DISPLAY_NAMES.map(name => `Search for and enable "Google ${name} API"`),
        ],
      },
      {
        id: 'branding',
        name: 'OAuth Consent — Branding',
        url: consentBrandingUrl(projectId),
        actions: [
          'Set "App name" to "Google Drive MCP"',
          `Set "User support email" to "${email}"`,
          `Set "Developer contact information" to "${email}"`,
          'Click "Save"',
        ],
      },
      {
        id: 'audience',
        name: 'OAuth Consent — Audience & Test Users',
        url: consentAudienceUrl(projectId),
        actions: [
          'User type should be "External" (or "Internal" for Google Workspace)',
          'Click "+ Add Users"',
          `Add "${email}" as a test user`,
          'Click "Save"',
        ],
      },
      {
        id: 'scopes',
        name: 'OAuth Consent — Scopes',
        url: consentScopesUrl(projectId),
        actions: [
          'Click "Add or Remove Scopes"',
          ...REQUIRED_SCOPES.map(scope => `Add scope: ${scope}`),
          'Click "Update" then "Save"',
        ],
      },
      {
        id: 'credentials',
        name: 'Create OAuth Client Credentials',
        url: credentialsUrl(projectId),
        actions: [
          'Set "Application type" to "Desktop app"',
          'Set "Name" to "Google Drive MCP"',
          'Click "Create"',
          'Click "Download JSON" to save the credentials file',
        ],
      },
    ],
    afterBrowserSteps: [
      'Copy the downloaded JSON to the credentialsDestination path',
      'Run: node dist/index.js auth',
    ],
  };
}

function getDefaultCredentialsPath(): string {
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'google-drive-mcp',
    'gcp-oauth.keys.json',
  );
}

// ── gcloud helpers ──────────────────────────────────────────────────────────

function hasGcloud(): boolean {
  try {
    execSync('gcloud --version', { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function hasClaude(): boolean {
  try {
    execSync('claude --version', { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function gcloud(args: string): string {
  return execSync(`gcloud ${args}`, { encoding: 'utf-8' }).trim();
}

function listGcloudAccounts(): string[] {
  try {
    return parseAccountList(gcloud("auth list --format='value(account)'"));
  } catch { return []; }
}

function getActiveAccount(): string | null {
  try {
    return gcloud("auth list --filter=status:ACTIVE --format='value(account)'") || null;
  } catch { return null; }
}

// ── Console formatting ──────────────────────────────────────────────────────

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function heading(text: string) { console.log(`\n${BOLD}${text}${RESET}\n`); }
function success(text: string) { console.log(`${GREEN}  ✓ ${text}${RESET}`); }
function warn(text: string) { console.log(`${YELLOW}  ! ${text}${RESET}`); }
function link(text: string, url: string) { console.log(`  ${text}: ${CYAN}${url}${RESET}`); }
function instructions(lines: string[]) { for (const l of lines) console.log(`  ${DIM}${l}${RESET}`); }

async function openInBrowser(url: string) {
  const open = (await import('open')).default;
  await open(url);
}

async function pressEnter(message = 'Press Enter when done') {
  await input({ message, default: '' });
}

// ===========================================================================
// STEP FUNCTIONS — each accepts optional params to skip prompts
// ===========================================================================

/**
 * Step 0: Resolve which gcloud account to use for CLI automation.
 * Returns the account email, or null if gcloud should not be used.
 */
export async function resolveGcloudAccount(
  opts: Pick<SetupOptions, 'gcloudAccount' | 'skipGcloud'> = {},
): Promise<string | null> {
  // Pre-filled: return immediately
  if (opts.gcloudAccount) return opts.gcloudAccount;
  if (opts.skipGcloud) return null;

  if (!hasGcloud()) {
    warn('gcloud CLI not found — some steps will need to be done manually in the browser.');
    console.log(`  ${DIM}Install from: https://cloud.google.com/sdk/docs/install${RESET}\n`);
    return null;
  }

  const accounts = listGcloudAccounts();
  if (accounts.length === 0) {
    warn('gcloud is installed but not authenticated.');
    console.log('  Run: gcloud auth login\n');
    const proceed = await confirm({ message: 'Continue without gcloud automation?', default: true });
    if (!proceed) process.exit(0);
    return null;
  }

  const active = getActiveAccount();
  const choices = accounts.map(a => ({
    name: a === active ? `${a} (active)` : a,
    value: a,
  }));
  choices.push({ name: 'Skip gcloud — I\'ll do everything in the browser', value: '__skip__' });

  const account = await select({
    message: 'Which Google account to use for gcloud project/API setup?',
    choices,
    default: active || undefined,
  });

  if (account === '__skip__') return null;

  if (account !== active) {
    gcloud(`config set account ${account}`);
  }

  success(`gcloud account: ${BOLD}${account}${RESET}`);
  console.log(`  ${DIM}Note: the browser may use a different Google account — you'll choose there.${RESET}`);
  return account;
}

/**
 * Step 1: Resolve or create a GCP project.
 * Returns the project ID.
 */
export async function resolveProject(
  opts: Pick<SetupOptions, 'projectId' | 'createProject' | 'skipBrowser'> = {},
  gcloudAccount?: string | null,
): Promise<string> {
  // Pre-filled: return immediately
  if (opts.projectId) {
    // If createProject requested with a projectId, create it via gcloud
    if (opts.createProject && gcloudAccount) {
      try {
        console.log(`  Creating project ${BOLD}${opts.projectId}${RESET}...`);
        gcloud(`projects create ${opts.projectId}`);
        success('Project created.');
      } catch (e: any) {
        warn(`Project creation failed (may already exist): ${e.message?.split('\n')[0]}`);
      }
    }
    return opts.projectId;
  }

  heading('Step 1: Google Cloud Project');

  if (gcloudAccount) {
    const createNew = await select({
      message: 'Create a new GCP project or use an existing one?',
      choices: [
        { name: 'Create new project', value: 'new' },
        { name: 'Use existing project', value: 'existing' },
      ],
    });

    if (createNew === 'new') {
      const randomSuffix = Math.random().toString(36).substring(2, 8);
      const projectId = await input({
        message: 'Project ID:',
        default: `gdrive-mcp-${randomSuffix}`,
      });
      try {
        console.log(`  Creating project ${BOLD}${projectId}${RESET}...`);
        gcloud(`projects create ${projectId}`);
        success('Project created.');
      } catch (e: any) {
        warn(`Project creation failed (may already exist): ${e.message?.split('\n')[0]}`);
      }
      return projectId;
    } else {
      return await input({ message: 'Existing project ID:' });
    }
  } else {
    console.log('  Create or select a project in the Google Cloud Console:');
    link('Console', projectCreateUrl());
    if (!opts.skipBrowser) await openInBrowser(projectCreateUrl());
    return await input({ message: 'Enter your project ID:' });
  }
}

/**
 * Step 2: Enable required Google APIs for the project.
 */
export async function enableApis(
  projectId: string,
  opts: Pick<SetupOptions, 'skipGcloud' | 'skipBrowser'> = {},
  gcloudAccount?: string | null,
): Promise<{ success: boolean; skipped?: boolean }> {
  // If skipping gcloud, just report success (used in testing or when APIs already enabled)
  if (opts.skipGcloud || (!gcloudAccount && opts.skipBrowser)) {
    return { success: true, skipped: true };
  }

  heading('Step 2: Enable Required APIs');

  if (gcloudAccount && !opts.skipGcloud) {
    console.log(`  Enabling ${API_DISPLAY_NAMES.join(', ')} APIs...`);
    try {
      gcloud(`services enable ${REQUIRED_APIS.join(' ')} --project=${projectId}`);
      success('All APIs enabled.');
      return { success: true };
    } catch (e: any) {
      warn(`API enablement issue: ${e.message?.split('\n')[0]}`);
      console.log('  You may need to enable billing or enable them manually:');
      link('API Library', apiLibraryUrl(projectId));
      return { success: false };
    }
  } else {
    console.log('  Enable these APIs in the API Library:');
    for (const name of API_DISPLAY_NAMES) {
      console.log(`    - Google ${name} API`);
    }
    link('API Library', apiLibraryUrl(projectId));
    if (!opts.skipBrowser) await openInBrowser(apiLibraryUrl(projectId));
    await pressEnter('Press Enter once all APIs are enabled');
    return { success: true };
  }
}

/**
 * Step 3 (manual mode): Walk through OAuth consent screen configuration.
 */
async function configureConsent(
  projectId: string,
  accountEmail: string,
  opts: Pick<SetupOptions, 'skipBrowser'> = {},
): Promise<void> {
  heading('Step 3: OAuth Consent Screen');
  console.log('  Configure the OAuth consent screen in three sub-steps:\n');

  // 3a: Branding
  console.log(`  ${BOLD}3a. Branding${RESET}`);
  link('Open', consentBrandingUrl(projectId));
  if (!opts.skipBrowser) await openInBrowser(consentBrandingUrl(projectId));
  instructions([
    '1. Set App name (e.g. "Google Drive MCP")',
    `2. Set User support email to ${accountEmail}`,
    `3. Set Developer contact to ${accountEmail}`,
    '4. Click "Save"',
  ]);
  await pressEnter();

  // 3b: Audience
  console.log(`\n  ${BOLD}3b. Audience & Test Users${RESET}`);
  link('Open', consentAudienceUrl(projectId));
  if (!opts.skipBrowser) await openInBrowser(consentAudienceUrl(projectId));
  instructions([
    '1. Choose "External" (or "Internal" for Workspace)',
    '2. Click "+ Add Users"',
    `3. Add ${accountEmail} as a test user`,
    '4. Click "Save"',
  ]);
  await pressEnter();

  // 3c: Scopes
  console.log(`\n  ${BOLD}3c. Data Access / Scopes (recommended)${RESET}`);
  link('Open', consentScopesUrl(projectId));
  if (!opts.skipBrowser) await openInBrowser(consentScopesUrl(projectId));
  instructions([
    '1. Click "Add or Remove Scopes"',
    '2. Add these scopes:',
    ...REQUIRED_SCOPES.map(s => `   - ${s}`),
    '3. Click "Save"',
  ]);
  await pressEnter();
}

/**
 * Step 4: Resolve the path to the downloaded credentials JSON file.
 * Returns the absolute path.
 */
export async function resolveCredentials(
  projectId: string,
  opts: Pick<SetupOptions, 'credentialsPath' | 'skipBrowser'> = {},
): Promise<string> {
  // Pre-filled: return immediately
  if (opts.credentialsPath) return opts.credentialsPath;

  heading('Step 4: Create OAuth Credentials');

  link('Open', credentialsUrl(projectId));
  if (!opts.skipBrowser) await openInBrowser(credentialsUrl(projectId));
  instructions([
    '1. Application type: "Desktop app"',
    '2. Name: "Google Drive MCP" (or anything)',
    '3. Click "Create"',
    '4. Click "Download JSON"',
  ]);
  console.log('');

  const CREDENTIALS_GLOB = '~/Downloads/client_secret*.json';
  const matches = findMatchingFiles(CREDENTIALS_GLOB);

  if (matches.length > 0) {
    const choices = matches.map(f => ({
      name: f.replace(homedir(), '~'),
      value: f,
    }));
    choices.push({ name: 'Enter a different path...', value: '__manual__' });

    const picked = await select({
      message: `Found ${matches.length} credential file${matches.length > 1 ? 's' : ''} in ~/Downloads:`,
      choices,
    });

    if (picked !== '__manual__') return picked;
  } else {
    console.log(`  ${DIM}No client_secret*.json files found in ~/Downloads${RESET}`);
  }

  const manual = await input({
    message: 'Path to downloaded JSON file:',
    validate: (val) => resolveFilePath(val) ? true : 'File not found.',
  });
  return resolveFilePath(manual)!;
}

/**
 * Step 5: Validate and copy credentials to the config directory.
 * Returns the destination path.
 */
export function storeCredentials(sourcePath: string, destPath?: string): string {
  const dest = destPath || getDefaultCredentialsPath();

  const content = JSON.parse(readFileSync(sourcePath, 'utf-8'));
  const result = validateCredentialsJson(content);
  if (!result.valid) {
    throw new Error(result.reason);
  }

  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(sourcePath, dest);
  success(`Credentials saved to ${dest}`);
  return dest;
}

// ===========================================================================
// ORCHESTRATOR
// ===========================================================================

export async function runSetup(opts: SetupOptions = {}): Promise<void> {
  console.log(`\n${BOLD}Google Drive MCP — Setup Wizard${RESET}`);
  console.log(`${DIM}This will walk you through creating a Google Cloud project,`);
  console.log(`enabling APIs, and configuring OAuth credentials.${RESET}\n`);

  // Account — ask for email to namespace credential storage
  const accountEmail = opts.account || await input({
    message: 'Google account email (for credential storage):',
  });
  const accountSlug = slugifyEmail(accountEmail);
  addAccount(accountEmail);
  success(`Account: ${accountEmail} (${accountSlug})`);

  // Mode selection
  const mode = opts.mode || await select({
    message: 'How would you like to complete the browser setup steps?',
    choices: [
      { name: 'Manual — I\'ll follow the instructions in my browser', value: 'manual' as const },
      { name: 'Claude-assisted — let Claude automate browser steps via Chrome extension', value: 'claude' as const },
    ],
  });

  // ── Claude-assisted: invoke claude CLI for each browser step ────────
  if (mode === 'claude') {
    if (!hasClaude()) {
      warn('claude CLI not found. Install Claude Code first:');
      console.log(`  ${DIM}https://docs.anthropic.com/en/docs/claude-code${RESET}\n`);
      process.exit(1);
    }

    // First: have the user sign into GCP and create/select a project
    heading('Step 1: Sign in to Google Cloud');
    console.log('  Before automation can begin, please:');
    console.log('  1. Sign in to the Google Cloud Console');
    console.log('  2. Accept the Terms of Service if prompted');
    console.log('  3. Create or select a project\n');

    if (!opts.skipBrowser) {
      await openInBrowser('https://console.cloud.google.com/projectcreate');
    }
    const projectId = opts.projectId || await input({ message: 'Enter the project ID:' });

    const plan = buildClaudeAssistedPlan(projectId, accountEmail);
    const steps = (plan as any).steps as { id: string; name: string; url: string; actions: string[] }[];

    heading('Claude-Assisted Setup');
    console.log('  Claude will now automate the remaining browser steps.\n');

    for (const step of steps) {
      heading(`${step.name}`);
      link('URL', step.url);

      const prompt = [
        `You are automating GCP setup. The user has authorized all actions — do not ask for confirmation, just complete each step.`,
        ``,
        `Navigate to: ${step.url}`,
        `Make sure you are on project "${projectId}" before taking any action.`,
        ``,
        `Complete these actions:`,
        ...step.actions.map((a, i) => `${i + 1}. ${a}`),
        ``,
        `Take a screenshot when done to verify the step completed successfully.`,
      ].join('\n');

      console.log(`  Running Claude...`);
      try {
        execSync(
          `claude -p --chrome --dangerously-skip-permissions --allowedTools "mcp__claude-in-chrome__*"`,
          { stdio: ['pipe', 'inherit', 'inherit'], input: prompt },
        );
        success(`${step.name} — done`);
      } catch (e: any) {
        warn(`${step.name} — Claude exited with an error`);
        const retry = await confirm({ message: 'Continue to next step?', default: true });
        if (!retry) process.exit(1);
      }
    }

    // After browser steps: auto-find the most recent credentials file
    heading('Step: Store Credentials');
    const matches = findMatchingFiles('~/Downloads/client_secret*.json');
    if (matches.length === 0) {
      warn('No client_secret*.json found in ~/Downloads');
      console.log('  Please download the JSON from the OAuth client page and run:');
      console.log(`  ${BOLD}npm run setup -- --mode manual --project-id ${projectId}${RESET}\n`);
      process.exit(1);
    }
    const credentialsPath = matches[0]; // most recent
    success(`Found credentials: ${credentialsPath.replace(homedir(), '~')}`);
    storeCredentials(credentialsPath, getAccountCredentialsPath(accountSlug));

    // Auth
    heading('Step: Authenticate');
    const shouldRunAuth = opts.runAuth ?? await confirm({
      message: 'Run OAuth authentication now?',
      default: true,
    });

    if (shouldRunAuth) {
      console.log('  Starting OAuth flow...\n');
      const { runAuthCommand } = await import('./auth.js');
      await runAuthCommand(accountSlug);
    } else {
      console.log(`  Run ${BOLD}npm run auth${RESET} (or ${BOLD}npx google-drive-mcp auth${RESET}) when ready.\n`);
    }

    heading('Setup Complete!');
    console.log('  Configure your MCP client with:\n');
    console.log(`  ${DIM}{`);
    console.log(`    "mcpServers": {`);
    console.log(`      "google-drive": {`);
    console.log(`        "command": "npx",`);
    console.log(`        "args": ["@piotr-agier/google-drive-mcp"]`);
    console.log(`      }`);
    console.log(`    }`);
    console.log(`  }${RESET}\n`);
    return;
  }

  // ── Manual mode: use gcloud where available ───────────────────────────
  const gcloudAccount = await resolveGcloudAccount(opts);
  const projectId = await resolveProject(opts, gcloudAccount);
  await enableApis(projectId, opts, gcloudAccount);

  // Skip consent + credential download if credentials already provided
  let credentialsPath: string;
  if (opts.credentialsPath) {
    credentialsPath = opts.credentialsPath;
  } else {
    await configureConsent(projectId, accountEmail, opts);
    credentialsPath = await resolveCredentials(projectId, opts);
  }

  heading('Step 5: Storing Credentials');
  storeCredentials(credentialsPath, getAccountCredentialsPath(accountSlug));

  heading('Step 6: Authenticate');
  const shouldRunAuth = opts.runAuth ?? await confirm({
    message: 'Run OAuth authentication now?',
    default: true,
  });

  if (shouldRunAuth) {
    console.log('  Starting OAuth flow...\n');
    const { runAuthCommand } = await import('./auth.js');
    await runAuthCommand(accountSlug);
  } else {
    console.log(`  Run ${BOLD}npm run auth${RESET} (or ${BOLD}npx google-drive-mcp auth${RESET}) when ready.\n`);
  }

  heading('Setup Complete!');
  console.log('  Configure your MCP client with:\n');
  console.log(`  ${DIM}{`);
  console.log(`    "mcpServers": {`);
  console.log(`      "google-drive": {`);
  console.log(`        "command": "npx",`);
  console.log(`        "args": ["@piotr-agier/google-drive-mcp"]`);
  console.log(`      }`);
  console.log(`    }`);
  console.log(`  }${RESET}\n`);
}
