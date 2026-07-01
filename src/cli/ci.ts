/**
 * CLI Command: ci
 * Diff-aware scanning for CI environments.
 *
 * Runs the full nark scan, compares results against a stored baseline scan
 * (keyed by git commit hash), and outputs ONLY newly introduced violations —
 * suppressing pre-existing ones to reduce noise in PR gates.
 *
 * Exit codes:
 *   0 — no new violations
 *   1 — new violations introduced since baseline
 *   2 — scan error (corpus missing, tsconfig not found, etc.)
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { createRequire } from 'module';
import chalk from 'chalk';

import { loadCorpus } from '../corpus-loader.js';
import { PackageDiscovery } from '../package-discovery.js';
import { ensureTsconfig } from '../tsconfig-generator.js';
import { printCorpusErrors } from '../reporter.js';
import { writeSarifOutput } from '../output/sarif-writer.js';
import {
  findNarkDir,
  writeCommitScan,
  loadCommitScan,
  findLatestScan,
} from '../output/scan-writer.js';
import { computeViolationFingerprint } from '../suppressions/fingerprint.js';
import { readTelemetryConfig } from './telemetry.js';
import { getToken } from '../lib/auth.js';
import type { AnalyzerConfig, Violation } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Finds the default corpus path by trying npm package then local dev paths.
 * Mirrors the same logic in index.ts.
 */
function findDefaultCorpusPath(): string {
  try {
    const _require = createRequire(import.meta.url);
    const corpusModule = _require('nark-corpus');
    const corpusRoot = path.dirname(corpusModule.getCorpusPath());
    if (fs.existsSync(path.join(corpusRoot, 'packages'))) {
      return corpusRoot;
    }
  } catch {
    // Not installed — fall through
  }

  const possiblePaths = [
    path.join(process.cwd(), '../nark-corpus'),
    path.join(process.cwd(), '../corpus'),
    path.join(process.cwd(), 'nark-corpus'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(path.join(p, 'packages'))) return p;
  }

  return path.join(process.cwd(), '../nark-corpus');
}

/**
 * Normalise tsconfig path — accept directory or file.
 */
function normalizeTsconfigPath(tsconfigPath: string): string {
  const resolved = path.resolve(tsconfigPath);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    return path.join(resolved, 'tsconfig.json');
  }
  return resolved;
}

/**
 * Run `git rev-parse HEAD` in cwd and return the full 40-char hash.
 * Returns 'nogit' on failure.
 */
