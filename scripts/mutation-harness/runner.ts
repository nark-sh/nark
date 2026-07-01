/**
 * Mutation harness runner.
 *
 * See work-packages/accuracy-roadmap/0004-mutation-harness-spec.md for the
 * full specification. This file implements §4 (verification protocol) and
 * §5's per-PR sampling mode.
 *
 * Invocation:
 *   node scripts/mutation-harness/runner.ts [--sample 0.2] [--output <path>]
 *   node scripts/mutation-harness/runner.ts --sample 0.02 --output /tmp/mutation-run.json
 *   node scripts/mutation-harness/runner.ts --sample 1 --shard-index 0 --shard-count 10
 *
 * Sharding (spec 0004 §5): the nightly full matrix is fanned across 10 GHA
 * runners via `--shard-index N --shard-count K`. Deterministic hash of the
 * (seed_path, operator_name) tuple decides ownership so every shard sees
 * ~1/K of the total pairs with no overlap and no coordination.
 *
 * Design notes:
 *   - Walks BOTH `nark-corpus/` and `nark-corpus-pro/` per multi-corpus rules
 *     (.claude/rules/multi-corpus.md). If either directory is missing, it's
 *     skipped without failure.
 *   - Uses the programmatic runScan() API from src/api.ts (not the CLI) to
 *     avoid subprocess spawn cost on 7k+ scan invocations.
 *   - Mutant files land in `nark-dev/nark/mutations/staging/<operator>/...`.
 *     This directory is gitignored. NEVER commits to fixtures/.
 *   - Output JSON: `nark-dev/nark/mutations/runs/<timestamp>.json`.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';
import { runScan } from '../../src/api.js';
import type { ScanResult, ScanViolation } from '../../src/api.js';
import { ALL_OPERATORS, type MutationOperator } from './operators/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');            // nark-dev/nark
const WORKSPACE_ROOT = path.resolve(REPO_ROOT, '..', '..');       // behavioral-contracts

const CORPUS_TIERS = [
  { name: 'public', path: path.join(WORKSPACE_ROOT, 'nark-dev', 'nark-corpus') },
  { name: 'pro', path: path.join(WORKSPACE_ROOT, 'nark-dev', 'nark-corpus-pro') },
];

const STAGING_ROOT = path.join(REPO_ROOT, 'mutations', 'staging');
const RUNS_ROOT = path.join(REPO_ROOT, 'mutations', 'runs');

const FIXTURE_FILENAMES = [
  'proper-error-handling.ts',
  'missing-error-handling.ts',
  'instance-usage.ts',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Seed {
  /** Absolute path to the seed .ts fixture. */
  path: string;
  /** Fixture type inferred from filename. */
  type: 'proper' | 'missing' | 'instance';
  /** Package name (e.g. "axios", "@prisma/client"). */
  packageName: string;
  /** Corpus tier ("public" | "pro"). */
  tier: string;
  /** Path to the fixture directory's tsconfig.json. */
  tsconfig: string;
  /** Path to the fixture directory (for corpus + resolution). */
  fixtureDir: string;
  /** Path to the corpus root for this seed. */
  corpusPath: string;
}

interface PairOutcome {
  seed_path: string;
  seed_tier: string;
  package_name: string;
  operator: string;
  operator_kind: string;
  expected: string;
  outcome: 'pass' | 'fail-recall' | 'fail-precision' | 'fail-noise' | 'skip';
  violations_before: ScanViolation[];
  violations_after: ScanViolation[];
  skip_reason?: string;
  mutant_path?: string;
}

interface OperatorAggregate {
  pass: number;
  fail_recall: number;
  fail_precision: number;
  fail_noise: number;
  skip: number;
  coverage: number;
}

interface RunReport {
  run_id: string;
  ran_at: string;
  scanner_version: string;
  corpus_version: string;
  nark_commit_sha?: string;
  corpus_commit_sha?: string;
  sample_rate: number;
  /**
   * Shard identity for this partial run. shard_count=1 means this run holds
   * the entire (sampled) matrix; shard_count>1 means the run holds ~1/K of
   * the (seed, operator) pairs and must be merged with sibling shards for
   * matrix-complete stats.
   */
  shard_index?: number;
  shard_count?: number;
  totals: {
    seeds: number;
    operators: number;
    pairs: number;
    pass: number;
    fail_recall: number;
    fail_precision: number;
    fail_noise: number;
    skip: number;
  };
  aggregates: {
    per_operator: Record<string, OperatorAggregate>;
  };
  results: PairOutcome[];
}

