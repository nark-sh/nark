/**
 * Inline Comment Parser
 *
 * Parses @behavioral-contract-ignore comments from TypeScript source files.
 */

import * as ts from 'typescript';
import { InlineSuppressionComment } from './types.js';

/**
 * Regular expression for matching suppression comments
 *
 * Format: @behavioral-contract-ignore <package>/<postcondition-id>: <reason>
 *
 * Examples:
 *   @behavioral-contract-ignore axios/network-failure: Global error handler
 *   @behavioral-contract-ignore STAR/timeout-not-set: Timeout set globally (use * for STAR)
 *   @behavioral-contract-ignore prisma/STAR: Framework handles all errors (use * for STAR)
 */
const SUPPRESSION_COMMENT_REGEX = /@behavioral-contract-ignore\s+([\w@/-]+|\*)\/([\w-]+|\*):\s*(.+)/i;

/**
 * Parse all inline suppression comments from a TypeScript source file
 *
 * @param sourceFile - TypeScript source file
 * @returns Array of parsed suppression comments
 */
export function parseInlineSuppressions(
  sourceFile: ts.SourceFile
): InlineSuppressionComment[] {
  const suppressions: InlineSuppressionComment[] = [];
  const sourceText = sourceFile.getFullText();
  const lines = sourceText.split('\n');

  lines.forEach((line, index) => {
    const trimmed = line.trim();

    // Check if line is a comment
    if (!trimmed.startsWith('//')) {
      return;
    }

    // Try to match suppression format
    const match = trimmed.match(SUPPRESSION_COMMENT_REGEX);
    if (!match) {
      return;
    }

    const [, packagePattern, postconditionPattern, reason] = match;

    suppressions.push({
      line: index + 1, // Convert to 1-indexed
      package: packagePattern.trim(),
      postconditionId: postconditionPattern.trim(),
      reason: reason.trim(),
      originalComment: trimmed
    });
  });

  return suppressions;
}

/**
 * Check if a specific line has a suppression comment
 *
 * @param sourceFile - TypeScript source file
 * @param targetLine - Line number to check (1-indexed)
 * @returns Suppression comment if found, undefined otherwise
 */
export function getSuppressionForLine(
  sourceFile: ts.SourceFile,
  targetLine: number
): InlineSuppressionComment | undefined {
  const suppressions = parseInlineSuppressions(sourceFile);

  // Check the line before target (comment usually precedes code)
  return suppressions.find(s => s.line === targetLine - 1 || s.line === targetLine);
}

/**
 * Check if a suppression comment applies to a specific violation
 *
 * @param suppression - Parsed suppression comment
 * @param packageName - Package name from violation
 * @param postconditionId - Postcondition ID from violation
 * @returns True if suppression applies
 */
export function suppressionMatches(
  suppression: InlineSuppressionComment,
  packageName: string,
  postconditionId: string
): boolean {
  // Check package match (supports wildcards)
  const packageMatches =
    suppression.package === '*' ||
    suppression.package === packageName;

  // Check postcondition match (supports wildcards)
  const postconditionMatches =
    suppression.postconditionId === '*' ||
    suppression.postconditionId === postconditionId;

  return packageMatches && postconditionMatches;
}

/**
 * Validate suppression comment format
 *
 * @param comment - Comment text to validate
 * @returns Validation result
 */
export function validateSuppressionComment(comment: string): {
  valid: boolean;
  error?: string;
} {
  const match = comment.match(SUPPRESSION_COMMENT_REGEX);

  if (!match) {
    return {
      valid: false,
      error: 'Invalid format. Expected: @behavioral-contract-ignore <package>/<postcondition-id>: <reason>'
    };
  }

  const [, packagePattern, postconditionPattern, reason] = match;

  // Validate reason is not empty
  if (!reason || reason.trim().length === 0) {
    return {
      valid: false,
      error: 'Reason is required. Provide explanation after colon (:)'
    };
  }

  // Validate reason is meaningful (at least 10 characters)
  if (reason.trim().length < 10) {
    return {
      valid: false,
      error: 'Reason must be at least 10 characters. Provide meaningful explanation.'
    };
  }

  // Warn about overly broad wildcards
  if (packagePattern === '*' && postconditionPattern === '*') {
    return {
      valid: true, // Still valid, but warn
      error: 'Warning: */* suppresses ALL violations. Use specific patterns when possible.'
    };
  }

  return { valid: true };
}

/**
 * Generate a suppression comment string
 *
 * @param packageName - Package name
 * @param postconditionId - Postcondition ID
 * @param reason - Human-readable reason
 * @returns Formatted comment string
 */
export function generateSuppressionComment(
  packageName: string,
  postconditionId: string,
  reason: string
): string {
  return `// @behavioral-contract-ignore ${packageName}/${postconditionId}: ${reason}`;
}

/**
 * Extract all comments from a TypeScript node
 *
 * @param node - TypeScript AST node
 * @param sourceFile - Source file containing the node
 * @returns Array of comment texts
 */
export function getNodeComments(
  node: ts.Node,
  sourceFile: ts.SourceFile
): string[] {
  const comments: string[] = [];
  const sourceText = sourceFile.getFullText();

  // Get leading comments
  const leadingComments = ts.getLeadingCommentRanges(
    sourceText,
    node.getFullStart()
  );

  if (leadingComments) {
    leadingComments.forEach(comment => {
      const text = sourceText.substring(comment.pos, comment.end);
      comments.push(text);
    });
  }

  // Get trailing comments
  const trailingComments = ts.getTrailingCommentRanges(
    sourceText,
    node.getEnd()
  );

  if (trailingComments) {
    trailingComments.forEach(comment => {
      const text = sourceText.substring(comment.pos, comment.end);
      comments.push(text);
    });
  }

  return comments;
}
