/**
 * Global path resolution for nark runtime artifacts.
 *
 * All transient/cache artifacts live under `~/.nark/projects/<encoded>/`
 * where <encoded> is the absolute project root with `/` replaced by `-`
 * and a leading `-` (mirrors Claude Code's per-project memory pattern).
 *
 * Scope: scans, violations, runs/<runDir>, generated tsconfig.json,
 * init config.json, suppressions.json (manifest cache).
 *
 * NOT in scope: `.nark/config.yaml`, `.nark/suppressions.json` (intentional
 * project-local team config), `~/.nark/credentials`, `~/.nark/telemetry.json`
 * (already global, handled elsewhere).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Encode an absolute project root path into a folder name.
 * Mirrors Claude Code's pattern: prepend '-', replace '/' with '-'.
 * Example: '/Users/calebgates/foo' -> '-Users-calebgates-foo'.
 *
 * Relative inputs are resolved to absolute first.
 */
export function encodeProjectPath(absProjectRoot: string): string {
  const abs = path.resolve(absProjectRoot);
  return abs.replace(/\//g, '-');
}

function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureParent(filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return filePath;
}

/** ~/.nark/projects/<encoded>/ — lazily created. */
export function getNarkProjectDir(projectRoot: string): string {
  return ensureDir(
    path.join(os.homedir(), '.nark', 'projects', encodeProjectPath(projectRoot))
  );
}

export function getNarkScansDir(projectRoot: string): string {
  return ensureDir(path.join(getNarkProjectDir(projectRoot), 'scans'));
}

export function getNarkViolationsDir(projectRoot: string): string {
  return ensureDir(path.join(getNarkProjectDir(projectRoot), 'violations'));
}

export function getNarkRunsDir(projectRoot: string): string {
  return ensureDir(path.join(getNarkProjectDir(projectRoot), 'runs'));
}

export function getNarkGeneratedTsconfig(projectRoot: string): string {
  return ensureParent(path.join(getNarkProjectDir(projectRoot), 'tsconfig.json'));
}

export function getNarkInitConfig(projectRoot: string): string {
  return ensureParent(path.join(getNarkProjectDir(projectRoot), 'config.json'));
}

export function getNarkSuppressionsManifest(projectRoot: string): string {
  return ensureParent(path.join(getNarkProjectDir(projectRoot), 'suppressions.json'));
}

/**
 * Short readable form of a project id for DISPLAY ONLY.
 * Returns "<basename>-<6char-hex>" where the hex is the first 6 chars of
 * sha1(absolute project path). On-disk naming continues to use
 * encodeProjectPath() — this is purely a presentation helper introduced by
 * qt-185 to keep the post-scan Results line readable in marketing
 * screenshots.
 *
 * Example:
 *   input:  '/Users/calebgates/WebstormProjects/behavioral-contracts/nark-dev/nark-corpus'
 *   output: 'nark-corpus-8c27717' (6 hex chars after the basename)
 *
 * Why sha1 (not the path hash itself or a random suffix):
 * - Deterministic — same project always shows the same display id.
 * - Cheap — already in node:crypto.
 * - 6 hex chars = ~16M slots, more than enough for one user's project tree.
 * - Collisions are cosmetic only; on-disk paths stay uniquely encoded.
 *
 * Relative inputs are resolved to absolute first (same convention as
 * encodeProjectPath).
 */
export function displayProjectId(projectRoot: string): string {
  const abs = path.resolve(projectRoot);
  const basename = path.basename(abs);
  const hash = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 6);
  return `${basename}-${hash}`;
}