// ---------------------------------------------------------------------------
// Seed enumeration
// ---------------------------------------------------------------------------

function walkFixtureSeeds(): Seed[] {
  const seeds: Seed[] = [];
  for (const tier of CORPUS_TIERS) {
    if (!fs.existsSync(path.join(tier.path, 'packages'))) continue;
    const packagesDir = path.join(tier.path, 'packages');

    // packages contain scoped-package subdirs (@scope/name/) and plain (name/).
    const walkPackages = (dir: string, packagePrefix = ''): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const entryPath = path.join(dir, entry.name);
        // Scoped package roots start with `@`
        if (entry.name.startsWith('@') && packagePrefix === '') {
          walkPackages(entryPath, entry.name);
          continue;
        }
        const packageName = packagePrefix
          ? `${packagePrefix}/${entry.name}`
          : entry.name;
        const fixturesDir = path.join(entryPath, 'fixtures');
        if (!fs.existsSync(fixturesDir)) continue;
        const tsconfig = path.join(fixturesDir, 'tsconfig.json');
        if (!fs.existsSync(tsconfig)) continue;

        for (const fixtureFile of FIXTURE_FILENAMES) {
          const fixturePath = path.join(fixturesDir, fixtureFile);
          if (!fs.existsSync(fixturePath)) continue;
          seeds.push({
            path: fixturePath,
            type: fixtureFile.startsWith('proper')
              ? 'proper'
              : fixtureFile.startsWith('missing')
                ? 'missing'
                : 'instance',
            packageName,
            tier: tier.name,
            tsconfig,
            fixtureDir: fixturesDir,
            corpusPath: tier.path,
          });
        }
      }
    };

    walkPackages(packagesDir);
  }
  return seeds;
}

// ---------------------------------------------------------------------------
// Deterministic sampling (hash-based per spec §5)
// ---------------------------------------------------------------------------

function sampleSeeds(seeds: Seed[], rate: number): Seed[] {
  if (rate >= 1) return seeds;
  if (rate <= 0) return [];
  return seeds.filter((seed) => {
    const digest = crypto
      .createHash('sha256')
      .update(seed.path)
      .digest();
    // Take first 4 bytes as uint32; treat as fraction of 2^32.
    const asUint = digest.readUInt32BE(0);
    return asUint / 0xffffffff < rate;
  });
}

/**
 * Deterministic shard selection.
 *
 * Given a `(seed, operator)` pair, decide whether the current shard owns it.
 * Hash-based selection means every shard sees ~1/K of the total workload with
 * no coordination and no cross-shard overlap. Used by the nightly workflow
 * (spec 0004 §5) to fan the full matrix across 10 GHA runners.
 *
 * Called at pair-classify time (see main loop). Kept here rather than at
 * seed-filter time because M9/M10 apply to `any` seed and we want operator
 * variety per shard, not just per seed.
 */
function shardOwns(
  seedPath: string,
  operatorName: string,
  shardIndex: number,
  shardCount: number,
): boolean {
  if (shardCount <= 1) return true;
  const digest = crypto
    .createHash('sha256')
    .update(`${seedPath}::${operatorName}`)
    .digest();
  const asUint = digest.readUInt32BE(0);
  return asUint % shardCount === shardIndex;
}

// ---------------------------------------------------------------------------
// Scan wrappers
// ---------------------------------------------------------------------------

/**
 * Run nark against a single .ts file by writing a temporary tsconfig that
 * includes only that file. Cleans up the tsconfig even on failure.
 */
