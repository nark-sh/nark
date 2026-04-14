/**
 * Positive Evidence Reporter
 *
 * Generates reports that show value even when zero violations are found.
 * Focus: "Here's what we checked and validated" vs "Here's what broke"
 */

import type { AuditRecord, EnhancedAuditRecord } from '../types.js';
import { calculateHealthScore, type HealthMetrics } from './health-score.js';
import {
  buildPackageBreakdown,
  formatPackageBreakdown,
  type PackageBreakdownSummary,
  getPassingPackages,
} from './package-breakdown.js';
import {
  compareAgainstBenchmark,
  formatBenchmarkComparison,
  loadBenchmark,
  type BenchmarkData,
  type ComparisonMetrics,
} from './benchmarking.js';

export interface PositiveEvidenceReportOptions {
  showHealthScore: boolean;
  showPackageBreakdown: boolean;
  showInsights: boolean;
  showRecommendations: boolean;
  showBenchmarking: boolean;
}

export interface PositiveEvidenceReport {
  healthMetrics: HealthMetrics;
  packageBreakdown: PackageBreakdownSummary;
  benchmarking?: ComparisonMetrics;
  insights: string[];
  recommendations: string[];
  formattedReport: string;
}

/**
 * Generate complete positive evidence report
 */
export async function generatePositiveEvidenceReport(
  audit: AuditRecord | EnhancedAuditRecord,
  options: PositiveEvidenceReportOptions = {
    showHealthScore: true,
    showPackageBreakdown: true,
    showInsights: true,
    showRecommendations: true,
    showBenchmarking: false, // Phase 2
  }
): Promise<PositiveEvidenceReport> {
  // Calculate metrics
  const healthMetrics = calculateHealthScore(audit);
  const packageBreakdown = buildPackageBreakdown(audit);

  // Load and compare against benchmark (if enabled)
  let benchmarking: ComparisonMetrics | undefined;
  let benchmark: BenchmarkData | undefined;

  if (options.showBenchmarking) {
    try {
      // Try to load benchmark from default location
      const path = await import('path');
      const url = await import('url');
      const __filename = url.fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const benchmarkPath = path.resolve(__dirname, '../../data/benchmarks.json');

      const loadedBenchmark = await loadBenchmark(benchmarkPath);
      if (loadedBenchmark) {
        benchmark = loadedBenchmark;
        benchmarking = compareAgainstBenchmark(audit, benchmark);
      }
    } catch {
      // Benchmark not available, skip
    }
  }

  // Generate insights (with benchmarking data if available)
  const insights = generateInsights(audit, healthMetrics, packageBreakdown, benchmarking);

  // Generate recommendations
  const recommendations = generateRecommendations(audit, healthMetrics, packageBreakdown);

  // Format complete report
  const formattedReport = formatPositiveEvidenceReport(
    audit,
    healthMetrics,
    packageBreakdown,
    insights,
    recommendations,
    options,
    benchmarking,
    benchmark
  );

  return {
    healthMetrics,
    packageBreakdown,
    benchmarking,
    insights,
    recommendations,
    formattedReport,
  };
}

/**
 * Format the complete positive evidence report
 */
