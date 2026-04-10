/**
 * Reporter - generates audit records and terminal output
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import chalk from "chalk";
import { fileURLToPath } from "url";
import type {
  AuditRecord,
  Violation,
  VerificationSummary,
  EnhancedAuditRecord,
  PackageDiscoveryResult,
} from "./types.js";
import {
  extractCodeSnippet,
  formatSnippetForJSON,
  formatSnippetForTerminal,
} from "./code-snippet.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOOL_NAME = "nark";

// Read version from package.json dynamically
function getToolVersion(): string {
  try {
    // When running from dist/, __dirname is dist/, so go up one level to nark root
    const packageJsonPath = path.join(__dirname, "../package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    return packageJson.version;
  } catch (error) {
    return "0.0.0"; // Fallback if package.json can't be read
  }
}

const TOOL_VERSION = getToolVersion();

/**
 * Enriches violations with code snippets
 */
export async function enrichViolationsWithSnippets(
  violations: Violation[],
): Promise<Violation[]> {
  const enrichedViolations: Violation[] = [];

  for (const violation of violations) {
    const snippet = await extractCodeSnippet(violation.file, violation.line, 4);

    if (snippet) {
      enrichedViolations.push({
        ...violation,
        code_snippet: formatSnippetForJSON(snippet),
      });
    } else {
      enrichedViolations.push(violation);
    }
  }

  return enrichedViolations;
}

/**
 * Generates an audit record from violations
 */
export async function generateAuditRecord(
  violations: Violation[],
  config: {
    tsconfigPath: string;
    packagesAnalyzed: string[];
    contractsApplied: number;
    filesAnalyzed: number;
    corpusVersion: string;
  },
): Promise<AuditRecord> {
  // Enrich violations with code snippets
  const enrichedViolations = await enrichViolationsWithSnippets(violations);

  const summary = generateSummary(enrichedViolations, config.filesAnalyzed);

  const repoRoot = path.dirname(path.resolve(config.tsconfigPath));
  const record: AuditRecord = {
    tool: TOOL_NAME,
    tool_version: TOOL_VERSION,
    corpus_version: config.corpusVersion,
    timestamp: new Date().toISOString(),
    git_commit: getGitCommit(),
    git_branch: getGitBranch(),
    git_dirty: isWorkingTreeDirty(repoRoot),
    tsconfig: config.tsconfigPath,
    packages_analyzed: config.packagesAnalyzed,
    contracts_applied: config.contractsApplied,
    files_analyzed: config.filesAnalyzed,
    violations: enrichedViolations,
    summary,
  };

  return record;
}

/**
 * Generates summary statistics
 */
function generateSummary(
  violations: Violation[],
  filesAnalyzed: number,
): VerificationSummary {
  const errorCount = violations.filter((v) => v.severity === "error").length;
  const warningCount = violations.filter(
    (v) => v.severity === "warning",
  ).length;
  const infoCount = violations.filter((v) => v.severity === "info").length;

  return {
    total_violations: violations.length,
    error_count: errorCount,
    warning_count: warningCount,
    info_count: infoCount,
    files_analyzed: filesAnalyzed,
    passed: errorCount === 0,
  };
}

/**
 * Gets current git commit hash
 */
