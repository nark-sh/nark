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
   * Local user-defined factory functions in the current source file. Populated each
   * file by walking top-level declarations for the pattern:
   *   const getUmami = () => new Umami({...});
   *   function getUmami() { return new Umami({...}); }
   * Maps local factory name → package name (resolved via importMap of the new'd class).
   *
   * Concern: concern-20260612-umami-node-onboard-1 — sealos uses a local getUmami()
   * factory that wraps `new Umami(...)`. The TypeScript-checker-based fallback
   * (`resolveCallReturnTypeViaChecker`) fails for unresolvable types (e.g. when the
   * package isn't installed in node_modules, common for fixtures). A pure AST pass
   * recovers the one-hop factory indirection without any checker dependency.
   */
  private localFactoryMap = new Map<string, string>();
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
    this.localFactoryMap.clear();
    // Pre-scan for local arrow/function factories returning `new <ImportedClass>(...)`.
    // Concern: concern-20260612-umami-node-onboard-1
    this.walkLocalFactoryDeclarations(sf, ctx);
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

      // Build a map of namespace qualifiers: localName → packageName.
      // This handles the pattern `signer: ethers.Signer` where 'ethers' is imported as
      // a named export from 'ethers' (import { ethers } from 'ethers') rather than as a
      // bare type import (import { Signer } from 'ethers').
      // Concern: concern-20260618-ethers-deepen-1 — signer: ethers.Signer parameter type
      // was not recognized because 'Signer' is not a named import in the fixture.
      // Covers: namespace imports (import * as X), default imports (import X), and
      // named imports where the local name matches the package root (e.g. import { ethers }).
      const namespaceQualifiers = new Map<string, string>(); // localQualifierName → packageName
      for (const [localName, importInfo] of ctx.importMap.entries()) {
        if (
          importInfo.kind === 'namespace' ||
          importInfo.kind === 'default' ||
          // Named import where the imported name == the local name (e.g. import { ethers } from 'ethers')
          // and the local name is used as a namespace qualifier (e.g. ethers.Signer)
          (importInfo.kind === 'named' && localName === importInfo.importedName)
        ) {
          namespaceQualifiers.set(localName, importInfo.packageName);
        }
      }

      if (confirmedTypes.size > 0 || namespaceQualifiers.size > 0) {
        this.walkTypeAnnotations(sf, confirmedTypes, namespaceQualifiers);
      }
    }

    // Also scan class PropertyDeclaration initializers (not covered by onVariableDeclaration).
    // Pattern: class Foo { private db = new PrismaClient(); }
    // These are ts.PropertyDeclaration nodes (not VariableDeclaration), so they're not
    // visited by onVariableDeclaration. We pre-scan the file to track them.
    this.walkPropertyDeclarationInitializers(sf, ctx);
  }

  /**
   * Walk source file for local arrow/function factories that wrap `new <ImportedClass>()`.
   *
   * Patterns handled (one-hop only):
   *   const getUmami = () => new Umami({...});
   *   const getUmami = () => { return new Umami({...}); };
   *   function getUmami() { return new Umami({...}); }
   *
   * The class name is resolved via the file's importMap (authoritative — same priority
   * as resolveNewExpression). When a downstream call site does `const c = getUmami();`,
   * resolveFactoryCall consults `localFactoryMap` and tracks `c` as the wrapped package.
   *
   * Why pure AST and not type checker: when a package isn't installed in node_modules
   * (common for fixtures, monorepo workspaces with unresolved declarations), the TS
   * checker can't resolve `Umami` to a real symbol, so resolveCallReturnTypeViaChecker
   * returns null. The importMap, however, still works because it reads import statements
   * directly from the AST.
   *
   * Concern: concern-20260612-umami-node-onboard-1
   */
  private walkLocalFactoryDeclarations(node: ts.Node, ctx: PluginContext): void {
    // Pattern: const X = () => new Y(...) / function X() { return new Y(...) }
    // Only top-level / module-level declarations are tracked to keep scope simple.
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const factoryName = node.name.text;
      const init = node.initializer;
      // const X = () => new Y(...)        (arrow function, expression body)
      // const X = () => { return new Y(...) }  (arrow function, block body)
      // const X = function () { return new Y(...) }  (function expression, block body)
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        const pkg = this.extractWrappedNewExpressionPackage(init.body, ctx);
        if (pkg) this.localFactoryMap.set(factoryName, pkg);
      }
    }
    // function X() { return new Y(...) }
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const factoryName = node.name.text;
      const pkg = this.extractWrappedNewExpressionPackage(node.body, ctx);
      if (pkg) this.localFactoryMap.set(factoryName, pkg);
    }
    ts.forEachChild(node, (child) => this.walkLocalFactoryDeclarations(child, ctx));
  }

  /**
   * Given a function body (block) or arrow expression body, return the package
   * name if the body is (or returns) a single `new <ImportedClass>(...)` expression.
   *
   * Returns null if the body is more complex (multiple statements other than the
   * return, conditional logic, returns a non-new value, etc.). Deliberately
   * conservative — we don't try to model arbitrary function flow, only the
   * common `() => new X(...)` factory pattern.
   */
  private extractWrappedNewExpressionPackage(
    body: ts.ConciseBody,
    ctx: PluginContext
  ): string | null {
    // Arrow function expression body: () => new X(...)
    if (ts.isNewExpression(body)) {
      return this.resolveNewExpressionFromImports(body, ctx);
    }
    // Block body: { return new X(...); }
    if (ts.isBlock(body)) {
      // Find the single return statement. Conservative: only when body is exactly
      // `{ return new X(...); }` (one statement, a ReturnStatement with NewExpression).
      const statements = body.statements;
      if (statements.length !== 1) return null;
      const stmt = statements[0];
      if (ts.isReturnStatement(stmt) && stmt.expression && ts.isNewExpression(stmt.expression)) {
        return this.resolveNewExpressionFromImports(stmt.expression, ctx);
      }
    }
    return null;
  }

  /**
   * Resolve a NewExpression to a package name using ONLY the importMap and
   * classToPackage (no type checker). Mirrors `resolveNewExpression` priority
   * but takes a PluginContext (used during the pre-traversal pass).
   */
  private resolveNewExpressionFromImports(
    expr: ts.NewExpression,
    ctx: PluginContext
  ): string | null {
    if (ts.isIdentifier(expr.expression)) {
      const className = expr.expression.text;
      const importInfo = ctx.importMap.get(className);
      if (importInfo) return importInfo.packageName;
      const fromClassMap = this.classToPackage.get(className);
      if (fromClassMap) return fromClassMap;
    }
    if (ts.isPropertyAccessExpression(expr.expression)) {
      // Walk to the root identifier of the property chain (handles deep chains like
      // new ExcelJS.stream.xlsx.WorkbookWriter(...) → root 'ExcelJS').
      // Concern: concern-20260618-exceljs-deepen-1
      let current: ts.Expression = expr.expression;
      while (ts.isPropertyAccessExpression(current)) {
        current = current.expression;
      }
      if (ts.isIdentifier(current)) {
        const importInfo = ctx.importMap.get(current.text);
        if (importInfo) return importInfo.packageName;
      }
    }
    return null;
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
        const pkg = this.resolveFactoryCall(init, nodeCtx)
          ?? this.resolveCallReturnTypeViaChecker(init, nodeCtx);
        if (pkg) this.instanceMap.set(varName, pkg);
      }

      // await factory(): class Repo { private db = await createClient() }
      if (ts.isAwaitExpression(init) && ts.isCallExpression(init.expression)) {
        const pkg = this.resolveFactoryCall(init.expression, nodeCtx)
          ?? this.resolveCallReturnTypeViaChecker(init.expression, nodeCtx);
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
  private walkTypeAnnotations(
    node: ts.Node,
    importedTypes: Map<string, string>,
    namespaceQualifiers?: Map<string, string>,
  ): void {
    // Function/method/arrow parameters
    if (ts.isParameter(node) && node.name && node.type && ts.isIdentifier(node.name)) {
      const varName = node.name.text;
      const result = this.resolveTypeAnnotationWithName(node.type, importedTypes, namespaceQualifiers);
      if (result) {
        this.instanceMap.set(varName, result.pkg);
        this.instanceTypeMap.set(varName, result.typeName);
      }
    }

    // Variable declarations with explicit type: const x: SomeType = ...
    if (ts.isVariableDeclaration(node) && node.type && ts.isIdentifier(node.name)) {
      const varName = node.name.text;
      const result = this.resolveTypeAnnotationWithName(node.type, importedTypes, namespaceQualifiers);
      if (result) {
        this.instanceMap.set(varName, result.pkg);
        this.instanceTypeMap.set(varName, result.typeName);
      }
    }

    // Class property declarations: private channel: TextChannel;
    if (ts.isPropertyDeclaration(node) && node.type && ts.isIdentifier(node.name)) {
      const varName = node.name.text;
      const result = this.resolveTypeAnnotationWithName(node.type, importedTypes, namespaceQualifiers);
      if (result) {
        this.instanceMap.set(varName, result.pkg);
        this.instanceTypeMap.set(varName, result.typeName);
      }
    }

    ts.forEachChild(node, (child) => this.walkTypeAnnotations(child, importedTypes, namespaceQualifiers));
  }

  /**
   * Resolve a TypeScript type node to both a package name and the type name.
   * Used to populate instanceTypeMap for class-level disambiguation (e.g.,
   * channel: GuildChannel → pkg='discord.js', typeName='GuildChannel').
   */
  private resolveTypeAnnotationWithName(
    typeNode: ts.TypeNode,
    importedTypes: Map<string, string>,
    namespaceQualifiers?: Map<string, string>,
  ): { pkg: string; typeName: string } | null {
    if (ts.isTypeReferenceNode(typeNode)) {
      const name = typeNode.typeName;
      if (ts.isIdentifier(name)) {
        const pkg = importedTypes.get(name.text);
        if (pkg) return { pkg, typeName: name.text };
      }
      if (ts.isQualifiedName(name) && ts.isIdentifier(name.right) && ts.isIdentifier(name.left)) {
        // Path 1: right side is in importedTypes (e.g. import { Signer } from 'ethers',
        //         type annotation 'ethers.Signer' — right='Signer' in importedTypes).
        const pkgFromRight = importedTypes.get(name.right.text);
        if (pkgFromRight) return { pkg: pkgFromRight, typeName: name.right.text };

        // Path 2: left side is a namespace qualifier (e.g. import { ethers } from 'ethers',
        //         type annotation 'ethers.Signer' — left='ethers' in namespaceQualifiers).
        // Concern: concern-20260618-ethers-deepen-1 — signer: ethers.Signer was not tracked
        // because 'Signer' is not a named import; only 'ethers' (namespace) is imported.
        if (namespaceQualifiers) {
          const qualifierPkg = namespaceQualifiers.get(name.left.text);
          if (qualifierPkg) {
            // Verify that name.right.text is a known type_name for this package.
            const rightTypePkg = this.typeToPackage.get(name.right.text);
            if (rightTypePkg === qualifierPkg) {
              return { pkg: qualifierPkg, typeName: name.right.text };
            }
          }
        }
      }
    }
    if (ts.isUnionTypeNode(typeNode)) {
      for (const t of typeNode.types) {
        const result = this.resolveTypeAnnotationWithName(t, importedTypes, namespaceQualifiers);
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
        // Also record the class name in instanceTypeMap, BUT ONLY for classes that are
        // explicitly registered via `class_names` in the contract's detection section.
        // This enables disambiguation when multiple classes share a method name
        // (e.g., @azure/identity has both DeviceCodeCredential.authenticate and
        // InteractiveBrowserCredential.authenticate). Setting instanceTypeMap
        // unconditionally would interfere with packages that don't need disambiguation
        // and whose class names might accidentally match contract dotted-name prefixes.
        // Pattern: const deviceCodeCredential = new DeviceCodeCredential(...) → typeName='DeviceCodeCredential'
        if (ts.isIdentifier(init.expression)) {
          const className = init.expression.text;
          if (this.classToPackage.has(className)) {
            this.instanceTypeMap.set(varName, className);
          }
        }
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

    // Case 2c / 3e: TypeChecker return-type fallback — handles helper functions
    // that wrap a constructor or factory but don't match any known factory name.
    // Pattern: const app = getAppInstance() where function getAppInstance(): App
    //
    // Runs AFTER the cheap factory/schema/chain paths so most call sites resolve
    // via the existing logic. Guarded by importMap (and classToPackage as fallback)
    // to prevent matching unrelated types that happen to share a class name.
    if (
      ts.isCallExpression(init) ||
      (ts.isAwaitExpression(init) && ts.isCallExpression(init.expression))
    ) {
      const callExpr = ts.isCallExpression(init) ? init : (init.expression as ts.CallExpression);
      const pkg = this.resolveCallReturnTypeViaChecker(callExpr, context);
      if (pkg) {
        this.instanceMap.set(varName, pkg);
        return [];
      }
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
    // Accept both:
    //   (a) this.client = createClient()    — PropertyAccessExpression
    //   (b) apolloServer = new ApolloServer() — Identifier (split declare-then-assign)
    //       Evidence: concern-20260611-apollo-server-instance-tracking (erxes/erxes).
    let varName: string;
    if (ts.isPropertyAccessExpression(left)) {
      varName = left.name.text;
    } else if (ts.isIdentifier(left)) {
      varName = left.text;
    } else {
      return [];
    }
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
      const pkg = this.resolveFactoryCall(rhs, context)
        ?? this.resolveCallReturnTypeViaChecker(rhs, context);
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

    // Case B: new module.ClassName() or new ns1.ns2.ns3.ClassName() — property access chain.
    // Walk up the full property access chain to find the root identifier, then look it up in
    // the importMap. This handles deep namespace patterns like:
    //   new ExcelJS.stream.xlsx.WorkbookWriter(...)  → root='ExcelJS' → exceljs
    //   new braintree.BraintreeGateway()             → root='braintree' → braintree
    // Concern: concern-20260618-exceljs-deepen-1 — the one-level check only handled
    // new module.ClassName() but not new module.ns.ns.ClassName().
    if (ts.isPropertyAccessExpression(expr.expression)) {
      // Walk to the root identifier of the property chain
      let current: ts.Expression = expr.expression;
      while (ts.isPropertyAccessExpression(current)) {
        current = current.expression;
      }
      if (ts.isIdentifier(current)) {
        const importInfo = context.importMap.get(current.text);
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
        // OR if the contract explicitly declares it as a factory method via detection.factory_methods.
        // importInfo is authoritative — it tells us exactly which package this function was
        // imported from in this file. Using importInfo when the contract declares the function
        // as a factory prevents cross-package ambiguity when multiple packages export the same
        // factory name (e.g., both cross-fetch and undici export `fetch`; the importMap tells
        // us which one was actually imported here, so we use it over the factoryToPackage map).
        if (this.isFactoryMethodName(funcName) || this.factoryToPackage.has(funcName)) {
          return importInfo.packageName;
        }
      }

      // Fallback: check factory map from contract detection rules.
      // Useful when factory is not a direct named import (e.g., called via intermediate variable).
      const fromFactoryMap = this.factoryToPackage.get(funcName);
      if (fromFactoryMap) {
        return fromFactoryMap;
      }

      // Fallback: check local factory map (user-defined arrow/function in this file
      // that wraps `new <ImportedClass>(...)`). Populated by walkLocalFactoryDeclarations.
      // Handles the sealos `const getUmami = () => new Umami({...})` pattern.
      // Concern: concern-20260612-umami-node-onboard-1
      const fromLocalFactory = this.localFactoryMap.get(funcName);
      if (fromLocalFactory) {
        return fromLocalFactory;
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
    // Walk through the call/property-access chain to find the root identifier OR
    // root NewExpression. Builder-style APIs like LangGraph's StateGraph route
    // through:
    //   new StateGraph(State).addNode(...).addEdge(...).compile()
    // — the root of the chain is `new StateGraph(State)` (a NewExpression), not
    // a plain identifier. We extend the chain walk to accept a NewExpression
    // root and resolve its class to a package via importMap / classToPackage.
    // Concern: bc-npm-package-onboard @langchain/langgraph 2026-06-15
    let current: ts.Expression = expr.expression;

    while (true) {
      if (ts.isPropertyAccessExpression(current)) {
        current = current.expression;
      } else if (ts.isCallExpression(current)) {
        current = current.expression;
      } else if (ts.isParenthesizedExpression(current)) {
        current = current.expression;
      } else {
        break;
      }
    }

    // Root is a NewExpression — resolve its class via importMap / classToPackage.
    // This catches builder-pattern chains rooted at `new X(...)` rather than at an identifier.
    if (ts.isNewExpression(current)) {
      // resolveNewExpression uses an internal PluginContext shape; the NodeContext
      // passed here exposes the same importMap surface we need. Inline the lookup
      // to avoid coupling to that wider context.
      if (ts.isIdentifier(current.expression)) {
        const className = current.expression.text;
        const importInfo = context.importMap.get(className);
        if (importInfo) return importInfo.packageName;
        const fromClassMap = this.classToPackage.get(className);
        if (fromClassMap) return fromClassMap;
      }
      return null;
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
   * Resolve a CallExpression's return type via the TypeScript type checker.
   *
   * Last-resort fallback for helper functions that wrap a constructor or factory
   * but don't match any known factory name pattern. Returns null unless the type
   * is confirmed by the file's importMap (or, as fallback, by classToPackage).
   *
   * The importMap confirmation is the same disambiguation guard used by
   * walkTypeAnnotations — it prevents matching identical class names from
   * unrelated packages (e.g., Socket from socket.io vs socket.io-client).
   *
   * Pattern handled:
   *   function getAppInstance(): App { return new App({...}); }
   *   const app = getAppInstance(); // → tracks 'app' as @octokit/app
   */
  private resolveCallReturnTypeViaChecker(
    callExpr: ts.CallExpression,
    context: NodeContext
  ): string | null {
    const sig = context.typeChecker.getResolvedSignature(callExpr);
    if (!sig) return null;
    const returnType = context.typeChecker.getReturnTypeOfSignature(sig);
    if (!returnType) return null;

    // Walk the type to find a named class symbol. Handles:
    //   - Direct types: App
    //   - Nullable union: App | null  /  App | undefined
    //   - Promise<App> (async helpers): unwrap to the contained type
    const typeName = this.extractClassNameFromType(returnType, context.typeChecker);
    if (!typeName) return null;

    // Confirm via importMap first (authoritative — tells us exactly which package
    // the type was imported from in this file).
    const importInfo = context.importMap.get(typeName);
    if (importInfo) return importInfo.packageName;

    // Fallback: classToPackage from contract detection rules. Mirrors the same
    // priority order used by resolveNewExpression — importMap wins, classToPackage
    // covers cases where the type isn't a direct named import.
    const fromClassMap = this.classToPackage.get(typeName);
    if (fromClassMap) return fromClassMap;

    return null;
  }

  /**
   * Walk a TypeScript type to extract a class-like name symbol.
   * Unwraps unions (App | null) and Promise<T> wrappers.
   */
  private extractClassNameFromType(
    type: ts.Type,
    typeChecker: ts.TypeChecker
  ): string | null {
    // Union: pick the first non-null/undefined branch with a resolvable symbol.
    if (type.isUnion()) {
      for (const t of type.types) {
        if (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
          continue;
        }
        const name = this.extractClassNameFromType(t, typeChecker);
        if (name) return name;
      }
      return null;
    }

    const symbol = type.getSymbol();
    if (!symbol) return null;
    const name = symbol.getName();

    // Unwrap Promise<T> from async helpers (e.g., async function makeClient(): Promise<App>)
    if (name === 'Promise') {
      const typeArgs = (type as ts.TypeReference).typeArguments;
      if (typeArgs && typeArgs.length > 0) {
        return this.extractClassNameFromType(typeArgs[0], typeChecker);
      }
      return null;
    }

    // Skip anonymous / builtin / non-class-like names that can never confirm via importMap.
    if (!name || name === '__type' || name === '__object') return null;

    return name;
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
