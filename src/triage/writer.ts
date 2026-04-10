/**
 * Write triage verdicts to violation files.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Find the violation .json file matching this fingerprint.
 * Scans .nark/violations/ recursively.
 */
function findViolationFile(narkDir: string, fingerprint: string): string | null {
  const violationsDir = path.join(narkDir, 'violations');

  if (!fs.existsSync(violationsDir)) {
    return null;
  }

  try {
    const packages = fs.readdirSync(violationsDir);
    for (const pkg of packages) {
      const pkgDir = path.join(violationsDir, pkg);
      try {
        if (!fs.statSync(pkgDir).isDirectory()) continue;
        const jsonPath = path.join(pkgDir, `${fingerprint}.json`);
        if (fs.existsSync(jsonPath)) {
          return jsonPath;
        }
      } catch {
        // Skip
      }
    }
  } catch {
    // Violations dir unreadable
  }

  return null;
}

/**
 * Update the Triage section in a .md file.
 */
function updateMdTriage(
  mdPath: string,
  verdict: string,
  reason: string,
  triagedBy: string,
  triagedAt: string
): void {
  try {
    const content = fs.readFileSync(mdPath, 'utf-8');

    const updated = content.replace(
      /## Triage\n[\s\S]*$/,
      `## Triage\n**Verdict:** ${verdict}\n**Reason:** ${reason}\n**Triaged by:** ${triagedBy}\n**Triaged at:** ${triagedAt}\n`
    );

    fs.writeFileSync(mdPath, updated, 'utf-8');
  } catch {
    // Non-fatal — JSON is the source of truth
  }
}

/**
 * Mark a triage verdict for a violation.
 * Finds the violation .json file by fingerprint, updates its triage section,
 * and also updates the corresponding .md file.
 *
 * Returns true on success, false if the violation file wasn't found or an error occurred.
 */
export function markVerdict(
  narkDir: string,
  fingerprint: string,
  verdict: string,
  reason: string,
  triagedBy: string
): boolean {
  try {
    const jsonPath = findViolationFile(narkDir, fingerprint);

    if (!jsonPath) {
      return false;
    }

    // Read existing JSON
    const raw = fs.readFileSync(jsonPath, 'utf-8');
    const data = JSON.parse(raw);

    const triagedAt = new Date().toISOString();

    // Update triage section
    data.triage = {
      verdict,
      reason,
      triaged_by: triagedBy,
      triaged_at: triagedAt,
    };

    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8');

    // Also update the .md file if it exists
    const mdPath = jsonPath.replace(/\.json$/, '.md');
    if (fs.existsSync(mdPath)) {
      updateMdTriage(mdPath, verdict, reason, triagedBy, triagedAt);
    }

    return true;
  } catch {
    return false;
  }
}
