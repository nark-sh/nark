/**
 * Instance Tracker Plugin
 *
 * Tracks factory method calls and class instantiations to resolve
 * variable names back to their originating package.
 *
 * This allows other plugins (ThrowingFunctionDetector, PropertyChainDetector)
 * to detect calls on instances created by factory methods or constructors.
 *
 * Examples tracked:
 *   - const prisma = new PrismaClient()         → prisma → @prisma/client
 *   - const stripe = new Stripe(key)            → stripe → stripe
 *   - const client = createClient(url, key)     → client → @supabase/supabase-js
 *   - const instance = await factory.create()   → instance → some-package
 */

import * as ts from 'typescript';
import { DetectorPlugin, PluginContext, NodeContext, Detection } from '../types/index.js'; // eslint-disable-line @typescript-eslint/no-unused-vars

/**
 * Instance Tracker Plugin
 *
 * Tracks which variable names correspond to which package instances.
 * Exposes resolveIdentifier() for other plugins to query.
 */
export class InstanceTrackerPlugin implements DetectorPlugin {
  name = 'InstanceTracker';
  version = '1.0.0';
  description = 'Tracks factory method calls and class instances to resolve variable → package';

  private instanceMap = new Map<string, string>(); // variable name → package name
  private instanceTypeMap = new Map<string, string>(); // variable name → type/class name
  private factoryToPackage: Map<string, string>; // factory method name → package name
  private classToPackage: Map<string, string>; // class name → package name
  private typeToPackage: Map<string, string>; // type name → package name
  /**
   * Promise-factory methods: factory functions whose result has a `.promise` property.
   * Pattern: `const doc = await getDocument(src).promise`
   * When getDocument is in this map (pdfjs-dist), `doc` is tracked as pdfjs-dist.
   */
  private promiseFactoryToPackage: Map<string, string>;
  /**
   * Instance chain methods: methods on tracked instances that return another tracked instance.
   * Pattern: `const page = await doc.getPage(1)` where doc is a tracked pdfjs-dist instance.
   * When getPage is in this map (pdfjs-dist) AND doc is tracked as pdfjs-dist, `page` is also tracked.
   */
  private instanceChainMethodToPackage: Map<string, string>;

  constructor(
    factoryToPackage: Map<string, string>,
    classToPackage: Map<string, string>,
    typeToPackage?: Map<string, string>,
    promiseFactoryToPackage?: Map<string, string>,
    instanceChainMethodToPackage?: Map<string, string>,
  ) {
    this.factoryToPackage = factoryToPackage;
    this.classToPackage = classToPackage;
    this.typeToPackage = typeToPackage ?? new Map();
    this.promiseFactoryToPackage = promiseFactoryToPackage ?? new Map();
    this.instanceChainMethodToPackage = instanceChainMethodToPackage ?? new Map();
  }

  /**
   * Reset instance tracking and pre-populate from type annotations.
   *
   * Walks the source file to find all parameters and variables typed as known
   * package types (e.g., msg: Message → discord.js, channel: TextChannel → discord.js).
   * This is the V2 equivalent of V1's type-aware detection via typeChecker.getTypeAtLocation().
   */
  public beforeTraversal(sf: ts.SourceFile, ctx: PluginContext): void {
    this.instanceMap.clear();
    this.instanceTypeMap.clear();
    if (this.typeToPackage.size > 0) {
      // Only register type names whose package is confirmed by the file's import map.
      // This prevents mapping `Socket` → socket.io when the file imports it from socket.io-client.
      const confirmedTypes = new Map<string, string>(); // typeName → packageName
      for (const [typeName, contractPkg] of this.typeToPackage.entries()) {
        const importInfo = ctx.importMap.get(typeName);
        if (importInfo && importInfo.packageName === contractPkg) {
          confirmedTypes.set(typeName, contractPkg);
        }
      }
      if (confirmedTypes.size > 0) {
        this.walkTypeAnnotations(sf, confirmedTypes);
      }
    }

    // Also scan class PropertyDeclaration initializers (not covered by onVariableDeclaration).
    // Pattern: class Foo { private db = new PrismaClient(); }
    // These are ts.PropertyDeclaration nodes (not VariableDeclaration), so they're not
    // visited by onVariableDeclaration. We pre-scan the file to track them.
    this.walkPropertyDeclarationInitializers(sf, ctx);
  }

