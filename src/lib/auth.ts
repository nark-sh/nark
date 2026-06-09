/**
 * Credential helpers for nark authentication (v2 — qt-162).
 *
 * Storage: ~/.nark/credentials.json (v2) — multi-workspace store keyed by orgSlug.
 *          ~/.nark/credentials       (v1, legacy) — single credential, auto-migrated on first read.
 *
 * Resolution priority (resolveActiveWorkspace):
 *   1. NARK_API_KEY env var (canonical)
 *   2. NARK_TOKEN env var (deprecated, one-time stderr warning)
 *   3. opts.orgSlug flag matching a workspace
 *   4. .nark/config.json `workspace` field in CWD or parents
 *   5. .narkrc.json `workspace` field in CWD or parents (legacy)
 *   6. credentials.json `default` field
 *   7. Single workspace silent (exactly one workspace, no default field)
 *   8. null (caller prints actionable error)
 *
 * File permissions: credentials.json is chmod 0o600 (owner read/write only).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { readRepoWorkspace } from "./config.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface NarkWorkspace {
  token: string;
  orgId: string;
  orgSlug: string;
  orgName: string;
  email: string;
  plan: string;
  loggedInAt: string; // ISO timestamp
  /**
   * The NARK_API_BASE URL this workspace's token was minted against
   * (e.g. "https://app.nark.sh" or "http://localhost:3000").
   *
   * Added in nark@2.5.1 (S2-1). Tokens minted before that release have this
   * field undefined; callers should treat undefined as "endpoint unknown,
   * legacy entry" and fall back to the runtime 401 retry path.
   */
  endpoint?: string;
}

export interface NarkCredentialsV2 {
  version: 2;
  default: string | null;
  workspaces: Record<string, NarkWorkspace>;
  migratedAt?: string;
}

export interface ResolvedWorkspace {
  token: string;
  workspace?: NarkWorkspace;
  source: "env" | "flag" | "config" | "narkrc" | "default" | "single";
}

// ── Legacy v1 type (kept for back-compat shims) ─────────────────────────────

export interface NarkCredentials {
  token: string;
  email: string;
  orgName: string;
  plan: string;
}

// ── Paths ───────────────────────────────────────────────────────────────────

function narkDir(): string {
  return path.join(os.homedir(), ".nark");
}
function v1Path(): string {
  return path.join(narkDir(), "credentials");
}
function v2Path(): string {
  return path.join(narkDir(), "credentials.json");
}

// ── One-time-warning flags (module-scoped, reset via vi.resetModules) ───────

let _narkTokenDeprecationWarned = false;

// ── Public API ──────────────────────────────────────────────────────────────

export function getCredentialsPath(): string {
  return v2Path();
}

/**
 * Reads ~/.nark/credentials.json (v2). If absent but a v1 file exists,
 * performs silent migration with exactly one stderr note, sets migratedAt
 * on the new file so subsequent reads stay silent, and deletes the v1 file.
 */
export function readCredentialsV2(): NarkCredentialsV2 | null {
  // V2 already present
  try {
    const raw = fs.readFileSync(v2Path(), "utf-8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === 2 &&
      typeof parsed.workspaces === "object" &&
      parsed.workspaces !== null
    ) {
      return parsed as NarkCredentialsV2;
    }
    // Malformed — treat as absent
  } catch {
    // not present or unreadable — fall through to v1 migration check
  }

  // V1 present — migrate
  let v1Raw: string;
  try {
    v1Raw = fs.readFileSync(v1Path(), "utf-8");
  } catch {
    return null; // neither v1 nor v2
  }

  let v1: any;
  try {
    v1 = JSON.parse(v1Raw);
  } catch {
    return null; // corrupt v1
  }
  if (
    !v1 ||
    typeof v1 !== "object" ||
    typeof v1.token !== "string" ||
    typeof v1.email !== "string" ||
    typeof v1.orgName !== "string" ||
    typeof v1.plan !== "string"
  ) {
    return null;
  }

  const slug = "default"; // sentinel — v1 had no orgSlug
  const ws: NarkWorkspace = {
    token: v1.token,
    orgId: "",
    orgSlug: slug,
    orgName: v1.orgName,
    email: v1.email,
    plan: v1.plan,
    loggedInAt: new Date().toISOString(),
  };
  const v2: NarkCredentialsV2 = {
    version: 2,
    default: slug,
    workspaces: { [slug]: ws },
    migratedAt: new Date().toISOString(),
  };
  writeCredentialsV2(v2);
  try {
    fs.rmSync(v1Path(), { force: true });
  } catch {
    // best-effort
  }
  process.stderr.write(
    "Migrated nark credentials to v2 (multi-workspace).\n",
  );
  return v2;
}

/**
 * Writes credentials.json to disk with chmod 0o600.
 */
export function writeCredentialsV2(creds: NarkCredentialsV2): void {
  fs.mkdirSync(narkDir(), { recursive: true });
  fs.writeFileSync(v2Path(), JSON.stringify(creds, null, 2), "utf-8");
  try {
    fs.chmodSync(v2Path(), 0o600);
  } catch {
    // ignore — non-POSIX filesystems may not support chmod
  }
}

