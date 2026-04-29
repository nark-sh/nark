/**
 * Suppression Matcher
 *
 * Combines inline comments and config rules to check if violations are suppressed
 */

import * as ts from "typescript";
import * as path from "path";
import { getSuppressionForLine, suppressionMatches } from "./parser.js";
import { loadConfigSync, findMatchingRules } from "./config-loader.js";
import {
  loadManifestSync,
  saveManifestSync,
  createSuppression,
  upsertSuppression,
} from "./manifest.js";
import { SuppressionCheckResult } from "./types.js";

/**
 * Options for checking suppressions
 */
export interface CheckSuppressionOptions {
  /** Project root directory */
  projectRoot: string;

  /** TypeScript source file */
  sourceFile: ts.SourceFile;

  /** Line number of violation (1-indexed) */
  line: number;

  /** Column number of violation (1-indexed) */
  column?: number;

  /** Package name */
  packageName: string;

  /** Postcondition ID */
  postconditionId: string;

  /** Current analyzer version */
  analyzerVersion: string;

  /** Update manifest with suppression metadata */
  updateManifest?: boolean;

  /**
   * Precomputed fingerprint for this violation (informational only).
   */
  fingerprint?: string;
}

/**
 * Check if a violation is suppressed
 *
 * Checks both inline comments and config file rules.
 * Optionally updates manifest with metadata.
 *
 * @param options - Check options
 * @returns Suppression check result
 */
export function checkSuppression(
  options: CheckSuppressionOptions,
): SuppressionCheckResult {
  const {
    projectRoot,
    sourceFile,
    line,
    column,
    packageName,
    postconditionId,
    analyzerVersion,
    updateManifest = true,
  } = options;

  // Get relative file path from project root
  const absoluteFilePath = sourceFile.fileName;
  const relativeFilePath = path.relative(projectRoot, absoluteFilePath);

  // 1. Check inline comment suppression (deprecated — warn and still honour it)
  const inlineSuppress = getSuppressionForLine(sourceFile, line);

  if (
    inlineSuppress &&
    suppressionMatches(inlineSuppress, packageName, postconditionId)
  ) {
    // Emit deprecation warning so developers know to migrate
    process.stderr.write(
      `[nark-warn] Inline suppression at ${relativeFilePath}:${line} is deprecated.\n` +
        `  Add an ignore rule to .nark-suppressions.json instead:\n` +
        `  nark suppressions add --package ${packageName} --postcondition ${postconditionId} --file <path> --reason "<reason>"\n`,
    );

    if (updateManifest) {
      updateManifestWithSuppression({
        projectRoot,
        file: relativeFilePath,
        line,
        column,
        packageName,
        postconditionId,
        reason: inlineSuppress.reason,
        suppressedBy: "inline-comment",
        analyzerVersion,
      });
    }

    return {
      suppressed: true,
      source: "inline-comment",
      originalSource: inlineSuppress,
    };
  }

  // 3. Check config file suppression (.nark-suppressions.json)
  const config = loadConfigSync(projectRoot);
  const matchingRules = findMatchingRules(
    config,
    relativeFilePath,
    packageName,
    postconditionId,
  );

  if (matchingRules.length > 0) {
    const rule = matchingRules[0];

    if (updateManifest) {
      updateManifestWithSuppression({
        projectRoot,
        file: relativeFilePath,
        line,
        column,
        packageName,
        postconditionId,
        reason: rule.reason,
        suppressedBy: "config-file",
        analyzerVersion,
      });
    }

    return {
      suppressed: true,
      matchedSuppression: rule,
      source: "config-file",
      originalSource: rule,
    };
  }

  // Not suppressed
  return {
    suppressed: false,
  };
}

/**
 * Update manifest with suppression metadata
 *
 * Creates or updates a suppression entry in the manifest.
 *
 * @param options - Suppression options
 */
function updateManifestWithSuppression(options: {
  projectRoot: string;
  file: string;
  line: number;
  column?: number;
  packageName: string;
  postconditionId: string;
  reason: string;
  suppressedBy: "inline-comment" | "config-file";
  analyzerVersion: string;
}): void {
  try {
    const manifest = loadManifestSync(options.projectRoot);

    const suppression = createSuppression({
      file: options.file,
      line: options.line,
      column: options.column,
      packageName: options.packageName,
      postconditionId: options.postconditionId,
      reason: options.reason,
      suppressedBy: options.suppressedBy,
      analyzerVersion: options.analyzerVersion,
    });

    // Update last checked time
    suppression.lastChecked = new Date().toISOString();
    suppression.stillViolates = true; // Confirmed to still violate

    upsertSuppression(manifest, suppression);
    saveManifestSync(manifest);
  } catch (error) {
    // Don't fail the analysis if manifest update fails
    console.warn(
      `Warning: Failed to update suppression manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Batch check suppressions for multiple violations
 *
 * @param violations - Array of violations to check
 * @param projectRoot - Project root directory
 * @param analyzerVersion - Current analyzer version
 * @returns Map of violation ID to suppression result
 */
export function batchCheckSuppressions(
  violations: Array<{
    id: string;
    sourceFile: ts.SourceFile;
    line: number;
    column?: number;
    packageName: string;
    postconditionId: string;
  }>,
  projectRoot: string,
  analyzerVersion: string,
): Map<string, SuppressionCheckResult> {
  const results = new Map<string, SuppressionCheckResult>();

  for (const violation of violations) {
    const result = checkSuppression({
      projectRoot,
      sourceFile: violation.sourceFile,
      line: violation.line,
      column: violation.column,
      packageName: violation.packageName,
      postconditionId: violation.postconditionId,
      analyzerVersion,
      updateManifest: true,
    });

    results.set(violation.id, result);
  }

  return results;
}

/**
 * Get suppression statistics
 *
 * @param projectRoot - Project root directory
 * @returns Statistics object
 */
export function getSuppressionStats(projectRoot: string): {
  totalSuppressions: number;
  activeSuppressions: number;
  deadSuppressions: number;
  bySource: {
    inlineComment: number;
    configFile: number;
    aiAgent: number;
    cli: number;
  };
  byPackage: Map<string, number>;
} {
  const manifest = loadManifestSync(projectRoot);

  const active = manifest.suppressions.filter((s) => s.stillViolates);
  const dead = manifest.suppressions.filter((s) => !s.stillViolates);

  const bySource = {
    inlineComment: manifest.suppressions.filter(
      (s) => s.suppressedBy === "inline-comment",
    ).length,
    configFile: manifest.suppressions.filter(
      (s) => s.suppressedBy === "config-file",
    ).length,
    aiAgent: manifest.suppressions.filter((s) => s.suppressedBy === "ai-agent")
      .length,
    cli: manifest.suppressions.filter((s) => s.suppressedBy === "cli").length,
  };

  const byPackage = new Map<string, number>();
  manifest.suppressions.forEach((s) => {
    const count = byPackage.get(s.package) || 0;
    byPackage.set(s.package, count + 1);
  });

  return {
    totalSuppressions: manifest.suppressions.length,
    activeSuppressions: active.length,
    deadSuppressions: dead.length,
    bySource,
    byPackage,
  };
}
