/**
 * Benchmarking System
 *
 * Calculates aggregate statistics from test corpus and compares repos against baseline.
 * Answers: "How does this repo compare to others?"
 */

import type { AuditRecord, EnhancedAuditRecord } from '../types.js';

export interface BenchmarkData {
  /** When this benchmark was calculated */
  calculated_at: string;
  /** Number of repos in the sample */
  sample_size: number;
  /** Average violations per repository */
  avg_violations_per_repo: number;
  /** Average violations per 1,000 LOC */
  avg_violations_per_kloc: number;
  /** Average error handling compliance (%) */
  avg_compliance_percent: number;
  /** Distribution percentiles */
  percentiles: {
    p25: number; // 25th percentile (violations count)
    p50: number; // Median
    p75: number; // 75th percentile
    p90: number; // 90th percentile
    p95: number; // 95th percentile
  };
  /** Total checks performed across all repos */
  total_checks_performed: number;
  /** Total violations found across all repos */
  total_violations_found: number;
}

export interface ComparisonMetrics {
  /** Your repo's violations */
  your_violations: number;
  /** Your repo's violations per KLOC */
  your_violations_per_kloc?: number;
  /** Your repo's compliance % */
  your_compliance_percent: number;
  /** Average violations in benchmark */
  avg_violations: number;
  /** Average violations per KLOC in benchmark */
  avg_violations_per_kloc: number;
  /** Your percentile ranking (0-100, higher = cleaner) */
  percentile_rank: number;
  /** Violations avoided vs average repo */
  violations_avoided: number;
  /** Descriptive comparison */
  comparison: 'Much Better' | 'Better' | 'Average' | 'Worse' | 'Much Worse';
}

/**
 * Calculate benchmark baseline from multiple audit records
 */
export function calculateBenchmark(auditRecords: AuditRecord[]): BenchmarkData {
  if (auditRecords.length === 0) {
    throw new Error('Cannot calculate benchmark from zero audit records');
  }

  const violationCounts = auditRecords.map(r => r.violations.length);
  const complianceRates = auditRecords.map(r => {
    const total = r.contracts_applied;
    const violations = r.violations.length;
    return total > 0 ? ((total - violations) / total) * 100 : 100;
  });

  const totalChecks = auditRecords.reduce((sum, r) => sum + r.contracts_applied, 0);
  const totalViolations = auditRecords.reduce((sum, r) => sum + r.violations.length, 0);

  // Calculate percentiles
  const sortedViolations = [...violationCounts].sort((a, b) => a - b);
  const percentiles = {
    p25: getPercentile(sortedViolations, 25),
    p50: getPercentile(sortedViolations, 50),
    p75: getPercentile(sortedViolations, 75),
    p90: getPercentile(sortedViolations, 90),
    p95: getPercentile(sortedViolations, 95),
  };

  // Average metrics
  const avgViolationsPerRepo = totalViolations / auditRecords.length;
  const avgCompliancePercent = complianceRates.reduce((a, b) => a + b, 0) / complianceRates.length;

  // For violations per KLOC, we'd need LOC data (Phase 2.1)
  // For now, estimate based on files analyzed
  const avgViolationsPerKloc = 0; // TODO: Calculate when LOC data available

  return {
    calculated_at: new Date().toISOString(),
    sample_size: auditRecords.length,
    avg_violations_per_repo: avgViolationsPerRepo,
    avg_violations_per_kloc: avgViolationsPerKloc,
    avg_compliance_percent: avgCompliancePercent,
    percentiles,
    total_checks_performed: totalChecks,
    total_violations_found: totalViolations,
  };
}

/**
 * Compare a repo against benchmark baseline
 */
export function compareAgainstBenchmark(
  audit: AuditRecord | EnhancedAuditRecord,
  benchmark: BenchmarkData
): ComparisonMetrics {
  const yourViolations = audit.violations.length;
  const yourChecks = audit.contracts_applied;
  const yourCompliancePercent = yourChecks > 0
    ? ((yourChecks - yourViolations) / yourChecks) * 100
    : 100;

  // Calculate percentile rank (what % of repos you're cleaner than)
  const percentileRank = calculatePercentileRank(yourViolations, benchmark);

  // Violations avoided vs average
  const violationsAvoided = Math.max(0, Math.round(benchmark.avg_violations_per_repo - yourViolations));

  // Descriptive comparison
  const comparison = getComparison(percentileRank);

  return {
    your_violations: yourViolations,
    your_compliance_percent: Math.round(yourCompliancePercent),
    avg_violations: Math.round(benchmark.avg_violations_per_repo),
    avg_violations_per_kloc: benchmark.avg_violations_per_kloc,
    percentile_rank: Math.round(percentileRank),
    violations_avoided: violationsAvoided,
    comparison,
  };
}

