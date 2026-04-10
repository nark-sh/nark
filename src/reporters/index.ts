/**
 * Reporters Module - Positive Evidence Reporting
 *
 * Export all reporting functionality for external use
 */

export {
  calculateHealthScore,
  calculateViolationsPerKLOC,
  formatHealthScore,
  type HealthMetrics,
} from './health-score.js';

export {
  buildPackageBreakdown,
  formatPackageBreakdown,
  getTopPackages,
  getFailingPackages,
  getPassingPackages,
  type PackageUsageStats,
  type PackageBreakdownSummary,
} from './package-breakdown.js';

export {
  calculateBenchmark,
  compareAgainstBenchmark,
  formatBenchmarkComparison,
  loadBenchmark,
  saveBenchmark,
  type BenchmarkData,
  type ComparisonMetrics,
} from './benchmarking.js';

export {
  generatePositiveEvidenceReport,
  printPositiveEvidenceReport,
  writePositiveEvidenceReport,
  writePositiveEvidenceReportMarkdown,
  type PositiveEvidenceReportOptions,
  type PositiveEvidenceReport,
} from './positive-evidence.js';

export {
  generateD3Dashboard,
  writeD3Visualization,
  type D3VisualizationData,
} from './d3-visualizer.js';
