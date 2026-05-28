/**
 * qt-164 — Pre-scan workspace-mismatch warning + post-scan footer predicate.
 *
 * Extracted from src/index.ts into a small testable module so unit tests can
 * inject `cwd` and `now` rather than rely on the real filesystem + clock.
 *
 * Decisions encoded here (CONTEXT.md DEC1 + DEC6):
 *   - Pre-scan warning fires ONLY when ALL of:
 *       1. credentials v2 exists with >=2 workspaces and a default set
 *       2. most-recent loggedInAt slug !== default slug
 *       3. delta < 5 minutes
 *       4. cwd has no .nark/config.json or .narkrc.json binding in any ancestor
 *     Output: single cyan stderr line, non-blocking. Never throws.
 *   - Post-scan footer prints `✓ Scan uploaded to <orgName> (<slug>)` cyan
 *     ONLY when telemetry actually sent AND the resolver returned a workspace
 *     (env-token-only users have no workspace → silent).
 */

import chalk from "chalk";
import { readCredentialsV2 } from "./auth.js";
import { hasRepoWorkspaceBinding } from "./config.js";

const FIVE_MINUTES_MS = 5 * 60 * 1000;

export interface PreScanWarningOptions {
  /** Override cwd (testing). Defaults to process.cwd(). */
  cwd?: string;
  /** Override clock (testing). Defaults to Date.now. */
  now?: () => number;
}

/**
 * Print a one-line cyan stderr hint when the user just logged into a
 * different workspace from the current default and there is no repo-local
 * binding to explain why the scan should still go to the default.
 *
 * Non-blocking, never throws — pre-scan warnings must never break a scan.
 */
export function maybePrintPreScanWorkspaceWarning(
  opts?: PreScanWarningOptions,
): void {
  try {
    const cwd = opts?.cwd ?? process.cwd();
    const now = opts?.now ?? Date.now;

    const v2 = readCredentialsV2();
    if (!v2 || !v2.default) return;

    const entries = Object.entries(v2.workspaces);
    if (entries.length < 2) return;

    let mostRecentSlug = entries[0]![0];
    let mostRecentTime = entries[0]![1].loggedInAt;
    for (const [slug, ws] of entries) {
      if (ws.loggedInAt > mostRecentTime) {
        mostRecentTime = ws.loggedInAt;
        mostRecentSlug = slug;
      }
    }

    if (mostRecentSlug === v2.default) return;

    const delta = now() - new Date(mostRecentTime).getTime();
    if (delta >= FIVE_MINUTES_MS) return;
    if (delta < 0) return;

    if (hasRepoWorkspaceBinding(cwd)) return;

    const recentWs = v2.workspaces[mostRecentSlug];
    const defaultWs = v2.workspaces[v2.default];
    if (!recentWs || !defaultWs) return;

    process.stderr.write(
      chalk.cyan(
        `ℹ You recently logged into ${recentWs.orgName}, but this scan will go to ${defaultWs.orgName}. Run \`nark workspace use ${mostRecentSlug}\` to switch.\n`,
      ),
    );
  } catch {
    // Pre-scan warning must never break a scan.
  }
}

/**
 * Predicate (qt-164 DEC1): should the post-scan cyan footer print?
 *
 * Returns true only when:
 *   - telemetryResult.sent === true (network actually succeeded)
 *   - workspace was resolved (env-token users have no workspace entry → silent)
 *
 * Independent of `--quiet`: the whole point of qt-164 is that the user always
 * sees WHERE the scan went, including in quiet mode.
 */
export function shouldPrintScanUploadedFooter(
  result: { sent?: boolean } | undefined,
  workspace: { orgName: string; orgSlug: string } | undefined,
): boolean {
  return result?.sent === true && workspace !== undefined;
}