function getCurrentCommit(cwd: string): string {
  try {
    const _require = createRequire(import.meta.url);
    const { execSync } = _require('child_process');
    return (execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8' }) as string).trim();
  } catch {
    return 'nogit';
  }
}

/**
 * Detect the merge-base commit between HEAD and the default branch (main/master).
 * Returns null if detection fails (e.g., shallow clone, no remote).
 */
function detectBaselineCommit(cwd: string): string | null {
  try {
    const _require = createRequire(import.meta.url);
    const { execSync } = _require('child_process');

    const defaultBranch = (
      execSync(
        `git remote show origin 2>/dev/null | grep 'HEAD branch' | cut -d: -f2 | xargs`,
        { cwd, encoding: 'utf-8', stdio: 'pipe' }
      ) as string
    ).trim() || 'main';

    const mergeBase = (
      execSync(`git merge-base HEAD ${defaultBranch}`, {
        cwd,
        encoding: 'utf-8',
      }) as string
    ).trim();

    return mergeBase || null;
  } catch {
    return null;
  }
}

/**
 * Ensure fingerprints are set on all violations.
 */
function ensureFingerprints(violations: Violation[]): void {
  for (const v of violations) {
    const vAny = v as any;
    if (!vAny.fingerprint || vAny.fingerprint.includes(':') || vAny.fingerprint.includes('/')) {
      vAny.fingerprint = computeViolationFingerprint({
        packageName: v.package,
        postconditionId: v.contract_clause || v.id,
        filePath: v.file,
        lineNumber: v.line,
        callExpression: v.function || null,
      });
    }
  }
}

/**
 * Print a single violation to the terminal in the nark style.
 * `write` allows the caller to route output to stderr when --json is active.
 */
function printViolation(
  v: Violation,
  write: (msg: string) => void = (msg): void => console.log(msg)
): void {
  const sevColor =
    v.severity === 'error'
      ? chalk.red.bold
      : v.severity === 'warning'
        ? chalk.yellow.bold
        : chalk.blue.bold;

  const sevLabel = v.severity.toUpperCase();
  write(`  ${sevColor(sevLabel)} ${chalk.bold(v.package)} — ${v.description}`);
  write(`    ${chalk.gray(`${v.file}:${v.line}:${v.column}`)}`);

  if (v.suggested_fix) {
    write(`    ${chalk.dim('Fix:')} ${v.suggested_fix}`);
  }
  write('');
}

// ---------------------------------------------------------------------------
// Lifecycle event telemetry
// ---------------------------------------------------------------------------

interface LifecycleEvent {
  type: 'introduced' | 'resolved';
  fingerprint: string;
  contractId: string;
  packageName: string;
  commitHash: string;
}

/**
 * Fire lifecycle events (introduced / resolved) to the nark.sh analytics endpoint.
 * Fire-and-forget — never throws, never blocks the caller.
 * Requires telemetry enabled AND user logged in (events must be attributed to an org).
 */
function fireLifecycleEvents(events: LifecycleEvent[]): void {
  if (events.length === 0) return;
  const config = readTelemetryConfig();
  if (!config.enabled) return;
  const token = getToken();
  if (!token) return; // lifecycle events require auth for org attribution
  try {
    fetch(`${process.env['NARK_API_URL'] ?? 'https://app.nark.sh'}/api/telemetry/lifecycle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  } catch {
    // fire-and-forget — never affect the scan
  }
}

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

export function createCiCommand(): Command {
  const ci = new Command('ci');
  ci
    .description(
      'Diff-aware scan — outputs only violations introduced since a baseline commit.\n' +
        'Gate PRs on regressions, not accumulated debt already in main.'
    )
    .option('--tsconfig <path>', 'Path to tsconfig.json or project directory', './tsconfig.json')
    .option('--corpus <path>', 'Path to corpus directory', findDefaultCorpusPath())
    .option('--output <path>', 'Output path for full audit record JSON')
    .option('--baseline-commit <hash>', 'Commit hash to diff against (auto-detected if omitted)')
    .option('--sarif', 'Output diff results in SARIF 2.1.0 format to stdout')
    .option('--sarif-output <path>', 'Write SARIF 2.1.0 diff results to file')
    .option(
      '--json',
      'Emit a compact schema-versioned JSON envelope on stdout. Human output moves to stderr. Mutually exclusive with --sarif and --sarif-output.'
    )
    .action(async (options) => {
      try {
        // Mutual exclusion enforced at dispatch time per spec 0002 §4.
        if (options.json && (options.sarif || options.sarifOutput)) {
          process.stderr.write(
            chalk.red(
              'Error: --json cannot be combined with --sarif or --sarif-output.\n'
            )
          );
          process.exit(2);
        }
        await runCi(options);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`\nnark ci: fatal error — ${msg}\n`));
        process.exit(2);
      }
    });

  return ci;
}

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

async function runCi(options: {
  tsconfig: string;
  corpus: string;
  output?: string;
  baselineCommit?: string;
  sarif?: boolean;
  sarifOutput?: string;
  json?: boolean;
}): Promise<void> {
  // `--json` reroutes all human chatter to stderr so stdout can carry the
  // envelope untouched (spec 0002 §4). We use a `write()` helper rather than
  // console.log/error so the redirect is a single flag flip.
  const jsonMode = !!options.json;
  const write = (msg: string): void => {
    if (jsonMode) process.stderr.write(msg + '\n');
    else console.log(msg);
  };

  // 1. Resolve tsconfig and project root
  const tsconfigPath = normalizeTsconfigPath(options.tsconfig);
  const projectRoot = path.dirname(tsconfigPath);

  // 2. Validate corpus
  if (!fs.existsSync(options.corpus)) {
    process.stderr.write(
      chalk.red(`Error: Corpus directory not found at ${options.corpus}\n`) +
        chalk.yellow('Tip: Use --corpus <path> to specify corpus location\n')
    );
    process.exit(2);
  }

  // 3. Ensure tsconfig exists
  ensureTsconfig(tsconfigPath);

  const narkDir = findNarkDir(projectRoot);

  // 4. Detect baseline commit
  const baselineCommit: string | null =
    options.baselineCommit ?? detectBaselineCommit(projectRoot);

  // 5. Get current HEAD commit
  const currentCommit = getCurrentCommit(projectRoot);

  // 6. Load baseline scan
  let baselineRecord = baselineCommit ? loadCommitScan(narkDir, baselineCommit) : null;
  if (!baselineRecord) {
    baselineRecord = findLatestScan(narkDir); // fallback to latest available scan
  }

  // 7. Load corpus
  const corpusResult = await loadCorpus(options.corpus, {
    includeDrafts: false,
    includeDeprecated: false,
    includeInDevelopment: false,
  });

  if (corpusResult.errors.length > 0) {
    printCorpusErrors(corpusResult.errors);
    process.exit(2);
  }

  if (corpusResult.contracts.size === 0) {
    process.stderr.write(chalk.red('Error: No contracts loaded from corpus\n'));
    process.exit(2);
  }

  // 8. Discover packages
  const discoveryTool = new PackageDiscovery(corpusResult.contracts);
  const packageDiscovery = await discoveryTool.discoverPackages(
    projectRoot,
    path.resolve(tsconfigPath)
  );

  // 9. Run v2 analyzer (default)
  const config: AnalyzerConfig = {
    tsconfigPath: path.resolve(tsconfigPath),
    corpusPath: path.resolve(options.corpus),
    includeTests: false,
  };

  const { runV2Analyzer } = await import('../v2/adapter.js');
  const v2Result = await runV2Analyzer(config, corpusResult.contracts);
  const violations: Violation[] = v2Result.violations;

  // 10. Ensure fingerprints are set on all violations
  ensureFingerprints(violations);

  // 11. Persist current scan to .nark/scans/<currentCommit>.json
  writeCommitScan(narkDir, currentCommit, violations, tsconfigPath);

  // 12. Compute diff
  const baselineFingerprints = new Set<string>(
    (baselineRecord?.violations ?? [])
      .map((v: any) => v.fingerprint as string | undefined)
      .filter((fp): fp is string => !!fp)
  );

  const newViolations = violations.filter((v: any) => !baselineFingerprints.has(v.fingerprint));
  const preExistingCount = violations.length - newViolations.length;

  // 12b. Compute resolved violations and fire lifecycle events
  const currentFingerprints = new Set<string>(
    violations
      .map((v: any) => v.fingerprint as string | undefined)
      .filter((fp): fp is string => !!fp)
  );

  const resolvedViolations = (baselineRecord?.violations ?? []).filter(
    (v: any) => {
      const fp = v.fingerprint as string | undefined;
      return fp && !currentFingerprints.has(fp);
    }
  );

  const lifecycleEvents: LifecycleEvent[] = [
    ...newViolations.map((v: any): LifecycleEvent => ({
      type: 'introduced',
      fingerprint: v.fingerprint as string,
      contractId: (v.contract_clause || v.id) as string,
      packageName: v.package as string,
      commitHash: currentCommit,
    })),
    ...resolvedViolations.map((v: any): LifecycleEvent => ({
      type: 'resolved',
      fingerprint: v.fingerprint as string,
      contractId: (v.contract_clause || v.id) as string,
      packageName: v.package as string,
      commitHash: currentCommit,
    })),
  ];

  fireLifecycleEvents(lifecycleEvents);

  // 13. Print header. Under --json this goes to stderr; regular output
  // remains untouched on stdout.
  write(chalk.bold('\nnark ci — diff-aware scan\n'));
  write(chalk.gray(`  tsconfig: ${tsconfigPath}`));
  write(chalk.gray(`  corpus:   ${options.corpus}`));
  write(chalk.gray(`  baseline: ${baselineCommit ?? '(none)'}`));
  write(chalk.gray(`  current:  ${currentCommit}`));
  write('');

  if (!baselineRecord) {
    write(
      chalk.yellow(
        'Warning: No baseline scan found. Showing all violations (no diff available).'
      )
    );
    write('');
  }

  const baselineLabel = baselineCommit
    ? baselineCommit.substring(0, 12)
    : 'unknown baseline';

  if (newViolations.length === 0) {
    write(
      chalk.green('✓') +
        chalk.bold(
          ` 0 new violations introduced since ${baselineLabel}` +
            (preExistingCount > 0
              ? chalk.dim(` (${preExistingCount} pre-existing, not shown)`)
              : '')
        )
    );
  } else {
    write(
      chalk.red.bold(`${newViolations.length} new violation(s) introduced since ${baselineLabel}`) +
        (preExistingCount > 0
          ? chalk.dim(` (${preExistingCount} pre-existing, not shown)`)
          : '')
    );
    write('');

    // Group by severity for display
    const errors = newViolations.filter((v) => v.severity === 'error');
    const warnings = newViolations.filter((v) => v.severity === 'warning');
    const infos = newViolations.filter((v) => v.severity === 'info');

    if (errors.length > 0) {
      write(chalk.red.bold(`Errors (${errors.length}):`));
      errors.forEach((v) => printViolation(v, write));
    }
    if (warnings.length > 0) {
      write(chalk.yellow.bold(`Warnings (${warnings.length}):`));
      warnings.forEach((v) => printViolation(v, write));
    }
    if (infos.length > 0) {
      write(chalk.blue.bold(`Info (${infos.length}):`));
      infos.forEach((v) => printViolation(v, write));
    }
  }

  // 14. SARIF output for new violations only. Guarded so --json takes over.
  if (!jsonMode && (options.sarif || options.sarifOutput)) {
    writeSarifOutput(newViolations, options.sarifOutput);
  }

  // 15. Write full audit JSON if --output provided
  if (options.output) {
    // qt-187: read corpus version from installed package.json. Previous
    // '1.0.0' hardcode misreported the version in CI scan output that the
    // saas PR bot then displayed as scan context.
    const corpusPkgVersion = (() => {
      try {
        const pkgPath = path.join(options.corpus, 'package.json');
        const raw = fs.readFileSync(pkgPath, 'utf-8');
        return (
          (JSON.parse(raw) as { version?: string }).version ?? 'unknown'
        );
      } catch {
        return 'unknown';
      }
    })();
    const { generateAuditRecord, writeAuditRecord } = await import('../reporter.js');
    const auditRecord = await generateAuditRecord(violations, {
      tsconfigPath,
      packagesAnalyzed: packageDiscovery.packages.map((p: any) => p.name),
      contractsApplied: corpusResult.contracts.size,
      filesAnalyzed: v2Result.filesAnalyzed,
      corpusVersion: corpusPkgVersion,
    });
    writeAuditRecord(auditRecord, options.output);
  }

  // 15b. --json stdout envelope per spec 0002 §4.
  // Emitted just before exit so all human chatter (already redirected to
  // stderr via `write`) is flushed first. Consumers can parse stdout as a
  // single JSON document.
  if (jsonMode) {
    const exitCode = newViolations.length > 0 ? 1 : 0;
    const baselineSource: 'committed' | 'saas' | 'none' = baselineRecord
      ? 'committed'
      : 'none';
    const envelope = {
      $schema_version: '1',
      baseline: {
        found: !!baselineRecord,
        source: baselineSource,
        base_commit: baselineCommit ?? null,
      },
      counts: {
        total_violations: violations.length,
        new_violations: newViolations.length,
        resolved_violations: resolvedViolations.length,
      },
      new_violations: newViolations.map((v) => toEnvelopeViolation(v)),
      resolved_violations: (resolvedViolations as Violation[]).map((v) =>
        toEnvelopeViolation(v)
      ),
      exit_code: exitCode,
    };
    process.stdout.write(JSON.stringify(envelope) + '\n');
  }

  // 16. Exit code
  if (newViolations.length > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

/**
 * Map an internal Violation into the --json envelope's per-violation shape.
 * Kept adjacent to runCi so the envelope schema is co-located with its writer.
 * Field selection per 0002-ci-gate-spec.md §4 — a subset of Violation, plus
 * the maturity tier threaded through from the corpus postcondition.
 */
function toEnvelopeViolation(v: Violation): Record<string, unknown> {
  const row: Record<string, unknown> = {
    rule_id: `${v.package}/${v.contract_clause}`,
    package: v.package,
    postcondition_id: v.contract_clause,
    severity: v.severity,
    file: v.file,
    line: v.line,
    column: v.column,
    message: v.description,
  };
  // Optional fields — omitted (not null) when absent so the wire is thin.
  if (v.suggested_fix) row['suggested_fix'] = v.suggested_fix;
  if (v.maturity !== undefined) row['maturity'] = v.maturity;
  const fp = (v as unknown as { fingerprint?: string }).fingerprint;
  if (fp) row['fingerprint'] = fp;
  return row;
}