/**
 * Adds or replaces a workspace entry. If `opts.makeDefault` is true OR the
 * store currently has no default, sets the workspace as default.
 */
export function writeWorkspace(
  ws: NarkWorkspace,
  opts: { makeDefault?: boolean } = {},
): void {
  let v2 = readCredentialsV2();
  if (!v2) {
    v2 = { version: 2, default: null, workspaces: {} };
  }
  v2.workspaces[ws.orgSlug] = ws;
  if (opts.makeDefault || v2.default === null) {
    v2.default = ws.orgSlug;
  }
  writeCredentialsV2(v2);
}

/**
 * Lists all workspaces, marking the default + the most-recent (max loggedInAt).
 */
export function listWorkspaces(): {
  slug: string;
  workspace: NarkWorkspace;
  isDefault: boolean;
  isMostRecent: boolean;
}[] {
  const v2 = readCredentialsV2();
  if (!v2) return [];
  const entries = Object.entries(v2.workspaces);
  if (entries.length === 0) return [];

  // Find most-recent by loggedInAt
  let mostRecentSlug = entries[0]![0];
  let mostRecentTime = entries[0]![1].loggedInAt;
  for (const [slug, ws] of entries) {
    if (ws.loggedInAt > mostRecentTime) {
      mostRecentTime = ws.loggedInAt;
      mostRecentSlug = slug;
    }
  }

  return entries.map(([slug, ws]) => ({
    slug,
    workspace: ws,
    isDefault: v2.default === slug,
    isMostRecent: slug === mostRecentSlug,
  }));
}

/**
 * Sets the given slug as the default workspace. Throws if not found.
 */
export function setDefault(slug: string): void {
  const v2 = readCredentialsV2();
  if (!v2 || !v2.workspaces[slug]) {
    throw new Error(`Workspace \`${slug}\` not found.`);
  }
  v2.default = slug;
  writeCredentialsV2(v2);
}

/**
 * Removes a workspace. If it was the default, auto-promotes the
 * next-most-recent workspace (by loggedInAt) as the new default and prints
 * `Default workspace is now <slug>.` to stderr. If no workspaces remain,
 * deletes the credentials file entirely.
 */
export function removeWorkspace(slug: string): {
  newDefault: string | null;
  deleted: true;
} {
  const v2 = readCredentialsV2();
  if (!v2 || !v2.workspaces[slug]) {
    throw new Error(`Workspace \`${slug}\` not found.`);
  }
  const wasDefault = v2.default === slug;
  delete v2.workspaces[slug];

  const remainingEntries = Object.entries(v2.workspaces);

  if (remainingEntries.length === 0) {
    // Last workspace removed — delete file
    try {
      fs.rmSync(v2Path(), { force: true });
    } catch {
      // ignore
    }
    return { newDefault: null, deleted: true };
  }

  if (wasDefault) {
    // Auto-promote next-most-recent
    let newDefaultSlug = remainingEntries[0]![0];
    let newest = remainingEntries[0]![1].loggedInAt;
    for (const [s, ws] of remainingEntries) {
      if (ws.loggedInAt > newest) {
        newest = ws.loggedInAt;
        newDefaultSlug = s;
      }
    }
    v2.default = newDefaultSlug;
    writeCredentialsV2(v2);
    process.stderr.write(`Default workspace is now ${newDefaultSlug}.\n`);
    return { newDefault: newDefaultSlug, deleted: true };
  }

  // Not the default — just persist
  writeCredentialsV2(v2);
  return { newDefault: v2.default, deleted: true };
}

/**
 * Removes the entire credentials file (both v1 if present and v2).
 */
export function removeAllWorkspaces(): void {
  try {
    fs.rmSync(v2Path(), { force: true });
  } catch {
    // ignore
  }
  try {
    fs.rmSync(v1Path(), { force: true });
  } catch {
    // ignore
  }
}

/**
 * Renames a workspace slug. Throws if the new slug already exists in the store.
 */
export function renameWorkspace(oldSlug: string, newSlug: string): void {
  const v2 = readCredentialsV2();
  if (!v2 || !v2.workspaces[oldSlug]) {
    throw new Error(`Workspace \`${oldSlug}\` not found.`);
  }
  if (v2.workspaces[newSlug]) {
    throw new Error(`Workspace \`${newSlug}\` already exists.`);
  }
  const ws = v2.workspaces[oldSlug];
  v2.workspaces[newSlug] = { ...ws, orgSlug: newSlug };
  delete v2.workspaces[oldSlug];
  if (v2.default === oldSlug) {
    v2.default = newSlug;
  }
  writeCredentialsV2(v2);
}

/**
 * Returns true if a workspace's stored endpoint is compatible with the runtime
 * NARK_API_BASE. Legacy entries (endpoint === undefined) match any endpoint —
 * the 401-fallback path in fireEnrichedTelemetryEvent catches mismatches that
 * slip through. Defined endpoints require strict equality.
 */
