/**
 * Package Breakdown Analyzer
 *
 * Shows per-package violation breakdown. Only displays packages with violations
 * to avoid misleading pass-rate numbers when real call site counts aren't tracked.
 * Clean packages are reported as a summary count.
 */

import type { AuditRecord, EnhancedAuditRecord, Violation } from '../types.js';

export interface PackageUsageStats {
  packageName: string;
  contractsApplied: number;     // Estimated checks for this package
  isEstimated: boolean;         // true when contractsApplied is a proportional estimate
  violationsFound: number;      // Issues discovered
  checksPassedCount: number;    // Calculated: applied - violations
  status: 'PASS' | 'FAIL';      // PASS = zero violations
  compliancePercent: number;    // % of checks that passed
  violationBreakdown: {
    errors: number;
    warnings: number;
    info: number;
  };
}

export interface PackageBreakdownSummary {
  packages: PackageUsageStats[];
  totalPackagesAnalyzed: number;
  packagesWithContracts: number;
  packagesWithViolations: number;
  packagesFullyCompliant: number;  // Zero violations
}

/**
 * Build package breakdown from audit record
 */
export function buildPackageBreakdown(
  audit: AuditRecord | EnhancedAuditRecord
): PackageBreakdownSummary {
  // Group violations by package
  const violationsByPackage = groupViolationsByPackage(audit.violations);

  // Get list of all packages analyzed (with contracts)
  const packagesWithContracts = getPackagesWithContracts(audit);

  // Also include packages that appear only in violations (e.g. undici mapped from fetch())
  const missingViolationPkgs = Array.from(violationsByPackage.keys())
    .filter(p => !packagesWithContracts.includes(p));
  const allPackages = [...packagesWithContracts, ...missingViolationPkgs];

  // Build stats for each package
  const packages: PackageUsageStats[] = allPackages.map(pkgName => {
    const violations = violationsByPackage.get(pkgName) || [];

    // Use real call site count from analyzer when available
    const realCount = audit.callsites_by_package?.[pkgName];
    const isEstimated = realCount === undefined;
    const contractsApplied = isEstimated
      ? estimateContractsForPackage(pkgName, audit, violations)
      : realCount;

    const checksPassedCount = contractsApplied - violations.length;
    const compliancePercent = contractsApplied > 0
      ? (checksPassedCount / contractsApplied) * 100
      : 100;

    const violationBreakdown = {
      errors: violations.filter(v => v.severity === 'error').length,
      warnings: violations.filter(v => v.severity === 'warning').length,
      info: violations.filter(v => v.severity === 'info').length,
    };

    return {
      packageName: pkgName,
      contractsApplied,
      isEstimated,
      violationsFound: violations.length,
      checksPassedCount,
      status: violations.length === 0 ? 'PASS' : 'FAIL',
      compliancePercent: Math.round(compliancePercent),
      violationBreakdown,
    };
  });

  // Sort by most checks applied (most interesting packages first)
  packages.sort((a, b) => b.contractsApplied - a.contractsApplied);

  const packagesWithViolations = packages.filter(p => p.violationsFound > 0).length;
  const packagesFullyCompliant = packages.filter(p => p.violationsFound === 0).length;

  return {
    packages,
    totalPackagesAnalyzed: audit.packages_analyzed.length,
    packagesWithContracts: allPackages.length,
    packagesWithViolations,
    packagesFullyCompliant,
  };
}

/**
 * Group violations by package name
 */
function groupViolationsByPackage(violations: Violation[]): Map<string, Violation[]> {
  const grouped = new Map<string, Violation[]>();

  for (const violation of violations) {
    const pkgName = violation.package;
    if (!grouped.has(pkgName)) {
      grouped.set(pkgName, []);
    }
    grouped.get(pkgName)!.push(violation);
  }

  return grouped;
}

/**
 * Get list of packages that have contracts (were actually analyzed)
 */
function getPackagesWithContracts(audit: AuditRecord | EnhancedAuditRecord): string[] {
  const enhanced = audit as EnhancedAuditRecord;

  // If we have package discovery data, use it
  if (enhanced.package_discovery) {
    return enhanced.package_discovery.packages
      .filter(p => p.hasContract)
      .map(p => p.name);
  }

  // Fallback: Get unique packages from violations + packages_analyzed
  // (packages_analyzed includes all packages checked, even those with no violations)
  // Filter to only packages we actually have contracts for
  // (heuristic: if in packages_analyzed list, we have a contract)
  return audit.packages_analyzed.filter(pkg => pkg !== '');
}

