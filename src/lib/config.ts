/**
 * Per-repo workspace binding reader (qt-162).
 *
 * Reads `.nark/config.json` (canonical) or `.narkrc.json` (legacy) walking
 * up from a cwd to the filesystem root (or until a `.git` directory is hit).
 *
 * Both formats are `{ "workspace": "<orgSlug>" }`. Other keys are ignored.
 *
 * Conflict rule: when BOTH files coexist at the same directory level AND
 * both define a `workspace` field, the canonical `.nark/config.json` value
 * wins. A one-time-per-process stderr warning is emitted advising removal
 * of the legacy `.narkrc.json`.
 */

import * as fs from "fs";
import * as path from "path";

export interface RepoWorkspaceSource {
  slug: string;
  source: "config" | "narkrc";
}

let _conflictWarned = false;

function safeReadWorkspaceField(filePath: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.workspace === "string" &&
      parsed.workspace.length > 0
    ) {
      return parsed.workspace;
    }
  } catch {
    // file missing or unparsable — treat as no field
  }
  return null;
}

/**
 * Walks up from `cwd` looking for `.nark/config.json` or `.narkrc.json` with
 * a `workspace` field. Stops at the first directory level providing at least
 * one of them.
 *
 * Returns `{slug, source: 'config'|'narkrc'}` or null if neither found.
 */
export function readRepoWorkspace(cwd: string): RepoWorkspaceSource | null {
  let currentDir = path.resolve(cwd);
  const root = path.parse(currentDir).root;

  while (true) {
    const configSlug = safeReadWorkspaceField(
      path.join(currentDir, ".nark", "config.json"),
    );
    const narkrcSlug = safeReadWorkspaceField(
      path.join(currentDir, ".narkrc.json"),
    );

    if (configSlug && narkrcSlug) {
      if (!_conflictWarned) {
        process.stderr.write(
          `Found both .nark/config.json (canonical) and .narkrc.json (legacy) in ${currentDir}. Using .nark/config.json. Consider removing .narkrc.json.\n`,
        );
        _conflictWarned = true;
      }
      return { slug: configSlug, source: "config" };
    }
    if (configSlug) {
      return { slug: configSlug, source: "config" };
    }
    if (narkrcSlug) {
      return { slug: narkrcSlug, source: "narkrc" };
    }

    // Stop at git root if found
    if (fs.existsSync(path.join(currentDir, ".git"))) {
      return null;
    }

    if (currentDir === root) {
      return null;
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) return null;
    currentDir = parent;
  }
}
