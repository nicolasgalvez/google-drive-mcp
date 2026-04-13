/**
 * Interactive setup wizard for Google Drive MCP.
 *
 * The setup is a sequence of steps. Each step is defined once as data
 * (id, name, url, actions). The orchestrator runs each step through
 * the chosen mode (manual or Claude-assisted). State is saved after
 * every step regardless of mode.
 */

import { input, confirm, select } from '@inquirer/prompts';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { homedir } from 'os';
import {
  slugifyEmail, addAccount, getAccountSetup,
  getAccountCredentialsPath, getAccountTokenPath,
  updateAccountProject, updateStepStatus, mcpServerName,
} from './accounts.js';
import type { StepId, StepStatus } from './accounts.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SetupOptions {
  mode?: 'manual' | 'claude';
  account?: string;
  step?: string;
  gcloudAccount?: string;
  skipGcloud?: boolean;
  projectId?: string;
  createProject?: boolean;
  credentialsPath?: string;
  runAuth?: boolean;
  skipBrowser?: boolean;
}

export interface SetupStep {
  id: StepId;
  name: string;
  url: string;
  actions: string[];
}

// ── Constants ───────────────────────────────────────────────────────────────

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

/**
 * Build the list of setup steps for a project + account.
 */
export function buildSetupSteps(projectId: string, accountEmail: string): SetupStep[] {
  return [
    {
      id: 'enable-apis',
      name: 'Enable Required APIs',
      url: apiLibraryUrl(projectId),
      actions: API_DISPLAY_NAMES.map(name => `Search for and enable "Google ${name} API"`),
    },
    {
      id: 'branding',
      name: 'OAuth Consent — Branding',
      url: consentBrandingUrl(projectId),
      actions: [
        'Set "App name" to "Google Drive MCP"',
        `Set "User support email" to "${accountEmail}"`,
        `Set "Developer contact information" to "${accountEmail}"`,
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
        `Add "${accountEmail}" as a test user`,
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
  ];
}

// ── gcloud helpers ──────────────────────────────────────────────────────────

function hasGcloud(): boolean {
  try { execSync('gcloud --version', { stdio: 'ignore' }); return true; } catch { return false; }
}
function hasClaude(): boolean {
  try { execSync('claude --version', { stdio: 'ignore' }); return true; } catch { return false; }
}
function gcloud(args: string): string {
  return execSync(`gcloud ${args}`, { encoding: 'utf-8' }).trim();
}
function listGcloudAccounts(): string[] {
  try { return parseAccountList(gcloud("auth list --format='value(account)'")); } catch { return []; }
}
function getActiveAccount(): string | null {
  try { return gcloud("auth list --filter=status:ACTIVE --format='value(account)'") || null; } catch { return null; }
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

// ── Step execution — one function per mode ──────────────────────────────────

/**
 * Execute a step via Claude CLI + Chrome extension.
 */
async function executeStepWithClaude(step: SetupStep, projectId: string): Promise<void> {
  const prompt = [
    'You are automating GCP setup. The user has authorized all actions — do not ask for confirmation, just complete each step.',
    '',
    `Navigate to: ${step.url}`,
    `Make sure you are on project "${projectId}" before taking any action.`,
    '',
    'Complete these actions:',
    ...step.actions.map((a, i) => `${i + 1}. ${a}`),
    '',
    'Take a screenshot when done to verify the step completed successfully.',
  ].join('\n');

  execSync(
    'claude -p --chrome --dangerously-skip-permissions --allowedTools "mcp__claude-in-chrome__*"',
    { stdio: ['pipe', 'inherit', 'inherit'], input: prompt },
  );
}

/**
 * Execute a step manually — open browser, show instructions, wait for Enter.
 */
async function executeStepManually(step: SetupStep, skipBrowser?: boolean): Promise<void> {
  link('Open', step.url);
  if (!skipBrowser) await openInBrowser(step.url);
  instructions(step.actions.map((a, i) => `${i + 1}. ${a}`));
  await input({ message: 'Press Enter when done', default: '' });
}

// ── Exported step functions (for direct use and testing) ────────────────────

export async function resolveGcloudAccount(
  opts: Pick<SetupOptions, 'gcloudAccount' | 'skipGcloud'> = {},
): Promise<string | null> {
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
  if (account !== active) gcloud(`config set account ${account}`);
  success(`gcloud account: ${BOLD}${account}${RESET}`);
  console.log(`  ${DIM}Note: the browser may use a different Google account — you'll choose there.${RESET}`);
  return account;
}

export async function resolveProject(
  opts: Pick<SetupOptions, 'projectId' | 'createProject' | 'skipBrowser'> = {},
  gcloudAccount?: string | null,
): Promise<string> {
  if (opts.projectId) {
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
      const projectId = await input({ message: 'Project ID:', default: `gdrive-mcp-${randomSuffix}` });
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

export async function enableApis(
  projectId: string,
  opts: Pick<SetupOptions, 'skipGcloud' | 'skipBrowser'> = {},
  gcloudAccount?: string | null,
): Promise<{ success: boolean; skipped?: boolean }> {
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
    for (const name of API_DISPLAY_NAMES) console.log(`    - Google ${name} API`);
    link('API Library', apiLibraryUrl(projectId));
    if (!opts.skipBrowser) await openInBrowser(apiLibraryUrl(projectId));
    await input({ message: 'Press Enter once all APIs are enabled', default: '' });
    return { success: true };
  }
}

export async function resolveCredentials(
  projectId: string,
  opts: Pick<SetupOptions, 'credentialsPath' | 'skipBrowser'> = {},
): Promise<string> {
  if (opts.credentialsPath) return opts.credentialsPath;

  heading('Step: Locate Credentials');
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

export function storeCredentials(sourcePath: string, destPath?: string): string {
  const dest = destPath || join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'google-drive-mcp', 'gcp-oauth.keys.json',
  );
  const content = JSON.parse(readFileSync(sourcePath, 'utf-8'));
  const result = validateCredentialsJson(content);
  if (!result.valid) throw new Error(result.reason);

  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(sourcePath, dest);
  success(`Credentials saved to ${dest}`);
  return dest;
}

// ===========================================================================
// ORCHESTRATOR — one loop, both modes
// ===========================================================================

export async function runSetup(opts: SetupOptions = {}): Promise<void> {
  console.log(`\n${BOLD}Google Drive MCP — Setup Wizard${RESET}`);
  console.log(`${DIM}This will walk you through creating a Google Cloud project,`);
  console.log(`enabling APIs, and configuring OAuth credentials.${RESET}\n`);

  // ── Account ─────────────────────────────────────────────────────────────
  const accountEmail = opts.account || await input({
    message: 'Google account email (for credential storage):',
  });
  const accountSlug = slugifyEmail(accountEmail);
  addAccount(accountEmail);
  success(`Account: ${accountEmail} (${accountSlug})`);

  // ── Mode ────────────────────────────────────────────────────────────────
  const mode = opts.mode || await select({
    message: 'How would you like to complete the browser setup steps?',
    choices: [
      { name: 'Manual — I\'ll follow the instructions in my browser', value: 'manual' as const },
      { name: 'Claude-assisted — let Claude automate browser steps via Chrome extension', value: 'claude' as const },
    ],
  });

  if (mode === 'claude' && !hasClaude()) {
    warn('claude CLI not found. Install Claude Code first:');
    console.log(`  ${DIM}https://docs.anthropic.com/en/docs/claude-code${RESET}\n`);
    process.exit(1);
  }

  // ── Project ID ──────────────────────────────────────────────────────────
  const savedSetup = getAccountSetup(accountEmail);
  let projectId: string;

  if (opts.projectId) {
    projectId = opts.projectId;
  } else if (savedSetup?.projectId) {
    projectId = savedSetup.projectId;
    success(`Using saved project: ${projectId}`);
  } else if (mode === 'claude') {
    // Claude mode: no gcloud, just ask for project ID
    if (!opts.skipBrowser) await openInBrowser(projectCreateUrl());
    projectId = await input({ message: 'GCP Project ID:' });
  } else {
    // Manual mode: optionally use gcloud
    const gcloudAccount = await resolveGcloudAccount(opts);
    projectId = await resolveProject(opts, gcloudAccount);

    // If gcloud available, try enabling APIs via CLI
    if (gcloudAccount) {
      await enableApis(projectId, opts, gcloudAccount);
    }
  }

  updateAccountProject(accountEmail, projectId);

  // ── Build steps and filter ──────────────────────────────────────────────
  let steps = buildSetupSteps(projectId, accountEmail);

  if (opts.step) {
    const match = steps.find(s => s.id === opts.step);
    if (!match) {
      warn(`Unknown step: ${opts.step}`);
      console.log(`  Available steps: ${steps.map(s => s.id).join(', ')}`);
      process.exit(1);
    }
    steps = [match];
  }

  // ── Execute steps — same loop for both modes ────────────────────────────
  for (const step of steps) {
    // Skip steps already done (unless explicitly targeted with --step)
    if (!opts.step && savedSetup?.steps[step.id] === 'done') {
      console.log(`  ${DIM}${step.name} — already done, skipping${RESET}`);
      continue;
    }

    heading(step.name);

    try {
      if (mode === 'claude') {
        link('URL', step.url);
        console.log('  Running Claude...');
        await executeStepWithClaude(step, projectId);
      } else {
        await executeStepManually(step, opts.skipBrowser);
      }
      success(`${step.name} — done`);
      updateStepStatus(accountEmail, step.id, 'done');
    } catch (e: any) {
      warn(`${step.name} — failed`);
      updateStepStatus(accountEmail, step.id, 'failed');
      if (mode === 'claude') {
        const cont = await confirm({ message: 'Continue to next step?', default: true });
        if (!cont) process.exit(1);
      }
    }
  }

  // ── Credentials file ────────────────────────────────────────────────────
  if (!opts.step || opts.step === 'credentials') {
    let credentialsPath: string;
    if (opts.credentialsPath) {
      credentialsPath = opts.credentialsPath;
    } else if (mode === 'claude') {
      // Auto-pick most recent credential file
      const matches = findMatchingFiles('~/Downloads/client_secret*.json');
      if (matches.length === 0) {
        warn('No client_secret*.json found in ~/Downloads.');
        console.log(`  Download credentials and run: npm run setup -- --account ${accountEmail} --step credentials`);
        process.exit(1);
      }
      credentialsPath = matches[0];
      success(`Found credentials: ${credentialsPath.replace(homedir(), '~')}`);
    } else {
      credentialsPath = await resolveCredentials(projectId, opts);
    }

    heading('Storing Credentials');
    storeCredentials(credentialsPath, getAccountCredentialsPath(accountSlug));
  }

  // ── Auth ────────────────────────────────────────────────────────────────
  if (!opts.step) {
    heading('Authenticate');
    const shouldRunAuth = opts.runAuth ?? await confirm({
      message: 'Run OAuth authentication now?',
      default: true,
    });

    if (shouldRunAuth) {
      console.log('  Starting OAuth flow...\n');
      const { runAuthCommand } = await import('./auth.js');
      await runAuthCommand(accountSlug);
      updateStepStatus(accountEmail, 'auth', 'done');
    } else {
      console.log(`  Run ${BOLD}npm run auth --account ${accountEmail}${RESET} when ready.\n`);
    }

    const serverName = mcpServerName(accountEmail);
    heading('Setup Complete!');
    console.log('  Add to Claude Code:\n');
    console.log(`  ${DIM}claude mcp add -s user ${serverName} node /path/to/dist/index.js -- --account ${accountEmail}${RESET}\n`);
  }
}