  /**
   * Walk source file for class property declarations with initializers and track
   * any that create package instances (new SomeClass() or factory calls).
   *
   * Example: class Repo { private db = new PrismaClient() }
   *   → tracks 'db' → '@prisma/client'
   */
  private walkPropertyDeclarationInitializers(node: ts.Node, ctx: PluginContext): void {
    if (ts.isPropertyDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const varName = node.name.text;
      const init = node.initializer;

      // Build a minimal NodeContext for the existing resolve* helpers
      const nodeCtx: NodeContext = { ...ctx, node, depth: 0 };

      // new SomeClass()
      if (ts.isNewExpression(init)) {
        const pkg = this.resolveNewExpression(init, nodeCtx);
        if (pkg) this.instanceMap.set(varName, pkg);
      }

      // factory call: createClient(...)
      if (ts.isCallExpression(init)) {
        const pkg = this.resolveFactoryCall(init, nodeCtx);
        if (pkg) this.instanceMap.set(varName, pkg);
      }

      // await factory(): class Repo { private db = await createClient() }
      if (ts.isAwaitExpression(init) && ts.isCallExpression(init.expression)) {
        const pkg = this.resolveFactoryCall(init.expression, nodeCtx);
        if (pkg) this.instanceMap.set(varName, pkg);
      }
    }
    ts.forEachChild(node, (child) => this.walkPropertyDeclarationInitializers(child, ctx));
  }

  /**
   * Walk the source file and register any identifier whose TypeScript type annotation
   * resolves to a known package type name.
   *
   * Handles:
   *   - Function parameters:          async fn(msg: Message)
   *   - Arrow function parameters:    (msg: Message) => ...
   *   - Variable declarations:        const channel: TextChannel = getChannel()
   *   - Class properties:             private channel: TextChannel;
   *   - Constructor params w/ mod:    constructor(private msg: Message)
   */
  private walkTypeAnnotations(node: ts.Node, importedTypes: Map<string, string>): void {
    // Function/method/arrow parameters
    if (ts.isParameter(node) && node.name && node.type && ts.isIdentifier(node.name)) {
      const varName = node.name.text;
      const result = this.resolveTypeAnnotationWithName(node.type, importedTypes);
      if (result) {
        this.instanceMap.set(varName, result.pkg);
        this.instanceTypeMap.set(varName, result.typeName);
      }
    }

    // Variable declarations with explicit type: const x: SomeType = ...
    if (ts.isVariableDeclaration(node) && node.type && ts.isIdentifier(node.name)) {
      const varName = node.name.text;
      const result = this.resolveTypeAnnotationWithName(node.type, importedTypes);
      if (result) {
        this.instanceMap.set(varName, result.pkg);
        this.instanceTypeMap.set(varName, result.typeName);
      }
    }

    // Class property declarations: private channel: TextChannel;
    if (ts.isPropertyDeclaration(node) && node.type && ts.isIdentifier(node.name)) {
      const varName = node.name.text;
      const result = this.resolveTypeAnnotationWithName(node.type, importedTypes);
      if (result) {
        this.instanceMap.set(varName, result.pkg);
        this.instanceTypeMap.set(varName, result.typeName);
      }
    }

    ts.forEachChild(node, (child) => this.walkTypeAnnotations(child, importedTypes));
  }

