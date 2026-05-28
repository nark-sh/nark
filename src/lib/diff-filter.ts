/**
 * diff-filter
 *
 * Parses `git diff <base>..<head>` and returns a Map of file path → set of
 * line numbers that the diff added/modified on the new side. Used by the
 * `--diff` CLI flag to filter violations down to only those introduced by
 * the diff (PR-mode scanning).
 *
 * Same posture CodeRabbit / Greptile take: do not surface pre-existing
 * violations on untouched lines of touched files.
 */

import { execSync } from 'child_process';
import * as path from 'path';

export interface DiffSpec {
  base: string;
  head: string;
}

/** Map of absolute new-side file path → Set of line numbers added/modified by the diff. */
export type DiffLineMap = Map<string, Set<number>>;

/**
 * Parse a `<base>..<head>` spec string.
 *
 * Note: this is the two-dot form (direct comparison), NOT the three-dot form
 * `<base>...<head>` (merge-base comparison). The two-dot form is what we want
 * here — it returns the precise set of lines GitHub displays as the PR diff.
 *
 * @throws Error if the spec is not exactly `<non-empty>..<non-empty>`.
 */
export function parseDiffSpec(spec: string): DiffSpec {
  if (typeof spec !== 'string' || spec.length === 0) {
    throw new Error('Invalid --diff spec: expected <base>..<head>');
  }
  const parts = spec.split('..');
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw new Error('Invalid --diff spec: expected <base>..<head>');
  }
  return { base: parts[0], head: parts[1] };
}

/**
 * Parse one or more unified-diff hunk headers and return the set of new-side
 * line numbers they cover.
 *
 * Hunk header format: `@@ -oldStart[,oldCount] +newStart[,newCount] @@ [optional context]`
 *
 * - `newCount` omitted → defaults to 1
 * - `newCount === 0` → deletion-only hunk, no new lines to include
 * - `newCount >= 1` → lines `newStart..newStart+newCount-1` are added/modified
 */
export function parseHunkHeadersToLines(diffOutput: string): Set<number> {
  const lines = new Set<number>();
  const hunkRegex = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;

  let match: RegExpExecArray | null;
  while ((match = hunkRegex.exec(diffOutput)) !== null) {
    const newStart = parseInt(match[1], 10);
    const newCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
    if (newCount === 0) continue; // deletion-only hunk
    for (let i = 0; i < newCount; i++) {
      lines.add(newStart + i);
    }
  }
  return lines;
}

interface ExecOptions {
  cwd: string;
}

/**
 * Internal: run a git command and return stdout as a string. Wrapped so
 * tests can mock `child_process.execSync`.
 */
function runGit(cmd: string, opts: ExecOptions): string {
  return execSync(cmd, {
    cwd: opts.cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024, // 64MB — generous for very large diffs
  });
}

/**
 * Enumerate changed files (with rename detection) between two refs.
 * Returns paths on the new side. Deleted files (status 'D') are skipped
 * since they cannot host any new-line violations.
 *
 * `git diff --name-status -M` rows look like:
 *   M\tpath/to/file.ts
 *   A\tpath/to/new.ts
 *   D\tpath/to/gone.ts
 *   R100\told/path.ts\tnew/path.ts   (rename — third column is new path)
 */
function listChangedFilesNewSide(spec: DiffSpec, opts: ExecOptions): string[] {
  const out = runGit(`git diff --name-status -M ${spec.base}..${spec.head}`, opts);
  const files: string[] = [];
  for (const rawLine of out.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const cols = line.split('\t');
    const status = cols[0] || '';
    if (status.startsWith('D')) continue; // deleted — no new lines
    if (status.startsWith('R') || status.startsWith('C')) {
      // Rename or copy — new path is the third column
      if (cols.length >= 3 && cols[2]) files.push(cols[2]);
    } else {
      // A / M / T / U etc. — single path in column 2
      if (cols.length >= 2 && cols[1]) files.push(cols[1]);
    }
  }
  return files;
}

/**
 * Compute the per-file map of added/modified line numbers on the new side
 * between two refs.
 *
 * For each changed (non-deleted) file we run
 *   `git diff --unified=0 <base>..<head> -- <newPath>`
 * and parse the hunk headers. Paths in the returned map are absolute,
 * resolved against `opts.cwd`.
 */
export function computeDiffLines(spec: DiffSpec, opts: ExecOptions): DiffLineMap {
  const map: DiffLineMap = new Map();
  const files = listChangedFilesNewSide(spec, opts);

  for (const file of files) {
    // Quote the path defensively in case it contains spaces.
    const out = runGit(
      `git diff --unified=0 ${spec.base}..${spec.head} -- "${file}"`,
      opts,
    );
    const lines = parseHunkHeadersToLines(out);
    if (lines.size === 0) continue;
    const absPath = path.resolve(opts.cwd, file);
    map.set(absPath, lines);
  }

  return map;
}

/** Minimal shape we care about on a violation, tolerant of field aliases. */
interface ViolationLike {
  file?: string;
  filePath?: string;
  line?: number;
  lineNumber?: number;
}

/**
 * Keep only violations whose `(absolute file path, line number)` is present
 * in the diff map.
 *
 * Behavior:
 * - Violation file path normalized to absolute (against process cwd) before
 *   comparison. Map keys are already absolute.
 * - File not in the map at all → excluded.
 * - File in the map but line not in the set → excluded (the whole point of
 *   line-level filtering: 12 pre-existing axios calls in a file the PR adds
 *   1 line to should NOT be flagged).
 * - Empty diff map → empty result (positive filter, not a no-op).
 * - Missing file or line field on a violation → excluded (defensive).
 */
export function filterViolationsByDiff<V extends ViolationLike>(
  violations: V[],
  diffMap: DiffLineMap,
): V[] {
  if (diffMap.size === 0) return [];

  const out: V[] = [];
  for (const v of violations) {
    const rawFile = v.file ?? v.filePath;
    const rawLine = v.line ?? v.lineNumber;
    if (!rawFile || typeof rawLine !== 'number') continue;

    const abs = path.isAbsolute(rawFile) ? rawFile : path.resolve(process.cwd(), rawFile);
    const lineSet = diffMap.get(abs);
    if (lineSet && lineSet.has(rawLine)) {
      out.push(v);
    }
  }
  return out;
}
