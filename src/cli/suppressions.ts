/**
 * CLI Commands for Suppression Management
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as path from 'path';
import {
  loadManifestSync,
  getActiveSuppressions,
  getDeadSuppressions,
  detectDeadSuppressions,
  removeDeadSuppressionsFromManifest,
  getSuppressionStats,
  loadStore,
  saveStore,
  findByFingerprint,
  findStaleSuppressions,
  removeStaleSuppressions,
  createBcScanSuppression,
  getStorePath
} from '../suppressions/index.js';
import type { Suppression } from '../suppressions/types.js';

/**
 * Create suppressions subcommand
 */
export function createSuppressionsCommand(): Command {
  const suppressions = new Command('suppressions');

  suppressions
    .description('Manage behavioral contract suppressions')
    .addCommand(createListCommand())
    .addCommand(createShowCommand())
    .addCommand(createCleanCommand())
    .addCommand(createStatsCommand())
    .addCommand(createAddCommand())
    .addCommand(createVerifyCommand());

  return suppressions;
}

/**
 * List all suppressions
 */
function createListCommand(): Command {
  const list = new Command('list');

  list
    .description('List all suppressions')
    .option('--dead', 'Show only dead suppressions')
    .option('--active', 'Show only active suppressions')
    .option('--json', 'Output as JSON')
    .option('--project <path>', 'Project root directory', process.cwd())
    .action((options) => {
      const projectRoot = path.resolve(options.project);

      try {
        const manifest = loadManifestSync(projectRoot);

        let suppressions: Suppression[];
        if (options.dead) {
          suppressions = getDeadSuppressions(manifest);
        } else if (options.active) {
          suppressions = getActiveSuppressions(manifest);
        } else {
          suppressions = manifest.suppressions;
        }

        if (options.json) {
          console.log(JSON.stringify(suppressions, null, 2));
        } else {
          printSuppressionsList(suppressions, options);
        }
      } catch (error) {
        console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
      }
    });

  return list;
}

/**
 * Show specific suppression
 */
function createShowCommand(): Command {
  const show = new Command('show');

  show
    .description('Show details of a specific suppression')
    .argument('<location>', 'Suppression location (format: file:line or suppression-id)')
    .option('--project <path>', 'Project root directory', process.cwd())
    .action((location, options) => {
      const projectRoot = path.resolve(options.project);

      try {
        const manifest = loadManifestSync(projectRoot);

        // Parse location (file:line or suppression-id)
        let suppression: Suppression | undefined;

        if (location.includes(':')) {
          const [file, lineStr] = location.split(':');
          const line = parseInt(lineStr, 10);

          suppression = manifest.suppressions.find(
            s => s.file === file && s.line === line
          );
        } else {
          suppression = manifest.suppressions.find(s => s.id === location);
        }

        if (!suppression) {
          console.error(chalk.red(`No suppression found at: ${location}`));
          process.exit(1);
        }

        printSuppressionDetails(suppression);
      } catch (error) {
        console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
      }
    });

  return show;
}

/**
 * Clean up dead suppressions
 */
function createCleanCommand(): Command {
  const clean = new Command('clean');

  clean
    .description('Remove dead suppressions from manifest and optionally from code')
    .option('--auto', 'Automatically clean without confirmation')
    .option('--manifest-only', 'Only update manifest, do not modify code')
    .option('--project <path>', 'Project root directory', process.cwd())
    .action(async (options) => {
      const projectRoot = path.resolve(options.project);

      try {
        const deadSuppressions = detectDeadSuppressions(projectRoot, '1.1.0');

        if (deadSuppressions.length === 0) {
          console.log(chalk.green('✨ No dead suppressions found!'));
          return;
        }

        console.log(chalk.yellow(`Found ${deadSuppressions.length} dead suppressions:\n`));

        // Show dead suppressions
        deadSuppressions.forEach((dead, index) => {
          console.log(chalk.dim(`${index + 1}. ${dead.suppression.file}:${dead.suppression.line}`));
          console.log(chalk.dim(`   Package: ${dead.suppression.package}/${dead.suppression.postconditionId}`));
          console.log(chalk.dim(`   Reason: ${dead.improvementReason || 'Analyzer improved'}\n`));
        });

        if (!options.auto) {
          console.log(chalk.yellow('Run with --auto to remove these suppressions'));
          return;
        }

        // Remove from manifest
        const removed = removeDeadSuppressionsFromManifest(projectRoot);
        console.log(chalk.green(`✅ Removed ${removed} dead suppressions from manifest`));

        if (!options.manifestOnly) {
          console.log(chalk.yellow('\n⚠️  Note: Inline comments must be removed manually.'));
          console.log(chalk.dim('The following lines should be removed:\n'));

          deadSuppressions.forEach(dead => {
            console.log(chalk.dim(`  ${dead.suppression.file}:${dead.suppression.line - 1}`));
          });
        }
      } catch (error) {
        console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
      }
    });

  return clean;
}

