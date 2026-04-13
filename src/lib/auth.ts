/**
 * Credential helpers for nark authentication.
 * Credentials are stored at ~/.nark/credentials as a JSON file with mode 0o600.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface NarkCredentials {
  token: string;
  email: string;
  orgName: string;
  plan: string;
}

const CREDENTIALS_PATH = path.join(os.homedir(), '.nark', 'credentials');

/**
 * Returns the path to the credentials file.
 */
export function getCredentialsPath(): string {
  return CREDENTIALS_PATH;
}

/**
 * Writes credentials to ~/.nark/credentials.
 * Creates the ~/.nark/ directory if it does not exist.
 * Sets file permissions to 0o600 (owner read/write only).
 */
export function writeCredentials(creds: NarkCredentials): void {
  const dir = path.dirname(CREDENTIALS_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), 'utf-8');
  fs.chmodSync(CREDENTIALS_PATH, 0o600);
}

/**
 * Reads credentials from ~/.nark/credentials.
 * Returns null if the file does not exist, cannot be parsed, or is missing required fields.
 */
export function getCredentials(): NarkCredentials | null {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.token === 'string' &&
      typeof parsed.email === 'string' &&
      typeof parsed.orgName === 'string' &&
      typeof parsed.plan === 'string'
    ) {
      return parsed as NarkCredentials;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Returns the stored token, or null if not logged in.
 */
export function getToken(): string | null {
  return getCredentials()?.token ?? null;
}

/**
 * Returns true if a valid token is stored.
 */
export function isLoggedIn(): boolean {
  return getToken() !== null;
}

/**
 * Deletes the credentials file. Safe to call even if the file does not exist.
 */
export function deleteCredentials(): void {
  fs.rmSync(CREDENTIALS_PATH, { force: true });
}