/**
 * Estimate contracts applied for a specific package
 *
 * This is approximate - exact tracking requires analyzer to count each check.
 * For now, we estimate based on:
 * 1. Number of violations found (minimum)
 * 2. Proportional share of total contracts applied
 */
function estimateContractsForPackage(
  packageName: string,
  audit: AuditRecord | EnhancedAuditRecord,
  violations: Violation[]
): number {
  const enhanced = audit as EnhancedAuditRecord;

  // If we have violations_by_package (enhanced record), use that data
  if (enhanced.violations_by_package && enhanced.violations_by_package[packageName]) {
    // We know violations, estimate total checks as violations + estimate of passing checks
    // Heuristic: For every violation, there are likely 3-5 passing checks
    // (This is conservative - real ratio could be higher)
    const estimatedPassingChecks = violations.length * 4;
    return violations.length + estimatedPassingChecks;
  }

  // Fallback: Distribute total contracts_applied proportionally
  const packagesWithContracts = getPackagesWithContracts(audit);
  const totalPackages = packagesWithContracts.length;

  if (totalPackages === 0) return violations.length;

  // Simple proportional estimate
  const avgContractsPerPackage = Math.floor(audit.contracts_applied / totalPackages);

  // Use at least the violation count (we know we checked those)
  return Math.max(violations.length, avgContractsPerPackage);
}

/**
 * Format package breakdown for terminal display
 */
export function formatPackageBreakdown(breakdown: PackageBreakdownSummary): string {
  const lines: string[] = [];
  const red = '\x1b[31m';
  const reset = '\x1b[0m';

  const failingPackages = breakdown.packages.filter(p => p.violationsFound > 0);

  // Only show this section if there are violations
  if (failingPackages.length === 0) {
    lines.push('\n✓ VIOLATIONS BY PACKAGE');
    lines.push('─'.repeat(80));
    lines.push('  No violations found across any package.');
    lines.push('');
    lines.push(`  ${breakdown.packagesWithContracts} packages with contracts checked, all compliant ✓`);
    return lines.join('\n');
  }

  lines.push(`\n${red}✗${reset} VIOLATIONS BY PACKAGE`);
  lines.push('─'.repeat(80));

  // Sort by most violations first
  failingPackages.sort((a, b) => b.violationsFound - a.violationsFound);

  for (const pkg of failingPackages) {
    // Format package name (truncate if too long)
    const pkgDisplay = pkg.packageName.length > 30
      ? pkg.packageName.substring(0, 27) + '...'
      : pkg.packageName.padEnd(30);

    // Show violation count and severity breakdown inline
    const severityParts = [];
    if (pkg.violationBreakdown.errors > 0) {
      severityParts.push(`${pkg.violationBreakdown.errors} errors`);
    }
    if (pkg.violationBreakdown.warnings > 0) {
      severityParts.push(`${pkg.violationBreakdown.warnings} warnings`);
    }
    if (pkg.violationBreakdown.info > 0) {
      severityParts.push(`${pkg.violationBreakdown.info} info`);
    }

    const severityStr = severityParts.length > 0
      ? `  (${severityParts.join(', ')})`
      : '';

    lines.push(`  ${red}✗${reset} ${pkgDisplay}  ${pkg.violationsFound} violations${severityStr}`);
  }

  // Summary stats
  lines.push('');
  lines.push(`  ${breakdown.packagesWithContracts} packages with contracts checked`);
  lines.push(`  ${breakdown.packagesFullyCompliant} fully compliant ✓`);
  lines.push(`  ${breakdown.packagesWithViolations} with violations ✗`);

  return lines.join('\n');
}

/**
 * Get top N packages by usage (most checks applied)
 */
export function getTopPackages(breakdown: PackageBreakdownSummary, limit: number): PackageUsageStats[] {
  return breakdown.packages.slice(0, limit);
}

/**
 * Get only failing packages (with violations)
 */
export function getFailingPackages(breakdown: PackageBreakdownSummary): PackageUsageStats[] {
  return breakdown.packages.filter(p => p.status === 'FAIL');
}

/**
 * Get only passing packages (zero violations)
 */
export function getPassingPackages(breakdown: PackageBreakdownSummary): PackageUsageStats[] {
  return breakdown.packages.filter(p => p.status === 'PASS');
}
