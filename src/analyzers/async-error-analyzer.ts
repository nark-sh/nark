/**
 * Async Error Analyzer
 * Detects unprotected await expressions in async functions
 *
 * Related: dev-notes/github-issues/001-async-error-detection.md
 */

import * as ts from 'typescript';

export interface AsyncErrorDetection {
  /** Whether the await is protected by try-catch */
  isProtected: boolean;
  /** Line number of the await expression */
  line: number;
  /** Column number of the await expression */
  column: number;
  /** Text of the await expression */
  awaitText: string;
  /** The function containing this await */
  functionName: string;
  /** The AST node for type-aware detection (added for Phase 1) */
  node?: ts.CallExpression;
}

export class AsyncErrorAnalyzer {
  private sourceFile: ts.SourceFile;

  constructor(sourceFile: ts.SourceFile) {
    this.sourceFile = sourceFile;
  }

  /**
   * Checks if a node is an async function (function declaration, arrow function, or method)
   */
  isAsyncFunction(node: ts.Node): boolean {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) {
      return node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
    }

    if (ts.isArrowFunction(node)) {
      return node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
    }

    return false;
  }

  /**
   * Finds all unprotected await expressions in an async function
   */
  findUnprotectedAwaits(functionNode: ts.Node): AsyncErrorDetection[] {
    if (!this.isAsyncFunction(functionNode)) {
      return [];
    }

    const unprotectedAwaits: AsyncErrorDetection[] = [];
    const functionName = this.getFunctionName(functionNode);

    const visit = (node: ts.Node, insideTryBlock: boolean = false): void => {
      // If we're entering a try block, mark all children as protected
      if (ts.isTryStatement(node)) {
        // Visit try block with protection
        ts.forEachChild(node.tryBlock, child => visit(child, true));

        // Visit catch/finally blocks without changing protection status
        // (errors in catch block itself should also be handled)
        if (node.catchClause) {
          ts.forEachChild(node.catchClause, child => visit(child, false));
        }
        if (node.finallyBlock) {
          ts.forEachChild(node.finallyBlock, child => visit(child, false));
        }
        return;
      }

      // Check if this is an await expression
      if (ts.isAwaitExpression(node) && !insideTryBlock) {
        // Check for destructured { error } tuple pattern — Supabase's idiomatic style
        if (this.isDestructuredErrorTupleProtected(node, this.sourceFile)) {
          // This await IS handled via { error } destructuring + if check — not a violation
          ts.forEachChild(node, child => visit(child, insideTryBlock));
          return;
        }

        const location = this.sourceFile.getLineAndCharacterOfPosition(node.getStart());

        // Extract the call expression for type-aware detection
        const callNode = ts.isCallExpression(node.expression) ? node.expression : undefined;

        unprotectedAwaits.push({
          isProtected: false,
          line: location.line + 1,
          column: location.character + 1,
          awaitText: node.getText(this.sourceFile).substring(0, 100), // Limit length
          functionName,
          node: callNode,  // Include AST node for type-aware detection
        });
      }

      // Continue visiting children
      ts.forEachChild(node, child => visit(child, insideTryBlock));
    };

    // Get function body
    const body = this.getFunctionBody(functionNode);
    if (body) {
      visit(body, false);
    }

    return unprotectedAwaits;
  }

  /**
   * Checks if a specific await expression is protected by try-catch
   */
  isAwaitProtected(awaitNode: ts.AwaitExpression, functionNode: ts.Node): boolean {
    let current: ts.Node | undefined = awaitNode;

    // Walk up the AST until we find a try block or reach the function boundary
    while (current && current !== functionNode) {
      const parent: ts.Node | undefined = current.parent;

      if (!parent) {
        break;
      }

      // Check if we're inside a try block
      if (ts.isTryStatement(parent)) {
        // Check if current node is within the try block (not catch or finally)
        if (parent.tryBlock === current || this.isDescendantOf(awaitNode, parent.tryBlock)) {
          return true;
        }
      }

      current = parent;
    }

    return false;
  }

  /**
   * Checks if child is a descendant of parent node
   */
  private isDescendantOf(child: ts.Node, parent: ts.Node): boolean {
    let current: ts.Node | undefined = child;

    while (current) {
      if (current === parent) {
        return true;
      }
      current = current.parent;
    }

    return false;
  }

  /**
   * Gets a human-readable function name
   */
  private getFunctionName(node: ts.Node): string {
    if (ts.isFunctionDeclaration(node) && node.name) {
      return node.name.text;
    }

    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      return node.name.text;
    }

    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      // Try to get variable name if assigned
      const parent = node.parent;
      if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
      }

      // Check if it's a property assignment (object method)
      if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
      }

      return '(anonymous function)';
    }

    return '(unknown)';
  }

  /**
   * Gets the function body node
   */
  private getFunctionBody(node: ts.Node): ts.Node | undefined {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) {
      return node.body;
    }

    if (ts.isArrowFunction(node)) {
      // Arrow function body might be an expression or a block
      if (ts.isBlock(node.body)) {
        return node.body;
      }
      // If it's an expression body, wrap it conceptually
      return node.body;
    }

    return undefined;
  }

  /**
   * Detects if a catch block is empty or ineffective
   * Related: dev-notes/github-issues/002-empty-catch-block-detection.md
   */
  isCatchBlockEffective(catchClause: ts.CatchClause): {
    isEmpty: boolean;
    hasConsoleOnly: boolean;
    hasCommentOnly: boolean;
    hasUserFeedback: boolean;
  } {
    const statements = catchClause.block.statements;

    if (statements.length === 0) {
      return {
        isEmpty: true,
        hasConsoleOnly: false,
        hasCommentOnly: false,
        hasUserFeedback: false,
      };
    }

    let hasConsole = false;
    let hasUserFeedback = false;
    let hasOtherStatements = false;

    for (const stmt of statements) {
      const stmtType = this.classifyStatement(stmt);

      if (stmtType === 'console') {
        hasConsole = true;
      } else if (this.isUserFeedbackStatement(stmt)) {
        hasUserFeedback = true;
      } else if (stmtType !== 'comment') {
        hasOtherStatements = true;
      }
    }

    return {
      isEmpty: false,
      hasConsoleOnly: hasConsole && !hasUserFeedback && !hasOtherStatements,
      hasCommentOnly: false, // TODO: detect comment-only blocks
      hasUserFeedback: hasUserFeedback,
    };
  }

  /**
   * Classifies a statement type
   */
  private classifyStatement(stmt: ts.Statement): 'console' | 'throw' | 'comment' | 'other' {
    // Check for console.* calls
    if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
      const callExpr = stmt.expression;
      if (ts.isPropertyAccessExpression(callExpr.expression)) {
        const obj = callExpr.expression.expression;
        if (ts.isIdentifier(obj) && obj.text === 'console') {
          return 'console';
        }
      }
    }

    // Check for throw statements
    if (ts.isThrowStatement(stmt)) {
      return 'throw';
    }

    return 'other';
  }

  /**
   * Checks if a statement provides user feedback
   */
  private isUserFeedbackStatement(stmt: ts.Statement): boolean {
    if (!ts.isExpressionStatement(stmt) || !ts.isCallExpression(stmt.expression)) {
      return false;
    }

    const callExpr = stmt.expression;
    const callText = callExpr.expression.getText(this.sourceFile);

    // User feedback patterns
    const userFeedbackPatterns = [
      'toast.',
      'setError',
      'showError',
      'alert(',
      'showNotification',
      'notify',
      'message.',
      'Toast.',
      'Notification.',
    ];

    return userFeedbackPatterns.some(pattern => callText.includes(pattern));
  }

  /**
   * Returns true when an await is "protected" by destructured error-tuple pattern.
   *
   * Recognizes Supabase's idiomatic pattern where the library never throws and
   * always returns `{ data, error }`. An `if (error)` check after the destructuring
   * is semantically equivalent to a try-catch for such libraries.
   *
   * Handles all four cases:
   *   - Shorthand:  const { error } = await ...
   *   - Combined:   const { data, error } = await ...
   *   - Aliased:    const { error: upsertError } = await ...
   *   - None:       const { data } = await ...  → returns false (violation still fires)
   */
  private isDestructuredErrorTupleProtected(
    awaitNode: ts.AwaitExpression,
    sourceFile: ts.SourceFile,
  ): boolean {
    // Walk up: AwaitExpression → parent should be VariableDeclaration
    const varDecl = awaitNode.parent;
    if (!varDecl || !ts.isVariableDeclaration(varDecl)) return false;

    const nameNode = varDecl.name;
    if (!ts.isObjectBindingPattern(nameNode)) return false;

    // Find the bound name for the "error" property.
    // Handles: { error }, { data, error }, { error: upsertError }
    let errorVarName: string | undefined;
    for (const element of nameNode.elements) {
      const propName = element.propertyName
        ? ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : undefined
        : ts.isIdentifier(element.name)
          ? element.name.text
          : undefined;

      if (propName === 'error') {
        // If there's a propertyName ('error: alias'), the binding name is the alias
        errorVarName = ts.isIdentifier(element.name) ? element.name.text : undefined;
        break;
      }
      // No propertyName means shorthand: { error } — binding name IS "error"
      if (!element.propertyName && ts.isIdentifier(element.name) && element.name.text === 'error') {
        errorVarName = 'error';
        break;
      }
    }

    if (!errorVarName) return false;

    // Navigate up: VariableDeclaration → VariableDeclarationList → VariableStatement
    const varDeclStatement = varDecl.parent?.parent;
    const block = varDeclStatement?.parent;
    if (!block || !ts.isBlock(block)) return false;

    const stmts = block.statements;
    const declIdx = stmts.findIndex(s => s === varDeclStatement);
    if (declIdx === -1) return false;

    // Look for an IfStatement after the declaration whose condition references errorVarName
    for (let i = declIdx + 1; i < stmts.length; i++) {
      const stmt = stmts[i];
      if (ts.isIfStatement(stmt)) {
        const condText = stmt.expression.getText(sourceFile);
        if (condText.includes(errorVarName)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Finds all catch blocks in a source file
   */
  findAllCatchBlocks(node: ts.Node): ts.CatchClause[] {
    const catchBlocks: ts.CatchClause[] = [];

    const visit = (n: ts.Node): void => {
      if (ts.isTryStatement(n) && n.catchClause) {
        catchBlocks.push(n.catchClause);
      }

      ts.forEachChild(n, visit);
    };

    visit(node);
    return catchBlocks;
  }
}
