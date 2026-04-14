#!/usr/bin/env node

/**
 * CLI Entry Point - behavioral contract verification tool
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import chalk from 'chalk';
import { loadCorpus } from './corpus-loader.js';
import { Analyzer } from './analyzer.js';
import { PackageDiscovery } from './package-discovery.js';
import {
  generateAuditRecord,
  generateEnhancedAuditRecord,
  writeAuditRecord,
  printTerminalReport,
  printEnhancedTerminalReport,
  printCorpusErrors,
} from './reporter.js';
import {
  printPositiveEvidenceReport,
  writePositiveEvidenceReport,
  writePositiveEvidenceReportMarkdown,
  writeD3Visualization,
  calculateHealthScore,
  buildPackageBreakdown,
  compareAgainstBenchmark,
  loadBenchmark,
} from './reporters/index.js';
import { ensureTsconfig } from './tsconfig-generator.js';
import type { AnalyzerConfig, Violation } from './types.js';
import { createSuppressionsCommand } from './cli/suppressions.js';
import { createInitCommand } from './cli/init.js';
import { createTriageCommand } from './cli/triage.js';
import { createCompactCommand } from './cli/compact.js';
import { createShowCommand } from './cli/show.js';
import { createTelemetryCommand, handleFirstRunNotice, fireTelemetryEvent } from './cli/telemetry.js';
import { createAuthCommand } from './cli/auth.js';
import { createCiCommand } from './cli/ci.js';
import { generateAIPrompt } from './ai-prompt-generator.js';
import { loadStore, removeStaleSuppressions, saveStore } from './suppressions/bc-scan-store.js';
import { writeScanResults } from './output/index.js';
import { writeSarifOutput } from './output/sarif-writer.js';
import { loadNarkRc } from './config/narkrc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const program = new Command();

// Load .narkrc.yaml from the project root (cwd at invocation time).
// Commander hasn't parsed yet, so extract --project from argv manually.
const _projectArgIdx = process.argv.indexOf('--project');
const _projectRootForRc =
  _projectArgIdx !== -1 && process.argv[_projectArgIdx + 1]
    ? process.argv[_projectArgIdx + 1]
    : process.cwd();
const _narkRc = (() => {
  try {
    return loadNarkRc(_projectRootForRc);
  } catch (err) {
    console.error(
      chalk.yellow(`Warning: ${err instanceof Error ? err.message : String(err)}`)
    );
    return null;
  }
})();

program
  .name('nark')
  .description('Contract coverage scanner — find missing error handling before production')
  .version('1.0.0');

// Add suppressions subcommand
program.addCommand(createSuppressionsCommand());
program.addCommand(createInitCommand());
program.addCommand(createTriageCommand());
program.addCommand(createCompactCommand());
program.addCommand(createShowCommand());
program.addCommand(createTelemetryCommand());
program.addCommand(createAuthCommand());
program.addCommand(createCiCommand());

program
  .option('--tsconfig <path>', 'Path to tsconfig.json or project directory', _narkRc?.tsconfig ?? './tsconfig.json')
  .option('--corpus <path>', 'Path to corpus directory (default: auto-resolves from nark-corpus package)', _narkRc?.corpus ?? findDefaultCorpusPath())
  .option('--output <path>', 'Output path for audit record JSON (default: auto-generated in output/runs/)', _narkRc?.output?.json)
  .option('--project <path>', 'Path to project root (for package.json discovery)', process.cwd())
  .option('--no-terminal', 'Disable terminal output (JSON only)')
  .option('--fail-on-warnings', 'Exit with error code if warnings are found')
  .option('--report-only', 'Always exit 0 regardless of violations (report-only mode)', false)
  .option('--fail-threshold <level>', 'Exit 1 if violations at or above this severity are found (error|warning|info)', _narkRc?.failThreshold ?? 'error')
  .option('--discover-packages', 'Enable package discovery and coverage reporting', true)
  .option('--include-tests', 'Include test files in analysis (default: excludes test files)', _narkRc?.includeTests ?? false)
  .option('--include-drafts', 'Include draft and in-development contracts (default: excludes draft/in-development)', _narkRc?.includeDrafts ?? false)
  .option('--include-deprecated', 'Include deprecated contracts (default: excludes deprecated)', _narkRc?.includeDeprecated ?? false)
  .option('--positive-report', 'Generate positive evidence report (default: true)', true)
  .option('--no-positive-report', 'Disable positive evidence report')
  .option('--show-suppressions', 'Show suppressed violations in output', false)
  .option('--check-dead-suppressions', 'Check for and report dead suppressions', false)
  .option('--fail-on-dead-suppressions', 'Exit with error if dead suppressions are found', false)
  .option('--use-v1-analyzer', 'Use legacy v1 analyzer instead of the default v2', false)
  .option('--use-v2-analyzer', 'Deprecated no-op: v2 is now the default', false)
  .option('--compare-analyzers', 'Run both v1 and v2 analyzers and show diff (for validation)', false)
  .option('--instructions-path', 'Print the path to FORAIAGENTS.md and exit', false)
  .option('--sarif', 'Output results in SARIF 2.1.0 format (stdout)')
  .option('--sarif-output <path>', 'Write SARIF 2.1.0 output to file', _narkRc?.output?.sarif)
  .option('--verbose', 'Print diagnostic information to stderr during scan', false)
  .action(async (options) => {
    // This action handler is called when the main command is invoked
    // (i.e., not a subcommand like 'suppressions')
    await main(options);
  });

program.parse(process.argv);

/**
 * Find git repository root by walking up from a given path
 */
