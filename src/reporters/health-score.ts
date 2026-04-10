/**
 * Health Score Calculator - Positive Evidence Metrics
 *
 * Calculates metrics that show value even when zero violations are found.
 * Focuses on "what DID pass" rather than just "what failed".
 */

import type { AuditRecord, EnhancedAuditRecord } from '../types.js';

export interface HealthMetrics {
  // Composite score (0-100)
  overallScore: number;

  // Component scores
  errorHandlingCompliance: number;  // % of checks that passed
  packageCoverage: number;           // % of packages with contracts
  codeMaturity: 'LOW' | 'MEDIUM' | 'HIGH';
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

  // Positive evidence
  checksPerformed: number;           // Total checks run
  checksPassed: number;              // Checks that passed
  checksPassedPercent: number;       // As percentage

  // Insights
  hasGlobalErrorHandlers: boolean;   // Detected positive patterns
  hasConsistentPatterns: boolean;    // Same error handling style throughout

  // Benchmarking (calculated separately)
  violationsPerKLOC?: number;        // Violations per 1,000 lines
}

/**
 * Calculate health score from audit record
 */
export function calculateHealthScore(
  audit: AuditRecord | EnhancedAuditRecord
): HealthMetrics {
  const totalChecks = audit.contracts_applied;
  const violations = audit.violations.length;
  const checksPassed = Math.max(0, totalChecks - violations);

  // Error handling compliance: What % of checks passed?
  const errorHandlingCompliance = totalChecks > 0
    ? (checksPassed / totalChecks) * 100
    : 100;

  // Package coverage: What % of packages have contracts?
  const enhanced = audit as EnhancedAuditRecord;
  const packageCoverage = enhanced.package_discovery
    ? (enhanced.package_discovery.withContracts / enhanced.package_discovery.total) * 100
    : 0;

  // Code maturity (based on error handling compliance)
  const codeMaturity = getCodeMaturity(errorHandlingCompliance);

  // Risk level (based on violation count and severity)
  const riskLevel = getRiskLevel(audit);

  // Overall composite score
  // Weighted: Error handling (70%), Package coverage (30%)
  // Clamp to 0 minimum in case violations > contracts (V2 counts contracts differently than V1)
  const overallScore = Math.max(0, (errorHandlingCompliance * 0.7) + (packageCoverage * 0.3));

  // Pattern detection (simplified for now)
  const hasGlobalErrorHandlers = detectGlobalErrorHandlers(audit);
  const hasConsistentPatterns = detectConsistentPatterns(audit);

  return {
    overallScore: Math.round(overallScore),
    errorHandlingCompliance: Math.round(errorHandlingCompliance),
    packageCoverage: Math.round(packageCoverage),
    codeMaturity,
    riskLevel,
    checksPerformed: totalChecks,
    checksPassed,
    checksPassedPercent: Math.round(errorHandlingCompliance),
    hasGlobalErrorHandlers,
    hasConsistentPatterns,
  };
}

/**
 * Determine code maturity level
 */
function getCodeMaturity(compliance: number): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (compliance >= 95) return 'HIGH';
  if (compliance >= 80) return 'MEDIUM';
  return 'LOW';
}

/**
 * Determine risk level based on violations
 */
function getRiskLevel(audit: AuditRecord): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  const errorCount = audit.violations.filter(v => v.severity === 'error').length;
  const warningCount = audit.violations.filter(v => v.severity === 'warning').length;

  // Risk matrix
  if (errorCount === 0 && warningCount === 0) return 'LOW';
  if (errorCount === 0 && warningCount < 5) return 'LOW';
  if (errorCount < 5) return 'MEDIUM';
  if (errorCount < 20) return 'HIGH';
  return 'CRITICAL';
}

/**
 * Detect if repo has global error handlers (positive pattern)
 *
 * This is a simplified heuristic - looks for common global error handling setups.
 * Future enhancement: Actually parse code to detect these patterns.
 */
function detectGlobalErrorHandlers(audit: AuditRecord): boolean {
  // Check for axios interceptors (positive pattern)
  const hasAxiosInterceptors = audit.violations.some(v =>
    v.package === 'axios' &&
    v.description.includes('interceptor')
  );

  // Check for global query cache handlers in React Query
  const hasReactQueryGlobalHandlers = audit.violations.some(v =>
    v.package === '@tanstack/react-query' &&
    v.description.includes('QueryCache')
  );

  // If we have many checks but few violations, likely has global handlers
  const hasHighCompliance = audit.contracts_applied > 50 && audit.violations.length < 5;

  return hasAxiosInterceptors || hasReactQueryGlobalHandlers || hasHighCompliance;
}

/**
 * Detect if error handling patterns are consistent (positive pattern)
 *
 * Simplified: If violations are low despite many checks, patterns are likely consistent.
 * Future: Analyze actual error handling code for style consistency.
 */
function detectConsistentPatterns(audit: AuditRecord): boolean {
  // If high compliance, patterns are likely consistent
  const checksPerformed = audit.contracts_applied;
  const violations = audit.violations.length;

  if (checksPerformed < 10) return false; // Too few to judge

  const complianceRate = (checksPerformed - violations) / checksPerformed;
  return complianceRate >= 0.90; // 90%+ compliance = consistent patterns
}

/**
 * Calculate violations per 1,000 lines of code (if LOC available)
 */
export function calculateViolationsPerKLOC(
  violations: number,
  linesOfCode: number
): number {
  if (linesOfCode === 0) return 0;
  return (violations / linesOfCode) * 1000;
}

/**
 * Format health score for display
 */
export function formatHealthScore(metrics: HealthMetrics): string {
  const scoreColor = getScoreColor(metrics.overallScore);
  const riskColor = getRiskColor(metrics.riskLevel);

  return `
Health Score: ${scoreColor}${metrics.overallScore}/100${resetColor()}
  • Error Handling Compliance: ${metrics.errorHandlingCompliance}%
  • Package Coverage: ${metrics.packageCoverage}%
  • Code Maturity: ${metrics.codeMaturity}
  • Risk Level: ${riskColor}${metrics.riskLevel}${resetColor()}
`;
}

/**
 * ANSI color helpers
 */
function getScoreColor(score: number): string {
  if (score >= 90) return '\x1b[32m'; // Green
  if (score >= 70) return '\x1b[33m'; // Yellow
  return '\x1b[31m'; // Red
}

function getRiskColor(risk: string): string {
  if (risk === 'LOW') return '\x1b[32m'; // Green
  if (risk === 'MEDIUM') return '\x1b[33m'; // Yellow
  if (risk === 'HIGH') return '\x1b[31m'; // Red
  return '\x1b[35m'; // Magenta for CRITICAL
}

function resetColor(): string {
  return '\x1b[0m';
}
