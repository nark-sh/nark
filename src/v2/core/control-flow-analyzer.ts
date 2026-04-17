/**
 * Control Flow Analyzer
 *
 * Analyzes control flow to determine if code is properly protected by error handling.
 * Main responsibility: detecting if a node is inside a try-catch block.
 */

import * as ts from 'typescript';
import { ControlFlowAnalyzer as IControlFlowAnalyzer } from '../types/index.js';

/**
 * Control Flow Analysis
 *
 * Provides methods to analyze control flow in TypeScript AST.
 */
export class ControlFlowAnalysis implements IControlFlowAnalyzer {
  /**
   * Check if a node is inside a try-catch block
   *
   * @param node - The node to check
   * @returns True if node is in try block with a catch clause
   */
  public isInTryCatch(node: ts.Node): boolean {
    const tryStatement = this.getEnclosingTry(node);

    if (!tryStatement) {
      return false;
    }

    // Check if try statement has a catch clause
    return tryStatement.catchClause !== undefined;
  }

  /**
   * Get the enclosing try statement, if any
   *
   * @param node - The node to check
   * @returns The enclosing try statement, or undefined
   */
  public getEnclosingTry(node: ts.Node): ts.TryStatement | undefined {
    let current: ts.Node | undefined = node;

    while (current) {
      // Check if we're in a try block
      if (ts.isTryStatement(current)) {
        // Check if original node is in the try block (not catch or finally)
        if (this.isNodeInTryBlock(node, current)) {
          return current;
        }
      }

      current = current.parent;
    }

    return undefined;
  }

  /**
   * Check if a node is in the try block of a try statement
   * (not in catch or finally blocks)
   */
  private isNodeInTryBlock(node: ts.Node, tryStatement: ts.TryStatement): boolean {
    // Walk up from node to tryStatement
    let current: ts.Node | undefined = node;

    while (current && current !== tryStatement) {
      // If we encounter the catch or finally block first, node is not in try block
      if (current === tryStatement.catchClause || current === tryStatement.finallyBlock) {
        return false;
      }

      // If we encounter the try block, node is in try block
      if (current === tryStatement.tryBlock) {
        return true;
      }

      current = current.parent;
    }

    return false;
  }

  /**
   * Get the enclosing block (function, if, loop, etc.)
   *
   * @param node - The node to check
   * @returns The enclosing block, or undefined
   */
  public getEnclosingBlock(node: ts.Node): ts.Block | undefined {
    let current: ts.Node | undefined = node.parent;

    while (current) {
      if (ts.isBlock(current)) {
        return current;
      }
      current = current.parent;
    }

    return undefined;
  }

  /**
   * Check if a node is in a conditional branch
   *
   * @param node - The node to check
   * @returns True if node is in an if/else/switch/ternary
   */
  public isInConditional(node: ts.Node): boolean {
    let current: ts.Node | undefined = node;

    while (current) {
      if (
        ts.isIfStatement(current) ||
        ts.isConditionalExpression(current) ||
        ts.isSwitchStatement(current) ||
        ts.isCaseClause(current)
      ) {
        return true;
      }

      current = current.parent;
    }

    return false;
  }

  /**
   * Check if a function has explicit error handling
   *
   * Looks for:
   * - Try-catch blocks
   * - Error parameter checks (if (err) ...)
   * - .catch() calls on promises
   */
  public hasErrorHandling(node: ts.FunctionLikeDeclaration): boolean {
    let hasTryCatch = false;
    let hasErrorCheck = false;
    let hasCatchCall = false;

    const visit = (n: ts.Node): void => {
      // Check for try-catch
      if (ts.isTryStatement(n) && n.catchClause) {
        hasTryCatch = true;
      }

      // Check for error parameter checks (if (err) ...)
      if (ts.isIfStatement(n)) {
        const condition = n.expression;
        if (ts.isIdentifier(condition)) {
          const name = condition.text.toLowerCase();
          if (name === 'err' || name === 'error') {
            hasErrorCheck = true;
          }
        }
      }

      // Check for .catch() calls
      if (ts.isCallExpression(n)) {
        if (ts.isPropertyAccessExpression(n.expression)) {
          if (n.expression.name.text === 'catch') {
            hasCatchCall = true;
          }
        }
      }

      ts.forEachChild(n, visit);
    };

    if (node.body) {
      visit(node.body);
    }

    return hasTryCatch || hasErrorCheck || hasCatchCall;
  }