  /**
   * Resolve a TypeScript type node to both a package name and the type name.
   * Used to populate instanceTypeMap for class-level disambiguation (e.g.,
   * channel: GuildChannel → pkg='discord.js', typeName='GuildChannel').
   */
  private resolveTypeAnnotationWithName(
    typeNode: ts.TypeNode,
    importedTypes: Map<string, string>
  ): { pkg: string; typeName: string } | null {
    if (ts.isTypeReferenceNode(typeNode)) {
      const name = typeNode.typeName;
      if (ts.isIdentifier(name)) {
        const pkg = importedTypes.get(name.text);
        if (pkg) return { pkg, typeName: name.text };
      }
      if (ts.isQualifiedName(name) && ts.isIdentifier(name.right)) {
        const pkg = importedTypes.get(name.right.text);
        if (pkg) return { pkg, typeName: name.right.text };
      }
    }
    if (ts.isUnionTypeNode(typeNode)) {
      for (const t of typeNode.types) {
        const result = this.resolveTypeAnnotationWithName(t, importedTypes);
        if (result) return result;
      }
    }
    return null;
  }

  /**
   * Look up the type/class name for a tracked identifier.
   * Returns the class name (e.g., 'GuildChannel', 'Message') if the variable was
   * tracked from a typed declaration. Returns null if type info isn't available.
   *
   * Used by the ContractMatcher to disambiguate contracts with the same function name
   * on different classes (e.g., discord.js Message.delete vs GuildChannel.delete).
   */
  public resolveIdentifierTypeName(varName: string): string | null {
    return this.instanceTypeMap.get(varName) ?? null;
  }

  /**
   * Track variable declarations that create instances via new or factory calls.
   *
   * Patterns handled:
   *   const x = new SomeClass()           → class-based tracking
   *   const x = someImport.create()       → factory method tracking
   *   const x = await someImport.create() → async factory method tracking
   */
  public onVariableDeclaration(node: ts.VariableDeclaration, context: NodeContext): Detection[] {
    if (!node.initializer) {
      return [];
    }

    const varName = this.getVarName(node);
    if (!varName) {
      return [];
    }

    const init = node.initializer;

    // Case 1: new SomeClass()
    if (ts.isNewExpression(init)) {
      const packageName = this.resolveNewExpression(init, context);
      if (packageName) {
        this.instanceMap.set(varName, packageName);
      }
      return [];
    }

    // Case 2: someImport.factory() - direct call
    if (ts.isCallExpression(init)) {
      const packageName = this.resolveFactoryCall(init, context);
      if (packageName) {
        this.instanceMap.set(varName, packageName);
        return [];
      }
      // Case 2b: schema factory (z.object(), z.string(), etc.) — chained schema methods
      // The result is also a schema instance so also track it.
      const schemaPackage = this.resolveSchemaChainFactory(init, context);
      if (schemaPackage) {
        this.instanceMap.set(varName, schemaPackage);
        return [];
      }
      // Fall through to Case 3d (trackedInstance.chainMethod()) if no factory match
    }

    // Case 3: await someImport.factory() - async call
    if (ts.isAwaitExpression(init) && ts.isCallExpression(init.expression)) {
      const packageName = this.resolveFactoryCall(init.expression, context);
      if (packageName) {
        this.instanceMap.set(varName, packageName);
        return [];
      }
      // Fall through to Case 3c (await trackedInstance.chainMethod()) if no factory match
    }

    // Case 3b: await factory().promise — promise-factory pattern (e.g., pdfjs-dist)
    // Pattern: const doc = await getDocument(src).promise
    // The factory returns a task object; the .promise property yields the actual instance.
    if (
      ts.isAwaitExpression(init) &&
      ts.isPropertyAccessExpression(init.expression) &&
      init.expression.name.text === 'promise' &&
      ts.isCallExpression(init.expression.expression)
    ) {
      const call = init.expression.expression;
      const pkg = this.resolvePromiseFactory(call, context);
      if (pkg) {
        this.instanceMap.set(varName, pkg);
        return [];
      }
    }

    // Case 3c: await trackedInstance.chainMethod() — instance chain propagation (e.g., pdfjs-dist)
    // Pattern: const page = await doc.getPage(1) where doc is tracked and getPage is a chain method
    if (
      ts.isAwaitExpression(init) &&
      ts.isCallExpression(init.expression) &&
      ts.isPropertyAccessExpression(init.expression.expression)
    ) {
      const propAccess = init.expression.expression;
      const methodName = propAccess.name.text;
      if (ts.isIdentifier(propAccess.expression)) {
        const objName = propAccess.expression.text;
        const trackedPkg = this.instanceMap.get(objName);
        if (trackedPkg) {
          // Check if this method is a known chain method for this package
          const chainPkg = this.instanceChainMethodToPackage.get(methodName);
          if (chainPkg === trackedPkg) {
            this.instanceMap.set(varName, trackedPkg);
            return [];
          }
        }
      }
    }

    // Case 3d: trackedInstance.chainMethod() (non-awaited) — for RenderTask-like factories
    // Pattern: const renderTask = page.render(params) where page is tracked and render is a chain method
    if (
      ts.isCallExpression(init) &&
      ts.isPropertyAccessExpression(init.expression)
    ) {
      const propAccess = init.expression;
      const methodName = propAccess.name.text;
      if (ts.isIdentifier(propAccess.expression)) {
        const objName = propAccess.expression.text;
        const trackedPkg = this.instanceMap.get(objName);
        if (trackedPkg) {
          const chainPkg = this.instanceChainMethodToPackage.get(methodName);
          if (chainPkg === trackedPkg) {
            this.instanceMap.set(varName, trackedPkg);
            return [];
          }
        }
      }
    }

    // Case 4: const x = trackedVar — propagate package from already-tracked identifier
    // Example: private schema = productSchema  (productSchema is a tracked zod instance)
    if (ts.isIdentifier(init)) {
      const trackedPkg = this.instanceMap.get(init.text);
      if (trackedPkg) {
        this.instanceMap.set(varName, trackedPkg);
      }
    }

    return [];
  }

