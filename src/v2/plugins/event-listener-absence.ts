/**
 * Event Listener Absence Plugin
 *
 * Detects when a factory method (createClient, new WebSocket, etc.) is called
 * but required event listeners are NOT registered on the returned instance.
 *
 * Mirrors V1's EventListenerAnalyzer but as a V2 plugin.
 * Runs via afterTraversal() once the whole file has been walked.
 *
 * Example violations:
 *   const client = createClient(); // ← no client.on('error', ...) → violation
 *   const ws = new WebSocket(url); // ← no ws.on('error', ...)     → violation
 */

import * as ts from 'typescript';
import type { PackageContract, RequiredEventListener } from '../../types.js';
import { DetectorPlugin, PluginContext, NodeContext, Detection } from '../types/index.js';

interface TrackedCreation {
  varName: string;
  packageName: string;
  factoryMethodName: string;
  factoryCallNode: ts.Node;
  factoryCallPos: number; // position in source for scope-matching
  requiredListeners: RequiredEventListener[];
  attachedEvents: Set<string>;
}

/**
 * Absence-based event listener violation detector.
 *
 * Phase 1 (onVariableDeclaration): track instances created via factory methods
 *   or constructors that have required_event_listeners in their contract.
 * Phase 2 (onCallExpression): track .on('event', ...) calls on tracked instances.
 * Phase 3 (afterTraversal): emit missing-event-listener detections for any
 *   tracked instance that is still missing a required event listener.
 */
export class EventListenerAbsencePlugin implements DetectorPlugin {
  name = 'EventListenerAbsence';
  version = '1.0.0';
  description = 'Detects factory calls missing required .on("error") event listeners';

  private contracts: Map<string, PackageContract>;

  // Per-file state: list of all tracked creations (multiple per varName allowed for different scopes)
  private trackedCreations: TrackedCreation[] = [];
  // factoryToPackage and classToPackage built from contracts with required_event_listeners
  private factoryToPackage = new Map<string, string>();
  private classToPackage = new Map<string, string>();

  constructor(contracts: Map<string, PackageContract>) {
    this.contracts = contracts;
    this.buildLookupMaps();
  }

  private buildLookupMaps(): void {
    for (const [packageName, contract] of this.contracts.entries()) {
      if (!contract.detection?.required_event_listeners?.length) continue;
      const classNames = contract.detection.class_names ?? [];
      for (const factory of contract.detection.factory_methods ?? []) {
        // When a contract uses class_names for event-listener tracking (e.g. undici's WebSocket),
        // its factory_methods are typically stateless request functions (fetch, request, stream)
        // that DON'T return persistent connection objects needing error listeners.
        // Only add factory_methods to event-listener tracking when the contract has NO class_names
        // (e.g. redis: createClient() → connection object) or when the factory name itself
        // is connection-factory-like (starts with 'create', 'make', 'build', 'init', 'getInstance').
        if (classNames.length > 0 && !/^(create|make|build|init|getInstance)/i.test(factory)) {
          continue; // Skip non-constructor factory methods when class_names are present
        }
        this.factoryToPackage.set(factory, packageName);
      }
      for (const cls of classNames) {
        this.classToPackage.set(cls, packageName);
      }
    }
  }

  public beforeTraversal(sf: ts.SourceFile, ctx: PluginContext): void {
    this.trackedCreations = [];
    // Also scan class PropertyDeclaration initializers that create instances.
    // Pattern: class Foo { private client = createClient(); }
    // These are PropertyDeclaration nodes (not VariableDeclaration), so onVariableDeclaration
    // is never called for them. We pre-scan the file in beforeTraversal.
    this.walkPropertyDeclarations(sf, ctx.importMap);
  }

  private walkPropertyDeclarations(
    node: ts.Node,
    importMap: Map<string, { packageName: string; importedName: string }>
  ): void {
    if (ts.isPropertyDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const varName = node.name.text;
      this.trackCreation(varName, node.initializer, importMap);
    }
    ts.forEachChild(node, (child) => this.walkPropertyDeclarations(child, importMap));
  }