/**
 * Show suppression statistics
 */
function createStatsCommand(): Command {
  const stats = new Command('stats');

  stats
    .description('Show suppression statistics')
    .option('--json', 'Output as JSON')
    .option('--project <path>', 'Project root directory', process.cwd())
    .action((options) => {
      const projectRoot = path.resolve(options.project);

      try {
        const statsData = getSuppressionStats(projectRoot);

        if (options.json) {
          console.log(JSON.stringify({
            ...statsData,
            byPackage: Object.fromEntries(statsData.byPackage)
          }, null, 2));
        } else {
          printStats(statsData);
        }
      } catch (error) {
        console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
      }
    });

  return stats;
}

/**
 * Add a fingerprint-based suppression to .bc-suppressions.json
 *
 * This is the preferred way to suppress violations — no inline comments,
 * no production code pollution. The fingerprint links the suppression back
 * to the SaaS violation record for full traceability.
 *
 * Get the fingerprint from scan output or the SaaS dashboard.
 */
function createAddCommand(): Command {
  const add = new Command('add');

  add
    .description('Add a fingerprint-based suppression to .bc-suppressions.json')
    .requiredOption('--fingerprint <fp>', 'Violation fingerprint (from scan output or SaaS dashboard)')
    .requiredOption('--reason <text>', 'Why this violation is being suppressed (min 10 chars)')
    .option('--file <path>', 'File path (for reference — stored but not used for matching)')
    .option('--line <n>', 'Line number (for reference — stored but not used for matching)', parseInt)
    .option('--package <name>', 'Package name (for reference)')
    .option('--postcondition <id>', 'Postcondition ID (for reference)')
    .option('--project <path>', 'Project root directory', process.cwd())
    .action((options) => {
      const projectRoot = path.resolve(options.project);

      if (options.reason.length < 10) {
        console.error(chalk.red('Error: --reason must be at least 10 characters'));
        process.exit(1);
      }

      try {
        const store = loadStore(projectRoot);

        // Check for existing suppression with this fingerprint
        const existing = findByFingerprint(store, options.fingerprint);
        if (existing) {
          console.log(chalk.yellow(`⚠️  Suppression already exists for fingerprint: ${options.fingerprint}`));
          console.log(chalk.dim(`   File: ${existing.filePath}:${existing.lineNumber}`));
          console.log(chalk.dim(`   Reason: ${existing.reason}`));
          console.log(chalk.dim(`   Added: ${new Date(existing.suppressedAt).toLocaleDateString()}`));
          console.log(chalk.yellow('\nUse --force to overwrite (not yet implemented).'));
          return;
        }

        const suppression = createBcScanSuppression({
          fingerprint: options.fingerprint,
          packageName: options.package ?? 'unknown',
          postconditionId: options.postcondition ?? 'unknown',
          filePath: options.file ?? 'unknown',
          lineNumber: options.line ?? 0,
          reason: options.reason,
        });

        store.suppressions.push(suppression);
        saveStore(projectRoot, store);

        const storePath = path.relative(projectRoot, getStorePath(projectRoot));
        console.log(chalk.green(`✅ Suppression added to ${storePath}`));
        console.log(chalk.dim(`   Fingerprint: ${options.fingerprint}`));
        if (options.file) console.log(chalk.dim(`   File: ${options.file}${options.line ? `:${options.line}` : ''}`));
        console.log(chalk.dim(`   Reason: ${options.reason}`));
        console.log();
        console.log(chalk.dim('This suppression is keyed by fingerprint. If the code moves to a'));
        console.log(chalk.dim('different line, run "suppressions verify" to detect stale entries.'));
      } catch (error) {
        console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
      }
    });

  return add;
}