  /**
   * Track this.x = trackedVar assignments so class properties propagate package info.
   *
   * Example: this.schema = productSchema  → 'schema' → zod (if productSchema tracked)
   *          this.client = createClient() → 'client' → redis (via factory)
   */
  public onBinaryExpression(node: ts.BinaryExpression, context: NodeContext): Detection[] {
    if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return [];
    const left = node.left;
    if (!ts.isPropertyAccessExpression(left)) return [];
    const varName = left.name.text;
    const rhs = node.right;

    // Propagate from a tracked identifier: this.schema = productSchema
    if (ts.isIdentifier(rhs)) {
      const trackedPkg = this.instanceMap.get(rhs.text);
      if (trackedPkg) {
        this.instanceMap.set(varName, trackedPkg);
        return [];
      }
    }

    // Propagate from factory/new: this.client = createClient()
    if (ts.isCallExpression(rhs)) {
      const pkg = this.resolveFactoryCall(rhs, context);
      if (pkg) {
        this.instanceMap.set(varName, pkg);
        return [];
      }
    }
    if (ts.isNewExpression(rhs)) {
      const pkg = this.resolveNewExpression(rhs, context);
      if (pkg) {
        this.instanceMap.set(varName, pkg);
      }
    }
    return [];
  }

  /**
   * Resolve a new expression to a package name.
   *
   * Example: new PrismaClient() → '@prisma/client'
   */
  private resolveNewExpression(
    expr: ts.NewExpression,
    context: NodeContext
  ): string | null {
    // Case A: new ClassName() — direct identifier
    if (ts.isIdentifier(expr.expression)) {
      const className = expr.expression.text;

      // Check importMap FIRST — it's authoritative (the import tells us exactly which package).
      // classToPackage is only used as fallback because multiple packages can share class names
      // (e.g., 'Client' is in pg, cassandra-driver, and discord.js — only imports tell them apart).
      const importInfo = context.importMap.get(className);
      if (importInfo) {
        return importInfo.packageName;
      }

      // Fallback: classToPackage from contract detection rules
      const fromClassMap = this.classToPackage.get(className);
      if (fromClassMap) {
        return fromClassMap;
      }

      // Fallback: className is a tracked instance (e.g., User = mongoose.model(...))
      // so new User(...) creates a Document instance of the same package.
      const trackedPkg = this.instanceMap.get(className);
      if (trackedPkg) {
        return trackedPkg;
      }

      return null;
    }

    // Case B: new module.ClassName() — property access (e.g., new braintree.BraintreeGateway())
    // The module is imported, so map the instance to the module's package.
    if (ts.isPropertyAccessExpression(expr.expression)) {
      const obj = expr.expression.expression;
      if (ts.isIdentifier(obj)) {
        const importInfo = context.importMap.get(obj.text);
        if (importInfo) {
          return importInfo.packageName;
        }
      }
    }

    return null;
  }