  /**
   * Phase 1: track variable declarations that create instances requiring event listeners.
   *
   * Patterns:
   *   const client = createClient(...)   → factory call
   *   const ws = new WebSocket(url)      → constructor
   *   const queue = new Queue('tasks')   → constructor
   */
  /**
   * Handle assignments that create instances requiring event listeners:
   *   this.field = createClient()    (PropertyAccessExpression on left)
   *   moduleVar = createClient()     (bare Identifier on left — module-level reassignment)
   *
   * Also handles DOM-style event listener property assignments:
   *   ws.onerror = handler           (varName.onEventName = ...)
   *   These complement the .on()/.addEventListener() tracking in onCallExpression.
   */
  public onBinaryExpression(node: ts.BinaryExpression, context: NodeContext): Detection[] {
    // Only handle assignments
    if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return [];

    const left = node.left;

    // Handle DOM-style event listener property assignments: ws.onerror = handler
    // Pattern: <identifier>.<onEventName> = <value>
    if (
      ts.isPropertyAccessExpression(left) &&
      ts.isIdentifier(left.expression)
    ) {
      const objName = left.expression.text;
      const propName = left.name.text;
      // Check if this is an event handler property (onerror, onclose, onmessage, onopen, etc.)
      if (propName.startsWith('on') && propName.length > 2) {
        const eventName = propName.slice(2); // 'onerror' → 'error'
        const assignPos = node.getStart();
        let bestMatch: TrackedCreation | null = null;
        for (const creation of this.trackedCreations) {
          if (creation.varName !== objName) continue;
          if (creation.factoryCallPos > assignPos) continue;
          if (!bestMatch || creation.factoryCallPos > bestMatch.factoryCallPos) {
            bestMatch = creation;
          }
        }
        if (bestMatch) {
          bestMatch.attachedEvents.add(eventName);
        }
        // Return early — ws.onerror = handler is not a factory creation, skip trackCreation
        return [];
      }
    }

    let varName: string;

    if (ts.isPropertyAccessExpression(left)) {
      // this.client = createClient() or ClassName.field = createClient()
      varName = left.name.text;
    } else if (ts.isIdentifier(left)) {
      // moduleClient = createClient() (bare variable reassignment)
      varName = left.text;
    } else {
      return [];
    }

    this.trackCreation(varName, node.right, context.importMap);
    return [];
  }

  public onVariableDeclaration(node: ts.VariableDeclaration, context: NodeContext): Detection[] {
    if (!node.initializer || !ts.isIdentifier(node.name)) return [];
    const varName = node.name.text;

    this.trackCreation(varName, node.initializer, context.importMap);
    return [];
  }

  /**
   * Walk a chained call expression to find the innermost factory call and collect any
   * event names that are already chained via .on() / .once() / .addListener().
   *
   * Example: createClient().on('error', fn).on('end', fn2)
   *   → factoryCall = createClient(), chainedEvents = Set { 'error', 'end' }
   *
   * Returns null if no known factory is found in the chain.
   */
  private unwrapChain(
    node: ts.Expression,
    importMap: Map<string, { packageName: string; importedName: string }>
  ): { factory: ts.CallExpression; packageName: string; factoryMethodName: string; chainedEvents: Set<string> } | null {
    const chainedEvents = new Set<string>();

    // Walk the chain: peel off .on('event', handler) calls from the outside in
    let cur: ts.Expression = node;
    while (
      ts.isCallExpression(cur) &&
      ts.isPropertyAccessExpression(cur.expression) &&
      ['on', 'once', 'addListener', 'addEventListener'].includes(cur.expression.name.text)
    ) {
      const firstArg = cur.arguments[0];
      if (firstArg && ts.isStringLiteral(firstArg)) {
        chainedEvents.add(firstArg.text);
      }
      cur = cur.expression.expression; // step into the object the .on() is called on
    }

    // Also unwrap await: await createClient()
    const inner = ts.isAwaitExpression(cur) && ts.isCallExpression(cur.expression)
      ? cur.expression
      : ts.isCallExpression(cur) ? cur : null;

    if (!inner) return null;

    const expr = inner.expression;

    // Direct call: createClient()
    if (ts.isIdentifier(expr)) {
      const funcName = expr.text;
      const pkg = this.factoryToPackage.get(funcName);
      if (pkg) {
        const importInfo = importMap.get(funcName);
        if (!importInfo || importInfo.packageName === pkg) {
          return { factory: inner, packageName: pkg, factoryMethodName: funcName, chainedEvents };
        }
      }
    }

    // Property call: redis.createClient()
    if (ts.isPropertyAccessExpression(expr)) {
      const methodName = expr.name.text;
      const pkg = this.factoryToPackage.get(methodName);
      if (pkg) {
        return { factory: inner, packageName: pkg, factoryMethodName: methodName, chainedEvents };
      }
    }

    return null;
  }