async function scanSingleFile(
  filePath: string,
  corpusPath: string,
): Promise<ScanResult> {
  const dir = path.dirname(filePath);
  const tsconfigTmp = path.join(
    dir,
    `__mutation-harness-${path.basename(filePath, '.ts')}-tsconfig.json`,
  );
  const tsConfigContent = {
    compilerOptions: {
      target: 'ES2020',
      module: 'commonjs',
      lib: ['ES2020'],
      strict: false,
      esModuleInterop: true,
      skipLibCheck: true,
      moduleResolution: 'node',
    },
    include: [path.basename(filePath)],
  };
  fs.writeFileSync(tsconfigTmp, JSON.stringify(tsConfigContent, null, 2));

  try {
    const result = await runScan({
      tsconfigPath: tsconfigTmp,
      corpusPath,
      includeTests: false,
    });
    // Filter to violations from THIS file only (in case tsconfig picks up siblings).
    const targetBase = path.basename(filePath);
    const filtered = result.violations.filter(
      (v) => path.basename(v.location.file) === targetBase,
    );
    return {
      violations: filtered,
      summary: {
        totalViolations: filtered.length,
        errorCount: filtered.filter((v) => v.severity === 'ERROR').length,
        warningCount: filtered.filter((v) => v.severity === 'WARNING').length,
        filesScanned: 1,
      },
    };
  } finally {
    try {
      fs.unlinkSync(tsconfigTmp);
    } catch {
      // Best-effort cleanup.
    }
  }
}

// ---------------------------------------------------------------------------
// Delta comparison + classification
// ---------------------------------------------------------------------------

function fingerprintViolation(v: ScanViolation): string {
  // Per-postcondition fingerprint keyed by rule + line. Package included so
  // multi-package mutants don't collide.
  return `${v.package}::${v.rule}::${v.location.line}`;
}

function computeDelta(
  before: ScanViolation[],
  after: ScanViolation[],
): { added: ScanViolation[]; removed: ScanViolation[] } {
  const beforeSet = new Set(before.map(fingerprintViolation));
  const afterSet = new Set(after.map(fingerprintViolation));
  const added = after.filter((v) => !beforeSet.has(fingerprintViolation(v)));
  const removed = before.filter((v) => !afterSet.has(fingerprintViolation(v)));
  return { added, removed };
}

function classify(
  operator: MutationOperator,
  before: ScanViolation[],
  after: ScanViolation[],
): PairOutcome['outcome'] {
  const { added, removed } = computeDelta(before, after);

  if (operator.expected === 'violation-added') {
    if (added.length === 0) return 'fail-recall';
    return 'pass';
  }
  if (operator.expected === 'violation-removed') {
    if (removed.length === 0) return 'fail-precision';
    return 'pass';
  }
  // unchanged
  if (added.length === 0 && removed.length === 0) return 'pass';
  return 'fail-noise';
}

// ---------------------------------------------------------------------------
// Mutant staging
// ---------------------------------------------------------------------------

function sanitizeSeedPath(seed: Seed): string {
  // Convert absolute path to a stable relative label without slashes.
  const rel = path.relative(WORKSPACE_ROOT, seed.path);
  return rel.replace(/[\\/]/g, '__').replace(/[^\w.@\-]/g, '_');
}

function stageMutant(
  seed: Seed,
  operator: MutationOperator,
  mutatedSource: string,
): string {
  const opStagingDir = path.join(STAGING_ROOT, operator.name);
  fs.mkdirSync(opStagingDir, { recursive: true });
  const filename = `${sanitizeSeedPath(seed)}.ts`;
  const mutantPath = path.join(opStagingDir, filename);
  fs.writeFileSync(mutantPath, mutatedSource);
  return mutantPath;
}

// ---------------------------------------------------------------------------
// Main run loop
// ---------------------------------------------------------------------------

interface RunnerOptions {
  sample: number;
  outputPath: string;
  shardIndex: number;
  shardCount: number;
}

function parseArgs(argv: string[]): RunnerOptions {
  let sample = 1;
  let outputPath = '';
  let shardIndex = 0;
  let shardCount = 1;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sample' && argv[i + 1]) {
      sample = parseFloat(argv[++i]);
    } else if (arg === '--output' && argv[i + 1]) {
      outputPath = argv[++i];
    } else if (arg === '--shard-index' && argv[i + 1]) {
      shardIndex = parseInt(argv[++i], 10);
    } else if (arg === '--shard-count' && argv[i + 1]) {
      shardCount = parseInt(argv[++i], 10);
    }
  }
  if (!outputPath) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    outputPath = path.join(RUNS_ROOT, `${ts}.json`);
  }
  if (shardCount < 1) shardCount = 1;
  if (shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error(
      `--shard-index must be in [0, ${shardCount}); got ${shardIndex}`,
    );
  }
  return { sample, outputPath, shardIndex, shardCount };
}