/**
 * Verify suppressions in .bc-suppressions.json against a scan result file.
 *
 * Reads a scan output JSON and compares the fingerprints of all violations
 * found against the suppression store. Any stored suppression whose fingerprint
 * does not appear in the scan is flagged as stale.
 *
 * Stale reasons:
 * - The underlying violation was fixed (code corrected — great!)
 * - The violation moved to a different line (fingerprint changed)
 * - The file was deleted
 *
 * Usage:
 *   nark suppressions verify --scan output/20260324/repo-audit.json
 *   nark suppressions verify --scan output/20260324/repo-audit.json --clean
 */
function createVerifyCommand(): Command {
  const verify = new Command('verify');

  verify
    .description('Check .bc-suppressions.json for stale entries against a scan result')
    .requiredOption('--scan <file>', 'Path to scan output JSON (from nark --output)')
    .option('--clean', 'Automatically remove stale suppressions')
    .option('--json', 'Output results as JSON')
    .option('--project <path>', 'Project root directory', process.cwd())
    .action(async (options) => {
      const projectRoot = path.resolve(options.project);
      const scanPath = path.resolve(options.scan);

      try {
        // Load scan results
        const { readFileSync } = await import('fs');
        let scanData: any;
        try {
          scanData = JSON.parse(readFileSync(scanPath, 'utf-8'));
        } catch {
          console.error(chalk.red(`Error: Could not read scan file: ${scanPath}`));
          process.exit(1);
        }

        // Extract fingerprints from scan results
        // Supports both v2 format ({violations: [...], files: [...]}) and flat arrays
        const violations: any[] = Array.isArray(scanData)
          ? scanData
          : (scanData.violations ?? scanData.files?.flatMap((f: any) => f.violations ?? []) ?? []);

        const seenFingerprints = new Set<string>(
          violations
            .map((v: any) => v.fingerprint)
            .filter((fp: any) => typeof fp === 'string')
        );

        const store = loadStore(projectRoot);

        if (store.suppressions.length === 0) {
          console.log(chalk.dim('No suppressions in .bc-suppressions.json'));
          return;
        }

        const stale = findStaleSuppressions(store, seenFingerprints);
        const active = store.suppressions.filter(s => seenFingerprints.has(s.fingerprint));

        if (options.json) {
          console.log(JSON.stringify({ total: store.suppressions.length, active: active.length, stale }, null, 2));
          return;
        }

        console.log(chalk.bold(`\n🔍 Suppression Verification\n`));
        console.log(`  Scan file: ${chalk.cyan(path.relative(projectRoot, scanPath))}`);
        console.log(`  Violations in scan: ${violations.length} (${seenFingerprints.size} with fingerprints)`);
        console.log(`  Suppressions: ${store.suppressions.length} total, ${active.length} active, ${stale.length} stale\n`);

        if (stale.length === 0) {
          console.log(chalk.green('✅ All suppressions are active — no stale entries found.'));
          return;
        }

        console.log(chalk.yellow(`⚠️  ${stale.length} stale suppression(s) found:\n`));
        stale.forEach((s, i) => {
          console.log(`  ${i + 1}. ${chalk.cyan(s.filePath)}:${chalk.yellow(String(s.lineNumber))}`);
          console.log(`     ${s.package}/${s.postconditionId}`);
          console.log(chalk.dim(`     Fingerprint: ${s.fingerprint}`));
          console.log(chalk.dim(`     Reason: ${s.reason}`));
          console.log(chalk.dim(`     Added: ${new Date(s.suppressedAt).toLocaleDateString()}\n`));
        });

        if (options.clean) {
          removeStaleSuppressions(store, seenFingerprints);
          saveStore(projectRoot, store);
          console.log(chalk.green(`✅ Removed ${stale.length} stale suppression(s) from .bc-suppressions.json`));
        } else {
          console.log(chalk.dim('Run with --clean to remove stale suppressions automatically.'));
        }
      } catch (error) {
        console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
      }
    });

  return verify;
}

