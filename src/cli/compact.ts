/**
 * CLI Command: compact
 * Compact scan history — preserve triage decisions, remove old scan files.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Create the compact subcommand
 */
export function createCompactCommand(): Command {
  const compact = new Command('compact');

  compact
    .description('Compact scan history, preserving triage decisions')
    .option('--project <path>', 'Project root directory', process.cwd())
    .option('--dry-run', 'Show what would be done without making changes')
    .action(async (options) => {
      const projectRoot = path.resolve(options.project);
      const narkDir = path.join(projectRoot, '.nark');
      const scansDir = path.join(narkDir, 'scans');
      const violationsDir = path.join(narkDir, 'violations');

      if (!fs.existsSync(scansDir)) {
        console.log(chalk.dim('No .nark/scans/ directory found — nothing to compact.'));
        return;
      }

      try {
        // Read all scan files (only NNN.json files, not symlinks like "latest")
        const scanFiles = fs.readdirSync(scansDir)
          .filter(f => /^\d{3}\.json$/.test(f))
          .sort();

        if (scanFiles.length <= 1) {
          console.log(chalk.dim(`Only ${scanFiles.length} scan file(s) — nothing to compact.`));
          return;
        }

        // Find the most recent scan file
        const latestScanFile = scanFiles[scanFiles.length - 1];
        const oldScanFiles = scanFiles.slice(0, scanFiles.length - 1);

        console.log(chalk.bold(`\nCompacting ${scanFiles.length} scan files...\n`));
        console.log(chalk.dim(`  Keeping:  ${latestScanFile}`));
        console.log(chalk.dim(`  Removing: ${oldScanFiles.join(', ')}`));

        // Read triage data from violation files and persist to history.json
        if (fs.existsSync(violationsDir)) {
          const packages = fs.readdirSync(violationsDir);
          let historyFilesCreated = 0;

          for (const pkg of packages) {
            const pkgDir = path.join(violationsDir, pkg);
            try {
              if (!fs.statSync(pkgDir).isDirectory()) continue;

              const jsonFiles = fs.readdirSync(pkgDir).filter(f => f.endsWith('.json') && f !== 'history.json');

              if (jsonFiles.length === 0) continue;

              // Build history entry from all violation files in this package
              const violations: any[] = [];
              for (const file of jsonFiles) {
                try {
                  const raw = fs.readFileSync(path.join(pkgDir, file), 'utf-8');
                  const data = JSON.parse(raw);
                  violations.push({
                    fingerprint: data.fingerprint,
                    file: data.file,
                    line: data.line,
                    severity: data.severity,
                    description: data.description,
                    triage: data.triage,
                    scan_id: data.scan_id,
                  });
                } catch {
                  // Skip unreadable files
                }
              }

              // Read most recent scan data for this package
              let latestScanViolations: any[] = [];
              try {
                const latestScanPath = path.join(scansDir, latestScanFile);
                const scanRaw = fs.readFileSync(latestScanPath, 'utf-8');
                const scanData = JSON.parse(scanRaw);
                latestScanViolations = (scanData.violations || []).filter(
                  (v: any) => v.package === pkg || (pkg.startsWith('@') && v.package === pkg)
                );
              } catch {
                // Scan file unreadable
              }

              // Build scan history from old scans (summarized)
              const scanHistory: Array<{ scan_id: string; timestamp: string; violation_count: number }> = [];
              for (const scanFile of scanFiles) {
                try {
                  const scanPath = path.join(scansDir, scanFile);
                  const scanRaw = fs.readFileSync(scanPath, 'utf-8');
                  const scanData = JSON.parse(scanRaw);
                  const pkgViolations = (scanData.violations || []).filter(
                    (v: any) => v.package === pkg
                  );
                  scanHistory.push({
                    scan_id: scanData.id,
                    timestamp: scanData.timestamp,
                    violation_count: pkgViolations.length,
                  });
                } catch {
                  // Skip
                }
              }

              const historyData = {
                package: pkg,
                compacted_at: new Date().toISOString(),
                triage_decisions: violations
                  .filter(v => v.triage?.verdict && v.triage.verdict !== 'untriaged')
                  .map(v => ({ fingerprint: v.fingerprint, triage: v.triage })),
                latest_violations: latestScanViolations,
                scan_history: scanHistory,
              };

              const historyPath = path.join(pkgDir, 'history.json');

              if (!options.dryRun) {
                fs.writeFileSync(historyPath, JSON.stringify(historyData, null, 2), 'utf-8');
                historyFilesCreated++;
              } else {
                console.log(chalk.dim(`  Would create: ${path.relative(projectRoot, historyPath)}`));
                historyFilesCreated++;
              }
            } catch {
              // Skip package dirs with errors
            }
          }

          if (historyFilesCreated > 0) {
            console.log(chalk.dim(`\n  ${options.dryRun ? 'Would create' : 'Created'} history.json for ${historyFilesCreated} package(s)`));
          }
        }

        // Remove old scan files
        let removedCount = 0;
        for (const oldFile of oldScanFiles) {
          const filePath = path.join(scansDir, oldFile);
          if (!options.dryRun) {
            try {
              fs.unlinkSync(filePath);
              removedCount++;
            } catch {
              console.warn(chalk.yellow(`  Warning: Could not remove ${oldFile}`));
            }
          } else {
            console.log(chalk.dim(`  Would remove: ${oldFile}`));
            removedCount++;
          }
        }

        const action = options.dryRun ? 'Would compact' : 'Compacted';
        console.log(chalk.green(`\n✓ ${action} ${removedCount} scan file${removedCount === 1 ? '' : 's'} → keeping ${latestScanFile}`));
        console.log();
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  return compact;
}