  /** Extract factory/constructor info from an initializer expression and push to trackedCreations. */
  private trackCreation(varName: string, init: ts.Expression, importMap: Map<string, { packageName: string; importedName: string }>): void {
    let packageName: string | null = null;
    let factoryMethodName: string | null = null;
    let factoryCallNode: ts.Node | null = null;

    // Unwrap chained .on() calls: createClient().on('error', fn) or createClient({ url }).on('error', fn)
    // This handles the common pattern where the error listener is chained directly at creation time.
    // Evidence: concern-2026-04-06-redis-10 — 7 FP instances in packages/api/src/main.ts where
    //           redis clients are created and error-listened in a single chained expression.
    const chainResult = this.unwrapChain(init, importMap);
    if (chainResult && chainResult.chainedEvents.size > 0) {
      // Factory found with at least one chained .on() event — track with pre-populated events
      const contract = this.contracts.get(chainResult.packageName);
      const requiredListeners = contract?.detection?.required_event_listeners;
      if (requiredListeners?.length) {
        this.trackedCreations.push({
          varName,
          packageName: chainResult.packageName,
          factoryMethodName: chainResult.factoryMethodName,
          factoryCallNode: chainResult.factory,
          factoryCallPos: chainResult.factory.getStart(),
          requiredListeners,
          attachedEvents: chainResult.chainedEvents,
        });
        return; // Already handled — don't fall through to plain factory detection
      }
    }

    // Unwrap: const x = await factory()
    const innerInit = ts.isAwaitExpression(init) && ts.isCallExpression(init.expression)
      ? init.expression
      : ts.isCallExpression(init) ? init : null;

    if (innerInit) {
      const expr = innerInit.expression;

      // Direct call: createClient()
      if (ts.isIdentifier(expr)) {
        const funcName = expr.text;
        const pkg = this.factoryToPackage.get(funcName);
        if (pkg) {
          // Verify the import source matches — prevents redis.createClient from
          // firing on supabase's createClient (same name, different package).
          const importInfo = importMap.get(funcName);
          if (!importInfo || importInfo.packageName === pkg) {
            packageName = pkg;
            factoryMethodName = funcName;
            factoryCallNode = innerInit;
          }
        }
      }

      // Property call: redis.createClient()
      if (ts.isPropertyAccessExpression(expr)) {
        const methodName = expr.name.text;
        const pkg = this.factoryToPackage.get(methodName);
        if (pkg) {
          packageName = pkg;
          factoryMethodName = methodName;
          factoryCallNode = innerInit;
        }
      }
    }

    // Constructor: new WebSocket(url)
    if (ts.isNewExpression(init) && ts.isIdentifier(init.expression)) {
      const className = init.expression.text;
      const pkg = this.classToPackage.get(className);
      if (pkg) {
        // Always check the importMap first — if the class is explicitly imported from a
        // different package, that import is authoritative and overrides classToPackage.
        // This prevents false positives when multiple packages export the same class name
        // (e.g., ws and undici both export `WebSocket`; ioredis and @upstash/redis both export `Redis`).
        const importInfo = importMap.get(className);
        if (importInfo && importInfo.packageName !== pkg) {
          // Class is explicitly imported from a different package — skip
        } else {
          // Either not imported explicitly (global), or imported from the expected package.
          // Also respect import_source if the contract specifies one.
          const contract = this.contracts.get(pkg);
          const importSource = contract?.detection?.import_source;
          if (importSource && importInfo && importInfo.packageName !== importSource) {
            // import_source mismatch — skip
          } else {
            packageName = pkg;
            factoryMethodName = className;
            factoryCallNode = init;
          }
        }
      }
    }

    if (!packageName || !factoryMethodName || !factoryCallNode) return;

    const contract = this.contracts.get(packageName);
    const requiredListeners = contract?.detection?.required_event_listeners;
    if (!requiredListeners?.length) return;

    this.trackedCreations.push({
      varName,
      packageName,
      factoryMethodName,
      factoryCallNode,
      factoryCallPos: factoryCallNode.getStart(),
      requiredListeners,
      attachedEvents: new Set(),
    });
  }

