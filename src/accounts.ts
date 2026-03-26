/**
 * Multi-account credential storage.
 *
 * Each Google account gets its own directory under
 * ~/.config/google-drive-mcp/accounts/{slug}/ containing
 * gcp-oauth.keys.json and tokens.json.
 *
 * The registry (accounts.json) maps emails to slugs and tracks
 * which account is the default.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ── Types ───────────────────────────────────────────────────────────────────

interface AccountEntry {
  slug: string;
  default: boolean;
}

interface AccountRegistry {
  [email: string]: AccountEntry;
}

export interface AccountInfo {
  email: string;
  slug: string;
  default: boolean;
}

// ── Config directory ────────────────────────────────────────────────────────

function getConfigDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configHome, 'google-drive-mcp');
}

function getRegistryPath(): string {
  return join(getConfigDir(), 'accounts.json');
}

function readRegistry(): AccountRegistry {
  const path = getRegistryPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

function writeRegistry(registry: AccountRegistry): void {
  const configDir = getConfigDir();
  mkdirSync(configDir, { recursive: true });
  writeFileSync(getRegistryPath(), JSON.stringify(registry, null, 2));
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Convert an email address to a filesystem-safe slug.
 * nick@simaccweb.com → nick-at-simaccweb-com
 */
export function slugifyEmail(email: string): string {
  return email
    .toLowerCase()
    .replace(/@/g, '-at-')
    .replace(/[.+]/g, '-');
}

/**
 * List all registered accounts.
 */
export function listAccounts(): AccountInfo[] {
  const registry = readRegistry();
  return Object.entries(registry).map(([email, entry]) => ({
    email,
    slug: entry.slug,
    default: entry.default,
  }));
}

/**
 * Add an account to the registry. Returns the slug.
 * First account added becomes the default.
 * Idempotent — adding an existing email is a no-op.
 */
export function addAccount(email: string): string {
  const registry = readRegistry();
  const slug = slugifyEmail(email);

  if (registry[email]) return registry[email].slug;

  const isFirst = Object.keys(registry).length === 0;
  registry[email] = { slug, default: isFirst };
  writeRegistry(registry);

  // Create the account directory
  mkdirSync(getAccountDir(slug), { recursive: true });

  return slug;
}

/**
 * Get the default account slug, or null if no accounts exist.
 */
export function getDefaultAccount(): string | null {
  const registry = readRegistry();
  for (const entry of Object.values(registry)) {
    if (entry.default) return entry.slug;
  }
  return null;
}

/**
 * Set which account is the default.
 */
export function setDefaultAccount(email: string): void {
  const registry = readRegistry();
  if (!registry[email]) {
    throw new Error(`Account "${email}" not found in registry`);
  }

  for (const entry of Object.values(registry)) {
    entry.default = false;
  }
  registry[email].default = true;
  writeRegistry(registry);
}

/**
 * Get the directory for an account's credentials and tokens.
 */
export function getAccountDir(slug: string): string {
  return join(getConfigDir(), 'accounts', slug);
}

/**
 * Get the credentials file path for an account.
 */
export function getAccountCredentialsPath(slug: string): string {
  return join(getAccountDir(slug), 'gcp-oauth.keys.json');
}

/**
 * Get the token file path for an account.
 */
export function getAccountTokenPath(slug: string): string {
  return join(getAccountDir(slug), 'tokens.json');
}