/**
 * Get percentile value from sorted array
 */
function getPercentile(sortedArray: number[], percentile: number): number {
  if (sortedArray.length === 0) return 0;
  const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
  return sortedArray[Math.max(0, index)];
}

/**
 * Calculate what percentile this repo is in (based on violation count)
 * Returns 0-100 where 100 = cleanest (fewest violations)
 */
function calculatePercentileRank(violations: number, benchmark: BenchmarkData): number {
  // Special case: if you have 0 violations and p25 is also 0, you're tied with top repos
  if (violations === 0 && benchmark.percentiles.p25 === 0) {
    return 100; // Perfect score - tied for cleanest
  }

  // If you have fewer violations than p25, you're in top 25%
  if (violations <= benchmark.percentiles.p25) {
    // Avoid division by zero
    if (benchmark.percentiles.p25 === 0) {
      return 75; // At the p25 mark
    }
    return 75 + (25 * (1 - violations / benchmark.percentiles.p25));
  }
  // If you have fewer violations than median, you're above 50th percentile
  else if (violations <= benchmark.percentiles.p50) {
    const range = benchmark.percentiles.p50 - benchmark.percentiles.p25;
    if (range === 0) {
      return 62.5; // Midpoint between p25 and p50
    }
    const position = violations - benchmark.percentiles.p25;
    return 50 + (25 * (1 - position / range));
  }
  // If you have fewer violations than p75, you're above 25th percentile
  else if (violations <= benchmark.percentiles.p75) {
    const range = benchmark.percentiles.p75 - benchmark.percentiles.p50;
    if (range === 0) {
      return 37.5; // Midpoint between p50 and p75
    }
    const position = violations - benchmark.percentiles.p50;
    return 25 + (25 * (1 - position / range));
  }
  // Otherwise, you're in bottom 25%
  else {
    const range = benchmark.percentiles.p95 - benchmark.percentiles.p75;
    if (range === 0) {
      return 12.5; // Bottom quartile
    }
    const position = Math.min(violations - benchmark.percentiles.p75, range);
    return 25 * (1 - position / range);
  }
}

/**
 * Get descriptive comparison based on percentile rank
 */
function getComparison(percentileRank: number): 'Much Better' | 'Better' | 'Average' | 'Worse' | 'Much Worse' {
  if (percentileRank >= 90) return 'Much Better';
  if (percentileRank >= 70) return 'Better';
  if (percentileRank >= 40) return 'Average';
  if (percentileRank >= 20) return 'Worse';
  return 'Much Worse';
}

/**
 * Format benchmarking results for display
 */
export function formatBenchmarkComparison(
  comparison: ComparisonMetrics,
  benchmark: BenchmarkData
): string {
  const lines: string[] = [];
  const green = '\x1b[32m';
  const cyan = '\x1b[36m';
  const reset = '\x1b[0m';

  lines.push(`${cyan}🏆 BENCHMARKING${reset}`);
  lines.push('─'.repeat(80));
  lines.push(`  Sample Size: ${benchmark.sample_size} repositories analyzed`);
  lines.push('');
  lines.push(`  Your Violations: ${comparison.your_violations}`);
  lines.push(`  Average Violations: ${comparison.avg_violations}`);
  lines.push('');

  if (comparison.violations_avoided > 0) {
    lines.push(`  ${green}✓${reset} You avoided ${comparison.violations_avoided} violations vs typical repo`);
  }

  lines.push('');
  lines.push(`  ${green}Your Ranking: Top ${100 - comparison.percentile_rank}%${reset}`);
  lines.push(`  Your repo is ${comparison.comparison.toLowerCase()} than ${comparison.percentile_rank}% of repos scanned.`);
  lines.push('');

  // Show percentile distribution
  lines.push('  Percentile Distribution:');
  lines.push(`    25th percentile: ${benchmark.percentiles.p25} violations`);
  lines.push(`    50th percentile: ${benchmark.percentiles.p50} violations (median)`);
  lines.push(`    75th percentile: ${benchmark.percentiles.p75} violations`);
  lines.push(`    90th percentile: ${benchmark.percentiles.p90} violations`);

  return lines.join('\n');
}

/**
 * Load benchmark data from file
 */
export async function loadBenchmark(benchmarkPath: string): Promise<BenchmarkData | null> {
  try {
    const { readFile } = await import('fs/promises');
    const data = await readFile(benchmarkPath, 'utf-8');
    return JSON.parse(data) as BenchmarkData;
  } catch {
    return null;
  }
}

/**
 * Save benchmark data to file
 */
export async function saveBenchmark(benchmark: BenchmarkData, benchmarkPath: string): Promise<void> {
  const { writeFile } = await import('fs/promises');
  await writeFile(benchmarkPath, JSON.stringify(benchmark, null, 2), 'utf-8');
}
