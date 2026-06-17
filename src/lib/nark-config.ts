/**
 * Read/write the per-repo .nark/config.json file.
 *
 * The file is a single JSON object that may contain any of:
 *   - workspace:    nark workspace slug binding (qt-162, written by `nark workspace use --here`)
 *   - tsconfig:     repo-relative tsconfig path picked via the interactive picker
 *   - nodeModules:  repo-relative node_modules path (when not auto-detectable)
 *   - savedAt:      ISO8601 timestamp of the most recent picker write
 *   - savedFrom:    short tag describing which code path wrote the file
 *
 * Different fields are written by different callers and MUST be merge-preserved
 * — e.g. `nark workspace use --here <slug>` writes `{ workspace }` and the
 * tsconfig picker writes `{ tsconfig, nodeModules, savedAt, savedFrom }`.
 * Neither caller should clobber the other's fields.
 *
 * Spec: .planning/research/nark-cli-discovery-ux.md (Part B).
 */

import * as fs from "fs";
import * as path from "path";

export interface NarkConfigJson {
  workspace?: string;
  tsconfig?: string;
  nodeModules?: string;
  savedAt?: string;
  savedFrom?: string;
}

/**
 * Find the repo / workspace root for a given starting directory. Walks up
 * looking for any of:
 *   - .git/                  (git repo root)
 *   - pnpm-workspace.yaml    (pnpm workspace root)
 *   - lerna.json             (lerna monorepo root)
 *   - package.json with a top-level `workspaces` field (npm/yarn workspace)
 *
 * Falls back to the starting dir if no marker is found within 8 ancestor
 * levels. The 8-level bound is intentionally larger than the
 * missing-node-modules check (which uses 4) because we may be running from a
 * deeply nested CWD (e.g. `nark` invoked inside packages/foo/src/components/).
 */
export function findRepoRoot(startDir: string): string {
  const start = path.resolve(startDir);
  let dir = start;
  const MAX_LEVELS = 8;
  for (let level = 0; level <= MAX_LEVELS; level++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    if (fs.existsSync(path.join(dir, "lerna.json"))) return dir;

    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (parsed && typeof parsed === "object") {
          const ws = parsed.workspaces;
          if (Array.isArray(ws) && ws.length > 0) return dir;
          if (ws && typeof ws === "object" && Array.isArray(ws.packages)) {
            return dir;
          }
        }
      } catch {
        // unreadable / unparseable — keep walking
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root — stop walking
    dir = parent;
  }
  // No marker found anywhere in the walked range — fall back to start dir
  // rather than returning the filesystem root.
  return start;
}

function configFilePath(repoRoot: string): string {
  return path.join(repoRoot, ".nark", "config.json");
}

/**
 * Read .nark/config.json from a repo root. Returns the parsed object or null
 * if the file is missing / unparseable. Never throws.
 */
export function readNarkConfig(repoRoot: string): NarkConfigJson | null {
  const file = configFilePath(repoRoot);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as NarkConfigJson;
    return null;
  } catch {
    return null;
  }
}

/**
 * Merge-and-write .nark/config.json. Reads any existing file, shallow-merges
 * `patch` on top, writes back as pretty JSON. Creates `.nark/` if missing.
 */
export function writeNarkConfig(
  repoRoot: string,
  patch: Partial<NarkConfigJson>,
): void {
  const existing = readNarkConfig(repoRoot) ?? {};
  const merged: NarkConfigJson = { ...existing, ...patch };
  const dir = path.join(repoRoot, ".nark");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    configFilePath(repoRoot),
    JSON.stringify(merged, null, 2) + "\n",
    "utf8",
  );
}
