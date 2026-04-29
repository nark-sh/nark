/**
 * CLI Command: telemetry
 * Manage anonymous usage telemetry collection.
 *
 * nark telemetry [on|off|status]
 *
 * State stored at ~/.nark/telemetry.json
 * Shape: { enabled: boolean, notified: boolean, deviceId?: string }
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createHash, randomUUID } from "crypto";
import { execSync } from "child_process";
import chalk from "chalk";
import { getToken, getCredentials } from "../lib/auth.js";
import type { Violation } from "../types.js";

export interface TelemetryConfig {
  enabled: boolean;
  notified: boolean;
  deviceId?: string;
}

/**
 * Per-suppression detail sent in telemetry (opt-in, never-throw).
 * Describes WHY a violation was suppressed — this data feeds back into
 * corpus quality improvements: high suppress rates on a clause → likely FP.
 * Privacy: suppression reasons describe Nark profile behavior, not user code.
 */
export interface SuppressionDetail {
  /** Short fingerprint to deduplicate across scans (first 16 hex chars) */
  fingerprint: string;
  /** Package name, e.g. "axios" */
  package: string;
  /** Postcondition ID, e.g. "error-4xx-5xx" */
  postconditionId: string;
  /** Human-readable reason (from .nark-suppressions.json or inline comment) */
  reason?: string;
  /** How the suppression was created */
  suppressedBy?: string;
}

export interface TelemetryPayload {
  version: string;
  os: string;
  arch: string;
  nodeVersion: string;
  packageNames: string[];
  contractIds: string[];
  violationCountsByContract: Record<string, number>;
  scanDurationMs: number;
  isCiMode: boolean;
  repoFingerprint?: string;
  deviceId?: string;
  fileCount?: number;
  totalCallSites?: number;
  corpusVersion?: string;
  suppressionCount?: number;
  scanMode?: string;
  exitCode?: number;
  /**
   * Per-suppression details — crowdsources FP signal from users.
   * High suppress rates on a clause → likely FP or overly strict profile.
   * Respect NARK_TELEMETRY=off and DO_NOT_TRACK=1 opt-outs (checked in fireTelemetryEvent).
   * concern-20260429-telemetry-suppression-insights
   */
  suppressionDetails?: SuppressionDetail[];
  /**
   * Installed versions of contracted packages (name → resolved version).
   * Read from node_modules/<pkg>/package.json at scan time.
   * Allows the server to detect which exact versions are in the wild
   * and correlate violations with specific release series.
   */
  packageVersions?: Record<string, string>;
  /**
   * Packages used in the scanned project that have no Nark profile yet.
   * Sorted by callSiteCount descending — most-used packages first.
   * Used to prioritize which profiles to write next.
   * version is the installed version from node_modules (omitted if unresolvable).
   */
  uncoveredPackages?: Array<{
    name: string;
    version?: string;
    callSiteCount: number;
  }>;
}

export interface TelemetryResult {
  sent: boolean;
  authenticated: boolean;
  endpoint: string;
  email?: string;
  disabled?: boolean;
  error?: boolean;
}

export interface EnrichedTelemetryPayload extends TelemetryPayload {
  repoName?: string;
  repoUrl?: string;
  gitAuthor?: string;
  branch?: string;
  commitSha?: string;
  ciProvider?: string;
  codeSnippets?: Array<{
    file: string;
    line: number;
    code: string;
    contractId: string;
  }>;
}

/**
 * Compute a SHA256 hash of the git remote origin URL for the current working directory.
 * Returns undefined if git is unavailable, there is no origin remote, or any error occurs.
 * Never throws.
 */