function readPackageVersion(pkgJsonPath: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function readCommitSha(repoDir: string): string | undefined {
  try {
    const headPath = path.join(repoDir, '.git', 'HEAD');
    if (!fs.existsSync(headPath)) return undefined;
    const head = fs.readFileSync(headPath, 'utf-8').trim();
    if (head.startsWith('ref: ')) {
      const refPath = path.join(repoDir, '.git', head.slice(5));
      if (fs.existsSync(refPath)) return fs.readFileSync(refPath, 'utf-8').trim();
    }
    return head;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const startTs = Date.now();

  const allSeeds = walkFixtureSeeds();
  const sampled = sampleSeeds(allSeeds, opts.sample);

  const scannerVersion = readPackageVersion(path.join(REPO_ROOT, 'package.json'));
  const publicCorpusVersion = readPackageVersion(
    path.join(CORPUS_TIERS[0].path, 'package.json'),
  );

  const shardLabel =
    opts.shardCount > 1
      ? ` shard=${opts.shardIndex}/${opts.shardCount}`
      : '';
  console.error(
    `[mutation-harness] scanner=${scannerVersion} corpus=${publicCorpusVersion} seeds=${sampled.length}/${allSeeds.length} sample=${opts.sample} operators=${ALL_OPERATORS.length}${shardLabel}`,
  );

  const results: PairOutcome[] = [];
  const perOperator: Record<string, OperatorAggregate> = {};
  for (const op of ALL_OPERATORS) {
    perOperator[op.name] = { pass: 0, fail_recall: 0, fail_precision: 0, fail_noise: 0, skip: 0, coverage: 0 };
  }

  let processed = 0;
  const total = sampled.length * ALL_OPERATORS.length;

  for (const seed of sampled) {
    // Shard optimization: if NO operator on this seed belongs to this shard,
    // don't pay the seed-scan cost. (`ALL_OPERATORS` is ~10, cheap to check.)
    const seedInShard = ALL_OPERATORS.some((op) =>
      shardOwns(seed.path, op.name, opts.shardIndex, opts.shardCount),
    );
    if (!seedInShard) {
      processed += ALL_OPERATORS.length;
      continue;
    }

    // Scan seed once, reuse for every operator.
    let seedViolations: ScanViolation[];
    try {
      const seedResult = await scanSingleFile(seed.path, seed.corpusPath);
      seedViolations = seedResult.violations;
    } catch (err) {
      // Log and skip this seed entirely.
      for (const op of ALL_OPERATORS) {
        if (!shardOwns(seed.path, op.name, opts.shardIndex, opts.shardCount)) {
          processed++;
          continue;
        }
        results.push({
          seed_path: path.relative(WORKSPACE_ROOT, seed.path),
          seed_tier: seed.tier,
          package_name: seed.packageName,
          operator: op.name,
          operator_kind: op.kind,
          expected: op.expected,
          outcome: 'skip',
          violations_before: [],
          violations_after: [],
          skip_reason: `seed scan errored: ${err instanceof Error ? err.message : String(err)}`,
        });
        perOperator[op.name].skip++;
        processed++;
      }
      continue;
    }

    const source = fs.readFileSync(seed.path, 'utf-8');

    for (const op of ALL_OPERATORS) {
      processed++;
      // Shard filter — determines whether THIS shard owns the (seed, operator)
      // pair. See shardOwns() for the hash contract.
      if (!shardOwns(seed.path, op.name, opts.shardIndex, opts.shardCount)) {
        continue;
      }
      // Filter: does the operator apply to this seed type?
      if (op.seedType !== 'any' && op.seedType !== seed.type) {
        // Not a skip — genuinely not applicable, so we don't record it.
        // (Fair reporting: we only count pairs we attempted.)
        continue;
      }

      perOperator[op.name].coverage++;

      let mutatedSource: string | null;
      try {
        mutatedSource = op.apply(source, seed.path);
      } catch (err) {
        results.push({
          seed_path: path.relative(WORKSPACE_ROOT, seed.path),
          seed_tier: seed.tier,
          package_name: seed.packageName,
          operator: op.name,
          operator_kind: op.kind,
          expected: op.expected,
          outcome: 'skip',
          violations_before: seedViolations,
          violations_after: [],
          skip_reason: `mutation threw: ${err instanceof Error ? err.message : String(err)}`,
        });
        perOperator[op.name].skip++;
        continue;
      }

      if (mutatedSource === null || mutatedSource === source) {
        results.push({
          seed_path: path.relative(WORKSPACE_ROOT, seed.path),
          seed_tier: seed.tier,
          package_name: seed.packageName,
          operator: op.name,
          operator_kind: op.kind,
          expected: op.expected,
          outcome: 'skip',
          violations_before: seedViolations,
          violations_after: [],
          skip_reason: 'operator not applicable to this seed',
        });
        perOperator[op.name].skip++;
        continue;
      }

      const mutantPath = stageMutant(seed, op, mutatedSource);

      let mutantViolations: ScanViolation[];
      try {
        // Mutant lives in staging (mutations/staging/<op>/...) — scan there.
        const mutantResult = await scanSingleFile(mutantPath, seed.corpusPath);
        mutantViolations = mutantResult.violations;
      } catch (err) {
        results.push({
          seed_path: path.relative(WORKSPACE_ROOT, seed.path),
          seed_tier: seed.tier,
          package_name: seed.packageName,
          operator: op.name,
          operator_kind: op.kind,
          expected: op.expected,
          outcome: 'skip',
          violations_before: seedViolations,
          violations_after: [],
          skip_reason: `mutant scan errored: ${err instanceof Error ? err.message : String(err)}`,
          mutant_path: path.relative(WORKSPACE_ROOT, mutantPath),
        });
        perOperator[op.name].skip++;
        continue;
      }

      const outcome = classify(op, seedViolations, mutantViolations);
      // Map hyphenated outcome names to underscored aggregate keys.
      const aggKey =
        outcome === 'fail-recall'
          ? 'fail_recall'
          : outcome === 'fail-precision'
            ? 'fail_precision'
            : outcome === 'fail-noise'
              ? 'fail_noise'
              : outcome; // 'pass' | 'skip'
      (perOperator[op.name] as unknown as Record<string, number>)[aggKey]++;
      results.push({
        seed_path: path.relative(WORKSPACE_ROOT, seed.path),
        seed_tier: seed.tier,
        package_name: seed.packageName,
        operator: op.name,
        operator_kind: op.kind,
        expected: op.expected,
        outcome,
        violations_before: seedViolations,
        violations_after: mutantViolations,
        mutant_path: path.relative(WORKSPACE_ROOT, mutantPath),
      });
    }

    if (processed % 50 === 0 || processed === total) {
      console.error(`[mutation-harness] processed ${processed}/${total}`);
    }
  }

  const totals = {
    seeds: sampled.length,
    operators: ALL_OPERATORS.length,
    pairs: results.length,
    pass: results.filter((r) => r.outcome === 'pass').length,
    fail_recall: results.filter((r) => r.outcome === 'fail-recall').length,
    fail_precision: results.filter((r) => r.outcome === 'fail-precision').length,
    fail_noise: results.filter((r) => r.outcome === 'fail-noise').length,
    skip: results.filter((r) => r.outcome === 'skip').length,
  };

  const report: RunReport = {
    run_id: crypto.randomBytes(8).toString('hex'),
    ran_at: new Date().toISOString(),
    scanner_version: scannerVersion,
    corpus_version: publicCorpusVersion,
    nark_commit_sha: readCommitSha(REPO_ROOT),
    corpus_commit_sha: readCommitSha(CORPUS_TIERS[0].path),
    sample_rate: opts.sample,
    shard_index: opts.shardCount > 1 ? opts.shardIndex : undefined,
    shard_count: opts.shardCount > 1 ? opts.shardCount : undefined,
    totals,
    aggregates: { per_operator: perOperator },
    results,
  };

  fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
  fs.writeFileSync(opts.outputPath, JSON.stringify(report, null, 2));
  const elapsed = Math.round((Date.now() - startTs) / 1000);
  console.error(
    `[mutation-harness] wrote ${opts.outputPath} in ${elapsed}s — pass=${totals.pass} fail_recall=${totals.fail_recall} fail_precision=${totals.fail_precision} fail_noise=${totals.fail_noise} skip=${totals.skip}`,
  );
}

main().catch((err) => {
  console.error('[mutation-harness] fatal:', err);
  process.exit(1);
});