function getGitCommit(): string | undefined {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Returns true if the working tree at repoRoot has uncommitted changes.
 * Returns false if git is unavailable or the path is not a git repo.
 */
export function isWorkingTreeDirty(repoRoot: string): boolean {
  try {
    const out = execSync("git status --porcelain", {
      cwd: repoRoot,
      stdio: "pipe",
      encoding: "utf-8",
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Gets current git branch
 */
function getGitBranch(): string | undefined {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf-8",
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Writes audit record to JSON file
 */
export function writeAuditRecord(
  record: AuditRecord,
  outputPath: string,
): void {
  const json = JSON.stringify(record, null, 2);
  fs.writeFileSync(outputPath, json, "utf-8");
}

/**
 * Prints violations to terminal in human-readable format
 */
export function printTerminalReport(record: AuditRecord): void {
  console.log("\n" + chalk.bold("Behavioral Contract Verification Report"));
  console.log(chalk.gray("─".repeat(80)));

  // Summary
  console.log(`\n${chalk.bold("Summary:")}`);
  console.log(`  Files analyzed: ${record.files_analyzed}`);
  console.log(`  Packages: ${record.packages_analyzed.join(", ")}`);
  console.log(`  Contracts applied: ${record.contracts_applied}`);
  console.log(`  Timestamp: ${record.timestamp}`);

  if (record.git_commit) {
    const dirtyFlag = record.git_dirty ? " (dirty)" : "";
    console.log(`  Git commit: ${record.git_commit.substring(0, 8)}${dirtyFlag}`);
  }
  if (record.git_branch) {
    console.log(`  Git branch: ${record.git_branch}`);
  }

  // Violations
  if (record.violations.length === 0) {
    console.log(`\n${chalk.green("✓")} ${chalk.bold("No violations found!")}`);
    console.log(chalk.gray("─".repeat(80)) + "\n");
    return;
  }

  console.log(`\n${chalk.bold("Violations:")}`);

  // Group violations by severity
  const errors = record.violations.filter((v) => v.severity === "error");
  const warnings = record.violations.filter((v) => v.severity === "warning");
  const infos = record.violations.filter((v) => v.severity === "info");

  if (errors.length > 0) {
    console.log(`\n${chalk.red.bold(`Errors (${errors.length}):`)}`);
    errors.forEach((v) => printViolation(v));
  }

  if (warnings.length > 0) {
    console.log(`\n${chalk.yellow.bold(`Warnings (${warnings.length}):`)}`);
    warnings.forEach((v) => printViolation(v));
  }

  if (infos.length > 0) {
    console.log(`\n${chalk.blue.bold(`Info (${infos.length}):`)}`);
    infos.forEach((v) => printViolation(v));
  }

  // Summary stats
  console.log(chalk.gray("\n─".repeat(80)));
  console.log(chalk.bold("\nSummary:"));
  console.log(`  Total violations: ${record.summary.total_violations}`);
  console.log(`  ${chalk.red("Errors")}: ${record.summary.error_count}`);
  console.log(`  ${chalk.yellow("Warnings")}: ${record.summary.warning_count}`);
  console.log(`  ${chalk.blue("Info")}: ${record.summary.info_count}`);

  const statusIcon = record.summary.passed ? chalk.green("✓") : chalk.red("✗");
  const statusText = record.summary.passed
    ? chalk.green("PASSED")
    : chalk.red("FAILED");
  console.log(`\n${statusIcon} ${statusText}\n`);
}

/**
 * Prints a single violation
 */
function printViolation(violation: Violation): void {
  const icon = getSeverityIcon(violation.severity);
  const color = getSeverityColor(violation.severity);

  const relPath = path.relative(process.cwd(), violation.file);
  const location = `${relPath}:${violation.line}:${violation.column}`;

  console.log(`\n  ${icon} ${color(location)}`);
  console.log(`    ${chalk.bold(violation.description)}`);
  console.log(`    Package: ${violation.package}.${violation.function}()`);
  console.log(`    Contract: ${violation.contract_clause}`);

  // Show code snippet if available
  if (violation.code_snippet) {
    console.log("");
    const snippet = {
      startLine: violation.code_snippet.startLine,
      endLine: violation.code_snippet.endLine,
      lines: violation.code_snippet.lines.map((l) => ({
        lineNumber: l.line,
        content: l.content,
        isViolation: l.highlighted,
      })),
    };
    const formattedLines = formatSnippetForTerminal(snippet, 100);
    for (const line of formattedLines) {
      if (line.startsWith(">")) {
        console.log(`    ${chalk.red(line)}`);
      } else {
        console.log(`    ${chalk.dim(line)}`);
      }
    }
  }

  if (violation.subViolations && violation.subViolations.length > 0) {
    console.log(`    ${chalk.dim("Also fix in same handler:")}`);
    for (const sv of violation.subViolations) {
      const svColor = sv.severity === "error" ? chalk.red : chalk.yellow;
      console.log(`      ${svColor("↳")} ${chalk.dim(sv.description)}`);
    }
  }

  if (violation.suggested_fix) {
    console.log(
      `    ${chalk.dim("Fix:")} ${violation.suggested_fix.split("\n")[0]}`,
    );
  }

  console.log(`    ${chalk.dim("Docs:")} ${violation.source_doc}`);
}

/**
 * Gets the icon for a severity level
 */
function getSeverityIcon(severity: string): string {
  switch (severity) {
    case "error":
      return chalk.red("✗");
    case "warning":
      return chalk.yellow("⚠");
    case "info":
      return chalk.blue("ℹ");
    default:
      return "•";
  }
}

/**
 * Gets the color function for a severity level
 */
function getSeverityColor(severity: string): (text: string) => string {
  switch (severity) {
    case "error":
      return chalk.red;
    case "warning":
      return chalk.yellow;
    case "info":
      return chalk.blue;
    default:
      return chalk.white;
  }
}

/**
 * Prints corpus loading errors
 */
export function printCorpusErrors(errors: string[]): void {
  console.error(chalk.red.bold("\nCorpus Loading Errors:"));
  errors.forEach((err) => {
    console.error(chalk.red(`  ✗ ${err}`));
  });
  console.error("");
}

/**
 * Generates an enhanced audit record with package discovery
 */
export function generateEnhancedAuditRecord(
  baseRecord: AuditRecord,
  packageDiscovery: PackageDiscoveryResult,
): EnhancedAuditRecord {
  // Group violations by package
  const violationsByPackage: Record<
    string,
    {
      total: number;
      errors: number;
      warnings: number;
      info: number;
      violations: Violation[];
    }
  > = {};

  for (const violation of baseRecord.violations) {
    if (!violationsByPackage[violation.package]) {
      violationsByPackage[violation.package] = {
        total: 0,
        errors: 0,
        warnings: 0,
        info: 0,
        violations: [],
      };
    }

    const group = violationsByPackage[violation.package];
    group.total++;
    group.violations.push(violation);

    if (violation.severity === "error") group.errors++;
    else if (violation.severity === "warning") group.warnings++;
    else if (violation.severity === "info") group.info++;
  }

  return {
    ...baseRecord,
    package_discovery: packageDiscovery,
    violations_by_package: violationsByPackage,
  };
}

/**
 * Prints package discovery report
 */
export function printPackageDiscoveryReport(
  discovery: PackageDiscoveryResult,
): void {
  const coveragePercent =
    discovery.total > 0
      ? ((discovery.withContracts / discovery.total) * 100).toFixed(1)
      : "0.0";

  console.log("\n" + chalk.bold("Package Discovery & Coverage"));
  console.log(chalk.gray("─".repeat(80)));
  console.log(`\n  Total packages: ${discovery.total}`);
  console.log(
    `  Packages with contracts: ${chalk.green(discovery.withContracts)} (${coveragePercent}%)`,
  );
  console.log(
    `  Packages without contracts: ${chalk.yellow(discovery.withoutContracts)}`,
  );

  if (discovery.withContracts > 0) {
    console.log(`\n  ${chalk.green("✓")} Packages with contracts:`);
    for (const pkg of discovery.packages.filter((p) => p.hasContract)) {
      console.log(
        `    ${pkg.name}@${pkg.version} ${chalk.dim(`(contract v${pkg.contractVersion})`)}`,
      );
    }
  }

  if (discovery.withoutContracts > 0 && discovery.withoutContracts <= 20) {
    console.log(`\n  ${chalk.yellow("⚠")} Packages without contracts:`);
    for (const pkg of discovery.packages.filter((p) => !p.hasContract)) {
      const usageInfo =
        pkg.usedIn.length > 0
          ? chalk.dim(` (used in ${pkg.usedIn.length} files)`)
          : "";
      console.log(`    ${pkg.name}@${pkg.version}${usageInfo}`);
    }
  } else if (discovery.withoutContracts > 20) {
    console.log(
      `\n  ${chalk.yellow("⚠")} Packages without contracts (showing top 20):`,
    );
    for (const pkg of discovery.packages
      .filter((p) => !p.hasContract)
      .slice(0, 20)) {
      const usageInfo =
        pkg.usedIn.length > 0
          ? chalk.dim(` (used in ${pkg.usedIn.length} files)`)
          : "";
      console.log(`    ${pkg.name}@${pkg.version}${usageInfo}`);
    }
    console.log(
      `    ${chalk.dim(`... and ${discovery.withoutContracts - 20} more`)}`,
    );
  }

  console.log("");
}

/**
 * Prints enhanced terminal report with violations grouped by package
 */
export function printEnhancedTerminalReport(record: EnhancedAuditRecord): void {
  console.log("\n" + chalk.bold("Behavioral Contract Verification Report"));
  console.log(chalk.gray("─".repeat(80)));

  // Summary
  console.log(`\n${chalk.bold("Summary:")}`);
  console.log(`  Files analyzed: ${record.files_analyzed}`);
  console.log(`  Contracts applied: ${record.contracts_applied}`);
  console.log(`  Timestamp: ${record.timestamp}`);

  if (record.git_commit) {
    const dirtyFlag = record.git_dirty ? " (dirty)" : "";
    console.log(`  Git commit: ${record.git_commit.substring(0, 8)}${dirtyFlag}`);
  }
  if (record.git_branch) {
    console.log(`  Git branch: ${record.git_branch}`);
  }

  // Package discovery
  printPackageDiscoveryReport(record.package_discovery);

  // Violations grouped by package
  if (record.violations.length === 0) {
    console.log(`${chalk.green("✓")} ${chalk.bold("No violations found!")}`);
    console.log(chalk.gray("─".repeat(80)) + "\n");
    return;
  }

  console.log(chalk.bold("Violations by Package"));
  console.log(chalk.gray("─".repeat(80)));

  const packageNames = Object.keys(record.violations_by_package).sort();

  for (const packageName of packageNames) {
    const group = record.violations_by_package[packageName];
    console.log(
      `\n${chalk.bold.cyan(packageName)} ${chalk.dim(`(${group.total} violations)`)}`,
    );
    console.log(
      `  Errors: ${chalk.red(group.errors)} | Warnings: ${chalk.yellow(group.warnings)} | Info: ${chalk.blue(group.info)}`,
    );

    // Show first 5 violations for this package
    const displayCount = Math.min(5, group.violations.length);
    for (let i = 0; i < displayCount; i++) {
      printViolation(group.violations[i]);
    }

    if (group.violations.length > displayCount) {
      console.log(
        `\n    ${chalk.dim(`... and ${group.violations.length - displayCount} more violations in this package`)}`,
      );
    }
  }

  // Summary stats
  console.log(chalk.gray("\n" + "─".repeat(80)));
  console.log(chalk.bold("\nOverall Summary:"));
  console.log(`  Total violations: ${record.summary.total_violations}`);
  console.log(`  ${chalk.red("Errors")}: ${record.summary.error_count}`);
  console.log(`  ${chalk.yellow("Warnings")}: ${record.summary.warning_count}`);
  console.log(`  ${chalk.blue("Info")}: ${record.summary.info_count}`);

  const statusIcon = record.summary.passed ? chalk.green("✓") : chalk.red("✗");
  const statusText = record.summary.passed
    ? chalk.green("PASSED")
    : chalk.red("FAILED");
  console.log(`\n${statusIcon} ${statusText}\n`);
}