function getRepoFingerprint(): string | undefined {
  try {
    const url = execSync("git remote get-url origin", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!url) return undefined;
    return createHash("sha256").update(url).digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * Get or create a stable device ID (UUID v4) stored in ~/.nark/telemetry.json.
 * Used to count unique installations without any connection to user identity.
 * Never throws.
 */
function getOrCreateDeviceId(): string | undefined {
  try {
    const configPath = getTelemetryConfigPath();
    const dir = path.dirname(configPath);

    // Read existing config
    let config: Record<string, unknown> = {};
    try {
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      }
    } catch {
      /* ignore parse errors */
    }

    // Return existing deviceId if present
    if (typeof config.deviceId === "string" && config.deviceId.length > 0) {
      return config.deviceId;
    }

    // Generate and persist a new one
    const deviceId = randomUUID();
    config.deviceId = deviceId;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    return deviceId;
  } catch {
    return undefined;
  }
}

const NARK_API_BASE = process.env["NARK_API_URL"] ?? "https://app.nark.sh";
const TELEMETRY_ENDPOINT = `${NARK_API_BASE}/api/telemetry/scan`;

export function getTelemetryConfigPath(): string {
  return path.join(os.homedir(), ".nark", "telemetry.json");
}

/**
 * Check if telemetry is disabled via environment variable.
 * Supports NARK_TELEMETRY=off and the standard DO_NOT_TRACK=1.
 */
function isEnvDisabled(): boolean {
  const narkEnv = process.env["NARK_TELEMETRY"];
  if (
    narkEnv !== undefined &&
    ["off", "false", "0"].includes(narkEnv.toLowerCase())
  ) {
    return true;
  }
  if (process.env["DO_NOT_TRACK"] === "1") {
    return true;
  }
  return false;
}

export function readTelemetryConfig(): TelemetryConfig {
  // Environment variable overrides file config
  if (isEnvDisabled()) {
    return { enabled: false, notified: true };
  }

  const configPath = getTelemetryConfigPath();
  try {
    if (!fs.existsSync(configPath)) {
      return { enabled: true, notified: false };
    }
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.enabled === "boolean" &&
      typeof parsed.notified === "boolean"
    ) {
      return parsed as TelemetryConfig;
    }
    return { enabled: true, notified: false };
  } catch {
    return { enabled: true, notified: false };
  }
}