  /**
   * Resolve a factory call to a package name.
   *
   * Examples:
   *   createClient(url, key)       → package that exports createClient
   *   someImport.create()          → package of someImport
   *   someImport.createClient()    → package of someImport if createClient is known factory
   */
  private resolveFactoryCall(
    expr: ts.CallExpression,
    context: NodeContext
  ): string | null {
    const funcExpr = expr.expression;

    // Case 1: Direct call - createClient(), connect(), etc.
    if (ts.isIdentifier(funcExpr)) {
      const funcName = funcExpr.text;

      // Check importMap FIRST — it's authoritative (tells us exactly which package this
      // function was imported from in this file). This prevents cross-package confusion
      // when multiple packages export the same factory name (e.g., redis and @supabase/supabase-js
      // both export createClient — importMap knows which one was actually imported here).
      const importInfo = context.importMap.get(funcName);
      if (importInfo) {
        // Only treat as factory if the function name suggests it creates an instance
        if (this.isFactoryMethodName(funcName)) {
          return importInfo.packageName;
        }
      }

      // Fallback: check factory map from contract detection rules.
      // Useful when factory is not a direct named import (e.g., called via intermediate variable).
      const fromFactoryMap = this.factoryToPackage.get(funcName);
      if (fromFactoryMap) {
        return fromFactoryMap;
      }

      return null;
    }

    // Case 2: Property access call - someImport.create(), someImport.createClient()
    if (ts.isPropertyAccessExpression(funcExpr)) {
      const obj = funcExpr.expression;
      const methodName = funcExpr.name.text;

      if (!ts.isIdentifier(obj)) {
        return null;
      }

      const objName = obj.text;

      // Check if the object is an import — importMap is authoritative.
      // If the object is a direct import (e.g., MongoClient, SomeClass), use its package
      // regardless of whether the method name is also a generic factory method name.
      // This prevents false matches like MongoClient.connect() → undici (via undici's
      // factory_methods: [connect]) when MongoClient is actually imported from mongodb.
      const importInfo = context.importMap.get(objName);
      if (importInfo && this.isFactoryMethodName(methodName)) {
        return importInfo.packageName;
      }

      // Check if method is a known factory method AND the object is NOT a direct import.
      // Only use factoryToPackage when the object isn't from a specific known import —
      // otherwise the factory method name (e.g., 'connect') would match calls on any object.
      const fromFactoryMap = this.factoryToPackage.get(methodName);
      if (fromFactoryMap && !importInfo) {
        return fromFactoryMap;
      }

      // Check if the object is already a tracked instance
      const instancePackage = this.instanceMap.get(objName);
      if (instancePackage && this.isFactoryMethodName(methodName)) {
        return instancePackage;
      }

    }

    return null;
  }

