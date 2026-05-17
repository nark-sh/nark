/**
 * tsconfig auto-discovery + low-coverage guardrails.
 *
 * Background: The previous discoverTsconfig() walked a list of candidate paths
 * (root, named subdirs, monorepo roots at depth 2/3) and returned the FIRST one
 * that existed. In a turbo/pnpm monorepo like Tracearr that has no root
 * tsconfig.json (only tsconfig.base.json) but ships an `apps/e2e/tsconfig.json`
 * with only one `.ts` file, the walk would pick `apps/e2e/tsconfig.json` first
 * and `npx nark` would happily report "100/100 — no violations" after scanning
 * a single file. That's the canonical "one-file false-positive" pattern and is
 * a credibility killer for the scanner.
 *
 * Fix has two pieces:
 *   1) rankTsconfigCandidates — score candidates by depth, basename priority,
 *      composite (`references`) bonus, and how many `.ts` files they cover.
 *      Highest score wins instead of "first existing wins".
 *   2) shouldWarnLowCoverage + emitLowCoverageWarningIfNeeded — even when
 *      auto-discovery picks something, if the final scan covered <5 files
 *      absolute OR <10% of the project's `.ts` files, emit a loud yellow
 *      warning on stderr listing alternate `--tsconfig` candidates with file
 *      counts. Tiny projects (totalTsFiles <= 5) are exempt so single-fixture
 *      tests don't trigger false alarms.
 *
 * All public functions are exported and unit-tested in tsconfig-discovery.test.ts.
 */
import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".nark",
  ".git",
  "out",
]);

const FILECOUNT_CAP = 2000;
const PROJECT_TS_FILES_CAP = 5000;

export interface RankedCandidate {
  path: string;
  score: number;
  depth: number;
  isComposite: boolean;
  fileCount: number;
}

/**
 * Collect every tsconfig candidate path we'd consider for a project.
 *
 * Same walking logic as the previous discoverTsconfig() (root, named
 * subdirs, monorepo roots at depth 2 and 3) plus `tsconfig.base.json` at the
 * root — that's the turbo/pnpm/nx convention and we used to miss it entirely.
 *
 * Note: this returns the candidate paths whether or not they exist on disk.
 * Caller (rankTsconfigCandidates) filters for existing files.
 */
export function collectTsconfigCandidates(projectDir: string): string[] {
  const candidates: string[] = [
    path.join(projectDir, "tsconfig.json"),
    path.join(projectDir, "tsconfig.base.json"),
    path.join(projectDir, "tsconfig.build.json"),
  ];

  const namedSubdirs = [
    "src",
    "server",
    "frontend",
    "web",
    "client",
    "backend",
    "app",
  ];
  for (const subdir of namedSubdirs) {
    const dir = path.join(projectDir, subdir);
    if (fs.existsSync(dir)) {
      candidates.push(path.join(dir, "tsconfig.json"));
      candidates.push(path.join(dir, "tsconfig.build.json"));
    }
  }

  const monorepoRoots = ["apps", "packages", "libs"];
  for (const monorepoRoot of monorepoRoots) {
    const rootDir = path.join(projectDir, monorepoRoot);
    if (!fs.existsSync(rootDir)) continue;
    let depth2Entries: fs.Dirent[] = [];
    try {
      depth2Entries = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of depth2Entries) {
      if (!entry.isDirectory()) continue;
      const depth2Dir = path.join(rootDir, entry.name);
      candidates.push(path.join(depth2Dir, "tsconfig.json"));
      candidates.push(path.join(depth2Dir, "tsconfig.build.json"));

      for (const subdir of namedSubdirs) {
        const subDir = path.join(depth2Dir, subdir);
        if (fs.existsSync(subDir)) {
          candidates.push(path.join(subDir, "tsconfig.json"));
        }
      }

      for (const innerMonorepoDir of ["apps", "packages", "libs"]) {
        const innerRootDir = path.join(depth2Dir, innerMonorepoDir);
        if (!fs.existsSync(innerRootDir)) continue;
        try {
          const depth3DirEntries = fs.readdirSync(innerRootDir, {
            withFileTypes: true,
          });
          for (const innerEntry of depth3DirEntries) {
            if (!innerEntry.isDirectory()) continue;
            candidates.push(
              path.join(innerRootDir, innerEntry.name, "tsconfig.json"),
            );
          }
        } catch {
          // Permission errors — skip
        }
      }
    }
  }

  return candidates;
}

/**
 * Tolerant JSON-with-comments parser. tsconfig files routinely contain
 * `// line comments` and `/* block comments *\/` that strict JSON.parse rejects.
 * Returns null on any parse failure (caller treats unparseable as "no signal").
 */
function tryReadJsonLoose(filePath: string): any | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

/**
 * Recursively count `.ts`/`.tsx` files under a directory, skipping standard
 * noise dirs (node_modules, dist, .next, etc.). Stops at `cap` for perf —
 * we only need an order-of-magnitude signal, not an exact count.
 */
