/**
 * CLI Command: auth (qt-162 — multi-workspace device flow)
 *
 * nark auth login                   — open browser, print code, poll for token, write workspace
 * nark auth login --org <slug>      — pre-select org in browser
 * nark auth login --pick            — alias for login (browser-side picker is default)
 * nark auth logout                  — remove default workspace; auto-promote next-most-recent
 * nark auth logout --org <slug>     — remove specific workspace
 * nark auth logout --all            — delete entire credentials file
 *
 * Top-level aliases share the exact same action callbacks:
 *   nark login   — alias for `nark auth login`
 *   nark logout  — alias for `nark auth logout`
 */

import { Command } from "commander";
import * as crypto from "crypto";
import chalk from "chalk";
import open from "open";
import {
  writeWorkspace,
  readCredentialsV2,
  removeWorkspace,
  removeAllWorkspaces,
} from "../lib/auth.js";

const POLL_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 150; // 5 minutes

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

interface LoginOptions {
  org?: string;
  pick?: boolean;
}

interface LogoutOptions {
  org?: string;
  all?: boolean;
}

/**
 * Action callback for `nark login` / `nark auth login`.
 */
export async function loginAction(opts: LoginOptions = {}): Promise<void> {
  // 1. Generate a random 6-character uppercase code
  const code = crypto.randomBytes(3).toString("hex").toUpperCase();

  // 2. Build URLs (orgSlug pre-selects browser dropdown)
  const NARK_API_BASE = process.env["NARK_API_URL"] ?? "https://app.nark.sh";
  const orgQuery = opts.org ? `&orgSlug=${encodeURIComponent(opts.org)}` : "";
  const browserUrl = `${NARK_API_BASE}/auth/cli?code=${code}${orgQuery}`;
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
        process.stderr.write(
          chalk.dim(
            `\nWarning: unexpected poll response ${res.status}, retrying...\n`,
          ),
        );
        continue;
      }

      // res.ok === true (status 200-299) — parse the NEW response shape (qt-162):
      // { token, user: { email }, organization: { id, slug, name, plan } }
      let body: {
        token: string;
        user: { email: string };
        organization: { id: string; slug: string; name: string; plan: string };
      };
      try {
        body = (await res.json()) as typeof body;
      } catch (jsonErr) {
        const detail =
          jsonErr instanceof SyntaxError ? jsonErr.message : String(jsonErr);
        process.stderr.write(
          chalk.dim(
            `\nWarning: failed to parse auth response JSON (${detail}), retrying...\n`,
          ),
        );
        continue;
      }

      const existing = readCredentialsV2();
      const hadExistingDefault = !!existing?.default;

      writeWorkspace(
        {
          token: body.token,
          orgId: body.organization.id,
          orgSlug: body.organization.slug,
          orgName: body.organization.name,
          email: body.user.email,
          plan: body.organization.plan,
          loggedInAt: new Date().toISOString(),
        },
        { makeDefault: !hadExistingDefault },
      );

      console.log(
        `\nLogged in to ${chalk.green(body.organization.name)} (${body.organization.slug}) as ${body.user.email}`,
      );

      // qt-162 locked decision: first-login does NOT change existing default
      if (hadExistingDefault && existing?.default !== body.organization.slug) {
        process.stderr.write(
          `Default workspace unchanged. Run \`nark workspace use ${body.organization.slug}\` to switch.\n`,
        );
      }
      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        chalk.dim(`\nWarning: poll request failed (${msg}), retrying...\n`),
      );
    }
  }

  // Timed out
  process.stderr.write(
    `\nAuthentication timed out. Run nark login to try again.\n`,
  );
  process.exit(1);
}

/**
 * Action callback for `nark logout` / `nark auth logout`.
 */
export function logoutAction(opts: LogoutOptions = {}): void {
  if (opts.all) {
    removeAllWorkspaces();
    console.log("Logged out of all workspaces.");
    process.exit(0);
  }

  if (opts.org) {
    try {
      const result = removeWorkspace(opts.org);
      console.log(`Logged out of \`${opts.org}\`.`);
      if (result.newDefault) {
        // The stderr "Default workspace is now..." message comes from removeWorkspace itself.
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  }

  // No flag — remove the current default
  const v2 = readCredentialsV2();
  if (!v2 || !v2.default) {
    console.log("Not logged in.");
    process.exit(0);
  }
  try {
    removeWorkspace(v2.default);
    console.log(`Logged out of \`${v2.default}\`.`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

/**
 * Create the `nark auth` parent command with login and logout subcommands.
 */
export function createAuthCommand(): Command {
  const auth = new Command("auth");
  auth.description("Authenticate with nark.sh");

  const login = new Command("login");
  login
    .description("Log in to nark.sh")
    .option("--org <slug>", "Pre-select organization in browser")
    .option("--pick", "Force browser-side org picker (default behavior)")
    .action(loginAction);

  const logout = new Command("logout");
  logout
    .description("Log out from nark.sh")
    .option("--org <slug>", "Remove a specific workspace")
    .option("--all", "Remove all workspaces (delete credentials file)")
    .action(logoutAction);

  auth.addCommand(login);
  auth.addCommand(logout);

  return auth;
}

/**
 * Top-level `nark login` alias.
 */
export function createLoginCommand(): Command {
  const cmd = new Command("login");
  cmd
    .description("Log in to nark.sh")
    .option("--org <slug>", "Pre-select organization in browser")
    .option("--pick", "Force browser-side org picker (default behavior)")
    .action(loginAction);
  return cmd;
}

/**
 * Top-level `nark logout` alias.
 */
export function createLogoutCommand(): Command {
  const cmd = new Command("logout");
  cmd
    .description("Log out from nark.sh")
    .option("--org <slug>", "Remove a specific workspace")
    .option("--all", "Remove all workspaces (delete credentials file)")
    .action(logoutAction);
  return cmd;
}