/**
 * Print suppressions list
 */
function printSuppressionsList(
  suppressions: Suppression[],
  options: { dead?: boolean; active?: boolean }
): void {
  if (suppressions.length === 0) {
    console.log(chalk.dim('No suppressions found.'));
    return;
  }

  const title = options.dead
    ? '💀 Dead Suppressions'
    : options.active
    ? '✅ Active Suppressions'
    : '📋 All Suppressions';

  console.log(chalk.bold(`\n${title} (${suppressions.length} total)\n`));

  suppressions.forEach((s, index) => {
    const status = s.stillViolates
      ? chalk.green('✓ Active')
      : chalk.red('✗ Dead');

    console.log(`${index + 1}. ${chalk.cyan(s.file)}:${chalk.yellow(s.line)}`);
    console.log(`   ${status} | ${s.package}/${s.postconditionId}`);
    console.log(chalk.dim(`   Reason: ${s.reason}`));
    console.log(chalk.dim(`   Suppressed: ${new Date(s.suppressedAt).toLocaleDateString()}\n`));
  });
}

/**
 * Print suppression details
 */
function printSuppressionDetails(suppression: Suppression): void {
  console.log(chalk.bold('\n📍 Suppression Details\n'));

  console.log(`${chalk.bold('ID:')} ${suppression.id}`);
  console.log(`${chalk.bold('Location:')} ${chalk.cyan(suppression.file)}:${chalk.yellow(suppression.line)}`);
  console.log(`${chalk.bold('Package:')} ${suppression.package}`);
  console.log(`${chalk.bold('Postcondition:')} ${suppression.postconditionId}`);
  console.log(`${chalk.bold('Status:')} ${suppression.stillViolates ? chalk.green('Active') : chalk.red('Dead')}`);
  console.log(`${chalk.bold('Reason:')} ${suppression.reason}`);
  console.log(`${chalk.bold('Suppressed At:')} ${new Date(suppression.suppressedAt).toLocaleString()}`);
  console.log(`${chalk.bold('Suppressed By:')} ${suppression.suppressedBy}`);
  console.log(`${chalk.bold('Last Checked:')} ${new Date(suppression.lastChecked).toLocaleString()}`);
  console.log(`${chalk.bold('Analyzer Version:')} ${suppression.analyzerVersion}`);

  if (!suppression.stillViolates) {
    console.log(chalk.yellow('\n⚠️  This suppression is dead and can be removed!'));
  }
}

/**
 * Print statistics
 */
function printStats(stats: ReturnType<typeof getSuppressionStats>): void {
  console.log(chalk.bold('\n📊 Suppression Statistics\n'));

  console.log(`${chalk.bold('Total Suppressions:')} ${stats.totalSuppressions}`);
  console.log(`${chalk.bold('Active:')} ${chalk.green(stats.activeSuppressions.toString())}`);
  console.log(`${chalk.bold('Dead:')} ${chalk.red(stats.deadSuppressions.toString())}`);

  console.log(chalk.bold('\n📦 By Source:\n'));
  console.log(`  Inline Comments: ${stats.bySource.inlineComment}`);
  console.log(`  Config File: ${stats.bySource.configFile}`);
  console.log(`  AI Agent: ${stats.bySource.aiAgent}`);
  console.log(`  CLI: ${stats.bySource.cli}`);

  if (stats.byPackage.size > 0) {
    console.log(chalk.bold('\n📚 By Package:\n'));
    const sortedPackages = Array.from(stats.byPackage.entries())
      .sort((a, b) => b[1] - a[1]);

    sortedPackages.forEach(([pkg, count]) => {
      console.log(`  ${pkg}: ${count}`);
    });
  }

  if (stats.deadSuppressions > 0) {
    console.log(chalk.yellow(`\n⚠️  You have ${stats.deadSuppressions} dead suppressions that can be cleaned up.`));
    console.log(chalk.dim('   Run: nark suppressions clean --auto'));
  }
}
