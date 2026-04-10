/**
 * Suppression System Types
 *
 * Defines data structures for suppressing false positive violations
 * and tracking dead suppressions when the analyzer improves.
 */

/**
 * A single suppression entry
 */
export interface Suppression {
  /** Unique identifier: "suppress-{file}-{line}-{hash}" */
  id: string;

  /** Relative path from project root */
  file: string;

  /** Line number (1-indexed) */
  line: number;

  /** Optional column number (1-indexed) */
  column?: number;

  /** Package name (e.g., "axios") */
  package: string;

  /** Postcondition ID (e.g., "network-failure") */
  postconditionId: string;

  /** Human-readable reason for suppression */
  reason: string;

  /** ISO 8601 timestamp when suppression was created */
  suppressedAt: string;

  /** How the suppression was created */
  suppressedBy: 'inline-comment' | 'config-file' | 'ai-agent' | 'cli';

  /** ISO 8601 timestamp when last checked */
  lastChecked: string;

  /** Does this location still violate the contract? */
  stillViolates: boolean;

  /** Analyzer version that created this suppression */
  analyzerVersion: string;
}

/**
 * Manifest file tracking all suppressions
 */
export interface SuppressionManifest {
  /** Schema version */
  version: string;

  /** Absolute path to project root */
  projectRoot: string;

  /** ISO 8601 timestamp of last update */
  lastUpdated: string;

  /** All suppressions */
  suppressions: Suppression[];
}

/**
 * Configuration file structure (.behavioralcontractsrc.json)
 */
export interface BehavioralContractsConfig {
  /** Suppression rules */
  ignore?: IgnoreRule[];

  /** Other config options */
  [key: string]: any;
}

/**
 * A single ignore rule from config file
 */
export interface IgnoreRule {
  /** Glob pattern for files (e.g., "src/test/**") */
  file?: string;

  /** Package name to ignore */
  package?: string;

  /** Specific postcondition ID */
  postconditionId?: string;

  /** Required reason for suppression */
  reason: string;
}

/**
 * Result of parsing an inline suppression comment
 */
export interface InlineSuppressionComment {
  /** Line number where comment appears */
  line: number;

  /** Package name (or "*" for wildcard) */
  package: string;

  /** Postcondition ID (or "*" for wildcard) */
  postconditionId: string;

  /** Human-readable reason */
  reason: string;

  /** Full comment text */
  originalComment: string;
}

/**
 * A dead suppression that can be removed
 */
export interface DeadSuppression {
  /** The suppression that is no longer needed */
  suppression: Suppression;

  /** Analyzer version where it was fixed */
  improvedInVersion: string;

  /** Original analyzer version that needed suppression */
  originalVersion: string;

  /** Why the suppression is no longer needed */
  improvementReason?: string;
}

/**
 * Options for suppression matching
 */
export interface SuppressionMatchOptions {
  /** Enable wildcard matching */
  allowWildcards?: boolean;

  /** Case-insensitive matching */
  caseInsensitive?: boolean;
}

/**
 * Result of checking if a violation is suppressed
 */
export interface SuppressionCheckResult {
  /** Is this violation suppressed? */
  suppressed: boolean;

  /** The suppression that matched (if any) */
  matchedSuppression?: Suppression | IgnoreRule | BcScanSuppression;

  /** How it was suppressed */
  source?: 'inline-comment' | 'config-file' | 'bc-scan';

  /** Original comment or rule */
  originalSource?: any;
}

/**
 * A suppression entry in .bc-suppressions.json
 *
 * Keyed by fingerprint rather than line number, so it is stable across
 * line-number shifts caused by unrelated code additions. If code actually
 * moves (and the fingerprint changes), the entry is flagged as stale.
 */
export interface BcScanSuppression {
  /** Violation fingerprint (sha256 of package:postcondition:file:line:call, first 32 chars) */
  fingerprint: string;

  /** Package name (e.g., "axios") — stored for human reference only */
  package: string;

  /** Postcondition ID (e.g., "network-failure") — stored for human reference only */
  postconditionId: string;

  /** File path at time of suppression — stored for human reference only */
  filePath: string;

  /** Line number at time of suppression — stored for human reference only */
  lineNumber: number;

  /** Human-readable reason this violation is being suppressed */
  reason: string;

  /** ISO 8601 timestamp when suppression was created */
  suppressedAt: string;
}

/**
 * The .bc-suppressions.json file structure
 */
export interface BcScanStore {
  /** Schema version */
  version: string;

  /** All fingerprint-keyed suppressions */
  suppressions: BcScanSuppression[];
}