  /**
   * Resolve a promise-factory call to a package name.
   *
   * Handles the pattern: `await factory().promise` where the factory is in promiseFactoryToPackage.
   * Example (pdfjs-dist): `const doc = await getDocument(src).promise`
   *   — getDocument is in promiseFactoryToPackage → returns 'pdfjs-dist'
   *   — caller tracks `doc` as 'pdfjs-dist' instance
   *
   * Also handles: `await pdfjs.getDocument(src).promise` (namespace import)
   */
  private resolvePromiseFactory(
    callExpr: ts.CallExpression,
    context: NodeContext
  ): string | null {
    const funcExpr = callExpr.expression;

    // Direct call: getDocument(src)
    if (ts.isIdentifier(funcExpr)) {
      const funcName = funcExpr.text;
      // Check importMap first (authoritative for direct imports)
      const importInfo = context.importMap.get(funcName);
      if (importInfo) {
        const pkg = this.promiseFactoryToPackage.get(funcName);
        if (pkg && pkg === importInfo.packageName) {
          return pkg;
        }
      }
      // Fallback: check promiseFactoryToPackage directly
      const pkg = this.promiseFactoryToPackage.get(funcName);
      if (pkg) return pkg;
    }

    // Namespaced call: pdfjs.getDocument(src)
    if (ts.isPropertyAccessExpression(funcExpr) && ts.isIdentifier(funcExpr.expression)) {
      const methodName = funcExpr.name.text;
      const objName = funcExpr.expression.text;
      const importInfo = context.importMap.get(objName);
      if (importInfo) {
        const pkg = this.promiseFactoryToPackage.get(methodName);
        if (pkg && pkg === importInfo.packageName) {
          return pkg;
        }
      }
    }

    return null;
  }

  /**
   * Resolve schema factory chains: z.object(), z.string().optional(), etc.
   *
   * Zod schemas are created via z.<factory>() and method-chained (z.string().optional()).
   * Any call whose root eventually resolves to a zod import identifier is a schema factory.
   * We walk through call-chains to find the root import.
   *
   * Examples:
   *   z.object({ ... })            → root=z (zod import) → 'zod'
   *   z.string().optional()        → root=z (zod import) → 'zod'
   *   userSchema.optional()        → root=userSchema (already a tracked zod instance) → 'zod'
   */
  private resolveSchemaChainFactory(
    expr: ts.CallExpression,
    context: NodeContext
  ): string | null {
    // Walk through the call/property-access chain to find the root identifier
    let current: ts.Expression = expr.expression;

    while (true) {
      if (ts.isPropertyAccessExpression(current)) {
        current = current.expression;
      } else if (ts.isCallExpression(current)) {
        current = current.expression;
      } else {
        break;
      }
    }

    if (!ts.isIdentifier(current)) {
      return null;
    }

    const rootName = current.text;

    // Check if root is a direct import from a package that has contracts
    const importInfo = context.importMap.get(rootName);
    if (importInfo) {
      return importInfo.packageName;
    }

    // Check if root is already a tracked instance.
    // This handles method chains like client.db().collection(), mapper.forModel('User'),
    // model.startChat(), etc. where the root variable was already tracked as a package instance.
    const trackedPkg = this.instanceMap.get(rootName);
    if (trackedPkg) {
      return trackedPkg;
    }

    return null;
  }

  /**
   * Heuristic: does this method name suggest it creates an instance?
   */
  private isFactoryMethodName(name: string): boolean {
    const lower = name.toLowerCase();
    return (
      lower.startsWith('create') ||
      lower.startsWith('make') ||
      lower.startsWith('build') ||
      lower === 'connect' ||
      lower === 'init' ||
      lower === 'initialize' ||
      lower === 'getInstance' ||
      lower === 'getinstance' ||
      lower === 'client'  // e.g., mailgun.client({...}) returns IMailgunClient
    );
  }

  /**
   * Get the variable name from a declaration node.
   * Handles simple identifiers only (not destructuring).
   */
  private getVarName(node: ts.VariableDeclaration): string | null {
    if (ts.isIdentifier(node.name)) {
      return node.name.text;
    }
    return null;
  }

  /**
   * Resolve a variable name to its originating package.
   *
   * Called by other plugins to look up whether an identifier is an instance
   * of a contracted package.
   *
   * @param name - Variable name to look up
   * @returns Package name if tracked, null otherwise
   */
  public resolveIdentifier(name: string): string | null {
    return this.instanceMap.get(name) ?? null;
  }
}
