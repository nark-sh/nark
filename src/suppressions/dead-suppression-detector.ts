/**
 * Dead Suppression Detector
 *
 * Detects suppressions that are no longer needed because the analyzer has improved.
 */

import { loadManifestSync, saveManifestSync } from './manifest.js';
import { DeadSuppression } from './types.js';

/**
 * Detect dead suppressions in the manifest
 *
 * A dead suppression is one where stillViolates is false,
 * meaning the analyzer no longer flags this location.
 *
 * @param projectRoot - Project root directory
 * @param currentVersion - Current analyzer version
 * @returns Array of dead suppressions
 */
export function detectDeadSuppressions(
  projectRoot: string,
  currentVersion: string
): DeadSuppression[] {
  const manifest = loadManifestSync(projectRoot);
  const deadSuppressions: DeadSuppression[] = [];

  for (const suppression of manifest.suppressions) {
    if (!suppression.stillViolates) {
      deadSuppressions.push({
        suppression,
        improvedInVersion: currentVersion,
        originalVersion: suppression.analyzerVersion,
        improvementReason: `Analyzer ${currentVersion} no longer flags this pattern`
      });
    }
  }

  return deadSuppressions;
}

/**
 * Remove dead suppressions from manifest
 *
 * @param projectRoot - Project root directory
 * @returns Number of dead suppressions removed
 */
export function removeDeadSuppressionsFromManifest(
  projectRoot: string
): number {
  const manifest = loadManifestSync(projectRoot);
  const beforeCount = manifest.suppressions.length;

  manifest.suppressions = manifest.suppressions.filter(s => s.stillViolates);

  saveManifestSync(manifest);

  return beforeCount - manifest.suppressions.length;
}

/**
 * Get dead suppression summary
 *
 * @param deadSuppressions - Array of dead suppressions
 * @returns Summary object
 */
export function getDeadSuppressionSummary(deadSuppressions: DeadSuppression[]): {
  totalDead: number;
  byPackage: Map<string, number>;
  byFile: Map<string, number>;
  oldestSuppression: Date | null;
  newestSuppression: Date | null;
} {
  const byPackage = new Map<string, number>();
  const byFile = new Map<string, number>();
  let oldestDate: Date | null = null;
  let newestDate: Date | null = null;

  for (const dead of deadSuppressions) {
    // Count by package
    const packageCount = byPackage.get(dead.suppression.package) || 0;
    byPackage.set(dead.suppression.package, packageCount + 1);

    // Count by file
    const fileCount = byFile.get(dead.suppression.file) || 0;
    byFile.set(dead.suppression.file, fileCount + 1);

    // Track dates
    const suppressedAt = new Date(dead.suppression.suppressedAt);
    if (!oldestDate || suppressedAt < oldestDate) {
      oldestDate = suppressedAt;
    }
    if (!newestDate || suppressedAt > newestDate) {
      newestDate = suppressedAt;
    }
  }

  return {
    totalDead: deadSuppressions.length,
    byPackage,
    byFile,
    oldestSuppression: oldestDate,
    newestSuppression: newestDate
  };
}

/**
 * Format dead suppression for display
 *
 * @param dead - Dead suppression
 * @returns Formatted string
 */
export function formatDeadSuppression(dead: DeadSuppression): string {
  const s = dead.suppression;
  const daysAgo = Math.floor(
    (Date.now() - new Date(s.suppressedAt).getTime()) / (1000 * 60 * 60 * 24)
  );

  return [
    `├─ ${s.file}:${s.line}`,
    `│  Package: ${s.package}`,
    `│  Postcondition: ${s.postconditionId}`,
    `│  Suppressed: ${new Date(s.suppressedAt).toISOString().split('T')[0]} (${daysAgo} days ago)`,
    `│  Analyzer: ${dead.originalVersion} → ${dead.improvedInVersion}`,
    `│`,
    `│  Why improved: ${dead.improvementReason || 'Analyzer no longer flags this pattern'}`,
    `│  Action: Remove @behavioral-contract-ignore comment at line ${s.line}`,
    `│`
  ].join('\n');
}
