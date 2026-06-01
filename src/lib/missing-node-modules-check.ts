/**
 * qt-179 — Pre-scan missing-node_modules detection.
 *
 * Walks up from the tsconfig file's directory to find the nearest package.json.
 * If that package.json declares any corpus-covered dependency (across
 * dependencies, devDependencies, OR peerDependencies) but the same directory
 * has no `node_modules/`, returns `{ kind: 'missing', ... }`.
 *
 * Pure detection only. Side effects (stderr write, process.exit,
 * NARK_ALLOW_MISSING_DEPS handling) belong to the caller in src/index.ts.
 *
 * Decision references (CONTEXT.md):
 *   - DEC1: block by default (caller exits 1; this module just detects).
 *   - DEC3: include peerDependencies in the match set; exact-name match including @scope/name.
 *   - Walk up from the tsconfig file's directory; check node_modules in the
 *     same directory as the discovered package.json (handles pnpm workspaces
 *     naturally — per-package node_modules counts as "installed").
 */

import * as fs from "fs";
import * as path from "path";

export type MissingNodeModulesResult =
  | { kind: "ok" }
  | { kind: "missing"; packageJsonDir: string; matchingDeps: string[] };

export interface CheckOptions {
  /** Path to the tsconfig.json that nark is about to scan. */
  tsconfigPath: string;
  /**
   * Set of profile names available in the corpus. Caller passes
   * `corpusResult.contracts.keys()` so this module does not re-walk the corpus.
   */
  corpusContractNames: Iterable<string>;
}

function findNearestPackageJson(startDir: string): string | null {
  let dir = startDir;
  // Walk up until we hit a fixed point (filesystem root).
  while (true) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      // Reached the filesystem root.
      return null;
    }
    dir = parent;
  }
}

function readDeclaredNames(packageJsonPath: string): Set<string> | null {
  let body: string;
  try {
    body = fs.readFileSync(packageJsonPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Malformed package.json — do not block the scan over this. Nark itself
    // will surface a clearer downstream error.
    return null;
  }
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

export function checkMissingNodeModules(
  opts: CheckOptions,
): MissingNodeModulesResult {
  const corpusSet = new Set(opts.corpusContractNames);

  const startDir = path.dirname(path.resolve(opts.tsconfigPath));
  const pkgPath = findNearestPackageJson(startDir);
  if (!pkgPath) {
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

  const pkgDir = path.dirname(pkgPath);
  const nmPath = path.join(pkgDir, "node_modules");
  if (fs.existsSync(nmPath)) {
    return { kind: "ok" };
  }

  // Stable ordering for deterministic warning output.
  matching.sort();
  return { kind: "missing", packageJsonDir: pkgDir, matchingDeps: matching };
}