function findGitRepoRoot(startPath: string): string | null {
  let currentDir = path.dirname(path.resolve(startPath));
  const root = path.parse(currentDir).root;

  while (currentDir !== root) {
    const gitPath = path.join(currentDir, '.git');
    if (fs.existsSync(gitPath)) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }

  return null;
}

/**
 * Get git hash from the analyzed repository (not verify-cli)
 */
function getGitHashFromRepo(tsconfigPath: string): string {
  try {
    const _require = createRequire(import.meta.url);
    const { execSync } = _require('child_process');

    // Get the directory containing the tsconfig (the repo root)
    const repoDir = path.dirname(path.resolve(tsconfigPath));

    // Run git command in the analyzed repo's directory
    const gitHash = execSync('git rev-parse --short HEAD', {
      cwd: repoDir,
      encoding: 'utf-8',
    }).trim();

    return gitHash;
  } catch {
    // Not a git repo or git not available
    return 'nogit';
  }
}

/**
 * Ensure .nark is in .gitignore
 */
function ensureGitignore(projectRoot: string): void {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const entry = '.nark';

  try {
    let gitignoreContent = '';
    if (fs.existsSync(gitignorePath)) {
      gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
    }

    // Check if already ignored
    const lines = gitignoreContent.split('\n');
    const alreadyIgnored = lines.some(line => line.trim() === entry);

    if (!alreadyIgnored) {
      // Add entry to .gitignore
      const newContent = gitignoreContent.endsWith('\n')
        ? gitignoreContent + entry + '\n'
        : gitignoreContent + '\n' + entry + '\n';
      fs.writeFileSync(gitignorePath, newContent, 'utf-8');
    }
  } catch (err) {
    // If we can't update .gitignore, just warn but don't fail
    console.warn(chalk.yellow(`Warning: Could not update .gitignore: ${err}`));
  }
}

/**
 * Generate organized output path in the analyzed project's .nark directory
 */
function generateOutputPath(tsconfigPath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);

  // Get git commit hash from the analyzed repo
  const gitHash = getGitHashFromRepo(tsconfigPath);

  // Find the project root (git root or directory containing tsconfig)
  const projectRoot = findGitRepoRoot(tsconfigPath) || path.dirname(path.resolve(tsconfigPath));

  // Create run directory name
  const runDir = `${timestamp.replace(/T/, '-').replace(/-/g, '').substring(0, 13)}-${gitHash}`;

  // Output goes to .nark/runs/{runDir}/ in the analyzed project
  const outputDir = path.join(projectRoot, '.nark', 'runs', runDir);

  // Create directory if it doesn't exist
  fs.mkdirSync(outputDir, { recursive: true });

  // Ensure .nark is in .gitignore
  ensureGitignore(projectRoot);

  return path.join(outputDir, 'audit.json');
}

/**
 * Setup output logging to capture all terminal output to output.txt
 */
