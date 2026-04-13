import { OAuth2Client } from 'google-auth-library';
import { authenticate as googleAuthenticate } from '@google-cloud/local-auth';
import { TokenManager } from './tokenManager.js';
import { getKeysFilePaths } from './utils.js';
import { resolveOAuthScopes } from './scopes.js';
import { existsSync } from 'fs';

const SCOPES = resolveOAuthScopes();

export class AuthServer {
  private baseOAuth2Client: OAuth2Client;
  private tokenManager: TokenManager;
  private accountSlug?: string;
  public authCompletedSuccessfully = false;

  constructor(oauth2Client: OAuth2Client, accountSlug?: string) {
    this.baseOAuth2Client = oauth2Client;
    this.accountSlug = accountSlug;
    this.tokenManager = new TokenManager(oauth2Client, accountSlug);
  }

  async start(openBrowser = true): Promise<boolean> {
    // Check for existing valid tokens first
    if (await this.tokenManager.validateTokens()) {
      this.authCompletedSuccessfully = true;
      return true;
    }

    // Find the credentials file
    const keyfilePath = getKeysFilePaths(this.accountSlug).find(p => existsSync(p));
    if (!keyfilePath) {
      console.error('No credentials file found. Run setup first.');
      return false;
    }

    console.error('\n🔐 AUTHENTICATION REQUIRED');
    console.error('══════════════════════════════════════════');
    console.error('\nOpening your browser to authenticate...\n');

    try {
      // Use @google-cloud/local-auth — handles redirect URIs, ports, and token exchange correctly
      const client = await googleAuthenticate({
        keyfilePath,
        scopes: SCOPES,
      });

      if (client.credentials) {
        await this.tokenManager.saveTokens(client.credentials);
        // Also set credentials on the base client
        this.baseOAuth2Client.setCredentials(client.credentials);
        this.authCompletedSuccessfully = true;
        console.error('Authentication tokens saved.');
        return true;
      }

      return false;
    } catch (error) {
      console.error('Authentication failed:', error);
      this.authCompletedSuccessfully = false;
      return false;
    }
  }

  async stop(): Promise<void> {
    // No-op — @google-cloud/local-auth manages its own server lifecycle
  }
}