  /**
   * Find all try-catch blocks in a node
   *
   * @param node - The root node to search
   * @returns Array of try statements
   */
  public findTryCatchBlocks(node: ts.Node): ts.TryStatement[] {
    const tryStatements: ts.TryStatement[] = [];

    const visit = (n: ts.Node): void => {
      if (ts.isTryStatement(n)) {
        tryStatements.push(n);
      }
      ts.forEachChild(n, visit);
    };

    visit(node);
    return tryStatements;
  }

  /**
   * Check if a call expression is awaited
   *
   * @param node - The call expression to check
   * @returns True if the call is awaited
   */
  public isAwaited(node: ts.CallExpression): boolean {
    const parent = node.parent;

    if (!parent) {
      return false;
    }

    // Check if parent is an await expression
    if (ts.isAwaitExpression(parent)) {
      return true;
    }

    // Check if parent is a return statement (return await is redundant but valid)
    if (ts.isReturnStatement(parent)) {
      return false; // Not awaited directly, but returned
    }

    return false;
  }

  /**
   * Get the catch clause enclosing a node (if any).
   *
   * Returns the catch clause of the innermost try statement that contains this node
   * in its try block. Returns undefined if the node is not inside a try-catch.
   */
  public getEnclosingCatchClause(node: ts.Node): ts.CatchClause | undefined {
    const tryStatement = this.getEnclosingTry(node);
    return tryStatement?.catchClause;
  }

  /**
   * Checks if a catch block checks whether error.response exists before accessing it.
   *
   * Looks for:
   * - `if (error.response)` — direct truthy check
   * - `if (!error.response)` — negated check
   * - `error.response?.status` — optional chaining
   * - `error.response && ...` — guard expression
   */
  public catchChecksResponseExists(catchClause: ts.CatchClause): boolean {
    let found = false;

    const visit = (node: ts.Node) => {
      // if (error.response) or if (error.response && ...)
      if (ts.isIfStatement(node)) {
        if (this.expressionChecksResponse(node.expression)) {
          found = true;
        }
      }

      // Optional chaining: error.response?.status
      if (ts.isPropertyAccessExpression(node) && node.questionDotToken) {
        if (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'response') {
          found = true;
        }
      }

      if (!found) ts.forEachChild(node, visit);
    };

    visit(catchClause.block);
    return found;
  }

