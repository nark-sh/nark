/**
 * Interactive tsconfig picker for first-run scans.
 *
 * Background: when `npx nark` is invoked in a monorepo with multiple
 * tsconfig*.json files (root + packages/*) and the user did not pass
 * `--tsconfig`, the auto-discovery path in `src/tsconfig-discovery.ts` will
 * silently pick the highest-scoring candidate. That's fine when the scores
 * are decisive but it produces surprise scans when the top candidates are
 * close. This module adds an interactive numbered picker for the close-call
 * case and persists the choice to `.nark/config.json` so the next run uses
 * the saved value without prompting.
 *
 * Non-TTY runs (CI, `npx nark | jq`, etc.) skip the prompt entirely — the
 * highest-scored candidate is used and announced once on stderr. No file is
 * written in that mode (we only persist after a human chose).
 *
 * Spec: .planning/research/nark-cli-discovery-ux.md (Part B).
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import chalk from "chalk";

import {
  collectTsconfigCandidates,
  rankTsconfigCandidates,
  type RankedCandidate,
} from "../tsconfig-discovery.js";

/**
 * A candidate as rendered in the picker. Adds project-name annotation on top
 * of the ranked candidate so the human sees something meaningful next to
 * each numeric option.
 */
export interface PickerCandidate extends RankedCandidate {
  /** `name` field from the nearest sibling package.json (or null). */
  projectName: string | null;
}

/**
 * Score gap below which we consider two candidates "close" and show the
 * picker. Above this gap, the top candidate is decisive and we fall through
 * to the silent auto-discovery path.
 */
const CLOSE_SCORE_GAP = 200;

/**
 * Maximum number of candidates rendered in the picker. The auto-discovery
 * sometimes finds 10+ candidates (large monorepos); we cap at this many to
 * keep the picker readable. The first candidate in the slice is always the
 * top-ranked.
 */
const MAX_PICKER_OPTIONS = 6;

function readProjectName(tsconfigPath: string): string | null {
  // Look for the nearest sibling package.json (walk up at most 2 levels).
  let dir = path.dirname(tsconfigPath);
  for (let i = 0; i < 3; i++) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (parsed && typeof parsed === "object") {
          const name = (parsed as { name?: unknown }).name;
          if (typeof name === "string" && name.length > 0) return name;
        }
      } catch {
        // ignore
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function annotate(
  candidates: RankedCandidate[],
): PickerCandidate[] {
  return candidates.map((c) => ({
    ...c,
    projectName: readProjectName(c.path),
  }));
}

/**
 * Return the candidates that should be shown in the picker, or null when
 * the picker is not warranted (single candidate, or top candidate is
 * decisively better than runners-up by CLOSE_SCORE_GAP).
 *
 * The returned list is always size 2..MAX_PICKER_OPTIONS, sorted by score
 * descending.
 */
export function selectPickerCandidates(
  projectDir: string,
): PickerCandidate[] | null {
  const raw = collectTsconfigCandidates(projectDir);
  const ranked = rankTsconfigCandidates(raw, projectDir);
  // Throwaway / zero-score configs are not picker-worthy.
  const usable = ranked.filter((c) => c.score > 0);
  if (usable.length <= 1) return null;

  const top = usable[0];
  const runner = usable[1];
  if (top.score - runner.score > CLOSE_SCORE_GAP) {
    // Decisive winner — no picker needed.
    return null;
  }

  return annotate(usable.slice(0, MAX_PICKER_OPTIONS));
}

/**
 * Render the picker, prompt for a numeric choice, return the picked
 * candidate. Defaults to candidate #1 on bare Enter. Returns null only on
 * EOF / explicit empty stream — the caller should fall back to the
 * highest-ranked candidate silently in that case.
 *
 * `stdout` and `stdin` parameters exist so tests can wire up streams.
 * Production callers pass `process.stdout` and `process.stdin`.
 */
export async function promptPicker(
  candidates: PickerCandidate[],
  projectDir: string,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = {
    input: process.stdin,
    output: process.stderr,
  },
): Promise<PickerCandidate | null> {
  if (candidates.length === 0) return null;

  const lines: string[] = [];
  lines.push("");
  lines.push(chalk.bold("Multiple tsconfig.json found. Pick one:"));
  lines.push("");

  candidates.forEach((c, idx) => {
    const num = String(idx + 1);
    const rel = path.relative(projectDir, c.path) || c.path;
    const ann: string[] = [];
    if (c.projectName) ann.push(c.projectName);
    ann.push(`${c.fileCount} files`);
    if (c.isComposite) ann.push("composite");
    lines.push(`  ${chalk.bold(num + ".")} ${rel}`);
    lines.push(`     ${chalk.dim(ann.join("  ·  "))}`);
    lines.push("");
  });

  for (const line of lines) {
    io.output.write(line + "\n");
  }

  const rl = readline.createInterface({
    input: io.input,
    output: io.output,
    terminal: false,
  });

  const answer: string = await new Promise((resolve) => {
    rl.question(chalk.bold("Pick [1]: "), (ans) => resolve(ans));
  });
  rl.close();

  const trimmed = answer.trim();
  if (trimmed === "") return candidates[0];

  const parsed = Number.parseInt(trimmed, 10);
  if (
    Number.isFinite(parsed) &&
    parsed >= 1 &&
    parsed <= candidates.length
  ) {
    return candidates[parsed - 1];
  }
  // Unparseable / out-of-range — fall back to candidate #1.
  io.output.write(
    chalk.yellow(
      `(invalid selection "${trimmed}" — using #1)\n`,
    ),
  );
  return candidates[0];
}
