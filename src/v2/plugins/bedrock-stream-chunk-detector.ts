/**
 * Bedrock Stream Chunk Detector
 *
 * Detects `for await (const chunk of response.body)` loops over InvokeModelWithResponseStream
 * responses that are missing per-chunk error field checks.
 *
 * AWS Bedrock streaming responses include a discriminated union of chunk types.
 * When iterating response.body, each chunk may carry one of six error event fields:
 *   internalServerException, modelStreamErrorException, modelTimeoutException,
 *   serviceUnavailableException, throttlingException, validationException
 *
 * Failing to check these fields silently swallows stream errors.
 *
 * Postcondition: bedrock-invoke-model-stream-errors-not-checked
 * Evidence: concern-20260618-bedrock-deepen-1
 */

import * as ts from 'typescript';
import type { InstanceTrackerPlugin } from './instance-tracker.js';
import { DetectorPlugin, PluginContext, Detection } from '../types/index.js';

const PACKAGE_NAME = '@aws-sdk/client-bedrock-runtime';
const STREAM_COMMAND_CLASS = 'InvokeModelWithResponseStreamCommand';
const PATTERN = 'bedrock-stream-chunk-missing';
const POSTCONDITION_ID = 'bedrock-invoke-model-stream-errors-not-checked';
const FUNCTION_NAME = 'send';

/**
 * Required error-event field names that must appear (as property accesses on the
 * loop variable) somewhere inside the for-await-of body.
 */
const REQUIRED_ERROR_FIELDS = new Set([
  'internalServerException',
  'modelStreamErrorException',
  'modelTimeoutException',
  'serviceUnavailableException',
  'throttlingException',
  'validationException',
]);

interface TrackedResponseVar {
  /** The variable name that holds the awaited send() result, e.g. "response" */
  varName: string;
  /** The AST node of the variable declaration (used for line-number reporting) */
  declNode: ts.Node;
}

/**
 * BedrockStreamChunkDetector
 *
 * Phase 1 (onVariableDeclaration / beforeTraversal): track variables that hold
 *   the result of `await client.send(new InvokeModelWithResponseStreamCommand(...))`.
 * Phase 2 (afterTraversal): walk the source file for for-await-of loops over
 *   `<trackedVar>.body`.  For each loop, collect all property accesses on the
 *   chunk variable inside the loop body.  If any required error field is missing,
 *   emit a Detection.
 */
export class BedrockStreamChunkDetector implements DetectorPlugin {
  name = 'BedrockStreamChunkDetector';
  version = '1.0.0';
  description =
    'Detects for-await-of loops over Bedrock InvokeModelWithResponseStream response.body missing per-chunk error field checks';

  private instanceTracker: InstanceTrackerPlugin;
  /** Per-file: variables that are confirmed InvokeModelWithResponseStream responses */
  private trackedResponseVars: TrackedResponseVar[] = [];

  constructor(instanceTracker: InstanceTrackerPlugin) {
    this.instanceTracker = instanceTracker;
  }

  public beforeTraversal(_sf: ts.SourceFile, _ctx: PluginContext): void {
    this.trackedResponseVars = [];
  }

  public onVariableDeclaration(
    node: ts.VariableDeclaration,
    _ctx: PluginContext,
  ): Detection[] {
    // We're looking for:
    //   const response = await client.send(new InvokeModelWithResponseStreamCommand(...))
    if (!node.initializer) return [];

    const init = node.initializer;

    // Must be an AwaitExpression
    if (!ts.isAwaitExpression(init)) return [];
    const awaitedExpr = init.expression;

    // Must be a CallExpression: client.send(...)
    if (!ts.isCallExpression(awaitedExpr)) return [];

    // Callee must be a PropertyAccessExpression: <instance>.send
    const callee = awaitedExpr.expression;
    if (!ts.isPropertyAccessExpression(callee)) return [];
    if (callee.name.text !== 'send') return [];

    // The object must be a tracked @aws-sdk/client-bedrock-runtime instance
    const instanceExpr = callee.expression;
    if (!ts.isIdentifier(instanceExpr)) return [];
    const resolvedPkg = this.instanceTracker.resolveIdentifier(instanceExpr.text);
    if (resolvedPkg !== PACKAGE_NAME) return [];

    // The first argument must be `new InvokeModelWithResponseStreamCommand(...)`
    const args = awaitedExpr.arguments;
    if (args.length === 0) return [];
    const firstArg = args[0];
    if (!ts.isNewExpression(firstArg)) return [];
    const commandExpr = firstArg.expression;
    if (!ts.isIdentifier(commandExpr)) return [];
    if (commandExpr.text !== STREAM_COMMAND_CLASS) return [];

    // Capture the variable name
    if (!ts.isIdentifier(node.name)) return [];
    const varName = node.name.text;

    this.trackedResponseVars.push({ varName, declNode: node });
    return [];
  }