  private expressionChecksResponse(node: ts.Expression): boolean {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'response') return true;
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      if (ts.isPropertyAccessExpression(node.operand) && node.operand.name.text === 'response') return true;
    }
    if (ts.isBinaryExpression(node)) {
      return this.expressionChecksResponse(node.left) || this.expressionChecksResponse(node.right);
    }
    if (ts.isParenthesizedExpression(node)) {
      return this.expressionChecksResponse(node.expression);
    }
    return false;
  }

  /**
   * Checks if a catch block inspects the HTTP status code (error.response.status).
   */
  public catchChecksStatusCode(catchClause: ts.CatchClause): boolean {
    let found = false;

    const visit = (node: ts.Node) => {
      // error.response.status
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'status') {
        const expr = node.expression;
        if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'response') {
          found = true;
        }
      }
      if (!found) ts.forEachChild(node, visit);
    };

    visit(catchClause.block);
    return found;
  }

  /**
   * Extracts which HTTP status codes are explicitly handled in a catch block.
   * Looks for patterns like: error.response.status === 429
   */
  public extractHandledStatusCodes(catchClause: ts.CatchClause): number[] {
    const codes: number[] = [];

    const visit = (node: ts.Node) => {
      if (ts.isBinaryExpression(node) &&
          (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
           node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken)) {
        if (ts.isNumericLiteral(node.right)) {
          const code = parseInt(node.right.text, 10);
          if (code >= 100 && code < 600) codes.push(code);
        }
        if (ts.isNumericLiteral(node.left)) {
          const code = parseInt(node.left.text, 10);
          if (code >= 100 && code < 600) codes.push(code);
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(catchClause.block);
    return codes;
  }

  /**
   * Checks if a catch block has retry logic (exponential backoff, retry loops, etc.).
   * Uses text-based heuristics on the catch block's text content.
   */
  public catchHasRetryLogic(catchClause: ts.CatchClause): boolean {
    const text = catchClause.getText().toLowerCase();
    return text.includes('retry') ||
           text.includes('backoff') ||
           text.includes('attempt') ||
           (text.includes('settimeout') && text.includes('delay'));
  }

  /**
   * Checks if the result of a call node is null-guarded in the containing function scope.
   *
   * Returns true if:
   * 1. The call result is assigned to a variable AND there's an explicit if(!var)/if(var === null) guard, OR
   * 2. The call result variable is ONLY accessed via optional chaining (var?.prop) — never as var.prop
   *
   * Used for postconditions like current-user-null-not-handled where null-check (not try-catch) is required.
   */
  /**
   * Returns true if the call result is considered null-guarded (skip the null-check violation).
   *
   * Strategy mirrors V1: only fire when there is a direct non-optional property access on the
   * result variable without an explicit null guard. If the result is passed to a function,
   * returned, or only accessed via optional chaining, consider it safe.
   *
   * Returns true (guarded/skip) when:
   *   - Direct return (no variable) — can't detect null usage
   *   - No variable assigned (destructuring etc.) — skip
   *   - No non-optional property access on the variable found in scope
   *   - OR explicit if(!var)/if(var===null) guard found
   */
  public isResultNullGuarded(callNode: ts.Node): boolean {
    // Skip past AwaitExpression wrapping the call
    let resultNode: ts.Node = callNode;
    if (callNode.parent && ts.isAwaitExpression(callNode.parent)) {
      resultNode = callNode.parent;
    }

    // Direct return (return await fn()) — result not null-checked, should fire
    if (resultNode.parent && ts.isReturnStatement(resultNode.parent)) return false;

    // Get variable name from assignment: const x = await fn()
    const varName = this.getAssignedVariableName(resultNode);
    if (!varName) return true; // Destructuring or other — can't track, skip

    // Get the containing function body block
    const funcBody = this.getContainingFunctionBody(resultNode);
    if (!funcBody) return true; // Can't analyze — skip

    // If there's an explicit null guard, it's guarded
    if (this.hasExplicitNullGuard(varName, funcBody)) return true;

    // Only fire if there's a non-optional direct property access: user.property (not user?.property)
    // If the variable is only passed to functions, returned, or used with ?. — skip
    return !this.hasNonOptionalPropertyAccess(varName, funcBody);
  }

  /**
   * Returns true if the call result is explicitly null-guarded (if (x == null) etc.)
   * but the result IS also accessed with non-optional property access somewhere.
   * Used to distinguish "guarded against null" from "result never accessed as object".
   */
  public isResultExplicitlyNullGuarded(callNode: ts.Node): boolean {
    let resultNode: ts.Node = callNode;
    if (callNode.parent && ts.isAwaitExpression(callNode.parent)) {
      resultNode = callNode.parent;
    }
    if (resultNode.parent && ts.isReturnStatement(resultNode.parent)) return false;
    const varName = this.getAssignedVariableName(resultNode);
    if (!varName) return false;
    const funcBody = this.getContainingFunctionBody(resultNode);
    if (!funcBody) return false;
    return this.hasExplicitNullGuard(varName, funcBody);
  }

  /** Returns true if varName is accessed with non-optional property access (var.prop, not var?.prop) */
  private hasNonOptionalPropertyAccess(varName: string, scope: ts.Node): boolean {
    let found = false;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (ts.isPropertyAccessExpression(node) &&
          ts.isIdentifier(node.expression) && node.expression.text === varName &&
          !node.questionDotToken) {
        found = true; return;
      }
      if (ts.isElementAccessExpression(node) &&
          ts.isIdentifier(node.expression) && node.expression.text === varName &&
          !node.questionDotToken) {
        found = true; return;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(scope, visit);
    return found;
  }

  /** Extract the identifier name if node is assigned: const varName = node */
  private getAssignedVariableName(node: ts.Node): string | null {
    if (node.parent &&
        ts.isVariableDeclaration(node.parent) &&
        ts.isIdentifier(node.parent.name)) {
      return node.parent.name.text;
    }
    return null;
  }

  /** Get the innermost function body block containing the given node. */
  private getContainingFunctionBody(node: ts.Node): ts.Block | null {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isBlock(current)) {
        const parent = current.parent;
        if (parent && (ts.isFunctionDeclaration(parent) ||
            ts.isFunctionExpression(parent) ||
            ts.isArrowFunction(parent) ||
            ts.isMethodDeclaration(parent))) {
          return current;
        }
      }
      current = current.parent;
    }
    return null;
  }

  /**
   * Returns true if the given identifier is checked for null/undefined
   * via an if(!varName), if(varName === null), or if(varName == null) statement.
   */
  private hasExplicitNullGuard(varName: string, scope: ts.Node): boolean {
    let found = false;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (ts.isIfStatement(node)) {
        const cond = node.expression;
        // if (!varName)
        if (ts.isPrefixUnaryExpression(cond) &&
            cond.operator === ts.SyntaxKind.ExclamationToken &&
            ts.isIdentifier(cond.operand) && cond.operand.text === varName) {
          found = true; return;
        }
        // if (varName === null) or if (varName == null)
        if (ts.isBinaryExpression(cond) &&
            ts.isIdentifier(cond.left) && cond.left.text === varName &&
            (cond.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
             cond.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) &&
            cond.right.kind === ts.SyntaxKind.NullKeyword) {
          found = true; return;
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(scope, visit);
    return found;
  }


  /**
   * Check if a call expression has an `onError` callback in any of its options arguments.
   *
   * Handles React Query patterns like:
   *   useMutation(fn, { onError: (err) => toast.error(...) })
   *   useQuery(key, fn, { onError: handler })
   *   useMutation({ mutationFn: fn, onError: handler })
   *
   * @param node - The call expression to check
   * @returns True if any argument object literal contains an `onError` property
   */
  public hasOnErrorInOptions(node: ts.CallExpression): boolean {
    for (const arg of node.arguments) {
      if (!ts.isObjectLiteralExpression(arg)) continue;
      for (const prop of arg.properties) {
        let propName: string | undefined;
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
          propName = prop.name.text;
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          propName = prop.name.text;
        } else if (ts.isMethodDeclaration(prop) && ts.isIdentifier(prop.name)) {
          propName = prop.name.text;
        }
        if (propName === 'onError') return true;
      }
    }
    return false;
  }

  /**
   * Returns true when a call (or chained call) is "protected" by Supabase's
   * idiomatic destructured-error-tuple pattern.
   *
   * Supabase's client never throws — it returns `{ data, error }` tuples.
   * A subsequent `if (error)` check is semantically equivalent to a try-catch.
   *
   * Works for:
   *   const { error: upsertError } = await supabase.from(...).upsert(...);
   *   if (upsertError) throw new Error(...);
   *
   *   const { data, error } = await supabase.from(...).select('*');
   *   if (error) { ... }
   *
   * @param callNode - The detection node (may be an intermediate chained call)
   * @param sourceFile - The source file for text extraction
   * @returns True if the await result is destructured with error + checked in if
   */
  public isDestructuredErrorTupleProtected(
    callNode: ts.Node,
    sourceFile: ts.SourceFile,
  ): boolean {
    // Walk up through chained CallExpressions / PropertyAccessExpressions to find AwaitExpression
    let current: ts.Node = callNode;
    let awaitNode: ts.AwaitExpression | undefined;

    while (current.parent) {
      const parent = current.parent;
      if (ts.isAwaitExpression(parent)) {
        awaitNode = parent;
        break;
      }
      // Stop if we leave the call-chain context (entered a statement, block, etc.)
      if (
        ts.isVariableDeclaration(parent) ||
        ts.isExpressionStatement(parent) ||
        ts.isBlock(parent) ||
        ts.isReturnStatement(parent)
      ) {
        break;
      }
      current = parent;
    }

    if (!awaitNode) return false;

    // The await's parent should be a VariableDeclaration with ObjectBindingPattern
    const varDecl = awaitNode.parent;
    if (!varDecl || !ts.isVariableDeclaration(varDecl)) return false;

    const nameNode = varDecl.name;
    if (!ts.isObjectBindingPattern(nameNode)) return false;

    // Find the bound name for the "error" property
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
        errorVarName = ts.isIdentifier(element.name) ? element.name.text : undefined;
        break;
      }
      if (!element.propertyName && ts.isIdentifier(element.name) && element.name.text === 'error') {
        errorVarName = 'error';
        break;
      }
    }

    if (!errorVarName) return false;

    // Navigate up: VariableDeclaration → VariableDeclarationList → VariableStatement → Block
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
   * Check if a call expression has .catch() chained
   *
   * @param node - The call expression to check
   * @returns True if .catch() is called on the result
   */
  public hasCatchHandler(node: ts.CallExpression): boolean {
    const parent = node.parent;

    if (!parent) {
      return false;
    }

    // Pattern A: node is the callee object of a property access: node.catch(...)
    // AST: node (CallExpression) → PropertyAccessExpression (node.catch) → CallExpression (node.catch(...))
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      const propName = parent.name.text;
      if (propName === 'catch') return true;
      // .then(successFn, errorFn) — two-argument then
      if (propName === 'then') {
        const grandParent = parent.parent;
        if (ts.isCallExpression(grandParent) && grandParent.arguments.length >= 2) {
          return true;
        }
        // .then(fn).catch(fn) — single-arg then followed by .catch()
        // Walk the chain: grandParent is the .then(fn) call, check if it has a .catch() next
        if (ts.isCallExpression(grandParent)) {
          if (this.chainHasCatch(grandParent)) return true;
        }
      }
    }

    // Pattern B: parent is the .catch(...) / .then(...) CallExpression itself
    // (node was passed as argument, not chained — less common but keep for compat)
    if (ts.isCallExpression(parent)) {
      if (ts.isPropertyAccessExpression(parent.expression)) {
        const propertyName = parent.expression.name.text;
        if (propertyName === 'catch') {
          return true;
        }
        if (propertyName === 'then' && parent.arguments.length >= 2) {
          return true; // .then() with error handler
        }
      }
    }

    return false;
  }

  /**
   * Checks if a specific argument to a call expression is an async function.
   *
   * Used to suppress async-submit-unhandled-error on sync handleSubmit callbacks.
   * A callback is considered async if:
   *   - It uses the `async` keyword (async () => {}, async function() {})
   *   - OR its return type annotation explicitly includes Promise
   *
   * @param callNode - The call expression (e.g., form.handleSubmit(onSubmit))
   * @param argIndex - The argument position to check (0 = first argument)
   * @returns True if the argument at argIndex is an async function literal
   */
  public isCallbackArgAsync(callNode: ts.CallExpression, argIndex: number): boolean {
    const arg = callNode.arguments[argIndex];
    if (!arg) return false;

    // Direct inline async function: handleSubmit(async (data) => { ... })
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
      return arg.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
    }

    // Identifier reference: const onSubmit = async (...) => {}; handleSubmit(onSubmit)
    // Walk up from the call expression to find the variable declaration for this identifier
    if (ts.isIdentifier(arg)) {
      const varName = arg.text;
      // Search in the enclosing function body for a declaration of this variable
      const funcBody = this.getContainingFunctionBody(callNode);
      if (!funcBody) return false;
      return this.isFunctionVariableAsync(varName, funcBody);
    }

    return false;
  }

  /**
   * Searches a scope for a variable declaration with the given name and checks
   * whether the initializer is an async function.
   */
  private isFunctionVariableAsync(varName: string, scope: ts.Node): boolean {
    let found = false;

    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) && node.name.text === varName &&
          node.initializer) {
        const init = node.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          found = init.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(scope);
    return found;
  }

  /**
   * Checks if the body of a function argument is fully wrapped in a try-catch.
   *
   * "Fully wrapped" means the function body block contains exactly one statement,
   * which is a try-catch (with a catch clause), and ALL other statements (if any)
   * are effectively unreachable (i.e., only a single top-level try-catch block).
   * More precisely: the function body's first statement is a try-catch, and the
   * try block contains all the real code.
   *
   * This recognizes the pattern:
   *   const onSubmit = async (data) => {
   *     try { await api.call(data); } catch (e) { toast.error(...); }
   *   }
   *
   * @param callNode - The call expression (e.g., form.handleSubmit(onSubmit))
   * @param argIndex - The argument position to inspect
   * @returns True if the argument function's body is fully wrapped in try-catch
   */
  public isCallbackBodyFullyWrappedInTryCatch(callNode: ts.CallExpression, argIndex: number): boolean {
    const arg = callNode.arguments[argIndex];
    if (!arg) return false;

    // Direct inline function: check its body directly
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
      return this.isFunctionBodyFullyWrappedInTryCatch(arg);
    }

    // Identifier reference: find the declaration and check its body
    if (ts.isIdentifier(arg)) {
      const varName = arg.text;
      const funcBody = this.getContainingFunctionBody(callNode);
      if (!funcBody) return false;
      return this.isNamedFunctionBodyFullyWrappedInTryCatch(varName, funcBody);
    }

    return false;
  }

  /**
   * Checks if a function-like node's body is fully wrapped in a single top-level try-catch.
   */
  private isFunctionBodyFullyWrappedInTryCatch(func: ts.ArrowFunction | ts.FunctionExpression): boolean {
    const body = func.body;
    if (!body || !ts.isBlock(body)) return false;
    return this.blockIsFullyWrappedInTryCatch(body);
  }

  /**
   * Checks if the body of a named function variable is fully wrapped in try-catch.
   */
  private isNamedFunctionBodyFullyWrappedInTryCatch(varName: string, scope: ts.Node): boolean {
    let result = false;

    const visit = (node: ts.Node): void => {
      if (result) return;
      if (ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) && node.name.text === varName &&
          node.initializer) {
        const init = node.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          result = this.isFunctionBodyFullyWrappedInTryCatch(init);
        } else if (ts.isFunctionDeclaration(init)) {
          // Shouldn't normally happen (function declaration as initializer) but guard anyway
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(scope);
    return result;
  }

  /**
   * Checks if a block (function body) consists of a single top-level try-catch statement
   * covering all the real code.
   *
   * Accepts blocks where the first (and only meaningful) statement is a TryStatement
   * that has a catch clause. Variable declarations and synchronous (non-await) expression
   * statements before and after the try are permitted — these are UI setup/teardown patterns
   * like setLoading(true) or toast.dismiss() that don't affect the async error boundary.
   *
   * The key criterion: no `await` expression exists OUTSIDE the try block. If all async
   * operations are inside the try-catch, the postcondition is satisfied.
   *
   * Pattern 1 — single statement:
   *   { try { ... } catch (e) { ... } }
   *
   * Pattern 2 — declarations then try:
   *   { let x; try { x = await ...; } catch (e) { ... } }
   *
   * Pattern 3 — sync setup/teardown around try-catch (new, concern-20260402-react-hook-form-5):
   *   { setLoading(true); try { await api.call(data); } catch (e) { toast.error(e.message); } setLoading(false); }
   *
   * Evidence: concern-20260402-react-hook-form-5 — 60 FP instances across 15 auth/settings forms
   * where setLoading() or similar sync calls appear before/after the try-catch block.
   */
  private blockIsFullyWrappedInTryCatch(block: ts.Block): boolean {
    const stmts = block.statements;
    if (stmts.length === 0) return false;

    // Find the first TryStatement
    const tryIdx = stmts.findIndex(s => ts.isTryStatement(s));
    if (tryIdx === -1) return false;

    const tryStmt = stmts[tryIdx] as ts.TryStatement;
    if (!tryStmt.catchClause) return false;

    // Verify no `await` expression exists outside the try block.
    // Check all statements before and after the try statement.
    const stmtsOutsideTry = [
      ...stmts.slice(0, tryIdx),
      ...stmts.slice(tryIdx + 1),
    ];

    for (const stmt of stmtsOutsideTry) {
      if (this.statementContainsAwait(stmt)) {
        return false; // Unprotected await found outside the try block
      }
    }

    return true;
  }

  /**
   * Checks whether a statement node contains any `await` expression at the top level
   * (not nested inside a new function boundary).
   */
  private statementContainsAwait(stmt: ts.Statement): boolean {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isAwaitExpression(node)) {
        found = true;
        return;
      }
      // Do not descend into new function boundaries — a nested async function's
      // await does not affect the outer function's error handling requirements.
      if (
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node)
      ) {
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(stmt);
    return found;
  }

  /**
   * Walks a promise chain to check if a .catch() handler exists.
   * Handles: expr.then(fn).catch(fn), expr.then(fn).finally(fn).catch(fn), etc.
   * Limited to 5 levels to avoid performance issues.
   */
  private chainHasCatch(node: ts.CallExpression, depth = 0): boolean {
    if (depth > 5) return false;
    const parent = node.parent;
    if (!parent) return false;

    // node.catch(...) → parent is PropertyAccessExpression with name 'catch'
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      if (parent.name.text === 'catch') return true;
      // Continue traversing: node.then(...), node.finally(...)
      const grandParent = parent.parent;
      if (ts.isCallExpression(grandParent)) {
        return this.chainHasCatch(grandParent, depth + 1);
      }
    }

    return false;
  }
}