export function workspaceEndpointMatches(
  workspace: { endpoint?: string },
  runtimeApiBase: string,
): boolean {
  if (workspace.endpoint === undefined) return true;
  return workspace.endpoint === runtimeApiBase;
}

/**
 * Resolves the active workspace via the 8-step priority chain.
 * Returns null if no token source is available.
 *
 * When `opts.endpoint` is provided, workspace records whose stored `endpoint`
 * is defined but does not equal it are skipped (returned as null) — used by
 * the telemetry path to avoid sending a localhost-minted token to prod, and
 * vice-versa (S2-1). Env-token sources (NARK_API_KEY / NARK_TOKEN) bypass the
 * filter because they are not bound to a workspace endpoint.
 */
export function resolveActiveWorkspace(
  opts: { orgSlug?: string; cwd?: string; endpoint?: string } = {},
): ResolvedWorkspace | null {
  // Step 1: NARK_API_KEY (canonical)
  const apiKey = process.env.NARK_API_KEY;
  if (apiKey && apiKey.length > 0) {
    return { token: apiKey, source: "env" };
  }

  // Step 2: NARK_TOKEN (deprecated)
  const narkToken = process.env.NARK_TOKEN;
  if (narkToken && narkToken.length > 0) {
    if (!_narkTokenDeprecationWarned) {
      process.stderr.write(
        "NARK_TOKEN is deprecated. Set NARK_API_KEY instead. NARK_TOKEN will be removed in nark v2.0.\n",
      );
      _narkTokenDeprecationWarned = true;
    }
    return { token: narkToken, source: "env" };
  }

  // Steps 3-8: require a workspace store
  const v2 = readCredentialsV2();
  if (!v2 || Object.keys(v2.workspaces).length === 0) {
    return null;
  }

  const accept = (ws: NarkWorkspace): boolean =>
    opts.endpoint === undefined || workspaceEndpointMatches(ws, opts.endpoint);

  // Step 3: opts.orgSlug flag
  if (opts.orgSlug && v2.workspaces[opts.orgSlug]) {
    const ws = v2.workspaces[opts.orgSlug];
    if (accept(ws)) {
      return { token: ws.token, workspace: ws, source: "flag" };
    }
    return null;
  }

  // Steps 4-5: per-repo config
  const cwd = opts.cwd ?? process.cwd();
  const repoCfg = readRepoWorkspace(cwd);
  if (repoCfg && v2.workspaces[repoCfg.slug]) {
    const ws = v2.workspaces[repoCfg.slug];
    if (accept(ws)) {
      return { token: ws.token, workspace: ws, source: repoCfg.source };
    }
    return null;
  }

  // Step 6: default field
  if (v2.default && v2.workspaces[v2.default]) {
    const ws = v2.workspaces[v2.default];
    if (accept(ws)) {
      return { token: ws.token, workspace: ws, source: "default" };
    }
    return null;
  }

  // Step 7: single workspace silent
  const keys = Object.keys(v2.workspaces);
  if (keys.length === 1) {
    const ws = v2.workspaces[keys[0]!]!;
    if (accept(ws)) {
      return { token: ws.token, workspace: ws, source: "single" };
    }
    return null;
  }

  // Step 8: ambiguous — caller handles
  return null;
}

// ── Backward-compatible shims (used by api.ts, api-v2.ts, telemetry.ts) ─────

/**
 * Returns a token via the resolution priority chain.
 * @deprecated Use resolveActiveWorkspace() to also get source + workspace metadata.
 */
export function getToken(): string | null {
  return resolveActiveWorkspace()?.token ?? null;
}

/**
 * Returns true if a token can be resolved.
 */
export function isLoggedIn(
  opts: { orgSlug?: string; cwd?: string } = {},
): boolean {
  return resolveActiveWorkspace(opts) !== null;
}

/**
 * Returns the active default workspace as a v1-shaped credentials object,
 * or null. Kept for legacy callers; new code should use resolveActiveWorkspace.
 */
export function getCredentials(): NarkCredentials | null {
  const v2 = readCredentialsV2();
  if (!v2 || !v2.default) return null;
  const ws = v2.workspaces[v2.default];
  if (!ws) return null;
  return {
    token: ws.token,
    email: ws.email,
    orgName: ws.orgName,
    plan: ws.plan,
  };
}

/**
 * Legacy single-credential writer — kept for any direct caller.
 * Builds a v2 workspace entry keyed under the sentinel slug "default".
 */
export function writeCredentials(creds: NarkCredentials): void {
  const slug = "default";
  writeWorkspace(
    {
      token: creds.token,
      orgId: "",
      orgSlug: slug,
      orgName: creds.orgName,
      email: creds.email,
      plan: creds.plan,
      loggedInAt: new Date().toISOString(),
    },
    { makeDefault: true },
  );
}

/**
 * Deletes all credentials — alias for removeAllWorkspaces.
 */
export function deleteCredentials(): void {
  removeAllWorkspaces();
}
