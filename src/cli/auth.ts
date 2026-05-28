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
import { hasRepoWorkspaceBinding } from "../lib/config.js";

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
 * qt-164: post-login branch identifier — feeds `printLoginResult` and gates
 * `writeWorkspace({ makeDefault })`.
 *
 *   first         — no prior default → auto-promote (also covers existing===null)
 *   same-slug     — re-login into the current default → token refresh (dim)
 *   multi-config  — different slug AND `.nark/config.json` ancestor exists
 *                   → preserve default, print multi-workspace block
 *   auto-promote  — different slug AND no binding → Vercel-style auto-promote
 */
export type LoginBranch =
  | "first"
  | "same-slug"
  | "multi-config"
  | "auto-promote";

/**
 * Pure decision helper (qt-164) — no side effects, no chalk, no console.
 * Used directly by `loginAction` and unit-tested in src/cli/auth.test.ts.
 */
export function decideLoginBranch(
  existing: {
    default: string | null;
    workspaces: Record<string, { orgName: string }>;
  } | null,
  newSlug: string,
  cwd: string,
): { branch: LoginBranch; oldDefaultName: string | null } {
  const currentDefault = existing?.default ?? null;
  const oldDefaultName =
    currentDefault && existing?.workspaces[currentDefault]?.orgName
      ? existing.workspaces[currentDefault]!.orgName
      : currentDefault;

  if (currentDefault === null) return { branch: "first", oldDefaultName };
  if (currentDefault === newSlug)
    return { branch: "same-slug", oldDefaultName };
  if (hasRepoWorkspaceBinding(cwd))
    return { branch: "multi-config", oldDefaultName };
  return { branch: "auto-promote", oldDefaultName };
}

/**
 * Render the four branch outputs (qt-164). Pure-ish — only `console.log`
 * side effects. Tests spy on console.log to capture lines.
 *
 * Color scheme (CONTEXT.md DEC3):
 *   first        → green "Logged in to..."
 *   same-slug    → dim "✓ Token refreshed for ..."
 *   multi-config → plain body, cyan accents on command names
 *   auto-promote → green "Logged in to..." + cyan "✓ Default workspace switched to..."
 */
export function printLoginResult(
  branch: LoginBranch,
  newName: string,
  newSlug: string,
  email: string,
  oldDefaultName: string | null,
  currentDefault: string | null,
): void {
  if (branch === "same-slug") {
    // Dim refresh — replaces the legacy `Logged in to ...` + `Default unchanged`
    // pair from qt-162. Single line, no switch hint, no noise.
    console.log(chalk.dim(`✓ Token refreshed for ${newName}.`));
    return;
  }

  if (branch === "first") {
    console.log(
      `\n${chalk.green(`Logged in to ${newName} (${newSlug}) as ${email}`)}`,
    );
    return;
  }

  if (branch === "multi-config") {
    // Preserve existing default. 4 informational lines + leading blank.
    // Spaces after `To switch default:` are tuned to visually align the
    // command columns under `To list all workspaces:`.
    console.log(`\nLogged in to ${newName} (${newSlug}). Token saved.`);
    console.log("");
    console.log(
      `Your default workspace is still ${oldDefaultName} (${currentDefault}).`,
    );
    console.log(`To list all workspaces: ${chalk.cyan("nark workspace")}`);
    console.log(
      `To switch default:      ${chalk.cyan(`nark workspace use ${newSlug}`)}`,
    );
    return;
  }

  // auto-promote — different slug, no binding. Vercel-style.
  console.log(
    `\n${chalk.green(`Logged in to ${newName} (${newSlug}) as ${email}`)}`,
  );
  console.log(
    chalk.cyan(`✓ Default workspace switched to ${newName} (${newSlug}).`),
  );
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

      // qt-164: four-branch login flow.
      //   first         → no prior default, auto-promote (Branch A)
      //   same-slug     → re-login into current default, dim refresh (Branch B)
      //   multi-config  → different slug + .nark/config.json binding
      //                   → preserve default, multi-workspace block (Branch C)
      //   auto-promote  → different slug + no binding
      //                   → Vercel-style auto-promote (Branch D)
      const existing = readCredentialsV2();
      const newSlug = body.organization.slug;
      const newName = body.organization.name;
      const { branch, oldDefaultName } = decideLoginBranch(
        existing,
        newSlug,
        process.cwd(),
      );

      // `first` and `auto-promote` both flip the default. `same-slug` is a
      // no-op for `default` (writeWorkspace re-sets the same value if true,
      // but we pass false here to keep the operation purely token-refresh).
      // `multi-config` explicitly preserves the existing default.
      const shouldMakeDefault = branch === "first" || branch === "auto-promote";

      writeWorkspace(
        {
          token: body.token,
          orgId: body.organization.id,
          orgSlug: newSlug,
          orgName: newName,
          email: body.user.email,
          plan: body.organization.plan,
          loggedInAt: new Date().toISOString(),
        },
        { makeDefault: shouldMakeDefault },
      );

      printLoginResult(
        branch,
        newName,
        newSlug,
        body.user.email,
        oldDefaultName,
        existing?.default ?? null,
      );
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

  // qt-164 DEC7: typo suggestion (`nark auth loginn` → "Did you mean login?")
  auth
    .showSuggestionAfterError(true)
    .showHelpAfterError("(add --help for additional usage)");

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
