/**
 * Violation Fingerprint Computation
 *
 * Mirrors the SaaS fingerprint computation so CLI suppressions are keyed by
 * the same stable identifier used in the SaaS database. This enables:
 * - Cross-referencing CLI suppressions with SaaS violation records
 * - Stale detection: if a fingerprint no longer appears in scan results,
 *   the suppression can be safely removed
 *
 * Formula: sha256("{packageName}:{postconditionId}:{normalizedFilePath}:{lineNumber}:{callExpression}").slice(0, 32)
 */

import { createHash } from 'crypto';

export interface FingerprintParams {
  packageName: string;
  postconditionId: string;
  filePath: string;
  lineNumber: number;
  callExpression: string | null;
}

/**
 * Compute a stable fingerprint for a violation.
 *
 * The fingerprint is tied to the exact location (file + line), so it will
 * change if lines are added/removed above the violation. This is intentional:
 * a moved suppression should be re-reviewed to confirm it still applies.
 *
 * The fingerprint matches what the SaaS computes, enabling traceability
 * between CLI suppressions and SaaS violation records.
 */
export function computeViolationFingerprint(params: FingerprintParams): string {
  const normalized = params.filePath
    .replace(/^\.\//, '')
    .replace(/\\/g, '/')
    .toLowerCase();

  const input = [
    params.packageName,
    params.postconditionId,
    normalized,
    params.lineNumber,
    params.callExpression ?? '',
  ].join(':');

  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}