  /**
   * Phase 2: track .on('event', ...) calls on tracked instances.
   *
   * Patterns:
   *   client.on('error', handler)
   *   ws.addEventListener('error', handler)
   *   this.client.on('error', handler)
   */
  public onCallExpression(node: ts.CallExpression, _context: NodeContext): Detection[] { // eslint-disable-line @typescript-eslint/no-unused-vars
    if (!ts.isPropertyAccessExpression(node.expression)) return [];

    const methodName = node.expression.name.text;
    if (!['on', 'once', 'addEventListener', 'addListener'].includes(methodName)) return [];

    // Extract object name: client.on(...) → 'client'
    const obj = node.expression.expression;
    let varName: string | null = null;

    if (ts.isIdentifier(obj)) {
      varName = obj.text;
    } else if (ts.isPropertyAccessExpression(obj) && ts.isIdentifier(obj.name)) {
      // this.client.on(...) → 'client'
      varName = obj.name.text;
    }

    if (!varName) return [];

    // Extract event name from first argument
    const firstArg = node.arguments[0];
    if (!firstArg) return [];

    let eventName: string | null = null;
    if (ts.isStringLiteral(firstArg)) {
      eventName = firstArg.text;
    } else if (ts.isNoSubstitutionTemplateLiteral(firstArg)) {
      eventName = firstArg.text;
    }

    if (eventName) {
      // Mark the most recently declared instance with this varName that appears
      // before this .on() call. This handles multiple functions with same varName.
      const onCallPos = node.getStart();
      let bestMatch: TrackedCreation | null = null;
      for (const creation of this.trackedCreations) {
        if (creation.varName !== varName) continue;
        if (creation.factoryCallPos > onCallPos) continue; // declared after this .on() — skip
        if (!bestMatch || creation.factoryCallPos > bestMatch.factoryCallPos) {
          bestMatch = creation;
        }
      }
      if (bestMatch) {
        bestMatch.attachedEvents.add(eventName);
      }
    }

    return [];
  }

  /**
   * Phase 3: after traversal, emit detections for missing event listeners.
   */
  public afterTraversal(detections: Detection[], _context: PluginContext): void {
    for (const creation of this.trackedCreations) {
      for (const required of creation.requiredListeners) {
        if (!creation.attachedEvents.has(required.event)) {
          // Find the postcondition ID for this missing event
          const contract = this.contracts.get(creation.packageName);
          const funcContract = contract?.functions.find(
            (f) => f.name === creation.factoryMethodName
          );
          // Prefer error-severity postconditions (missing error listener is more severe
          // than syntax errors). Fall back to warning if no error-severity postcondition.
          const postcondition =
            funcContract?.postconditions?.find((p) => p.severity === 'error') ??
            funcContract?.postconditions?.find((p) => p.severity === 'warning');

          detections.push({
            pluginName: this.name,
            pattern: 'missing-event-listener',
            node: creation.factoryCallNode,
            packageName: creation.packageName,
            functionName: creation.factoryMethodName,
            confidence: 'high',
            metadata: {
              missingEvent: required.event,
              postconditionId: postcondition?.id ?? 'missing-error-listener',
            },
          });
        }
      }
    }
  }
}
