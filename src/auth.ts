// Main authentication module that re-exports and orchestrates the modular components
import { initializeOAuth2Client } from './auth/client.js';
import { AuthServer } from './auth/server.js';
import { TokenManager } from './auth/tokenManager.js';
import {
  isServiceAccountMode, createServiceAccountAuth,
  isExternalTokenMode, validateExternalTokenConfig,
  createExternalOAuth2Client,
} from './auth/externalAuth.js';

export { TokenManager } from './auth/tokenManager.js';
export { initializeOAuth2Client } from './auth/client.js';
export { AuthServer } from './auth/server.js';
export { SCOPE_ALIASES, SCOPE_PRESETS, DEFAULT_SCOPES, resolveOAuthScopes } from './auth/scopes.js';
export {
  isServiceAccountMode, createServiceAccountAuth,
  isExternalTokenMode, validateExternalTokenConfig,
  createExternalOAuth2Client,
} from './auth/externalAuth.js';

/**
 * Authenticate and return OAuth2 client
 * This is the main entry point for authentication in the MCP server
 */
export async function authenticate(accountSlug?: string): Promise<any> {
  console.error('Initializing authentication...');

  // Priority 1: Service account
  if (isServiceAccountMode()) {
    return await createServiceAccountAuth();
  }

  // Priority 2: External OAuth tokens
  if (isExternalTokenMode()) {
    validateExternalTokenConfig();
    return createExternalOAuth2Client();
  }

  // Priority 3: Existing local OAuth flow

  // Initialize OAuth2 client
  const oauth2Client = await initializeOAuth2Client(accountSlug);
  const tokenManager = new TokenManager(oauth2Client, accountSlug);

  // Try to validate existing tokens
  if (await tokenManager.validateTokens()) {
    console.error('Authentication successful - using existing tokens');
    console.error('OAuth2Client credentials:', {
      hasAccessToken: !!oauth2Client.credentials?.access_token,
      hasRefreshToken: !!oauth2Client.credentials?.refresh_token,
      expiryDate: oauth2Client.credentials?.expiry_date
    });
    return oauth2Client;
  }

  // No valid tokens — don't open a browser automatically.
  // The user should authenticate explicitly via `auth` command or /mcp in Claude Code.
  throw new Error(
    'Not authenticated. Run authentication first:\n' +
    (accountSlug
      ? `  node dist/index.js auth --account <email>\n`
      : '  node dist/index.js auth\n') +
    'Or use /mcp in Claude Code to authenticate.'
  );
}

/**
 * Manual authentication command
 * Used when running "npm run auth" or when the user needs to re-authenticate
 */
export async function runAuthCommand(accountSlug?: string): Promise<void> {
  try {
    console.error('Google Drive MCP - Manual Authentication');
    console.error('════════════════════════════════════════\n');

    const oauth2Client = await initializeOAuth2Client(accountSlug);
    const authServer = new AuthServer(oauth2Client, accountSlug);
    const success = await authServer.start(true);

    if (success) {
      console.error("\n✅ Authentication successful!");
      console.error("You can now use the Google Drive MCP server.");
      process.exit(0);
    } else {
      console.error("Authentication failed.");
      process.exit(1);
    }
  } catch (error) {
    console.error("\n❌ Authentication failed:", error);
    process.exit(1);
  }
}