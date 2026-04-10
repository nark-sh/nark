/**
 * Code Snippet Extraction Module
 *
 * Extracts code snippets around violation locations with context lines.
 */

import * as fs from 'fs/promises';

export interface CodeSnippet {
  lines: CodeLine[];
  startLine: number;
  endLine: number;
}

export interface CodeLine {
  lineNumber: number;
  content: string;
  isViolation: boolean;
}

/**
 * Extracts a code snippet from a file around a specific line
 *
 * @param filePath - Path to the source file
 * @param violationLine - Line number where the violation occurred
 * @param contextLines - Number of lines to show before and after (default: 4)
 * @returns Code snippet with context
 */
export async function extractCodeSnippet(
  filePath: string,
  violationLine: number,
  contextLines: number = 4
): Promise<CodeSnippet | null> {
  try {
    // Read the entire file
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    // Calculate range (1-indexed line numbers)
    const startLine = Math.max(1, violationLine - contextLines);
    const endLine = Math.min(lines.length, violationLine + contextLines);

    // Extract lines (convert to 0-indexed for array access)
    const snippetLines: CodeLine[] = [];
    for (let i = startLine; i <= endLine; i++) {
      const lineContent = lines[i - 1]; // Convert to 0-indexed
      snippetLines.push({
        lineNumber: i,
        content: lineContent,
        isViolation: i === violationLine,
      });
    }

    return {
      lines: snippetLines,
      startLine,
      endLine,
    };
  } catch (error) {
    // File might not be accessible, return null
    return null;
  }
}

/**
 * Formats a code snippet for terminal display
 *
 * @param snippet - Code snippet to format
 * @param maxLineLength - Maximum length of a line (truncate longer lines)
 * @returns Formatted string array
 */
export function formatSnippetForTerminal(
  snippet: CodeSnippet,
  maxLineLength: number = 120
): string[] {
  const output: string[] = [];
  const maxLineNumWidth = String(snippet.endLine).length;

  for (const line of snippet.lines) {
    const lineNum = String(line.lineNumber).padStart(maxLineNumWidth, ' ');
    let content = line.content;

    // Truncate long lines
    if (content.length > maxLineLength) {
      content = content.substring(0, maxLineLength - 3) + '...';
    }

    // Add line prefix
    const prefix = line.isViolation ? '>' : ' ';
    output.push(`${prefix} ${lineNum} | ${content}`);
  }

  return output;
}

/**
 * Formats a code snippet for JSON export
 *
 * @param snippet - Code snippet to format
 * @returns Object suitable for JSON serialization
 */
export function formatSnippetForJSON(snippet: CodeSnippet): {
  startLine: number;
  endLine: number;
  lines: Array<{ line: number; content: string; highlighted: boolean }>;
} {
  return {
    startLine: snippet.startLine,
    endLine: snippet.endLine,
    lines: snippet.lines.map(line => ({
      line: line.lineNumber,
      content: line.content,
      highlighted: line.isViolation,
    })),
  };
}