function setupOutputLogging(outputDir: string): () => void {
  const outputTxtPath = path.join(outputDir, 'output.txt');
  const logStream = fs.createWriteStream(outputTxtPath, { flags: 'w' });

  // Store original console methods
  const originalLog = console.log;
  const originalError = console.error;

  // Strip ANSI codes for file output
  const stripAnsi = (str: string) => str.replace(/\x1b\[[0-9;]*m/g, '');

  // Override console.log
  console.log = (...args: any[]) => {
    const message = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
    originalLog(...args); // Original output to terminal (with colors)
    logStream.write(stripAnsi(message) + '\n'); // Clean output to file
  };

  // Override console.error
  console.error = (...args: any[]) => {
    const message = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
    originalError(...args); // Original output to terminal (with colors)
    logStream.write(stripAnsi(message) + '\n'); // Clean output to file
  };

  // Return cleanup function
  return () => {
    console.log = originalLog;
    console.error = originalError;
    logStream.end();
  };
}

/**
 * Normalize tsconfig path (accept directory or file)
 * If directory is provided, append /tsconfig.json
 */
function normalizeTsconfigPath(tsconfigPath: string): string {
  const resolved = path.resolve(tsconfigPath);

  // If it's a directory, append tsconfig.json
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    return path.join(resolved, 'tsconfig.json');
  }

  // Otherwise assume it's already pointing to tsconfig.json
  return resolved;
}

/**
 * Write a verbose diagnostic line to stderr.
 * Uses process.stderr.write directly to bypass the console.error override
 * in setupOutputLogging — verbose output must not appear in output.txt.
 */
function verboseLog(message: string): void {
  process.stderr.write(message + '\n');
}

/**
 * Main execution
 */