  public afterTraversal(detections: Detection[], context: PluginContext): void {
    if (this.trackedResponseVars.length === 0) return;

    const sf = context.sourceFile;
    const trackedNames = new Set(this.trackedResponseVars.map((v) => v.varName));

    // Walk the entire source file for for-await-of statements
    this.walkForForOfStatements(sf, trackedNames, detections);
  }

  /**
   * Recursively walk AST nodes looking for for-await-of statements whose
   * iterable is `<trackedVar>.body`.
   */
  private walkForForOfStatements(
    node: ts.Node,
    trackedNames: Set<string>,
    detections: Detection[],
  ): void {
    if (ts.isForOfStatement(node) && node.awaitModifier !== undefined) {
      const violation = this.checkForOfLoop(node, trackedNames);
      if (violation) {
        detections.push(violation);
      }
    }

    ts.forEachChild(node, (child) => {
      this.walkForForOfStatements(child, trackedNames, detections);
    });
  }

  /**
   * Check a single for-await-of statement.
   * Returns a Detection if:
   *   1. The iterable is `<trackedResponseVar>.body`
   *   2. The loop variable is a simple identifier (e.g. `chunk`)
   *   3. At least one of the 6 required error fields is NOT checked inside the body
   */
  private checkForOfLoop(
    forOf: ts.ForOfStatement,
    trackedNames: Set<string>,
  ): Detection | null {
    // iterable must be `<trackedVar>.body`
    const iterable = forOf.expression;
    if (!ts.isPropertyAccessExpression(iterable)) return null;
    if (iterable.name.text !== 'body') return null;

    const iterableObj = iterable.expression;
    if (!ts.isIdentifier(iterableObj)) return null;
    if (!trackedNames.has(iterableObj.text)) return null;

    // Loop variable must be a simple identifier: `for await (const chunk of ...)`
    const initializer = forOf.initializer;
    if (!ts.isVariableDeclarationList(initializer)) return null;
    if (initializer.declarations.length !== 1) return null;
    const loopVarDecl = initializer.declarations[0];
    if (!ts.isIdentifier(loopVarDecl.name)) return null;
    const loopVarName = loopVarDecl.name.text;

    // Collect all property accesses on the chunk variable inside the loop body
    const accessedFields = new Set<string>();
    this.collectPropertyAccesses(forOf.statement, loopVarName, accessedFields);

    // Check which required fields are missing
    const missingFields: string[] = [];
    for (const field of REQUIRED_ERROR_FIELDS) {
      if (!accessedFields.has(field)) {
        missingFields.push(field);
      }
    }

    if (missingFields.length === 0) return null;

    // Find the associated TrackedResponseVar for the specific response variable
    // to get the for-of loop node position (use the for-of statement as the report node)
    return {
      pluginName: this.name,
      pattern: PATTERN,
      node: forOf,
      packageName: PACKAGE_NAME,
      functionName: FUNCTION_NAME,
      confidence: "high",
      metadata: {
        postconditionId: POSTCONDITION_ID,
        missingFields,
        responseVarName: iterableObj.text,
        chunkVarName: loopVarName,
      },
    };
  }

  /**
   * Walk a subtree collecting all property accesses on a given identifier.
   * Example: for `chunk.throttlingException`, adds "throttlingException" to the set.
   * Also handles optional chaining: `chunk?.throttlingException`.
   */
  private collectPropertyAccesses(
    node: ts.Node,
    varName: string,
    result: Set<string>,
  ): void {
    // PropertyAccessExpression: chunk.fieldName or chunk?.fieldName
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isPropertyAccessChain(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === varName
    ) {
      result.add(node.name.text);
    }

    // ElementAccessExpression: chunk['fieldName'] or chunk?.['fieldName']
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === varName
    ) {
      const arg = node.argumentExpression;
      if (ts.isStringLiteral(arg)) {
        result.add(arg.text);
      }
    }

    ts.forEachChild(node, (child) => {
      this.collectPropertyAccesses(child, varName, result);
    });
  }
}
