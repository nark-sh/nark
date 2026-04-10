/**
 * Format violations as markdown and JSON for .nark/violations/
 */

import type { Violation } from '../types.js';

export interface ViolationFileJson {
  fingerprint: string;
  package: string;
  postcondition_id: string;
  severity: string;
  description: string;
  file: string;
  line: number;
  column: number;
  scan_id: string;
  triage: {
    verdict: 'untriaged' | 'true_positive' | 'false_positive' | 'wont_fix';
    reason: string;
    triaged_by: string;
    triaged_at: string;
  };
  code_snippet?: {
    startLine: number;
    endLine: number;
    lines: Array<{ line: number; content: string; highlighted: boolean }>;
  };
}

/**
 * Extract postcondition_id from violation contract_clause.
 * contract_clause is typically like "postcondition:axios-handle-network-errors" or just the id.
 */
function extractPostconditionId(violation: Violation): string {
  const clause = violation.contract_clause || '';
  if (clause.startsWith('postcondition:')) {
    return clause.replace('postcondition:', '');
  }
  return clause || violation.id;
}

/**
 * Get fingerprint from violation (may have been added by analyzer as extra property).
 */
function getFingerprint(violation: Violation): string {
  const v = violation as any;
  return v.fingerprint || violation.id || '';
}

/**
 * Build the code context block for a violation markdown file.
 */
function buildCodeContext(violation: Violation): string {
  if (!violation.code_snippet) {
    return '(No code context available)';
  }

  const lines = violation.code_snippet.lines
    .map(l => {
      const marker = l.highlighted ? '> ' : '  ';
      return `${marker}${l.line.toString().padStart(4)}: ${l.content}`;
    })
    .join('\n');

  return lines;
}

/**
 * Format a violation as human/AI-readable markdown.
 */
export function formatViolationMd(violation: Violation, scanId: string): string {
  const fingerprint = getFingerprint(violation);
  const codeContext = buildCodeContext(violation);
  const severityUpper = violation.severity.toUpperCase();

  return `# ${violation.description}

**Package:** ${violation.package}
**Severity:** ${severityUpper}
**File:** ${violation.file}:${violation.line}
**Scan:** ${scanId}
**Fingerprint:** ${fingerprint}

## Description
${violation.description}

${violation.suggested_fix ? `## Suggested Fix\n${violation.suggested_fix}\n` : ''}
## Code Context
\`\`\`typescript
${codeContext}
\`\`\`

## Triage
**Verdict:** untriaged
**Reason:**
**Triaged by:**
**Triaged at:**
`;
}

/**
 * Format a violation as machine-readable JSON.
 */
export function formatViolationJson(violation: Violation, scanId: string): ViolationFileJson {
  return {
    fingerprint: getFingerprint(violation),
    package: violation.package,
    postcondition_id: extractPostconditionId(violation),
    severity: violation.severity.toUpperCase(),
    description: violation.description,
    file: violation.file,
    line: violation.line,
    column: violation.column,
    scan_id: scanId,
    triage: {
      verdict: 'untriaged',
      reason: '',
      triaged_by: '',
      triaged_at: '',
    },
    ...(violation.code_snippet && { code_snippet: violation.code_snippet }),
  };
}
