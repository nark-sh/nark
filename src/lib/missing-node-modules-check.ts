/**
 * qt-179 — Pre-scan missing-node_modules detection.
 *
 * Walks up from the tsconfig file's directory looking for:
 *   - the nearest package.json (first one wins),
 *   - any node_modules/ at the same or any walked ancestor,
 *   - a workspace marker (pnpm-workspace.yaml, lerna.json, or a package.json
 *     with a top-level `workspaces` field) — this is the rule that fixes the
 *     pnpm/yarn-workspaces failure mode where the workspace member has no
 *     sibling node_modules because deps are hoisted to the workspace root.
 *
 * If any walked ancestor has node_modules/, the scan proceeds and the
 * resolved path is returned in the `ok` result. If no node_modules is found
 * anywhere in the walked range, returns `missing` with `searchedPaths` and
 * (when applicable) `workspaceRoot` so the caller can render a path-aware
 * error message and target the install hint at the workspace root.
 *
 * Pure detection only. Side effects (stderr write, process.exit,
 * NARK_ALLOW_MISSING_DEPS handling) belong to the caller in src/index.ts.
 *
 * Decision references (CONTEXT.md):
 *   - DEC1: block by default (caller exits 1; this module just detects).
 *   - DEC3: include peerDependencies in the match set; exact-name match
 *     including @scope/name.
 *
 * Spec: .planning/research/nark-cli-discovery-ux.md (Part A).
 */

import * as fs from "fs";
import * as path from "path";

/**
 * Max number of directory levels above the tsconfig dir to walk when looking
 * for an ancestor node_modules. The workspace-marker short-circuit will stop
 * the walk earlier in the common case; this bound is a safety net so we don't
 * silently pick up a stale ~/code or /tmp node_modules.
 */
const MAX_ANCESTOR_LEVELS = 4;

export type WorkspaceMarkerType =
  | "pnpm-workspace.yaml"
  | "lerna.json"
  | "package.json-workspaces";

export type MissingNodeModulesResult =
  | {
      kind: "ok";
      /**
       * Set when an ancestor node_modules/ was found via the multi-level walk
       * (i.e. node_modules is not sibling-of-package.json but is higher up).
       * Caller may use this for verbose logging; downstream type resolution
       * is unchanged (TypeScript walks node_modules itself).
       */
      resolvedNodeModules?: string;
    }
  | {
      kind: "missing";
      packageJsonDir: string;
      matchingDeps: string[];
      /** All node_modules paths checked during the walk, in walk order. */
      searchedPaths: string[];
      /** Directory containing the workspace marker, if one was found. */
      workspaceRoot: string | null;
      /** Which marker type was matched at workspaceRoot. */
      workspaceMarkerType: WorkspaceMarkerType | null;
    };

export interface CheckOptions {
  /** Path to the tsconfig.json that nark is about to scan. */
  tsconfigPath: string;
  /**
   * Set of profile names available in the corpus. Caller passes
   * `corpusResult.contracts.keys()` so this module does not re-walk the corpus.
   */
  corpusContractNames: Iterable<string>;
}

function safeReadJson(filePath: string): unknown {
  let body: string;
  try {
    body = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function readDeclaredNames(packageJsonPath: string): Set<string> | null {
  const parsed = safeReadJson(packageJsonPath);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const names = new Set<string>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
  ] as const) {
    const section = obj[field];
    if (section && typeof section === "object") {
      for (const name of Object.keys(section as Record<string, unknown>)) {
        names.add(name);
      }
    }
  }
  return names;
}

/**
 * Detect a workspace marker at `dir`. Returns the marker type or null.
 *
 * Markers (in priority order):
 *   1. `pnpm-workspace.yaml` — pnpm workspaces
 *   2. `lerna.json` — Lerna monorepos
 *   3. `package.json` with a top-level `workspaces` field — npm/yarn/bun
 *      workspaces (object form `{packages: [...]}` or array form `[...]`)
 */
function detectWorkspaceMarker(dir: string): WorkspaceMarkerType | null {
  if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
    return "pnpm-workspace.yaml";
  }
  if (fs.existsSync(path.join(dir, "lerna.json"))) {
    return "lerna.json";
  }
  const pkgPath = path.join(dir, "package.json");
  if (fs.existsSync(pkgPath)) {
    const parsed = safeReadJson(pkgPath);
    if (parsed && typeof parsed === "object") {
      const ws = (parsed as Record<string, unknown>).workspaces;
      if (Array.isArray(ws) && ws.length > 0) {
        return "package.json-workspaces";
      }
      if (
        ws &&
        typeof ws === "object" &&
        Array.isArray((ws as { packages?: unknown }).packages)
      ) {
        return "package.json-workspaces";
      }
    }
  }
  return null;
}

function isExistingDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function checkMissingNodeModules(
  opts: CheckOptions,
): MissingNodeModulesResult {
  const corpusSet = new Set(opts.corpusContractNames);

  const startDir = path.dirname(path.resolve(opts.tsconfigPath));

  const searchedPaths: string[] = [];
  let pkgPath: string | null = null;
  let pkgDir: string | null = null;
  let resolvedNodeModules: string | null = null;
  let workspaceRoot: string | null = null;
  let workspaceMarkerType: WorkspaceMarkerType | null = null;

  let dir = startDir;
  let level = 0;

  while (true) {
    // 1. Check node_modules at this ancestor.
    const nmPath = path.join(dir, "node_modules");
    searchedPaths.push(nmPath);
    if (!resolvedNodeModules && isExistingDir(nmPath)) {
      resolvedNodeModules = nmPath;
    }

    // 2. Record nearest package.json (first one wins).
    if (!pkgPath) {
      const candidate = path.join(dir, "package.json");
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        pkgPath = candidate;
        pkgDir = dir;
      }
    }

    // 3. Record workspace marker (first one wins — defines the workspace root).
    if (!workspaceRoot) {
      const marker = detectWorkspaceMarker(dir);
      if (marker) {
        workspaceRoot = dir;
        workspaceMarkerType = marker;
      }
    }

    // Stop conditions (checked AFTER processing this level so the marker dir
    // itself is fully inspected for node_modules / package.json).
    if (workspaceRoot === dir) break; // don't walk past a workspace root
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    if (level >= MAX_ANCESTOR_LEVELS) break;

    dir = parent;
    level++;
  }

  // No package.json anywhere in the walked range — nothing to validate.
  if (!pkgPath || !pkgDir) {
    return { kind: "ok" };
  }

  const declared = readDeclaredNames(pkgPath);
  if (!declared) {
    return { kind: "ok" };
  }

  const matching: string[] = [];
  for (const name of declared) {
    if (corpusSet.has(name)) {
      matching.push(name);
    }
  }
  if (matching.length === 0) {
    return { kind: "ok" };
  }

  // Stable ordering for deterministic warning output.
  matching.sort();

  if (resolvedNodeModules) {
    return { kind: "ok", resolvedNodeModules };
  }

  return {
    kind: "missing",
    packageJsonDir: pkgDir,
    matchingDeps: matching,
    searchedPaths,
    workspaceRoot,
    workspaceMarkerType,
  };
}