function formatPositiveEvidenceReport(
  audit: AuditRecord | EnhancedAuditRecord,
  health: HealthMetrics,
  breakdown: PackageBreakdownSummary,
  insights: string[],
  recommendations: string[],
  options: PositiveEvidenceReportOptions,
  benchmarking?: ComparisonMetrics,
  benchmark?: BenchmarkData
): string {
  const lines: string[] = [];
  const green = '\x1b[32m';
  const yellow = '\x1b[33m';
  const cyan = '\x1b[36m';
  const bold = '\x1b[1m';
  const reset = '\x1b[0m';

  // Header
  lines.push('');
  lines.push('╔═══════════════════════════════════════════════════════════════════════════════╗');
  lines.push('║                         Nark Analysis Report                                  ║');
  lines.push('╚═══════════════════════════════════════════════════════════════════════════════╝');
  lines.push('');

  // Get repository name from tsconfig path
  const repoName = extractRepoName(audit.tsconfig);
  lines.push(`${bold}Repository:${reset} ${repoName}`);
  lines.push(`${bold}Analyzed:${reset} ${new Date(audit.timestamp).toLocaleString()}`);
  if (audit.git_commit) {
    lines.push(`${bold}Git Commit:${reset} ${audit.git_commit.substring(0, 8)}`);
  }
  if (audit.git_branch) {
    lines.push(`${bold}Git Branch:${reset} ${audit.git_branch}`);
  }
  lines.push('');

  // Health Score Section
  if (options.showHealthScore) {
    const scoreColor = getScoreColor(health.overallScore);
    lines.push(`${green}✅ CODE HEALTH SCORE: ${scoreColor}${health.overallScore}/100${reset}`);
    lines.push('');

    // Coverage Summary
    lines.push(`${cyan}📊 COVERAGE SUMMARY${reset}`);
    lines.push('─'.repeat(80));
    lines.push(`  • Files Analyzed: ${audit.files_analyzed}`);
    lines.push(`  • Call Sites Evaluated: ${health.checksPerformed}`);
    lines.push(`  • Contracts Applied: ${audit.contracts_applied}`);

    const violationColor = audit.violations.length === 0 ? green : yellow;
    const violationIcon = audit.violations.length === 0 ? '✓' : '!';
    lines.push(`  • Violations Found: ${violationColor}${audit.violations.length} ${violationIcon}${reset}`);
    lines.push(`  • Checks Passed: ${green}${health.checksPassed} ✓${reset}`);
    lines.push('');

    // Health Metrics
    lines.push(`${cyan}📈 REPOSITORY HEALTH METRICS${reset}`);
    lines.push('─'.repeat(80));
    lines.push(`  • Error Handling Compliance: ${health.errorHandlingCompliance}%`);
    lines.push(`  • Package Coverage: ${health.packageCoverage}%`);
    lines.push(`  • Code Maturity: ${health.codeMaturity}`);

    const riskColor = getRiskColor(health.riskLevel);
    lines.push(`  • Risk Level: ${riskColor}${health.riskLevel}${reset}`);
    lines.push('');
  }

  // Package Breakdown Section
  if (options.showPackageBreakdown) {
    lines.push(formatPackageBreakdown(breakdown));
    lines.push('');
  }

  // Benchmarking Section
  if (options.showBenchmarking && benchmarking && benchmark) {
    lines.push(formatBenchmarkComparison(benchmarking, benchmark));
    lines.push('');
  }

  // Insights Section
  if (options.showInsights && insights.length > 0) {
    lines.push(`${cyan}💡 INSIGHTS${reset}`);
    lines.push('─'.repeat(80));
    insights.forEach(insight => {
      lines.push(`  ${insight}`);
    });
    lines.push('');
  }

  // Recommendations Section
  if (options.showRecommendations && recommendations.length > 0) {
    lines.push(`${cyan}🎯 RECOMMENDATIONS${reset}`);
    lines.push('─'.repeat(80));
    recommendations.forEach((rec, idx) => {
      lines.push(`  ${idx + 1}. ${rec}`);
    });
    lines.push('');
  }

  // Footer
  lines.push('═'.repeat(80));
  lines.push(`  Report generated by Nark v${audit.tool_version}`);
  lines.push(`  Next scan: Enable CI integration for continuous monitoring`);
  lines.push('═'.repeat(80));
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate insights based on analysis
 */
function generateInsights(
  audit: AuditRecord | EnhancedAuditRecord,
  health: HealthMetrics,
  breakdown: PackageBreakdownSummary,
  benchmarking?: ComparisonMetrics
): string[] {
  const insights: string[] = [];
  const green = '\x1b[32m';
  const yellow = '\x1b[33m';
  const reset = '\x1b[0m';

  // Perfect score insight
  if (health.errorHandlingCompliance === 100) {
    insights.push(`${green}✓${reset} Perfect score! All ${health.checksPerformed} call sites follow best practices.`);
  }

  // High compliance insight
  else if (health.errorHandlingCompliance >= 95) {
    insights.push(`${green}✓${reset} Excellent compliance (${health.errorHandlingCompliance}%) - only ${audit.violations.length} issues found in ${health.checksPerformed} call sites.`);
  }

  // Passing packages insight
  const passingPackages = getPassingPackages(breakdown);
  if (passingPackages.length > 0) {
    const topPassing = passingPackages.slice(0, 3).map(p => p.packageName).join(', ');
    insights.push(`${green}✓${reset} ${passingPackages.length} packages have zero violations (${topPassing}${passingPackages.length > 3 ? ', ...' : ''}).`);
  }

  // Global error handlers insight
  if (health.hasGlobalErrorHandlers) {
    insights.push(`${green}✓${reset} Global error handling patterns detected - shows architectural maturity.`);
  }

  // Consistent patterns insight
  if (health.hasConsistentPatterns) {
    insights.push(`${green}✓${reset} Consistent error handling patterns throughout codebase.`);
  }

  // Package coverage insight
  const enhanced = audit as EnhancedAuditRecord;
  if (enhanced.package_discovery) {
    const uncoveredCount = enhanced.package_discovery.withoutContracts;
    if (uncoveredCount > 0) {
      insights.push(`${yellow}!${reset} ${uncoveredCount} packages don't have contracts yet - coverage opportunity for future scans.`);
    }
  }

  // Add volume insight (shows we did real work)
  if (health.checksPerformed > 100) {
    insights.push(`${green}✓${reset} Evaluated ${health.checksPerformed} call sites across ${audit.files_analyzed} files - comprehensive coverage.`);
  }

  // Benchmarking insight
  if (benchmarking) {
    if (benchmarking.percentile_rank >= 75) {
      insights.push(`${green}✓${reset} Your code is cleaner than ${benchmarking.percentile_rank}% of repos analyzed (${benchmarking.comparison.toLowerCase()}).`);
    }
    if (benchmarking.violations_avoided > 0) {
      insights.push(`${green}✓${reset} Avoided ${benchmarking.violations_avoided} violations compared to average repo.`);
    }
  }

  return insights;
}

/**
 * Generate actionable recommendations
 */
function generateRecommendations(
  audit: AuditRecord | EnhancedAuditRecord,
  health: HealthMetrics,
  _breakdown: PackageBreakdownSummary
): string[] {
  const recommendations: string[] = [];

  // Perfect code recommendations
  if (audit.violations.length === 0) {
    recommendations.push('Add Nark badge to your README to showcase code quality');
    recommendations.push('Integrate with CI/CD to maintain these standards as the team scales');
    recommendations.push('Share this report with your team to celebrate excellent code quality');
  }

  // Some violations recommendations
  else if (audit.violations.length < 10) {
    recommendations.push(`Fix ${audit.violations.length} remaining violations to achieve 100% compliance`);
    recommendations.push('Run scan after fixes to verify improvements');
    recommendations.push('Add to CI to prevent future violations');
  }

  // Many violations recommendations
  else {
    recommendations.push('Prioritize fixing ERROR-level violations first (production risk)');
    recommendations.push('Consider fixing violations package-by-package for manageable progress');
    recommendations.push('Review error handling patterns with team to establish standards');
  }

  // Package coverage recommendations
  const enhanced = audit as EnhancedAuditRecord;
  if (enhanced.package_discovery && enhanced.package_discovery.withoutContracts > 5) {
    recommendations.push(`Request contracts for your most-used packages (${enhanced.package_discovery.withoutContracts} uncovered)`);
  }

  // Growth recommendations
  if (health.checksPerformed > 500) {
    recommendations.push('Consider automated scanning on every PR for this large codebase');
  }

  return recommendations;
}

/**
 * Extract repository name from tsconfig path
 */
function extractRepoName(tsconfigPath: string): string {
  // Extract from path like: /Users/.../test-repos/Next-js-Boilerplate/tsconfig.json
  const parts = tsconfigPath.split('/');
  const repoIndex = parts.findIndex(p => p === 'test-repos') + 1;

  if (repoIndex > 0 && repoIndex < parts.length) {
    return parts[repoIndex];
  }

  // Fallback: get parent directory
  return parts[parts.length - 2] || 'Unknown Repository';
}

/**
 * Get color for score
 */
function getScoreColor(score: number): string {
  if (score >= 90) return '\x1b[32m'; // Green
  if (score >= 70) return '\x1b[33m'; // Yellow
  return '\x1b[31m'; // Red
}

/**
 * Get color for risk level
 */
function getRiskColor(risk: string): string {
  if (risk === 'LOW') return '\x1b[32m'; // Green
  if (risk === 'MEDIUM') return '\x1b[33m'; // Yellow
  if (risk === 'HIGH') return '\x1b[31m'; // Red
  return '\x1b[35m'; // Magenta for CRITICAL
}

/**
 * Print positive evidence report to console
 */
export async function printPositiveEvidenceReport(
  audit: AuditRecord | EnhancedAuditRecord,
  options?: PositiveEvidenceReportOptions
): Promise<void> {
  const report = await generatePositiveEvidenceReport(audit, options);
  console.log(report.formattedReport);
}

/**
 * Write positive evidence report to file
 */
export async function writePositiveEvidenceReport(
  audit: AuditRecord | EnhancedAuditRecord,
  outputPath: string,
  options?: PositiveEvidenceReportOptions
): Promise<void> {
  const { writeFile } = await import('fs/promises');
  const report = await generatePositiveEvidenceReport(audit, options);
  await writeFile(outputPath, report.formattedReport, 'utf-8');
}

/**
 * Format positive evidence report as Markdown
 */
function formatPositiveEvidenceReportMarkdown(
  audit: AuditRecord | EnhancedAuditRecord,
  health: HealthMetrics,
  breakdown: PackageBreakdownSummary,
  insights: string[],
  recommendations: string[],
  options: PositiveEvidenceReportOptions,
  benchmarking?: ComparisonMetrics,
  benchmark?: BenchmarkData
): string {
  const lines: string[] = [];

  // Header
  lines.push('# Nark Analysis Report');
  lines.push('');

  // Get repository name from tsconfig path
  const repoName = extractRepoName(audit.tsconfig);
  lines.push(`**Repository:** ${repoName}`);
  lines.push(`**Analyzed:** ${new Date(audit.timestamp).toLocaleString()}`);
  if (audit.git_commit) {
    lines.push(`**Git Commit:** \`${audit.git_commit.substring(0, 8)}\``);
  }
  if (audit.git_branch) {
    lines.push(`**Git Branch:** ${audit.git_branch}`);
  }
  lines.push('');

  // Health Score Section
  if (options.showHealthScore) {
    lines.push(`## ✅ Code Health Score: ${health.overallScore}/100`);
    lines.push('');

    // Coverage Summary
    lines.push('### 📊 Coverage Summary');
    lines.push('');
    lines.push(`- **Files Analyzed:** ${audit.files_analyzed}`);
    lines.push(`- **Call Sites Evaluated:** ${health.checksPerformed}`);
    lines.push(`- **Contracts Applied:** ${audit.contracts_applied}`);
    lines.push(`- **Violations Found:** ${audit.violations.length}`);
    lines.push(`- **Checks Passed:** ${health.checksPassed} ✓`);
    lines.push('');

    // Health Metrics
    lines.push('### 📈 Repository Health Metrics');
    lines.push('');
    lines.push(`- **Error Handling Compliance:** ${health.errorHandlingCompliance}%`);
    lines.push(`- **Package Coverage:** ${health.packageCoverage}%`);
    lines.push(`- **Code Maturity:** ${health.codeMaturity}`);
    lines.push(`- **Risk Level:** ${health.riskLevel}`);
    lines.push('');
  }

  // Violations by Package Section
  if (options.showPackageBreakdown) {
    lines.push('## 📦 Violations by Package');
    lines.push('');

    const failingPkgs = breakdown.packages.filter(p => p.violationsFound > 0);

    if (failingPkgs.length === 0) {
      lines.push('All packages compliant — no violations found.');
    } else {
      lines.push('| Package | Violations | Breakdown |');
      lines.push('|---------|------------|-----------|');

      failingPkgs.forEach(pkg => {
        const parts = [];
        if (pkg.violationBreakdown.errors > 0) parts.push(`${pkg.violationBreakdown.errors} errors`);
        if (pkg.violationBreakdown.warnings > 0) parts.push(`${pkg.violationBreakdown.warnings} warnings`);
        if (pkg.violationBreakdown.info > 0) parts.push(`${pkg.violationBreakdown.info} info`);
        lines.push(`| ${pkg.packageName} | ${pkg.violationsFound} | ${parts.join(', ')} |`);
      });
    }

    lines.push('');
    lines.push(`**Summary:** ${breakdown.packagesWithContracts} packages checked, ${breakdown.packagesFullyCompliant} compliant, ${breakdown.packagesWithViolations} with violations`);
    lines.push('');
  }

  // Benchmarking Section
  if (options.showBenchmarking && benchmarking && benchmark) {
    lines.push('## 🏆 Benchmarking');
    lines.push('');
    lines.push(`**Sample Size:** ${benchmark.sample_size} repositories analyzed`);
    lines.push('');
    lines.push(`- **Your Violations:** ${benchmarking.your_violations}`);
    lines.push(`- **Average Violations:** ${benchmarking.avg_violations}`);
    lines.push('');

    if (benchmarking.violations_avoided > 0) {
      lines.push(`✓ You avoided **${benchmarking.violations_avoided} violations** vs typical repo`);
      lines.push('');
    }

    lines.push(`**Your Ranking:** Top ${100 - benchmarking.percentile_rank}%`);
    lines.push('');
    lines.push(`Your repo is **${benchmarking.comparison.toLowerCase()}** than ${benchmarking.percentile_rank}% of repos scanned.`);
    lines.push('');

    // Show percentile distribution
    lines.push('### Percentile Distribution');
    lines.push('');
    lines.push('| Percentile | Violations |');
    lines.push('|------------|------------|');
    lines.push(`| 25th | ${benchmark.percentiles.p25} |`);
    lines.push(`| 50th (median) | ${benchmark.percentiles.p50} |`);
    lines.push(`| 75th | ${benchmark.percentiles.p75} |`);
    lines.push(`| 90th | ${benchmark.percentiles.p90} |`);
    lines.push('');
  }

  // Insights Section
  if (options.showInsights && insights.length > 0) {
    lines.push('## 💡 Insights');
    lines.push('');
    // Strip ANSI codes from insights
    insights.forEach(insight => {
      const clean = insight.replace(/\x1b\[\d+m/g, '');
      lines.push(`- ${clean}`);
    });
    lines.push('');
  }

  // Recommendations Section
  if (options.showRecommendations && recommendations.length > 0) {
    lines.push('## 🎯 Recommendations');
    lines.push('');
    recommendations.forEach((rec, idx) => {
      lines.push(`${idx + 1}. ${rec}`);
    });
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push('');
  lines.push(`*Report generated by Nark v${audit.tool_version}*`);
  lines.push('');
  lines.push('*Next scan: Enable CI integration for continuous monitoring*');
  lines.push('');

  return lines.join('\n');
}

/**
 * Write positive evidence report to file as Markdown
 */
export async function writePositiveEvidenceReportMarkdown(
  audit: AuditRecord | EnhancedAuditRecord,
  outputPath: string,
  options?: PositiveEvidenceReportOptions
): Promise<void> {
  const { writeFile } = await import('fs/promises');

  // Generate the report data (includes loading benchmark if enabled)
  const report = await generatePositiveEvidenceReport(audit, options);

  // Load benchmark data separately for formatting (if benchmarking is enabled)
  let benchmark: BenchmarkData | undefined;
  if (options?.showBenchmarking !== false && report.benchmarking) {
    benchmark = await loadBenchmarkForMarkdown();
  }

  // Format as markdown
  const markdownContent = formatPositiveEvidenceReportMarkdown(
    audit,
    report.healthMetrics,
    report.packageBreakdown,
    report.insights,
    report.recommendations,
    options || {
      showHealthScore: true,
      showPackageBreakdown: true,
      showInsights: true,
      showRecommendations: true,
      showBenchmarking: true,
    },
    report.benchmarking,
    benchmark
  );

  await writeFile(outputPath, markdownContent, 'utf-8');
}

/**
 * Helper to load benchmark for markdown formatting
 */
async function loadBenchmarkForMarkdown(): Promise<BenchmarkData | undefined> {
  try {
    const path = await import('path');
    const url = await import('url');
    const __filename = url.fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const benchmarkPath = path.resolve(__dirname, '../../data/benchmarks.json');
    const loadedBenchmark = await loadBenchmark(benchmarkPath);
    return loadedBenchmark || undefined;
  } catch {
    return undefined;
  }
}
