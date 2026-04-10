/**
 * CLI Command: triage
 * Manage violation triage verdicts.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as path from 'path';
import { readAllViolationFiles, markVerdict } from '../triage/index.js';

const VALID_VERDICTS = ['true-positive', 'false-positive', 'wont-fix'];

/**
 * Resolve .nark directory from project root option.
 */
function resolveNarkDir(projectOption: string): string {
  return path.join(path.resolve(projectOption), '.nark');
}

/**
 * Create the triage subcommand
 */
export function createTriageCommand(): Command {
  const triage = new Command('triage');

  triage
    .description('Manage violation triage')
    .addCommand(createTriageListCommand())
    .addCommand(createTriageMarkCommand())
    .addCommand(createTriageSummaryCommand());

  return triage;
}

/**
 * nark triage list — list all untriaged violations
 */
function createTriageListCommand(): Command {
  const list = new Command('list');

  list
    .description('List all untriaged violations from .nark/violations/')
    .option('--project <path>', 'Project root directory', process.cwd())
    .option('--all', 'Show all violations including triaged ones')
    .action((options) => {
      const narkDir = resolveNarkDir(options.project);
      const files = readAllViolationFiles(narkDir);

      if (files.length === 0) {
        console.log(chalk.dim('No violation files found in .nark/violations/'));
        return;
      }

      const toShow = options.all
        ? files
        : files.filter(f => !f.data.triage?.verdict || f.data.triage.verdict === 'untriaged');

      if (toShow.length === 0) {
        console.log(chalk.green('✓ All violations have been triaged.'));
        return;
      }

      const label = options.all ? 'All Violations' : 'Untriaged Violations';
      console.log(chalk.bold(`\n${label} (${toShow.length})\n`));

      for (const { data } of toShow) {
        const verdict = data.triage?.verdict || 'untriaged';
        const verdictColor =
          verdict === 'untriaged' ? chalk.yellow :
          verdict === 'true-positive' ? chalk.red :
          verdict === 'false-positive' ? chalk.green :
          chalk.dim;

        console.log(`  ${chalk.cyan(data.fingerprint)}`);
        console.log(`    Package:  ${data.package}`);
        console.log(`    File:     ${data.file}:${data.line}`);
        console.log(`    Severity: ${data.severity}`);
        console.log(`    Verdict:  ${verdictColor(verdict)}`);
        if (data.triage?.reason) {
          console.log(`    Reason:   ${chalk.dim(data.triage.reason)}`);
        }
        console.log();
      }
    });

  return list;
}

/**
 * nark triage mark <fingerprint> <verdict> --reason "..."
 */
function createTriageMarkCommand(): Command {
  const mark = new Command('mark');

  mark
    .description('Mark a violation with a triage verdict')
    .argument('<fingerprint>', 'Violation fingerprint (from scan output)')
    .argument('<verdict>', `Verdict: ${VALID_VERDICTS.join(', ')}`)
    .option('--reason <text>', 'Why this verdict was chosen', '')
    .option('--by <name>', 'Who is triaging (default: cli)', 'cli')
    .option('--project <path>', 'Project root directory', process.cwd())
    .action((fingerprint, verdict, options) => {
      if (!VALID_VERDICTS.includes(verdict)) {
        console.error(chalk.red(`Error: Invalid verdict "${verdict}". Must be one of: ${VALID_VERDICTS.join(', ')}`));
        process.exit(1);
      }

      const narkDir = resolveNarkDir(options.project);
      const success = markVerdict(narkDir, fingerprint, verdict, options.reason, options.by);

      if (!success) {
        console.error(chalk.red(`Error: Violation not found for fingerprint: ${fingerprint}`));
        console.error(chalk.dim('Run "nark triage list" to see available fingerprints.'));
        process.exit(1);
      }

      const verdictColor =
        verdict === 'false-positive' ? chalk.green :
        verdict === 'true-positive' ? chalk.red :
        chalk.dim;

      console.log(chalk.green('✓') + ` Marked ${chalk.cyan(fingerprint)} as ${verdictColor(verdict)}`);
      if (options.reason) {
        console.log(chalk.dim(`  Reason: ${options.reason}`));
      }
      console.log(chalk.dim(`  By: ${options.by}`));

      if (verdict === 'false-positive') {
        console.log(chalk.dim('\n  This violation will be suppressed on next scan.'));
      }
    });

  return mark;
}

/**
 * nark triage summary — show triage stats
 */
function createTriageSummaryCommand(): Command {
  const summary = new Command('summary');

  summary
    .description('Show triage statistics')
    .option('--project <path>', 'Project root directory', process.cwd())
    .option('--json', 'Output as JSON')
    .action((options) => {
      const narkDir = resolveNarkDir(options.project);
      const files = readAllViolationFiles(narkDir);

      const counts: Record<string, number> = {
        total: files.length,
        untriaged: 0,
        'true-positive': 0,
        'false-positive': 0,
        'wont-fix': 0,
      };

      for (const { data } of files) {
        const verdict = data.triage?.verdict || 'untriaged';
        const key = verdict in counts ? verdict : 'untriaged';
        counts[key]++;
      }

      if (options.json) {
        console.log(JSON.stringify(counts, null, 2));
        return;
      }

      console.log(chalk.bold('\nTriage Summary\n'));
      console.log(`  Total violations:  ${counts.total}`);
      console.log(`  Untriaged:         ${chalk.yellow(String(counts.untriaged))}`);
      console.log(`  True positives:    ${chalk.red(String(counts['true-positive']))}`);
      console.log(`  False positives:   ${chalk.green(String(counts['false-positive']))}`);
      console.log(`  Won't fix:         ${chalk.dim(String(counts['wont-fix']))}`);

      if (counts.untriaged > 0) {
        console.log(chalk.dim(`\n  Run "nark triage list" to see untriaged violations.`));
      } else if (counts.total > 0) {
        console.log(chalk.green('\n  ✓ All violations triaged.'));
      }
      console.log();
    });

  return summary;
}
