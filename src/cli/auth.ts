/**
 * CLI Command: auth
 * Authenticate the nark CLI with nark.sh using the device-flow pattern.
 *
 * nark auth login   — open browser, print code, poll for token, write credentials
 * nark auth logout  — delete credentials
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
 * Create the `nark auth` parent command with login and logout subcommands.
 */
export function createAuthCommand(): Command {
  const auth = new Command('auth');
  auth.description('Authenticate with nark.sh');

  // ------------------------------------------------------------------
  // nark auth login
  // ------------------------------------------------------------------
  const login = new Command('login');
  login
    .description('Log in to nark.sh')
    .action(async () => {
      // 1. Generate a random 6-character uppercase code
      const code = crypto.randomBytes(3).toString('hex').toUpperCase();

      // 2. Build URLs
      const browserUrl = `https://nark.sh/auth/cli?code=${code}`;
      const pollUrl = `https://nark.sh/api/auth/cli/exchange?code=${code}`;

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

          if (res.status === 200) {
            // Success — parse the token and write credentials
            const body = await res.json() as {
              token: string;
              user: { email: string; orgName: string; plan: string };
            };
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
          }

          if (res.status === 202 || res.status === 404) {
            // Not ready yet — keep polling
            continue;
          }

          // Unexpected status — warn and continue polling
          process.stderr.write(
            chalk.dim(`\nWarning: unexpected poll response ${res.status}, retrying...\n`)
          );
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
    });

  // ------------------------------------------------------------------
  // nark auth logout
  // ------------------------------------------------------------------
  const logout = new Command('logout');
  logout
    .description('Log out from nark.sh')
    .action(() => {
      deleteCredentials();
      console.log('Logged out');
      process.exit(0);
    });

  auth.addCommand(login);
  auth.addCommand(logout);

  return auth;
}
