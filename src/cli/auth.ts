/**
 * CLI Command: auth
 * Authenticate the nark CLI with nark.sh using the device-flow pattern.
 *
 * nark auth login   — open browser, print code, poll for token, write credentials
 * nark auth logout  — delete credentials
 *
 * Top-level aliases (share the exact same action callbacks):
 *   nark login   — alias for `nark auth login`
 *   nark logout  — alias for `nark auth logout`
 */

import { Command } from 'commander';
import * as crypto from 'crypto';
import chalk from 'chalk';
import open from 'open';
import { writeCredentials, deleteCredentials } from '../lib/auth.js';

const POLL_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 150; // 5 minutes

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Action callback for `nark login` / `nark auth login`.
 * Opens a browser to nark.sh/auth/cli?code=XXX, then polls the exchange
 * endpoint every 2s for up to 5 minutes for the user to approve.
 * On success: writes credentials and exits 0. On timeout: exits 1.
 */
export async function loginAction(): Promise<void> {
  // 1. Generate a random 6-character uppercase code
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();

  // 2. Build URLs
  const NARK_API_BASE = process.env['NARK_API_URL'] ?? 'https://app.nark.sh';
  const browserUrl = `${NARK_API_BASE}/auth/cli?code=${code}`;
  const pollUrl = `${NARK_API_BASE}/api/auth/cli/exchange?code=${code}`;

  // 3. Open browser (best-effort)
  try {
    await open(browserUrl);
  } catch {
    // Browser open failed — user can visit the URL manually
  }

  // 4. Print waiting message
  console.log(`Opening nark.sh in your browser...`);
  console.log(`Waiting for authentication (code: ${chalk.bold(code)})`);

  // 5. Poll for up to 5 minutes
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    try {
      const res = await fetch(pollUrl);

      if (res.status === 202 || res.status === 404) {
        // Not ready yet — keep polling
        continue;
      }

      if (!res.ok) {
        // Non-success HTTP status — warn and continue polling
        process.stderr.write(
          chalk.dim(`\nWarning: unexpected poll response ${res.status}, retrying...\n`)
        );
        continue;
      }

      // res.ok === true (status 200-299) — parse the token and write credentials
      let body: { token: string; user: { email: string; orgName: string; plan: string } };
      try {
        body = await res.json() as typeof body;
      } catch (jsonErr) {
        const detail = jsonErr instanceof SyntaxError ? jsonErr.message : String(jsonErr);
        process.stderr.write(chalk.dim(`\nWarning: failed to parse auth response JSON (${detail}), retrying...\n`));
        continue;
      }
      writeCredentials({
        token: body.token,
        email: body.user.email,
        orgName: body.user.orgName,
        plan: body.user.plan,
      });
      console.log(
        `\nLogged in as ${chalk.green(body.user.email)} (${body.user.orgName}, ${body.user.plan} plan)`
      );
      process.exit(0);
    } catch (err) {
      // Network error — warn and continue polling
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(chalk.dim(`\nWarning: poll request failed (${msg}), retrying...\n`));
    }
  }

  // 6. Timed out
  process.stderr.write(
    `\nAuthentication timed out. Run nark login to try again.\n`
  );
  process.exit(1);
}

/**
 * Action callback for `nark logout` / `nark auth logout`.
 * Deletes ~/.nark/credentials and exits 0.
 */
export function logoutAction(): void {
  deleteCredentials();
  console.log('Logged out');
  process.exit(0);
}

/**
 * Create the `nark auth` parent command with login and logout subcommands.
 */
export function createAuthCommand(): Command {
  const auth = new Command('auth');
  auth.description('Authenticate with nark.sh');

  const login = new Command('login');
  login.description('Log in to nark.sh').action(loginAction);

  const logout = new Command('logout');
  logout.description('Log out from nark.sh').action(logoutAction);

  auth.addCommand(login);
  auth.addCommand(logout);

  return auth;
}

/**
 * Create the top-level `nark login` alias.
 * Mirrors `nark auth login` exactly — same description, same action.
 */
export function createLoginCommand(): Command {
  const cmd = new Command('login');
  cmd.description('Log in to nark.sh').action(loginAction);
  return cmd;
}

/**
 * Create the top-level `nark logout` alias.
 * Mirrors `nark auth logout` exactly — same description, same action.
 */
export function createLogoutCommand(): Command {
  const cmd = new Command('logout');
  cmd.description('Log out from nark.sh').action(logoutAction);
  return cmd;
}
