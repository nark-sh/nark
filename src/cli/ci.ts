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
 */
function printViolation(v: Violation): void {
  const sevColor =
    v.severity === 'error'
      ? chalk.red.bold
      : v.severity === 'warning'
        ? chalk.yellow.bold
        : chalk.blue.bold;

  const sevLabel = v.severity.toUpperCase();
  console.log(`  ${sevColor(sevLabel)} ${chalk.bold(v.package)} — ${v.description}`);
  console.log(`    ${chalk.gray(`${v.file}:${v.line}:${v.column}`)}`);

  if (v.suggested_fix) {
    console.log(`    ${chalk.dim('Fix:')} ${v.suggested_fix}`);
  }
  console.log();
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
    .action(async (options) => {
      try {
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
}): Promise<void> {
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

  // 13. Print header
  console.log(chalk.bold('\nnark ci — diff-aware scan\n'));
  console.log(chalk.gray(`  tsconfig: ${tsconfigPath}`));
  console.log(chalk.gray(`  corpus:   ${options.corpus}`));
  console.log(chalk.gray(`  baseline: ${baselineCommit ?? '(none)'}`));
  console.log(chalk.gray(`  current:  ${currentCommit}`));
  console.log();

  if (!baselineRecord) {
    console.log(
      chalk.yellow(
        'Warning: No baseline scan found. Showing all violations (no diff available).'
      )
    );
    console.log();
  }

  const baselineLabel = baselineCommit
    ? baselineCommit.substring(0, 12)
    : 'unknown baseline';

  if (newViolations.length === 0) {
    console.log(
      chalk.green('✓') +
        chalk.bold(
          ` 0 new violations introduced since ${baselineLabel}` +
            (preExistingCount > 0
              ? chalk.dim(` (${preExistingCount} pre-existing, not shown)`)
              : '')
        )
    );
  } else {
    console.log(
      chalk.red.bold(`${newViolations.length} new violation(s) introduced since ${baselineLabel}`) +
        (preExistingCount > 0
          ? chalk.dim(` (${preExistingCount} pre-existing, not shown)`)
          : '')
    );
    console.log();

    // Group by severity for display
    const errors = newViolations.filter((v) => v.severity === 'error');
    const warnings = newViolations.filter((v) => v.severity === 'warning');
    const infos = newViolations.filter((v) => v.severity === 'info');

    if (errors.length > 0) {
      console.log(chalk.red.bold(`Errors (${errors.length}):`));
      errors.forEach(printViolation);
    }
    if (warnings.length > 0) {
      console.log(chalk.yellow.bold(`Warnings (${warnings.length}):`));
      warnings.forEach(printViolation);
    }
    if (infos.length > 0) {
      console.log(chalk.blue.bold(`Info (${infos.length}):`));
      infos.forEach(printViolation);
    }
  }

  // 14. SARIF output for new violations only
  if (options.sarif || options.sarifOutput) {
    writeSarifOutput(newViolations, options.sarifOutput);
  }

  // 15. Write full audit JSON if --output provided
  if (options.output) {
    const { generateAuditRecord, writeAuditRecord } = await import('../reporter.js');
    const auditRecord = await generateAuditRecord(violations, {
      tsconfigPath,
      packagesAnalyzed: packageDiscovery.packages.map((p: any) => p.name),
      contractsApplied: corpusResult.contracts.size,
      filesAnalyzed: v2Result.filesAnalyzed,
      corpusVersion: '1.0.0',
    });
    writeAuditRecord(auditRecord, options.output);
  }

  // 16. Exit code
  if (newViolations.length > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}