function countTsFilesUnder(dir: string, cap: number): number {
  let count = 0;
  const stack: string[] = [dir];
  while (stack.length > 0 && count < cap) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (count >= cap) break;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.name !== ".") continue;
        stack.push(path.join(current, entry.name));
      } else if (entry.isFile()) {
        if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          // Skip .d.ts — they're type-only and inflate the count
          if (entry.name.endsWith(".d.ts")) continue;
          count++;
        }
      }
    }
  }
  return count;
}

/**
 * Estimate how many `.ts`/`.tsx` files a given tsconfig actually covers.
 * Cheap approximation: count under each include root (or the tsconfig dir if
 * include is missing). We deliberately don't expand glob patterns precisely —
 * if a tsconfig says `include: ["src/**\/*.ts"]` we count under `src/`.
 */
function estimateFileCoverage(tsconfigPath: string): number {
  const parsed = tryReadJsonLoose(tsconfigPath);
  const tsconfigDir = path.dirname(tsconfigPath);

  // Determine include roots
  let includeRoots: string[] = [];
  if (parsed && Array.isArray(parsed.include) && parsed.include.length > 0) {
    for (const pattern of parsed.include) {
      if (typeof pattern !== "string") continue;
      // Take everything up to the first glob char as the root
      const globIdx = pattern.search(/[*?[]/);
      const root = globIdx === -1 ? pattern : pattern.slice(0, globIdx);
      const cleaned = root.replace(/\/+$/, "");
      const abs = path.isAbsolute(cleaned)
        ? cleaned
        : path.join(tsconfigDir, cleaned || ".");
      includeRoots.push(abs);
    }
  } else if (parsed && Array.isArray(parsed.files) && parsed.files.length > 0) {
    // `files` is an exact list — its length IS the coverage
    return Math.min(parsed.files.length, FILECOUNT_CAP);
  } else {
    // Default include is everything under the tsconfig dir
    includeRoots = [tsconfigDir];
  }

  // De-dupe roots and count
  const uniqueRoots = Array.from(new Set(includeRoots));
  let total = 0;
  for (const root of uniqueRoots) {
    if (!fs.existsSync(root)) continue;
    const stat = fs.statSync(root);
    if (stat.isFile()) {
      if (root.endsWith(".ts") || root.endsWith(".tsx")) total++;
    } else if (stat.isDirectory()) {
      total += countTsFilesUnder(root, FILECOUNT_CAP - total);
    }
    if (total >= FILECOUNT_CAP) break;
  }
  return total;
}

/**
 * Rank tsconfig candidates by how likely each one is to give a comprehensive
 * scan. Highest score first. See module-level docs for why this exists.
 *
 * Score components:
 *   - depthScore: depth-0 (project root) gets +1000, depth-1 +500, depth-2 +200.
 *     Comprehensive configs almost always live at the root.
 *   - basenamePriority: tsconfig.json +100, tsconfig.base.json +90,
 *     tsconfig.build.json +50. base.json is the standard monorepo root marker;
 *     build.json is sometimes broader than the default tsconfig.
 *   - compositeBonus: +300 for tsconfigs with a `references` array. Composite
 *     configs are the standard turbo/nx/pnpm pattern for monorepo roots — even
 *     when they don't directly include source files, TypeScript will follow the
 *     references and produce a comprehensive program.
 *   - fileCountScore: roughly the number of `.ts`/`.tsx` files the tsconfig
 *     covers (cap 1000). Breaks ties when depth and composite-ness are equal.
 *   - Throwaway-config penalty: paths matching `.nark/` or basename
 *     `tsconfig.scan.json` get score = 0. These are scan artifacts, never the
 *     right answer.
 */
export function rankTsconfigCandidates(
  candidates: string[],
  projectDir: string,
): RankedCandidate[] {
  const ranked: RankedCandidate[] = [];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;

    const basename = path.basename(candidate);

    // Throwaway-config check: scan-generated tsconfigs should never win
    if (
      basename === "tsconfig.scan.json" ||
      candidate.includes(`${path.sep}.nark${path.sep}`)
    ) {
      ranked.push({
        path: candidate,
        score: 0,
        depth: relativeDepth(projectDir, candidate),
        isComposite: false,
        fileCount: 0,
      });
      continue;
    }

    const depth = relativeDepth(projectDir, candidate);
    const depthScore = depth === 0 ? 1000 : depth === 1 ? 500 : depth === 2 ? 200 : 0;

    let basenamePriority = 0;
    if (basename === "tsconfig.json") basenamePriority = 100;
    else if (basename === "tsconfig.base.json") basenamePriority = 90;
    else if (basename === "tsconfig.build.json") basenamePriority = 50;

    const parsed = tryReadJsonLoose(candidate);
    const isComposite =
      parsed != null && Array.isArray(parsed.references) && parsed.references.length > 0;
    const compositeBonus = isComposite ? 300 : 0;

    const fileCount = estimateFileCoverage(candidate);
    const fileCountScore = Math.min(fileCount, 1000);

    const score = depthScore + basenamePriority + compositeBonus + fileCountScore;

    ranked.push({
      path: candidate,
      score,
      depth,
      isComposite,
      fileCount,
    });
  }

  // Stable sort by score desc, then depth asc as tiebreaker
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.depth - b.depth;
  });

  return ranked;
}