async function main(options: any) {
  // Handle --instructions-path: print FORAIAGENTS.md path and exit
  if (options.instructionsPath) {
    const forAiAgentsPath = path.join(__dirname, '../FORAIAGENTS.md');
    console.log(forAiAgentsPath);
    process.exit(0);
  }

  // First-run telemetry notice (prints to stderr only, does not pollute JSON output)
  handleFirstRunNotice();

  const scanStartTime = Date.now();

  console.log(chalk.bold('\nNark Contract Verification\n'));

  // Normalize tsconfig path (allow directory or file)
  const tsconfigPath = normalizeTsconfigPath(options.tsconfig);

  // Ensure tsconfig exists (generate if missing)
  ensureTsconfig(tsconfigPath);

  // Validate corpus exists
  if (!fs.existsSync(options.corpus)) {
    console.error(chalk.red(`Error: Corpus directory not found at ${options.corpus}`));
    console.error(chalk.yellow('Tip: npm install nark-corpus, or use --corpus <path>, or set NARK_CORPUS_PATH'));
    process.exit(2);
  }

  // Generate organized output path if not specified
  const outputPath = options.output || generateOutputPath(tsconfigPath);
  const outputDir = path.dirname(outputPath);

  // Setup output logging (capture all terminal output to output.txt)
  const cleanupLogging = setupOutputLogging(outputDir);

  console.log(chalk.gray(`  tsconfig: ${tsconfigPath}`));
  console.log(chalk.gray(`  corpus: ${options.corpus}`));

  // Show corpus source (npm package vs local)
  if (options.corpus === findDefaultCorpusPath()) {
    try {
      const _require = createRequire(import.meta.url);
      _require.resolve('nark-corpus');
      console.log(chalk.dim(`  (using npm package nark-corpus)`));
    } catch {
      console.log(chalk.dim(`  (using local corpus for development)`));
    }
  } else {
    console.log(chalk.dim(`  (using custom corpus path)`));
  }

  console.log(chalk.gray(`  output: ${outputPath}\n`));

  // Load corpus
  console.log(chalk.dim('Loading contracts...'));
  const corpusStartTime = Date.now();
  const corpusResult = await loadCorpus(options.corpus, {
    includeDrafts: options.includeDrafts,
    includeDeprecated: options.includeDeprecated,
    includeInDevelopment: options.includeDrafts, // in-development included with drafts
  });
  const corpusEndTime = Date.now();

  if (corpusResult.errors.length > 0) {
    printCorpusErrors(corpusResult.errors);
    process.exit(2);
  }

  if (corpusResult.contracts.size === 0) {
    console.error(chalk.red('Error: No contracts loaded from corpus'));
    process.exit(2);
  }

  console.log(chalk.green(`✓ Loaded ${corpusResult.contracts.size} package contracts`));

  // Show skipped contracts (if any)
  if (corpusResult.skipped && corpusResult.skipped.length > 0) {
    const draftCount = corpusResult.skipped.filter(s => s.status === 'draft').length;
    const inDevCount = corpusResult.skipped.filter(s => s.status === 'in-development').length;
    const deprecatedCount = corpusResult.skipped.filter(s => s.status === 'deprecated').length;

    const skippedParts: string[] = [];
    if (draftCount > 0) skippedParts.push(`${draftCount} draft`);
    if (inDevCount > 0) skippedParts.push(`${inDevCount} in-development`);
    if (deprecatedCount > 0) skippedParts.push(`${deprecatedCount} deprecated`);

    console.log(chalk.dim(`  (Skipped ${skippedParts.join(', ')} - use --include-drafts to include)`));
  }
  console.log();

  // Checkpoint 1: verbose corpus output
  if (options.verbose && corpusResult.contractFiles) {
    const totalFiles = Array.from(corpusResult.contractFiles.values())
      .reduce((sum, files) => sum + files.length, 0);
    verboseLog(`\n[verbose] Contracts loaded: ${totalFiles} files across ${corpusResult.contracts.size} packages`);
    if (totalFiles <= 20) {
      for (const [pkg, files] of corpusResult.contractFiles) {
        for (const f of files) verboseLog(`  ${pkg}: ${f}`);
      }
    } else {
      for (const [pkg, files] of corpusResult.contractFiles) {
        verboseLog(`  ${pkg}: ${files.length} file(s)`);
      }
    }
  }

  // Discover packages (if enabled)
  let packageDiscovery;
  const discoveryStartTime = Date.now();
  if (options.discoverPackages !== false) {
    console.log(chalk.dim('Discovering packages...'));
    const discoveryTool = new PackageDiscovery(corpusResult.contracts);
    packageDiscovery = await discoveryTool.discoverPackages(
      options.project,
      path.resolve(tsconfigPath)
    );
    console.log(chalk.green(`✓ Discovered ${packageDiscovery.total} packages\n`));
  }
  const discoveryEndTime = Date.now();

  // Checkpoint 2: verbose package discovery output
  if (options.verbose && packageDiscovery) {
    verboseLog(`\n[verbose] Package discovery:`);
    for (const pkg of packageDiscovery.packages) {
      if (pkg.usedIn.length > 0) {
        verboseLog(`  ${pkg.name}: imported in ${pkg.usedIn.length} file(s)`);
        for (const f of pkg.usedIn) verboseLog(`    ${f}`);
      }
    }
  }

  // Create analyzer
  const config: AnalyzerConfig = {
    tsconfigPath: path.resolve(tsconfigPath),
    corpusPath: path.resolve(options.corpus),
    includeTests: options.includeTests,
  };

  console.log(chalk.dim('Analyzing TypeScript code...'));

  // Always create a v1 analyzer instance (used for suppression checks and dead suppression detection)
  const analyzer = new Analyzer(config, corpusResult.contracts);

  let violations: Violation[];
  let stats: { filesAnalyzed: number; contractsApplied: number; [key: string]: any };
  let v2Result: import('./v2/adapter.js').V2AdapterResult | undefined;

  const analysisStartTime = Date.now();
  if (options.useV1Analyzer && !options.compareAnalyzers) {
    // Legacy v1 mode (--use-v1-analyzer flag)
    violations = analyzer.analyze();
    stats = analyzer.getStats();
  } else if (options.compareAnalyzers) {
    // Compare mode: run both and show diff
    const { runV2Analyzer } = await import('./v2/adapter.js');
    v2Result = await runV2Analyzer(config, corpusResult.contracts);
    const v1Violations = analyzer.analyze();
    const v1Stats = analyzer.getStats();

    printAnalyzerDiff(v1Violations, v2Result.violations);

    // Use v2 as authoritative output
    violations = v2Result.violations;
    stats = {
      filesAnalyzed: v2Result.filesAnalyzed,
      contractsApplied: corpusResult.contracts.size,
    };
    void v1Stats; // used only for the diff above
  } else {
    // Default: v2 plugin-based analyzer
    const { runV2Analyzer } = await import('./v2/adapter.js');
    v2Result = await runV2Analyzer(config, corpusResult.contracts);
    violations = v2Result.violations;
    stats = {
      filesAnalyzed: v2Result.filesAnalyzed,
      contractsApplied: corpusResult.contracts.size,
      callsitesByPackage: v2Result.callSitesByPackage,
    };
  }
  const analysisEndTime = Date.now();

  console.log(chalk.green(`✓ Analyzed ${stats.filesAnalyzed} files\n`));

  // Checkpoint 3: verbose analysis timing output
  if (options.verbose && v2Result) {
    const slowFiles = v2Result.fileDurations
      .filter(f => f.durationMs > 500)
      .sort((a, b) => b.durationMs - a.durationMs);
    verboseLog(`\n[verbose] Analysis timing:`);
    if (slowFiles.length > 0) {
      verboseLog(`  Files taking >500ms:`);
      for (const f of slowFiles) verboseLog(`    ${f.durationMs}ms  ${f.file}`);
    } else {
      verboseLog(`  No files took >500ms`);
    }
    for (const s of v2Result.skippedFiles) {
      verboseLog(`  Skipped: ${s.count} ${s.reason}`);
    }
  }

  // Report suppressions if requested
  if (options.showSuppressions) {
    const suppressedViolations = analyzer.getSuppressedViolations();
    if (suppressedViolations.length > 0) {
      console.log(chalk.yellow(`⚠️  ${suppressedViolations.length} suppressions active\n`));
    }
  }

  // Check for dead suppressions if requested
  if (options.checkDeadSuppressions || options.failOnDeadSuppressions) {
    const deadSuppressions = analyzer.detectDeadSuppressions();
    if (deadSuppressions.length > 0) {
      console.log(chalk.yellow(`\n🎉 Found ${deadSuppressions.length} dead suppressions (analyzer improved!):\n`));
      deadSuppressions.forEach((dead) => {
        console.log(analyzer.formatDeadSuppression(dead));
      });

      if (options.failOnDeadSuppressions) {
        console.error(chalk.red('\n❌ Failing due to dead suppressions (--fail-on-dead-suppressions)'));
        process.exit(1);
      }
    } else {
      console.log(chalk.green('✨ No dead suppressions found!\n'));
    }
  }

  const outputStartTime = Date.now();

  // Generate audit record
  const packagesAnalyzed = Array.from(corpusResult.contracts.keys());
  const auditRecord = await generateAuditRecord(violations, {
    tsconfigPath: options.tsconfig,
    packagesAnalyzed,
    contractsApplied: stats.contractsApplied,
    filesAnalyzed: stats.filesAnalyzed,
    corpusVersion: '1.0.0', // TODO: Read from corpus metadata
    callsitesByPackage: stats.callsitesByPackage,
  });

  // Generate enhanced audit record if package discovery was run
  const finalRecord = packageDiscovery
    ? generateEnhancedAuditRecord(auditRecord, packageDiscovery)
    : auditRecord;

  // Write JSON output
  writeAuditRecord(finalRecord, outputPath);
  console.log(chalk.gray(`Audit record written to ${outputPath}`));

  // Automatically clean stale suppressions from .bc-suppressions.json
  const suppressionsStorePath = path.join(options.project, '.bc-suppressions.json');
  if (fs.existsSync(suppressionsStorePath)) {
    try {
      const store = loadStore(options.project);
      if (store.suppressions.length > 0) {
        // Collect all fingerprints seen in this scan (suppressed and active)
        const seenFingerprints = new Set<string>();
        violations.forEach(v => {
          const fp = (v as any).fingerprint;
          if (fp) seenFingerprints.add(fp);
        });

        const removed = removeStaleSuppressions(store, seenFingerprints);
        if (removed.length > 0) {
          saveStore(options.project, store);
          console.log(chalk.green(`\n✓ Removed ${removed.length} stale suppression${removed.length === 1 ? '' : 's'} (violations no longer detected):`));
          removed.forEach(s => {
            console.log(chalk.dim(`    ${s.filePath}:${s.lineNumber} — ${s.package}/${s.postconditionId}`));
          });
        }
      }
    } catch {
      // Don't fail the scan if suppression cleanup errors
    }
  }

  // Generate AI agent prompt file
  const aiPromptPath = await generateAIPrompt(finalRecord, outputPath);

  // Print terminal report
  if (options.terminal !== false) {
    if (packageDiscovery) {
      printEnhancedTerminalReport(finalRecord as any);
    } else {
      printTerminalReport(auditRecord);
    }
  }

  // Generate and print positive evidence report (default: on)
  if (options.positiveReport !== false && options.terminal !== false) {
    console.log(''); // Add spacing

    const reportOptions = {
      showHealthScore: true,
      showPackageBreakdown: true,
      showInsights: true,
      showRecommendations: true,
      showBenchmarking: true, // Phase 2 - now enabled!
    };

    await printPositiveEvidenceReport(finalRecord as any, reportOptions);

    // Write positive evidence report to file (both .txt and .md)
    const positiveReportTxtPath = path.join(outputDir, 'positive-report.txt');
    const positiveReportMdPath = path.join(outputDir, 'positive-report.md');

    await writePositiveEvidenceReport(finalRecord as any, positiveReportTxtPath, reportOptions);
    await writePositiveEvidenceReportMarkdown(finalRecord as any, positiveReportMdPath, reportOptions);

    // Generate D3.js interactive visualization
    const d3HtmlPath = path.join(outputDir, 'index.html');

    // Calculate metrics for D3 visualization
    const healthMetrics = calculateHealthScore(finalRecord);
    const packageBreakdown = buildPackageBreakdown(finalRecord);

    // Load benchmark if available
    let benchmarkComparison;
    let benchmarkData;
    try {
      const benchmarkPath = path.join(__dirname, '../data/benchmarks.json');
      benchmarkData = await loadBenchmark(benchmarkPath);
      if (benchmarkData) {
        benchmarkComparison = compareAgainstBenchmark(finalRecord, benchmarkData);
      }
    } catch {
      // Benchmark not available
    }

    await writeD3Visualization(
      {
        audit: finalRecord,
        health: healthMetrics,
        packageBreakdown,
        benchmarking: benchmarkComparison,
        benchmark: benchmarkData || undefined,
      },
      d3HtmlPath
    );

    const outputTxtPath = path.join(outputDir, 'output.txt');

    console.log(chalk.gray(`Reports written to:`));
    console.log(chalk.gray(`  - ${outputTxtPath} (full terminal output)`));
    console.log(chalk.gray(`  - ${positiveReportTxtPath}`));
    console.log(chalk.gray(`  - ${positiveReportMdPath}`));
    console.log(chalk.green(`  - file://${d3HtmlPath} (interactive visualization)`));

    // Only show AI prompt if it was generated (i.e., if there are violations)
    if (aiPromptPath) {
      console.log(chalk.hex('#FFA500')(`  - ${aiPromptPath} (AI agent instructions)`));
    }
    console.log('');
  }

  // Write .nark/ output directory
  const projectRoot = findGitRepoRoot(tsconfigPath) || path.dirname(path.resolve(tsconfigPath));
  const narkResult = await writeScanResults({
    projectRoot,
    auditRecord: finalRecord,
    violations,
    tsconfigPath: path.resolve(tsconfigPath),
    startTime: scanStartTime,
    narkVersion: '1.0.0',
  });

  if (narkResult) {
    console.log(chalk.gray(`\nScan results saved to ${narkResult.scanPath}`));
    console.log(chalk.gray(`Violation details: ${path.join(narkResult.narkDir, 'violations')}/`));
    console.log(chalk.gray(`For AI agent instructions: nark --instructions-path`));
  }

  // SARIF output (--sarif or --sarif-output)
  if (options.sarif || options.sarifOutput) {
    writeSarifOutput(violations, options.sarifOutput);
  }

  // Final summary at the very end (easy to spot after all output)
  const totalViolations = auditRecord.summary.error_count + auditRecord.summary.warning_count;
  if (totalViolations > 0) {
    console.log(chalk.yellow('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.yellow.bold(`  ⚠️  ${totalViolations} violation${totalViolations === 1 ? '' : 's'} found - scroll up for full report`));
    console.log(chalk.yellow('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
  } else {
    console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.green.bold('  ✓ No violations found - great work!'));
    console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
  }

  const outputEndTime = Date.now();

  // Fire telemetry (fire-and-forget, never blocks)
  {
    const narkPkg = (() => {
      try {
        const _require = createRequire(import.meta.url);
        return _require('../package.json') as { version: string };
      } catch { return { version: 'unknown' }; }
    })();
    const contractIds = corpusResult.contracts
      ? Array.from((corpusResult.contracts as Map<string, any>).values()).map((c: any) => c.id ?? c.contractId ?? c.package ?? '').filter(Boolean)
      : [];
    const packageNames = packageDiscovery?.packages?.map((p: any) => p.name) ?? [];
    const violationCountsByContract: Record<string, number> = {};
    for (const v of violations) {
      const id: string = (v as any).contractId ?? (v as any).contract ?? 'unknown';
      violationCountsByContract[id] = (violationCountsByContract[id] ?? 0) + 1;
    }
    fireTelemetryEvent({
      version: narkPkg.version,
      os: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      packageNames,
      contractIds,
      violationCountsByContract,
      scanDurationMs: outputEndTime - scanStartTime,
      isCiMode: !!(process.env.CI || process.env.CONTINUOUS_INTEGRATION),
    });
  }

  // Checkpoint 4: verbose time breakdown
  if (options.verbose) {
    const totalTime = Date.now() - scanStartTime;
    verboseLog(`\n[verbose] Time breakdown:`);
    verboseLog(`  Contract loading:     ${corpusEndTime - corpusStartTime}ms`);
    verboseLog(`  Package discovery:    ${discoveryEndTime - discoveryStartTime}ms`);
    verboseLog(`  TypeScript analysis:  ${analysisEndTime - analysisStartTime}ms`);
    verboseLog(`  Output generation:    ${outputEndTime - outputStartTime}ms`);
    verboseLog(`  Total:                ${totalTime}ms`);
  }

  // Cleanup logging
  cleanupLogging();

  // Exit with appropriate code
  // --report-only: always exit 0, even with violations (report-only mode)
  if (options.reportOnly) {
    process.exit(0);
  }

  const hasErrors = auditRecord.summary.error_count > 0;
  const hasWarnings = auditRecord.summary.warning_count > 0;
  const hasInfo = (auditRecord.summary as any).info_count > 0;

  // Determine effective threshold
  // --fail-on-warnings is kept for backward compatibility (equivalent to --fail-threshold warning)
  // --fail-threshold overrides for explicit control
  const threshold = options.failOnWarnings ? 'warning' : (options.failThreshold || 'error');

  let shouldFail = false;
  if (threshold === 'info') {
    shouldFail = hasErrors || hasWarnings || hasInfo;
  } else if (threshold === 'warning') {
    shouldFail = hasErrors || hasWarnings;
  } else {
    // 'error' (default)
    shouldFail = hasErrors;
  }

  process.exit(shouldFail ? 1 : 0);
}

/**
 * Finds the default corpus path by trying:
 * 1. Published npm package (nark-corpus)
 * 2. Local development paths (for contributors)
 */
function findDefaultCorpusPath(): string {
  // Try 1: NARK_CORPUS_PATH env var (highest priority override, for development)
  const envPath = process.env.NARK_CORPUS_PATH;
  if (envPath && fs.existsSync(path.join(envPath, 'packages'))) {
    return envPath;
  }

  // Try 2: Published npm package (production use)
  try {
    const _require = createRequire(import.meta.url);
    const corpusModule = _require('nark-corpus');
    // getCorpusPath() returns the packages/ subdirectory
    // corpus-loader expects the parent (the corpus root containing packages/ and schema/)
    const corpusRoot = path.dirname(corpusModule.getCorpusPath());

    if (fs.existsSync(path.join(corpusRoot, 'packages'))) {
      return corpusRoot;
    }
  } catch (err) {
    // Package not installed - fall through to local paths
  }

  // Try 3: Local corpus repo (development fallback)
  const possiblePaths = [
    path.join(process.cwd(), '../nark-corpus'),
    path.join(process.cwd(), '../corpus'),
    path.join(process.cwd(), '../../nark-corpus'),
    path.join(process.cwd(), '../../corpus'),
    path.join(__dirname, '../../nark-corpus'),
    path.join(__dirname, '../../corpus'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(path.join(p, 'packages'))) {
      return p;
    }
  }

  // Fallback: assume sibling nark-corpus repo
  return path.join(process.cwd(), '../nark-corpus');
}

/**
 * Print a diff between v1 and v2 analyzer results.
 *
 * Compares by CALL SITE (unique file + line + package + function), not by individual
 * violation count. This gives a fair regression picture: if v1 fires 3 violations at
 * line X and v2 fires 1, that counts as 1 matching call site (not 2 regressions).
 *
 * Shows:
 * - Call sites found by both (matching)
 * - Call sites only in v1 (missed by v2 = true regressions)
 * - Call sites only in v2 (new detections or v2-only patterns)
 */
function printAnalyzerDiff(v1Violations: Violation[], v2Violations: Violation[]): void {
  console.log(chalk.bold('\n══════════════════════════════════════════════'));
  console.log(chalk.bold('  Analyzer Comparison (v1 vs v2)'));
  console.log(chalk.bold('══════════════════════════════════════════════\n'));

  const LINE_FUZZ = 2;

  type CallSite = { file: string; line: number; pkg: string; fn: string };

  // Deduplicate violations into unique call sites.
  // Key: file:line:package (NOT function) so V1's catch-all double-fires
  // (e.g., [mongoose.find] + [mongoose.findById] at the same line) don't
  // appear as two separate regressions when V2 correctly fires only once.
  function toCallSites(violations: Violation[]): CallSite[] {
    const seen = new Set<string>();
    const sites: CallSite[] = [];
    for (const v of violations) {
      const key = `${v.file}:${v.line}:${v.package}`;
      if (!seen.has(key)) {
        seen.add(key);
        sites.push({ file: v.file, line: v.line, pkg: v.package, fn: v.function });
      }
    }
    return sites;
  }

  const v1Sites = toCallSites(v1Violations);
  const v2Sites = toCallSites(v2Violations);

  // Two-pass matching to prevent a V1 site with function=X from "stealing" the match
  // for a V2 site with function=Y at the same line, which would then leave a V2 site
  // with function=X at +2 lines unmatched (classic redis createClient:43 vs connect:45 bug).
  //
  // Pass 1: Exact function-name match (same file + pkg + fn + line within fuzz)
  // Pass 2: Fuzzy function-name match (same file + pkg + any fn + line within fuzz)
  //
  // This lets V1's connect:45 claim V2's connect:45 before V1's createClient:43 steals it,
  // while still falling back to fn-agnostic matching for discord.js / mongoose patterns
  // where V1 uses a catch-all function name.
  const matchedV2Indices = new Set<number>();
  const matchedSites: CallSite[] = [];
  const onlyInV1: CallSite[] = [];

  // Helper: attempt to match s1 against v2Sites, filtering by fn if requireFnMatch=true
  function tryMatch(s1: CallSite, requireFnMatch: boolean): boolean {
    for (let i = 0; i < v2Sites.length; i++) {
      if (matchedV2Indices.has(i)) continue;
      const s2 = v2Sites[i];
      if (s1.file !== s2.file || s1.pkg !== s2.pkg) continue;
      if (Math.abs(s1.line - s2.line) > LINE_FUZZ) continue;
      if (requireFnMatch && s1.fn !== s2.fn) continue;
      matchedV2Indices.add(i);
      matchedSites.push(s1);
      return true;
    }
    return false;
  }

  // Pass 1: fn-exact matches
  const unmatchedAfterPass1: CallSite[] = [];
  for (const s1 of v1Sites) {
    if (!tryMatch(s1, true)) unmatchedAfterPass1.push(s1);
  }

  // Pass 2: fn-fuzzy matches for remaining
  for (const s1 of unmatchedAfterPass1) {
    if (!tryMatch(s1, false)) onlyInV1.push(s1);
  }

  const onlyInV2 = v2Sites.filter((_, i) => !matchedV2Indices.has(i));

  // Print summary
  console.log(chalk.green(`  Matching call sites (in both): ${matchedSites.length}`));
  console.log(chalk.yellow(`  Only in v1 (missed by v2): ${onlyInV1.length} call sites`));
  console.log(chalk.cyan(`  Only in v2 (new or false positives): ${onlyInV2.length} call sites`));
  console.log('');
  console.log(chalk.dim(`  Raw counts: v1=${v1Violations.length} violations, v2=${v2Violations.length} violations`));
  console.log(chalk.dim(`  (v1 fires multiple violations per call site; call-site match is the accurate regression metric)`));
  console.log('');

  if (onlyInV1.length > 0) {
    console.log(chalk.yellow.bold('  Call sites in v1 but NOT in v2 (true regressions):'));
    for (const s of onlyInV1) {
      const relFile = path.relative(process.cwd(), s.file);
      console.log(chalk.yellow(`    - ${relFile}:${s.line} [${s.pkg}.${s.fn}]`));
    }
    console.log('');
  }

  if (onlyInV2.length > 0) {
    console.log(chalk.cyan.bold('  Call sites in v2 but NOT in v1 (new detections):'));
    for (const s of onlyInV2) {
      const relFile = path.relative(process.cwd(), s.file);
      console.log(chalk.cyan(`    + ${relFile}:${s.line} [${s.pkg}.${s.fn}]`));
    }
    console.log('');
  }

  console.log(chalk.bold('══════════════════════════════════════════════\n'));
}

/**
 * Handle errors
 */
process.on('uncaughtException', (error) => {
  console.error(chalk.red('\nUnexpected error:'));
  console.error(error);
  process.exit(2);
});