export function writeTelemetryConfig(config: TelemetryConfig): void {
  const configPath = getTelemetryConfigPath();
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Print first-run notice to stderr if the user has never been notified.
 * Sets notified=true after printing.
 */
export function handleFirstRunNotice(): void {
  const configPath = getTelemetryConfigPath();
  const fileExists = fs.existsSync(configPath);
  const config = readTelemetryConfig();

  if (!fileExists || !config.notified) {
    process.stderr.write(
      chalk.dim(
        "\nNark collects anonymous usage data on each scan:\n" +
          "  • which packages are scanned and their installed versions\n" +
          "  • violation counts by package — to reduce false positives in profiles\n" +
          "  • packages without profiles, ranked by usage — to prioritize what to build next\n" +
          "  • an anonymous device ID and a SHA256 hash of your git remote URL (not the URL itself)\n" +
          "Run `nark telemetry status` to see exactly what is sent.\n" +
          "Run `nark telemetry off` to opt out, or set DO_NOT_TRACK=1.\n" +
          "Learn more: https://nark.sh/telemetry\n\n",
      ),
    );
    writeTelemetryConfig({ ...config, notified: true });
  }
}

/**
 * Fire a telemetry event. Returns a promise that resolves when the request
 * completes (or fails). Never rejects — errors are silently swallowed.
 * The caller should await this before process.exit() to avoid the request
 * being killed mid-flight.
 *
 * When a user is logged in, includes Authorization: Bearer <token> header.
 * When a git remote is available, includes repoFingerprint (SHA256 of origin URL).
 */
export async function fireTelemetryEvent(
  payload: TelemetryPayload,
): Promise<TelemetryResult> {
  const config = readTelemetryConfig();
  if (!config.enabled)
    return {
      sent: false,
      authenticated: false,
      endpoint: TELEMETRY_ENDPOINT,
      disabled: true,
    };
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const token = getToken();
    if (token !== null) {
      headers["Authorization"] = "Bearer " + token;
    }
    const fp = getRepoFingerprint();
    const did = getOrCreateDeviceId();
    const enriched = {
      ...payload,
      ...(fp ? { repoFingerprint: fp } : {}),
      ...(did ? { deviceId: did } : {}),
    };
    let fetchFailed = false;
    await fetch(TELEMETRY_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(enriched),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {
      fetchFailed = true;
    });
    if (fetchFailed) {
      return {
        sent: false,
        authenticated: token !== null,
        endpoint: TELEMETRY_ENDPOINT,
        error: true,
      };
    }
    return {
      sent: true,
      authenticated: token !== null,
      endpoint: TELEMETRY_ENDPOINT,
      email: token ? getCredentials()?.email : undefined,
    };
  } catch {
    // ignore — telemetry must never affect the scanner
    return {
      sent: false,
      authenticated: false,
      endpoint: TELEMETRY_ENDPOINT,
      error: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Enriched telemetry helpers (all never-throw)
// ---------------------------------------------------------------------------

/**
 * Parse an owner/repo string from a git remote URL.
 * Handles both HTTPS (github.com/owner/repo.git) and SSH (git@github.com:owner/repo.git).
 * Returns undefined on any failure.
 */
function getRepoName(): string | undefined {
  try {
    const url = execSync("git remote get-url origin", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!url) return undefined;
    // SSH: git@github.com:owner/repo.git
    const sshMatch = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];
    return undefined;
  } catch {
    return undefined;
  }
}

function getRepoUrl(): string | undefined {
  try {
    return (
      execSync("git remote get-url origin", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

function getGitAuthor(): string | undefined {
  try {
    return (
      execSync("git config user.name", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

function getBranch(): string | undefined {
  try {
    return (
      execSync("git branch --show-current", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

function getCommitSha(): string | undefined {
  try {
    return (
      execSync("git rev-parse HEAD", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

function detectCiProvider(): string | undefined {
  if (process.env["GITHUB_ACTIONS"]) return "github-actions";
  if (process.env["GITLAB_CI"]) return "gitlab-ci";
  if (process.env["CIRCLECI"]) return "circleci";
  if (process.env["JENKINS_URL"]) return "jenkins";
  if (process.env["TRAVIS"]) return "travis";
  if (process.env["BITBUCKET_PIPELINE_UUID"]) return "bitbucket-pipelines";
  if (process.env["CODEBUILD_BUILD_ID"]) return "aws-codebuild";
  if (process.env["BUILDKITE"]) return "buildkite";
  if (process.env["TF_BUILD"]) return "azure-pipelines";
  return undefined;
}

const MAX_SNIPPETS = 50;
const MAX_CODE_LENGTH = 2000;

/**
 * Extract code snippets from violations for enriched telemetry.
 * If a violation has a code_snippet, use it; otherwise read ~5 lines from the file.
 * Caps at 50 snippets total, 2000 chars each.
 */
function extractCodeSnippets(
  violations: Violation[],
): Array<{ file: string; line: number; code: string; contractId: string }> {
  try {
    const snippets: Array<{
      file: string;
      line: number;
      code: string;
      contractId: string;
    }> = [];
    for (const v of violations) {
      if (snippets.length >= MAX_SNIPPETS) break;
      let code: string;
      if (v.code_snippet) {
        code = v.code_snippet.lines.map((l) => l.content).join("\n");
      } else {
        try {
          const lines = fs.readFileSync(v.file, "utf-8").split("\n");
          const start = Math.max(0, v.line - 3);
          const end = Math.min(lines.length, v.line + 2);
          code = lines.slice(start, end).join("\n");
        } catch {
          code = "";
        }
      }
      if (code.length > MAX_CODE_LENGTH) {
        code = code.slice(0, MAX_CODE_LENGTH) + "...";
      }
      if (code) {
        snippets.push({
          file: v.file,
          line: v.line,
          code,
          contractId: v.package,
        });
      }
    }
    return snippets;
  } catch {
    return [];
  }
}

/**
 * Fire an enriched telemetry event for authenticated users.
 * Sends to /api/telemetry/scan-enriched with Bearer auth, git metadata, and code snippets.
 * Same fire-and-forget pattern — never throws, 2-second timeout.
 */
export async function fireEnrichedTelemetryEvent(
  payload: TelemetryPayload,
  violations: Violation[],
): Promise<TelemetryResult> {
  const config = readTelemetryConfig();
  const enrichedEndpoint = `${NARK_API_BASE}/api/telemetry/scan-enriched`;
  if (!config.enabled)
    return {
      sent: false,
      authenticated: false,
      endpoint: enrichedEndpoint,
      disabled: true,
    };
  try {
    const token = getToken();
    if (!token)
      return {
        sent: false,
        authenticated: false,
        endpoint: TELEMETRY_ENDPOINT,
      };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };

    const fp = getRepoFingerprint();
    const did = getOrCreateDeviceId();
    const repoName = getRepoName();
    const repoUrl = getRepoUrl();
    const gitAuthor = getGitAuthor();
    const branch = getBranch();
    const commitSha = getCommitSha();
    const ciProvider = detectCiProvider();
    const codeSnippets = extractCodeSnippets(violations);

    const enriched: Record<string, unknown> = {
      ...payload,
      ...(fp ? { repoFingerprint: fp } : {}),
      ...(did ? { deviceId: did } : {}),
      ...(repoName ? { repoName } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(gitAuthor ? { gitAuthor } : {}),
      ...(branch ? { branch } : {}),
      ...(commitSha ? { commitSha } : {}),
      ...(ciProvider ? { ciProvider } : {}),
      ...(codeSnippets.length > 0 ? { codeSnippets } : {}),
    };

    let fetchFailed = false;
    await fetch(enrichedEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(enriched),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {
      fetchFailed = true;
    });
    if (fetchFailed) {
      return {
        sent: false,
        authenticated: true,
        endpoint: enrichedEndpoint,
        error: true,
      };
    }
    return {
      sent: true,
      authenticated: true,
      endpoint: enrichedEndpoint,
      email: getCredentials()?.email,
    };
  } catch {
    // ignore — telemetry must never affect the scanner
    return {
      sent: false,
      authenticated: true,
      endpoint: enrichedEndpoint,
      error: true,
    };
  }
}

/**
 * Create the `nark telemetry` subcommand.
 */
export function createTelemetryCommand(): Command {
  const cmd = new Command("telemetry");

  cmd
    .description("Manage anonymous usage telemetry collection")
    .argument("[action]", "on, off, or status (default: status)")
    .action((action = "status") => {
      const config = readTelemetryConfig();

      switch (action) {
        case "status": {
          const envOverride = isEnvDisabled();
          const statusLabel = config.enabled
            ? chalk.green("Enabled")
            : chalk.yellow("Disabled");

          console.log("");
          console.log(chalk.bold("Nark Telemetry"));
          console.log("");
          console.log(`Status:   ${statusLabel}`);
          if (envOverride) {
            console.log(
              `          ${chalk.dim("(disabled via environment variable)")}`,
            );
          }
          console.log(`Config:   ${getTelemetryConfigPath()}`);
          console.log(`Endpoint: ${TELEMETRY_ENDPOINT}`);
          console.log("");
          console.log(chalk.bold("What we collect (all scans):"));
          console.log(
            chalk.dim("  • Nark version, OS, Node.js version, architecture"),
          );
          console.log(
            chalk.dim("  • Scan duration, file count, total call sites"),
          );
          console.log(
            chalk.dim(
              "  • Names and installed versions of contracted packages",
            ),
          );
          console.log(
            chalk.dim(
              "    → Lets us detect which exact versions are in the wild and",
            ),
          );
          console.log(
            chalk.dim("      correlate violations with specific releases."),
          );
          console.log(chalk.dim("  • Violation counts per package"));
          console.log(
            chalk.dim(
              "    → High counts on a rule = likely false positive; we tighten the profile.",
            ),
          );
          console.log(
            chalk.dim("  • Suppression counts and which rules were suppressed"),
          );
          console.log(
            chalk.dim(
              "    → High suppress rates on a rule = profile is too strict; we fix it.",
            ),
          );
          console.log(
            chalk.dim(
              "  • Packages you use that have no profile yet, ranked by call site count",
            ),
          );
          console.log(
            chalk.dim(
              "    → Tells us which profiles would cover the most real-world code.",
            ),
          );
          console.log(
            chalk.dim(
              "  • Anonymous device ID (stable UUID, no connection to your identity)",
            ),
          );
          console.log(
            chalk.dim(
              "  • SHA256 hash of your git remote URL (not the URL itself)",
            ),
          );
          console.log(
            chalk.dim(
              "    → Lets us count unique repos without seeing what they are.",
            ),
          );
          console.log("");
          console.log(
            chalk.bold("Additional data when logged in (nark login):"),
          );
          console.log(
            chalk.dim("  • Git repo URL, branch, commit SHA, author name"),
          );
          console.log(chalk.dim("  • Code snippets around violations"));
          console.log(
            chalk.dim(
              "    → Used to identify patterns causing false positives and",
            ),
          );
          console.log(
            chalk.dim(
              "      improve profile accuracy for your specific codebase.",
            ),
          );
          console.log("");
          console.log(chalk.bold("What we never collect:"));
          console.log(
            chalk.dim(
              "  • Your source code (only small snippets around violations, when logged in)",
            ),
          );
          console.log(chalk.dim("  • File names or directory structure"));
          console.log(
            chalk.dim("  • Credentials, tokens, or environment variables"),
          );
          console.log(
            chalk.dim(
              "  • Personal information beyond git author name (when logged in)",
            ),
          );
          console.log("");
          console.log(chalk.dim("Run `nark telemetry off` to opt out."));
          console.log(
            chalk.dim(
              "Set NARK_TELEMETRY=off or DO_NOT_TRACK=1 to disable via env.",
            ),
          );
          console.log(chalk.dim("Learn more: https://nark.sh/telemetry"));
          console.log("");
          break;
        }

        case "on": {
          writeTelemetryConfig({ ...config, enabled: true });
          console.log(
            chalk.green(
              "Nark telemetry has been enabled. Thank you for helping improve Nark.",
            ),
          );
          break;
        }

        case "off": {
          writeTelemetryConfig({ ...config, enabled: false });
          console.log(
            chalk.yellow(
              "Nark telemetry has been disabled. No data will be collected.",
            ),
          );
          break;
        }

        default: {
          console.error(
            chalk.red(
              `Unknown telemetry action: "${action}". Use on, off, or status.`,
            ),
          );
          process.exit(1);
        }
      }
    });

  return cmd;
}