function relativeDepth(projectDir: string, candidatePath: string): number {
  const rel = path.relative(projectDir, candidatePath);
  if (!rel || rel.startsWith("..")) return 0;
  const parts = rel.split(path.sep);
  // The basename itself doesn't count; only the directory parts before it.
  return Math.max(0, parts.length - 1);
}

/**
 * Auto-discover the best tsconfig for a project directory.
 * Same external contract as the previous discoverTsconfig: returns an absolute
 * path or null. Internally, it now ranks all candidates and returns the
 * highest-scoring one (see rankTsconfigCandidates).
 */
export function discoverTsconfig(projectDir: string): string | null {
  const candidates = collectTsconfigCandidates(projectDir);
  const ranked = rankTsconfigCandidates(candidates, projectDir);
  return ranked[0]?.path ?? null;
}

/**
 * Count `.ts`/`.tsx` files under a project directory (excluding node_modules,
 * dist, .next, .turbo, etc.). Used to compute the denominator for the
 * low-coverage warning. Capped at PROJECT_TS_FILES_CAP for perf.
 */
export function countProjectTsFiles(projectDir: string): number {
  if (!fs.existsSync(projectDir)) return 0;
  return countTsFilesUnder(projectDir, PROJECT_TS_FILES_CAP);
}

/**
 * Decide whether the loud low-coverage warning should fire.
 *
 * Thresholds:
 *   - totalTsFiles <= 5 → never warn. Tiny projects (single fixture, smoke
 *     test) genuinely have few files; warning here would be a false alarm.
 *   - filesAnalyzed < 5 (absolute) → warn with reason 'absolute_low'.
 *     Almost always indicates a narrow tsconfig was picked.
 *   - filesAnalyzed / totalTsFiles < 0.1 → warn with reason 'ratio_low'.
 *     The scan touched <10% of the project's TS files.
 */
export function shouldWarnLowCoverage(opts: {
  filesAnalyzed: number;
  totalTsFiles: number;
}): { warn: boolean; reason: "absolute_low" | "ratio_low" | null } {
  if (opts.totalTsFiles <= 5) return { warn: false, reason: null };
  if (opts.filesAnalyzed < 5) return { warn: true, reason: "absolute_low" };
  if (opts.filesAnalyzed / opts.totalTsFiles < 0.1)
    return { warn: true, reason: "ratio_low" };
  return { warn: false, reason: null };
}

/**
 * Print the loud yellow low-coverage warning to stderr (must NOT go to stdout
 * so it doesn't pollute JSON/SARIF output). No-ops when shouldWarnLowCoverage
 * returns warn=false.
 *
 * If `explicit` is true, the user passed --tsconfig manually. Tone down the
 * header from "LOW COVERAGE — almost certainly wrong" to a softer note —
 * they made an explicit choice, we just want to flag it.
 */
export function emitLowCoverageWarningIfNeeded(opts: {
  projectDir: string;
  pickedTsconfig: string;
  filesAnalyzed: number;
  totalTsFiles: number;
  explicit: boolean;
}): void {
  const { warn } = shouldWarnLowCoverage({
    filesAnalyzed: opts.filesAnalyzed,
    totalTsFiles: opts.totalTsFiles,
  });
  if (!warn) return;

  // Re-rank all candidates so we can suggest alternatives. Exclude the one
  // already picked so we don't recommend the same thing back at the user.
  const candidates = collectTsconfigCandidates(opts.projectDir);
  const ranked = rankTsconfigCandidates(candidates, opts.projectDir)
    .filter((c) => path.resolve(c.path) !== path.resolve(opts.pickedTsconfig))
    .slice(0, 3);

  const write = (s: string) => process.stderr.write(s + "\n");

  write("");
  if (opts.explicit) {
    write(
      chalk.yellow(
        `Note (you passed --tsconfig explicitly): only ${opts.filesAnalyzed} files scanned (out of ~${opts.totalTsFiles} TypeScript files in this project).`,
      ),
    );
  } else {
    write(
      chalk.yellow.bold(
        `⚠  LOW COVERAGE — only ${opts.filesAnalyzed} files scanned (out of ~${opts.totalTsFiles} TypeScript files in this project).`,
      ),
    );
    write("");
    write(
      chalk.yellow(
        `This is the canonical "one-file false-positive" pattern: a narrow tsconfig was`,
      ),
    );
    write(
      chalk.yellow(
        `picked and the resulting score is almost certainly wrong.`,
      ),
    );
  }

  if (ranked.length > 0) {
    write("");
    write(chalk.dim(`Tip: pass --tsconfig <path> to one of these candidates:`));
    for (const c of ranked) {
      const rel = path.relative(opts.projectDir, c.path) || c.path;
      write(
        chalk.dim(
          `  • ${rel}  (covers ~${c.fileCount} files${c.isComposite ? ", composite" : ""})`,
        ),
      );
    }
    write("");
    write(chalk.dim(`Run: npx nark --tsconfig <path>`));
  }
  write("");
}
