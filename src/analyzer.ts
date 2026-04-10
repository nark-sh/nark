/**
 * AST Analyzer - uses TypeScript Compiler API to detect behavioral contract violations
 */

import * as ts from "typescript";
import * as path from "path";
import type {
  PackageContract,
  Violation,
  CallSite,
  CallSiteAnalysis,
  AnalyzerConfig,
  Postcondition,
} from "./types.js";
import { ReactQueryAnalyzer } from "./analyzers/react-query-analyzer.js";
import { AsyncErrorAnalyzer } from "./analyzers/async-error-analyzer.js";
import {
  ReturnValueAnalyzer,
  type ReturnValueCheck,
} from "./analyzers/return-value-analyzer.js";
import {
  EventListenerAnalyzer,
  type EventListenerCheck,
} from "./analyzers/event-listener-analyzer.js";
import {
  checkSuppression,
  getSuppressionStats,
  loadManifestSync,
  detectDeadSuppressions,
  formatDeadSuppression,
} from "./suppressions/index.js";
import type { Suppression, DeadSuppression } from "./suppressions/types.js";

/**
 * Main analyzer that coordinates the verification process
 */
export class Analyzer {
  private program: ts.Program;
  private typeChecker: ts.TypeChecker;
  private contracts: Map<string, PackageContract>;
  private violations: Violation[] = [];
  private suppressedViolations: Array<{
    violation: Violation;
    suppression: Suppression | any;
  }> = [];
  private projectRoot: string;
  private includeTests: boolean;
  private analyzerVersion: string = "1.1.0"; // From package.json

  // Detection maps built dynamically from contract definitions
  private typeToPackage: Map<string, string>;
  private classToPackage: Map<string, string>;
  private factoryToPackage: Map<string, string>;
  private awaitPatternToPackage: Map<string, string>;

  constructor(config: AnalyzerConfig, contracts: Map<string, PackageContract>) {
    this.contracts = contracts;
    this.includeTests = config.includeTests ?? false;

    // Build detection maps from contract definitions
    this.typeToPackage = new Map();
    this.classToPackage = new Map();
    this.factoryToPackage = new Map();
    this.awaitPatternToPackage = new Map();
    this.buildDetectionMaps();

    // Create TypeScript program
    const configFile = ts.readConfigFile(config.tsconfigPath, ts.sys.readFile);
    const parsedConfig = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(config.tsconfigPath),
    );

    // Store project root for file system operations
    this.projectRoot = path.dirname(config.tsconfigPath);

    try {
      this.program = ts.createProgram({
        rootNames: parsedConfig.fileNames,
        options: parsedConfig.options,
      });
    } catch (error: unknown) {
      throw new Error(
        `Failed to create TypeScript program: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const fileNotFoundDiagnostics = ts
      .getPreEmitDiagnostics(this.program)
      .filter((d) => d.code === 6053);
    if (fileNotFoundDiagnostics.length > 0) {
      const messages = fileNotFoundDiagnostics
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
        .join("\n");
      throw new Error(`TypeScript file-not-found errors:\n${messages}`);
    }

    // Initialize type checker for type-aware detection
    this.typeChecker = this.program.getTypeChecker();
  }

  /**
   * Builds detection maps from contract definitions
   * This replaces hardcoded mappings with data-driven approach
   */
  private buildDetectionMaps(): void {
    for (const [packageName, contract] of this.contracts.entries()) {
      const detection = contract.detection;
      if (!detection) continue;

      // Map class names for new expressions (e.g., new Octokit())
      for (const className of detection.class_names || []) {
        this.classToPackage.set(className, packageName);
      }

      // Map type names for type declarations (e.g., client: Octokit)
      for (const typeName of detection.type_names || []) {
        this.typeToPackage.set(typeName, packageName);
      }

      // Map factory methods (e.g., createClient())
      for (const factoryMethod of detection.factory_methods || []) {
        this.factoryToPackage.set(factoryMethod, packageName);
      }

      // Map await patterns (e.g., .repos., .pulls.)
      for (const pattern of detection.await_patterns || []) {
        this.awaitPatternToPackage.set(pattern.toLowerCase(), packageName);
      }
    }
  }

  /**
   * Analyzes all files in the program and returns violations
   */
  analyze(): Violation[] {
    this.violations = [];
    this.suppressedViolations = [];

    // Collect all violations first
    const allViolations: Array<{
      violation: Violation;
      sourceFile: ts.SourceFile;
    }> = [];

    for (const sourceFile of this.program.getSourceFiles()) {
      // Skip declaration files and node_modules
      if (
        sourceFile.isDeclarationFile ||
        sourceFile.fileName.includes("node_modules")
      ) {
        continue;
      }

      // Skip test files unless explicitly included
      if (!this.includeTests && this.isTestFile(sourceFile.fileName)) {
        continue;
      }

      const beforeCount = this.violations.length;
      this.analyzeFile(sourceFile);
      const afterCount = this.violations.length;

      // Track which violations came from this source file
      for (let i = beforeCount; i < afterCount; i++) {
        allViolations.push({
          violation: this.violations[i],
          sourceFile,
        });
      }
    }

    // Filter out suppressed violations
    return this.filterSuppressedViolations(allViolations);
  }

  /**
   * Filters out suppressed violations and updates manifest
   */
  private filterSuppressedViolations(
    violationsWithSource: Array<{
      violation: Violation;
      sourceFile: ts.SourceFile;
    }>,
  ): Violation[] {
    const unsuppressedViolations: Violation[] = [];

    for (const { violation, sourceFile } of violationsWithSource) {
      // Check if this violation is suppressed
      const suppressionResult = checkSuppression({
        projectRoot: this.projectRoot,
        sourceFile,
        line: violation.line,
        column: violation.column,
        packageName: violation.package,
        postconditionId: violation.contract_clause,
        analyzerVersion: this.analyzerVersion,
        updateManifest: true,
      });

      if (suppressionResult.suppressed) {
        // Store suppressed violation for reporting
        this.suppressedViolations.push({
          violation,
          suppression:
            suppressionResult.matchedSuppression ||
            suppressionResult.originalSource,
        });
      } else {
        // Keep unsuppressed violation
        unsuppressedViolations.push(violation);
      }
    }

    // Update this.violations with filtered list
    this.violations = unsuppressedViolations;

    return unsuppressedViolations;
  }

  /**
   * Extracts all package imports from a source file
   */
  private extractImports(sourceFile: ts.SourceFile): Set<string> {
    const imports = new Set<string>();

    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        const moduleSpecifier = statement.moduleSpecifier;
        if (ts.isStringLiteral(moduleSpecifier)) {
          const packageName = moduleSpecifier.text;
          // Add the exact import path (e.g., "next-auth/jwt", "@clerk/nextjs/server")
          imports.add(packageName);
          // Also add parent package for subpath imports so contracts can match:
          // "next-auth/jwt" → also add "next-auth"
          // "@clerk/nextjs/server" → also add "@clerk/nextjs" (already handled in resolvePackageFromImports)
          if (!packageName.startsWith("@") && packageName.includes("/")) {
            const parentPackage = packageName.substring(
              0,
              packageName.indexOf("/"),
            );
            imports.add(parentPackage);
          }
        }
      }

      // Also check for require() calls
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            declaration.initializer &&
            ts.isCallExpression(declaration.initializer)
          ) {
            const callExpr = declaration.initializer;
            if (
              ts.isIdentifier(callExpr.expression) &&
              callExpr.expression.text === "require"
            ) {
              const arg = callExpr.arguments[0];
              if (arg && ts.isStringLiteral(arg)) {
                imports.add(arg.text);
              }
            }
          }
        }
      }
    }

    return imports;
  }

  /**
   * Determines if a file is a test file based on common patterns
   * Test files are excluded by default because:
   * - Tests intentionally expect errors to be thrown
   * - Test frameworks (Jest, Vitest) handle errors automatically
   * - 90%+ of test violations are false positives
   */
  private isTestFile(filePath: string): boolean {
    const testPatterns = [
      "/__tests__/", // Jest convention
      "/__mocks__/", // Mock files
      ".test.ts", // Test files
      ".spec.ts", // Spec files
      ".test.tsx", // React test files
      ".spec.tsx", // React spec files
      "/tests/", // Test directories
      "/test/", // Test directory (singular)
      ".test.js", // JavaScript tests
      ".spec.js", // JavaScript specs
      ".e2e-spec.ts", // NestJS e2e test files
      ".e2e-spec.js", // NestJS e2e test files (JavaScript)
    ];

    return testPatterns.some((pattern) => filePath.includes(pattern));
  }

  /**
   * Returns true if classDecl has a @Controller() or @Injectable() decorator,
   * indicating NestJS manages exception handling for its methods via ExceptionFilter.
   */
  private isNestJsFrameworkClass(classDecl: ts.ClassDeclaration, _sourceFile: ts.SourceFile): boolean {
    const nestJsDecorators = ['Controller', 'Injectable'];
    for (const modifier of classDecl.modifiers ?? []) {
      if (ts.isDecorator(modifier)) {
        // Decorator expression can be: @Controller() → CallExpression, or @Injectable → Identifier
        const expr = modifier.expression;
        const name = ts.isCallExpression(expr)
          ? ts.isIdentifier(expr.expression) ? expr.expression.text : ''
          : ts.isIdentifier(expr) ? expr.text : '';
        if (nestJsDecorators.includes(name)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Analyzes a single source file
   */
  private analyzeFile(sourceFile: ts.SourceFile): void {
    const self = this;

    // Extract all imports from this file for context-aware contract application
    const fileImports = this.extractImports(sourceFile);

    // Track variables that are AxiosInstance objects
    const axiosInstances = new Map<string, string>(); // variableName -> packageName
    const instancesWithInterceptors = new Set<string>(); // variableName

    // Track variables that are schema instances (zod, yup, etc.)
    // Maps variable name to package name (e.g., "userSchema" -> "zod")
    const schemaInstances = new Map<string, string>();

    // Detect global React Query error handlers once per file
    const reactQueryAnalyzer = new ReactQueryAnalyzer(
      sourceFile,
      this.program.getTypeChecker(),
    );
    const globalHandlers = reactQueryAnalyzer.detectGlobalHandlers(sourceFile);

    // First pass: find all package instance declarations and interceptors
    function findAxiosInstances(node: ts.Node): void {
      // Look for: const instance = axios.create(...)
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const varName = node.name.getText(sourceFile);

        // Check for factory methods (axios.create, etc.)
        const packageName = self.extractPackageFromAxiosCreate(
          node.initializer,
          sourceFile,
        );
        if (packageName) {
          axiosInstances.set(varName, packageName);
        }

        // Check for generic factory methods from detection rules (mongoose.model, etc.)
        const genericFactoryPackage = self.extractPackageFromGenericFactory(
          node.initializer,
          sourceFile,
        );
        if (genericFactoryPackage) {
          axiosInstances.set(varName, genericFactoryPackage);
        }

        // Check for new expressions (new PrismaClient(), new Stripe(), etc.)
        const newPackageName = self.extractPackageFromNewExpression(
          node.initializer,
          sourceFile,
        );
        if (newPackageName) {
          axiosInstances.set(varName, newPackageName);
        }

        // Check for schema factory methods (z.object(), z.string(), etc.)
        const schemaPackageName = self.extractPackageFromSchemaFactory(
          node.initializer,
          sourceFile,
        );
        if (schemaPackageName) {
          schemaInstances.set(varName, schemaPackageName);
        }
      }

      // Look for: this._axios = axios.create(...) or this.db = new PrismaClient()
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left)
      ) {
        const varName = node.left.name.text;

        // Check for factory methods
        const packageName = self.extractPackageFromAxiosCreate(
          node.right,
          sourceFile,
        );
        if (packageName) {
          axiosInstances.set(varName, packageName);
        }

        // Check for generic factory methods from detection rules
        const genericFactoryPackage = self.extractPackageFromGenericFactory(
          node.right,
          sourceFile,
        );
        if (genericFactoryPackage) {
          axiosInstances.set(varName, genericFactoryPackage);
        }

        // Check for new expressions
        const newPackageName = self.extractPackageFromNewExpression(
          node.right,
          sourceFile,
        );
        if (newPackageName) {
          axiosInstances.set(varName, newPackageName);
        }

        // Check for schema factory methods
        const schemaPackageName = self.extractPackageFromSchemaFactory(
          node.right,
          sourceFile,
        );
        if (schemaPackageName) {
          schemaInstances.set(varName, schemaPackageName);
        }
      }

      // Look for: private _axios: AxiosInstance or private prisma: PrismaClient
      if (ts.isPropertyDeclaration(node) && node.type) {
        const varName = node.name.getText(sourceFile);
        if (
          ts.isTypeReferenceNode(node.type) &&
          ts.isIdentifier(node.type.typeName)
        ) {
          const typeName = node.type.typeName.text;

          // Look up package name from detection rules
          const packageName = self.typeToPackage.get(typeName);
          if (packageName) {
            axiosInstances.set(varName, packageName);
          }
        }
      }

      // Look for: constructor(private readonly prisma: PrismaService)
      // TypeScript/NestJS pattern where constructor parameters with modifiers create implicit properties
      if (
        ts.isParameter(node) &&
        node.modifiers?.some(
          (m) =>
            m.kind === ts.SyntaxKind.PrivateKeyword ||
            m.kind === ts.SyntaxKind.PublicKeyword ||
            m.kind === ts.SyntaxKind.ProtectedKeyword,
        ) &&
        node.type &&
        ts.isIdentifier(node.name)
      ) {
        const varName = node.name.text;
        if (
          ts.isTypeReferenceNode(node.type) &&
          ts.isIdentifier(node.type.typeName)
        ) {
          const typeName = node.type.typeName.text;

          // Look up package name from detection rules
          const packageName = self.typeToPackage.get(typeName);
          if (packageName) {
            axiosInstances.set(varName, packageName);
          }
        }
      }

      // Look for: instance.interceptors.response.use(...)
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const callText = node.expression.getText(sourceFile);
        // Match patterns like: axiosInstance.interceptors.response.use or instance.interceptors.request.use
        if (
          callText.includes(".interceptors.response.use") ||
          callText.includes(".interceptors.request.use")
        ) {
          // Extract the instance variable name (first part before .interceptors)
          const parts = callText.split(".");
          if (parts.length >= 4) {
            const instanceVar = parts[0];
            instancesWithInterceptors.add(instanceVar);
          }
        }
      }

      ts.forEachChild(node, findAxiosInstances);
    }

    findAxiosInstances(sourceFile);

    // Async error detection pass
    const asyncErrorAnalyzer = new AsyncErrorAnalyzer(sourceFile);
    this.detectAsyncErrors(
      sourceFile,
      asyncErrorAnalyzer,
      axiosInstances,
      fileImports,
    );

    // Return value error detection pass
    const returnValueAnalyzer = new ReturnValueAnalyzer(
      sourceFile,
      this.contracts,
      this.typeChecker,
    );
    this.detectReturnValueErrors(sourceFile, returnValueAnalyzer, fileImports);

    // Event listener detection pass
    const eventListenerAnalyzer = new EventListenerAnalyzer(
      sourceFile,
      this.contracts,
      this.typeChecker,
    );
    this.detectEventListenerErrors(
      sourceFile,
      eventListenerAnalyzer,
      fileImports,
    );

    function visit(node: ts.Node, parent?: ts.Node): void {
      // Set parent pointer if not already set
      if (parent && !(node as any).parent) {
        (node as any).parent = parent;
      }

      // Look for call expressions
      if (ts.isCallExpression(node)) {
        self.analyzeCallExpression(
          node,
          sourceFile,
          axiosInstances,
          instancesWithInterceptors,
          globalHandlers,
          schemaInstances,
          fileImports,
        );
      }

      // Recursively visit children, passing current node as parent
      ts.forEachChild(node, (child) => visit(child, node));
    }

    visit(sourceFile);
  }

  /**
   * Detects async functions with unprotected await expressions
   */
  private detectAsyncErrors(
    sourceFile: ts.SourceFile,
    asyncErrorAnalyzer: AsyncErrorAnalyzer,
    trackedInstances: Map<string, string>,
    fileImports: Set<string>,
  ): void {
    const self = this;

    function visitForAsyncFunctions(node: ts.Node, enclosingClass?: ts.ClassDeclaration): void {
      // Track the nearest enclosing class as we descend the AST
      const nextClass = ts.isClassDeclaration(node) ? node : enclosingClass;

      // Check if this is an async function
      if (asyncErrorAnalyzer.isAsyncFunction(node)) {
        const unprotectedAwaits =
          asyncErrorAnalyzer.findUnprotectedAwaits(node);

        // For each unprotected await, check if any contract requires error handling
        for (const detection of unprotectedAwaits) {
          // Suppress async-error violations inside NestJS framework classes.
          // @Controller() and @Injectable() classes are covered by the NestJS
          // ExceptionFilter pipeline — unhandled async errors are intentional.
          if (nextClass && self.isNestJsFrameworkClass(nextClass, sourceFile)) {
            continue; // skip — NestJS framework handles this
          }

          // Try to determine which package this await is calling
          // This is a simplified approach - we create a violation for any unprotected await
          // that might be calling a package function
          const violation = self.createAsyncErrorViolation(
            sourceFile,
            detection,
            node,
            trackedInstances,
            fileImports,
          );

          if (violation) {
            self.violations.push(violation);
          }
        }
      }

      // Continue traversing, passing along the nearest enclosing class
      ts.forEachChild(node, child => visitForAsyncFunctions(child, nextClass));
    }

    visitForAsyncFunctions(sourceFile);

    // Also detect empty/ineffective catch blocks
    const catchBlocks = asyncErrorAnalyzer.findAllCatchBlocks(sourceFile);
    for (const catchBlock of catchBlocks) {
      const effectiveness =
        asyncErrorAnalyzer.isCatchBlockEffective(catchBlock);

      if (effectiveness.isEmpty || effectiveness.hasConsoleOnly) {
        const violation = this.createEmptyCatchViolation(
          sourceFile,
          catchBlock,
          effectiveness,
          fileImports,
        );

        if (violation) {
          this.violations.push(violation);
        }
      }
    }
  }

  /**
   * Detects functions with unprotected return value error checks
   */
  private detectReturnValueErrors(
    sourceFile: ts.SourceFile,
    returnValueAnalyzer: ReturnValueAnalyzer,
    fileImports: Set<string>,
  ): void {
    const self = this;

    function visitForFunctions(node: ts.Node): void {
      // Check functions (including arrow functions and methods)
      const isFunctionLike =
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node);

      if (isFunctionLike) {
        const returnValueChecks = returnValueAnalyzer.analyze(node);

        // Create violations for unprotected return value checks
        for (const check of returnValueChecks) {
          const violation = self.createReturnValueViolation(
            sourceFile,
            check,
            fileImports,
          );

          if (violation) {
            self.violations.push(violation);
          }
        }
      }

      // Continue traversing
      ts.forEachChild(node, visitForFunctions);
    }

    visitForFunctions(sourceFile);
  }

  /**
   * Creates a violation for unprotected return value error checks
   */
  private createReturnValueViolation(
    sourceFile: ts.SourceFile,
    check: ReturnValueCheck,
    fileImports: Set<string>,
  ): Violation | null {
    // Only create violation if this package is actually imported
    if (!fileImports.has(check.packageName)) {
      return null;
    }

    const location = sourceFile.getLineAndCharacterOfPosition(
      check.declarationNode.getStart(),
    );

    const checkLocation = check.checkNode
      ? sourceFile.getLineAndCharacterOfPosition(check.checkNode.getStart())
      : location;

    const description = check.checkNode
      ? `Variable '${check.variableName}' assigned from ${check.packageName}.${check.functionName}() has unprotected error check. Error handling must be in try-catch block.`
      : `Variable '${check.variableName}' assigned from ${check.packageName}.${check.functionName}() has no error check. Return value must be checked for errors.`;

    return {
      id: `${check.packageName}-${check.postcondition.id}`,
      severity: check.postcondition.severity || "error",
      file: sourceFile.fileName,
      line: checkLocation.line + 1,
      column: checkLocation.character + 1,
      package: check.packageName,
      function: check.functionName,
      contract_clause: check.postcondition.id,
      description,
      source_doc:
        check.postcondition.sources?.[0] || check.postcondition.source || "",
      suggested_fix: check.postcondition.required_handling,
    };
  }

  /**
   * Detects instances missing required event listeners
   */
  private detectEventListenerErrors(
    sourceFile: ts.SourceFile,
    eventListenerAnalyzer: EventListenerAnalyzer,
    fileImports: Set<string>,
  ): void {
    const self = this;

    // NEW: Module-level analysis pass
    // Analyze code at the top level of the module (not inside functions)
    // This catches patterns like: const myQueue = new Queue(); (at module scope)
    // Pass true for moduleLevelOnly to stop traversal at function boundaries
    const moduleLevelChecks = eventListenerAnalyzer.analyze(sourceFile, true);
    for (const check of moduleLevelChecks) {
      const violation = self.createEventListenerViolation(
        sourceFile,
        check,
        fileImports,
      );

      if (violation) {
        self.violations.push(violation);
      }
    }

    // EXISTING: Function-level analysis pass
    // Analyze code inside functions, methods, and arrow functions
    function visitForFunctions(node: ts.Node): void {
      // Check functions (including arrow functions and methods)
      const isFunctionLike =
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node);

      if (isFunctionLike) {
        const eventListenerChecks = eventListenerAnalyzer.analyze(node);

        // Create violations for missing event listeners
        for (const check of eventListenerChecks) {
          const violation = self.createEventListenerViolation(
            sourceFile,
            check,
            fileImports,
          );

          if (violation) {
            self.violations.push(violation);
          }
        }
      }

      // Continue traversing
      ts.forEachChild(node, visitForFunctions);
    }

    visitForFunctions(sourceFile);
  }

  /**
   * Creates a violation for missing required event listeners
   */
  private createEventListenerViolation(
    sourceFile: ts.SourceFile,
    check: EventListenerCheck,
    fileImports: Set<string>,
  ): Violation | null {
    // Only create violation if this package is actually imported
    if (!fileImports.has(check.packageName)) {
      return null;
    }

    const location = sourceFile.getLineAndCharacterOfPosition(
      check.declarationNode.getStart(),
    );

    const description = `Instance '${check.variableName}' of ${check.packageName}.${check.className} is missing required '${check.missingEvent}' event listener. Unhandled events can cause crashes.`;

    return {
      id: `${check.packageName}-missing-${check.missingEvent}-listener`,
      severity: check.requiredListener.severity || "error",
      file: sourceFile.fileName,
      line: location.line + 1,
      column: location.character + 1,
      package: check.packageName,
      function: check.className,
      contract_clause: `missing-${check.missingEvent}-listener`,
      description,
      source_doc: "",
      suggested_fix: `Add ${check.variableName}.on('${check.missingEvent}', (err) => { /* handle error */ }) to handle ${check.missingEvent} events`,
    };
  }

  /**
   * Creates a violation for unprotected async calls
   */
  private createAsyncErrorViolation(
    sourceFile: ts.SourceFile,
    detection: {
      line: number;
      column: number;
      awaitText: string;
      functionName: string;
      node?: ts.CallExpression;
    },
    _functionNode: ts.Node,
    trackedInstances: Map<string, string>,
    fileImports: Set<string>,
  ): Violation | null {
    // PRIORITY 1: Type-aware detection (most accurate - uses TypeScript's type system)
    // This eliminates false positives from pattern overlap (e.g., mongoose ".create" vs discord.js ".createInvite")
    if (detection.node) {
      const typeBasedPackage = this.detectPackageFromType(detection.node);
      if (typeBasedPackage) {
        return this.createViolationForPackage(
          sourceFile,
          detection,
          typeBasedPackage,
          fileImports,
        );
      }
    }

    // PRIORITY 2: Check if this await is on a tracked instance (high accuracy)
    // Extract instance name from await expression (e.g., "this.catModel" from "await this.catModel.find()")
    const instancePackage = this.detectPackageFromTrackedInstance(
      detection.awaitText,
      trackedInstances,
    );

    if (instancePackage) {
      // Found a tracked instance - this is high-confidence detection
      return this.createViolationForPackage(
        sourceFile,
        detection,
        instancePackage,
        fileImports,
      );
    }

    // PRIORITY 3: Check data-driven detection patterns from contracts (fallback)
    // This allows contracts to define their own detection rules without analyzer changes
    const detectedPackage = this.detectPackageFromAwaitText(
      detection.awaitText,
    );

    if (!detectedPackage) {
      // No package detected by patterns and no tracked instance
      // Don't check legacy patterns to avoid false positives
      // Instance tracking is the primary method for ORM packages
      return null;
    }

    // Check if this package requires instance tracking
    const contract = this.contracts.get(detectedPackage);
    if (contract?.detection?.require_instance_tracking) {
      // This package requires instance tracking to avoid false positives
      // Pattern-based detection matched, but we didn't find a tracked instance
      // This is likely a false positive (e.g., .validate() on a non-mongoose object)
      return null;
    }

    // Package detected via contract patterns - create violation
    // NOTE: Pattern-based detection is less accurate than type-aware or instance tracking
    // and may produce false positives for packages with generic method names
    return this.createViolationForPackage(
      sourceFile,
      detection,
      detectedPackage,
      fileImports,
    );
  }

  /**
   * Detects which package is being called from the await expression text
   * Uses dynamic pattern matching from contract detection rules
   */
  private detectPackageFromAwaitText(awaitText: string): string | null {
    const lowerText = awaitText.toLowerCase();

    // Collect all matching patterns with their specificity (length)
    const matches: Array<{
      pattern: string;
      packageName: string;
      specificity: number;
    }> = [];

    for (const [pattern, packageName] of this.awaitPatternToPackage.entries()) {
      if (lowerText.includes(pattern)) {
        matches.push({
          pattern,
          packageName,
          specificity: pattern.length, // Longer patterns are more specific
        });
      }
    }

    // If no matches, return null
    if (matches.length === 0) {
      return null;
    }

    // If only one match, return it
    if (matches.length === 1) {
      return matches[0].packageName;
    }

    // Multiple matches - return the most specific (longest) pattern
    // This prevents false positives from broad patterns like ".create"
    // matching more specific patterns like ".createInvite"
    matches.sort((a, b) => b.specificity - a.specificity);
    return matches[0].packageName;
  }

  /**
   * Detects package using TypeScript's type system (MOST ACCURATE METHOD)
   *
   * Uses TypeScript's type checker to determine which package a variable belongs to
   * based on its type, eliminating false positives from pattern matching.
   *
   * Steps:
   * 1. Get the type of the object the method is called on
   * 2. Extract the type name (e.g., "TextChannel", "Model")
   * 3. Look up which package defines this type
   *
   * Example:
   *   const channel: TextChannel = getChannel();
   *   await channel.createInvite();
   *
   *   → channel has type TextChannel
   *   → TextChannel is from discord.js (per contract detection.type_names)
   *   → Return "discord.js"
   *
   * This eliminates false positives from pattern overlap:
   *   - mongoose ".create" won't match discord.js ".createInvite()"
   *   - Each type uniquely identifies its package
   *
   * @param node The call expression node from the AST
   * @returns Package name if type is recognized, null otherwise
   */
  private detectPackageFromType(node: ts.CallExpression): string | null {
    const expression = node.expression;

    // Handle: object.method() - e.g., channel.createInvite()
    if (ts.isPropertyAccessExpression(expression)) {
      const objectExpr = expression.expression;

      // Get the type of the object
      const type = this.typeChecker.getTypeAtLocation(objectExpr);

      // Try multiple strategies to extract the package
      const packageName = this.extractPackageFromType(type);
      if (packageName) {
        return packageName;
      }

      // Handle: ClassName.staticMethod() - e.g., Model.create()
      if (ts.isIdentifier(objectExpr)) {
        const className = objectExpr.text;
        const packageName = this.classToPackage.get(className);
        if (packageName) {
          return packageName;
        }
      }
    }

    return null;
  }

  /**
   * Extracts package name from a TypeScript type
   * Handles edge cases: generics, aliases, unions, intersections
   *
   * Edge cases:
   * 1. Type aliases: import { Client as Bot } from 'discord.js' → resolve "Bot" to "Client"
   * 2. Generic types: Model<User> → extract base type "Model"
   * 3. Union types: TextChannel | VoiceChannel → try all types in union
   * 4. Intersection types: A & B → try all types in intersection
   *
   * @param type The TypeScript type to analyze
   * @returns Package name if recognized, null otherwise
   */
  private extractPackageFromType(type: ts.Type): string | null {
    // Strategy 1: Direct symbol lookup
    const symbol = type.getSymbol();
    if (symbol) {
      const typeName = symbol.getName();
      const packageName = this.typeToPackage.get(typeName);
      if (packageName) {
        return packageName;
      }

      // EDGE CASE 1: Type aliases (e.g., import { Client as DiscordClient })
      // Check if this symbol is an alias and resolve it
      // Note: getAliasedSymbol should only be called on alias symbols
      if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        const aliasedSymbol = this.typeChecker.getAliasedSymbol(symbol);
        if (aliasedSymbol && aliasedSymbol !== symbol) {
          const aliasedName = aliasedSymbol.getName();
          const aliasedPackage = this.typeToPackage.get(aliasedName);
          if (aliasedPackage) {
            return aliasedPackage;
          }
        }
      }
    }

    // EDGE CASE 2: Generic types (e.g., Model<User>)
    // Check if this is a type reference with type arguments
    if (type.aliasSymbol) {
      const aliasName = type.aliasSymbol.getName();
      const aliasPackage = this.typeToPackage.get(aliasName);
      if (aliasPackage) {
        return aliasPackage;
      }
    }

    // EDGE CASE 3: Union types (e.g., TextChannel | VoiceChannel)
    // If multiple types, try each one and return first match
    if (type.isUnion()) {
      for (const unionType of type.types) {
        const packageName = this.extractPackageFromType(unionType);
        if (packageName) {
          return packageName; // Return first matching type in union
        }
      }
    }

    // EDGE CASE 4: Intersection types (e.g., A & B)
    // Less common but worth handling
    if (type.isIntersection && type.isIntersection()) {
      for (const intersectionType of type.types) {
        const packageName = this.extractPackageFromType(intersectionType);
        if (packageName) {
          return packageName; // Return first matching type in intersection
        }
      }
    }

    return null;
  }

  /**
   * Detects package from tracked instance (most accurate method)
   * Extracts instance name from await expression and checks if it's tracked
   *
   * Examples:
   *   "await this.catModel.find()" → extracts "catModel" → checks if tracked
   *   "await user.save()" → extracts "user" → checks if tracked
   *   "await Model.create()" → extracts "Model" → checks if tracked
   */
  private detectPackageFromTrackedInstance(
    awaitText: string,
    trackedInstances: Map<string, string>,
  ): string | null {
    // Remove "await " prefix if present
    const text = awaitText.replace(/^await\s+/, "");

    // Extract instance name patterns:
    // 1. "this.instanceName.method()" → "instanceName"
    // 2. "instanceName.method()" → "instanceName"
    // 3. "ClassName.staticMethod()" → "ClassName"

    const patterns = [
      // Match: this.instanceName.anything
      /^this\.(\w+)\./,
      // Match: instanceName.anything
      /^(\w+)\./,
      // Match: standalone identifier (for direct calls)
      /^(\w+)\(/,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const instanceName = match[1];
        const packageName = trackedInstances.get(instanceName);

        if (packageName) {
          // Found a tracked instance - high confidence detection
          return packageName;
        }
      }
    }

    return null;
  }

  /**
   * Creates a violation for a detected package
   * Extracted from createAsyncErrorViolation to reduce duplication
   */
  private createViolationForPackage(
    sourceFile: ts.SourceFile,
    detection: {
      line: number;
      column: number;
      awaitText: string;
      functionName: string;
    },
    packageName: string,
    fileImports: Set<string>,
  ): Violation | null {
    // Context-aware contract application: only apply if package is imported
    if (!fileImports.has(packageName)) {
      return null;
    }

    // Get the contract for this package
    const contract = this.contracts.get(packageName);
    if (!contract) {
      return null; // No contract for this package
    }

    // Find the matching function and postcondition
    let matchingPostcondition: Postcondition | undefined;
    let matchingFunctionName: string | undefined;

    for (const func of contract.functions) {
      // Check if any postcondition mentions async errors or matches the pattern
      const asyncErrorPostcondition = func.postconditions?.find(
        (pc) =>
          pc.id?.includes("no-try-catch") ||
          pc.id?.includes("async") ||
          pc.id?.includes("unhandled"),
      );

      if (asyncErrorPostcondition) {
        matchingPostcondition = asyncErrorPostcondition;
        matchingFunctionName = func.name;
        break;
      }
    }

    // If we found a matching postcondition, create a violation
    if (matchingPostcondition && matchingFunctionName) {
      const description = `Async function '${detection.functionName}' contains unprotected await expression. ${detection.awaitText.substring(0, 50)}... may throw unhandled errors.`;

      return {
        id: `${packageName}-${matchingPostcondition.id}`,
        severity: matchingPostcondition.severity || "error",
        file: sourceFile.fileName,
        line: detection.line,
        column: detection.column,
        package: packageName,
        function: matchingFunctionName,
        contract_clause: matchingPostcondition.id,
        description,
        source_doc:
          matchingPostcondition.sources?.[0] ||
          matchingPostcondition.source ||
          "",
        suggested_fix: matchingPostcondition.required_handling,
      };
    }

    return null;
  }

  /**
   * Creates a violation for empty or ineffective catch blocks
   */
  private createEmptyCatchViolation(
    sourceFile: ts.SourceFile,
    catchBlock: ts.CatchClause,
    effectiveness: {
      isEmpty: boolean;
      hasConsoleOnly: boolean;
      hasCommentOnly: boolean;
      hasUserFeedback: boolean;
    },
    fileImports: Set<string>,
  ): Violation | null {
    // Look for contracts with empty-catch-block postconditions
    let matchingPostcondition: Postcondition | undefined;
    let matchingPackageName: string | undefined;
    let matchingFunctionName: string | undefined;

    for (const [packageName, contract] of this.contracts.entries()) {
      // Context-aware contract application: only apply if package is imported
      if (!fileImports.has(packageName)) {
        continue;
      }

      for (const func of contract.functions) {
        const emptyCatchPostcondition = func.postconditions?.find(
          (pc) =>
            pc.id?.includes("empty-catch") || pc.id?.includes("silent-failure"),
        );

        if (emptyCatchPostcondition) {
          matchingPostcondition = emptyCatchPostcondition;
          matchingPackageName = packageName;
          matchingFunctionName = func.name;
          break;
        }
      }
      if (matchingPostcondition) break;
    }

    if (
      !matchingPostcondition ||
      !matchingPackageName ||
      !matchingFunctionName
    ) {
      return null;
    }

    const location = sourceFile.getLineAndCharacterOfPosition(
      catchBlock.getStart(),
    );
    const description = effectiveness.isEmpty
      ? "Empty catch block - errors are silently swallowed. Users receive no feedback when operations fail."
      : "Catch block only logs to console without user feedback. Consider using toast.error() or setError().";

    return {
      id: `${matchingPackageName}-${matchingPostcondition.id}`,
      severity: effectiveness.isEmpty ? "error" : "warning",
      file: sourceFile.fileName,
      line: location.line + 1,
      column: location.character + 1,
      package: matchingPackageName,
      function: matchingFunctionName,
      contract_clause: matchingPostcondition.id,
      description,
      source_doc:
        matchingPostcondition.sources?.[0] ||
        matchingPostcondition.source ||
        "",
      suggested_fix: matchingPostcondition.required_handling,
    };
  }

  /**
   * Analyzes a call expression to see if it violates any contracts
   */
  private analyzeCallExpression(
    node: ts.CallExpression,
    sourceFile: ts.SourceFile,
    axiosInstances: Map<string, string>,
    instancesWithInterceptors: Set<string>,
    globalHandlers: {
      hasQueryCacheOnError: boolean;
      hasMutationCacheOnError: boolean;
    },
    schemaInstances: Map<string, string>,
    fileImports: Set<string>,
  ): void {
    // Check if this is a React Query hook
    const reactQueryAnalyzer = new ReactQueryAnalyzer(
      sourceFile,
      this.program.getTypeChecker(),
    );
    const hookName = reactQueryAnalyzer.isReactQueryHook(node);

    if (hookName) {
      this.analyzeReactQueryHook(
        node,
        sourceFile,
        hookName,
        reactQueryAnalyzer,
        globalHandlers,
      );
      return;
    }

    // Special handling for AWS SDK S3 send() method
    // Pattern: s3Client.send(new GetObjectCommand(...))
    const s3Analysis = this.analyzeS3SendCall(node, sourceFile, axiosInstances);
    if (s3Analysis) {
      this.analyzeS3Command(s3Analysis, node, sourceFile);
      return;
    }

    // Skip call expressions used as decorators (e.g., @Controller(), @Injectable()).
    // Decorator calls are not real call sites that need error handling — the parent
    // node is a Decorator when the CallExpression is used in decorator position.
    if (node.parent && ts.isDecorator(node.parent)) {
      return;
    }

    const callSite = this.extractCallSite(
      node,
      sourceFile,
      axiosInstances,
      schemaInstances,
    );
    if (!callSite) return;

    const contract = this.contracts.get(callSite.packageName);
    if (!contract) return;

    // Context-aware contract application: only apply if package is imported
    if (!fileImports.has(callSite.packageName)) {
      return;
    }

    // NEW: Handle namespace methods
    // Check if this call has a namespace (e.g., ts.sys.readFile())
    const namespace = (node as any).__namespace;

    // Match function contract, considering namespace if present
    const functionContract = contract.functions.find((f) => {
      // If the call has a namespace, match both namespace and function name
      if (namespace) {
        return f.namespace === namespace && f.name === callSite.functionName;
      }
      // Otherwise, match function name only (and ensure it's not a namespaced function)
      return f.name === callSite.functionName && !f.namespace;
    });

    if (!functionContract) return;

    // Check if this call is on an instance with error interceptors
    const instanceVar = this.extractInstanceVariable(node, sourceFile);
    const hasGlobalInterceptor = instanceVar
      ? instancesWithInterceptors.has(instanceVar)
      : false;

    // Analyze what error handling exists at this call site
    const analysis = this.analyzeErrorHandling(
      node,
      sourceFile,
      hasGlobalInterceptor,
    );

    // Check each postcondition
    for (const postcondition of functionContract.postconditions || []) {
      if (postcondition.severity !== "error") continue;
      if (!postcondition.required_handling) continue;

      const violation = this.checkPostcondition(
        callSite,
        postcondition,
        analysis,
        contract.package,
        functionContract.name,
        node,
        sourceFile,
      );

      if (violation) {
        this.violations.push(violation);
      }
    }
  }

  /**
   * Analyzes React Query hooks for error handling
   */
  private analyzeReactQueryHook(
    node: ts.CallExpression,
    sourceFile: ts.SourceFile,
    hookName: string,
    reactQueryAnalyzer: ReactQueryAnalyzer,
    globalHandlers: {
      hasQueryCacheOnError: boolean;
      hasMutationCacheOnError: boolean;
    },
  ): void {
    // Check if we have a contract for React Query
    const contract = this.contracts.get("@tanstack/react-query");
    if (!contract) return;

    // Find the function contract for this hook
    const functionContract = contract.functions.find(
      (f) => f.name === hookName,
    );
    if (!functionContract) return;

    // Extract hook call information
    const hookCall = reactQueryAnalyzer.extractHookCall(node, hookName);
    if (!hookCall) return;

    // Find the containing component
    const componentNode = reactQueryAnalyzer.findContainingComponent(node);
    if (!componentNode) return;

    // Check for deferred error handling (mutateAsync with try-catch)
    let hasDeferredErrorHandling = false;
    if (hookName === "useMutation") {
      // Check if this mutation is assigned to a variable and later used with try-catch
      const parent = node.parent;
      if (
        parent &&
        ts.isVariableDeclaration(parent) &&
        ts.isIdentifier(parent.name)
      ) {
        const mutationVarName = parent.name.text;
        hasDeferredErrorHandling = this.checkMutateAsyncInTryCatch(
          mutationVarName,
          componentNode,
          sourceFile,
        );
      }
    }

    // Analyze error handling
    const errorHandling = reactQueryAnalyzer.analyzeHookErrorHandling(
      hookCall,
      componentNode,
    );

    // Credit global handlers if they exist
    if (hookName === "useQuery" || hookName === "useInfiniteQuery") {
      if (globalHandlers.hasQueryCacheOnError) {
        errorHandling.hasGlobalHandler = true;
      }
    } else if (hookName === "useMutation") {
      if (globalHandlers.hasMutationCacheOnError) {
        errorHandling.hasGlobalHandler = true;
      }
    }

    // Check postconditions
    for (const postcondition of functionContract.postconditions || []) {
      const violation = this.checkReactQueryPostcondition(
        hookCall,
        errorHandling,
        postcondition,
        contract.package,
        functionContract.name,
        hasDeferredErrorHandling,
      );

      if (violation) {
        this.violations.push(violation);
      }
    }
  }

  /**
   * Checks if a mutation variable is used with mutateAsync in a try-catch block
   */
  private checkMutateAsyncInTryCatch(
    mutationVarName: string,
    componentNode: ts.Node,
    sourceFile: ts.SourceFile,
  ): boolean {
    let foundInTryCatch = false;

    const visit = (node: ts.Node): void => {
      // Look for: mutation.mutateAsync(...) or await mutation.mutateAsync(...)
      if (ts.isCallExpression(node)) {
        if (ts.isPropertyAccessExpression(node.expression)) {
          const objName = node.expression.expression.getText(sourceFile);
          const methodName = node.expression.name.text;

          if (objName === mutationVarName && methodName === "mutateAsync") {
            // Check if this call is inside a try-catch
            if (this.isInTryCatch(node)) {
              foundInTryCatch = true;
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(componentNode);
    return foundInTryCatch;
  }

  /**
   * Checks a React Query postcondition and returns a violation if not met
   */
  private checkReactQueryPostcondition(
    hookCall: any,
    errorHandling: any,
    postcondition: Postcondition,
    packageName: string,
    functionName: string,
    hasDeferredErrorHandling: boolean = false,
  ): Violation | null {
    // Only check error severity postconditions
    if (postcondition.severity !== "error") return null;

    const clauseId = postcondition.id;

    // Check query-error-unhandled
    if (
      clauseId === "query-error-unhandled" ||
      clauseId === "mutation-error-unhandled" ||
      clauseId === "infinite-query-error-unhandled"
    ) {
      // Error is handled if ANY of these are true:
      // 1. Error state is checked (isError, error)
      // 2. onError callback is provided
      // 3. Global error handler is configured
      // 4. Deferred error handling (mutateAsync + try-catch)
      if (
        errorHandling.hasErrorStateCheck ||
        errorHandling.hasOnErrorCallback ||
        errorHandling.hasGlobalHandler ||
        hasDeferredErrorHandling
      ) {
        return null; // No violation
      }

      // Create violation
      return {
        id: `${packageName}-${clauseId}`,
        severity: postcondition.severity,
        file: hookCall.location.file,
        line: hookCall.location.line,
        column: hookCall.location.column,
        package: packageName,
        function: functionName,
        contract_clause: clauseId,
        description:
          "No error handling found. Errors will crash the application.",
        source_doc: postcondition.sources?.[0] || postcondition.source || "",
        suggested_fix: postcondition.required_handling,
      };
    }

    // Check mutation-optimistic-update-rollback
    if (clauseId === "mutation-optimistic-update-rollback") {
      if (hookCall.options.onMutate && !hookCall.options.onError) {
        return {
          id: `${packageName}-${clauseId}`,
          severity: postcondition.severity,
          file: hookCall.location.file,
          line: hookCall.location.line,
          column: hookCall.location.column,
          package: packageName,
          function: functionName,
          contract_clause: clauseId,
          description:
            "Optimistic update without rollback. UI will show incorrect data on error.",
          source_doc: postcondition.sources?.[0] || postcondition.source || "",
          suggested_fix: postcondition.required_handling,
        };
      }
    }

    return null;
  }

  /**
   * Walks up a property access chain and returns components
   * Example: prisma.user.create → { root: 'prisma', chain: ['user'], method: 'create' }
   * Example: axios.get → { root: 'axios', chain: [], method: 'get' }
   * Example: openai.chat.completions.create → { root: 'openai', chain: ['chat', 'completions'], method: 'create' }
   */
  private walkPropertyAccessChain(
    expr: ts.PropertyAccessExpression,
    _sourceFile: ts.SourceFile,
  ): { root: string; chain: string[]; method: string } | null {
    const chain: string[] = [];
    let current: ts.Expression = expr.expression;

    // Walk up the chain, collecting property names
    while (ts.isPropertyAccessExpression(current)) {
      chain.unshift(current.name.text); // Add to front to maintain order
      current = current.expression;
    }

    // NEW: Handle builder patterns - walk through call expressions
    // Example: supabase.from('users').select()
    // - current is now: from('users') [CallExpression]
    // - need to walk through it to reach 'supabase' [Identifier]
    while (ts.isCallExpression(current)) {
      if (ts.isPropertyAccessExpression(current.expression)) {
        // The call is on a property access (e.g., supabase.from)
        // Add the method name to the chain
        chain.unshift(current.expression.name.text);
        current = current.expression.expression;

        // Continue walking through any additional property accesses
        while (ts.isPropertyAccessExpression(current)) {
          chain.unshift(current.name.text);
          current = current.expression;
        }
      } else {
        // Handle factory function pattern: sharp().toFile()
        // Check if the call expression is on a simple identifier (e.g., sharp)
        if (ts.isIdentifier(current.expression)) {
          // Found root identifier, use it as the root
          current = current.expression;
          break; // Exit with the identifier
        } else {
          // Unsupported pattern (e.g., complex expression)
          break;
        }
      }
    }

    // At this point, current should be the root identifier
    if (!ts.isIdentifier(current)) {
      return null; // Unsupported pattern (e.g., complex expression)
    }

    const root = current.text;
    const method = expr.name.text;

    return { root, chain, method };
  }

  /**
   * Extracts call site information from a call expression
   */
  private extractCallSite(
    node: ts.CallExpression,
    sourceFile: ts.SourceFile,
    axiosInstances: Map<string, string>,
    schemaInstances: Map<string, string>,
  ): CallSite | null {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );

    // Try to determine the function and package being called
    let functionName: string | null = null;
    let packageName: string | null = null;

    if (ts.isPropertyAccessExpression(node.expression)) {
      // Walk the full property access chain to handle both simple and chained calls
      // Simple: axios.get() → { root: 'axios', chain: [], method: 'get' }
      // Chained: prisma.user.create() → { root: 'prisma', chain: ['user'], method: 'create' }
      // Property: this.prisma.user.create() → { root: 'this', chain: ['prisma', 'user'], method: 'create' }
      // Namespace: ts.sys.readFile() → { root: 'ts', chain: ['sys'], method: 'readFile' }
      const chainInfo = this.walkPropertyAccessChain(
        node.expression,
        sourceFile,
      );

      if (chainInfo) {
        functionName = chainInfo.method;
        let rootIdentifier = chainInfo.root;

        // Special handling for 'this.property' patterns
        if (rootIdentifier === "this" && chainInfo.chain.length > 0) {
          // For this.prisma.user.create(), use 'prisma' as the identifier
          rootIdentifier = chainInfo.chain[0];
          // Remove first element from chain since we're using it as root
          chainInfo.chain = chainInfo.chain.slice(1);
        }

        // Check if root is a direct package name
        if (this.contracts.has(rootIdentifier)) {
          packageName = rootIdentifier;
        }
        // Check if root is a known instance variable (e.g., axiosInstance, prismaClient)
        else if (axiosInstances.has(rootIdentifier)) {
          packageName = axiosInstances.get(rootIdentifier)!;
        }
        // Check if root is a tracked schema instance (e.g., userSchema created from z.object())
        else if (schemaInstances.has(rootIdentifier)) {
          packageName = schemaInstances.get(rootIdentifier)!;
        }
        // Fallback: resolve from imports
        else {
          packageName = this.resolvePackageFromImports(
            rootIdentifier,
            sourceFile,
          );
        }

        // NEW: Handle namespace methods
        // For patterns like ts.sys.readFile() where:
        // - root = 'ts' (namespace import alias)
        // - chain = ['sys'] (namespace within the package)
        // - method = 'readFile' (function name)
        // We need to check if there's a contract for this namespace method
        if (packageName && chainInfo.chain.length > 0) {
          const namespace = chainInfo.chain[0];
          const contract = this.contracts.get(packageName);

          if (contract) {
            // Check if any function in this contract has a matching namespace
            const namespacedFunction = contract.functions.find(
              (f) => f.namespace === namespace && f.name === functionName,
            );

            // If we found a namespaced function, we'll use it
            // The functionName stays as the method (e.g., 'readFile')
            // The chain info will help us match it later
            if (namespacedFunction) {
              // Store the namespace info for later matching
              // We'll use this in analyzeCallExpression
              (node as any).__namespace = namespace;
            }
          }
        }
      }
    } else if (ts.isIdentifier(node.expression)) {
      // get(...) pattern after import
      functionName = node.expression.text;
    }

    if (!functionName) return null;

    // Try to resolve package name from imports
    if (!packageName) {
      packageName = this.resolvePackageFromImports(functionName, sourceFile);
    }

    if (!packageName || !this.contracts.has(packageName)) {
      return null;
    }

    return {
      file: sourceFile.fileName,
      line: line + 1,
      column: character + 1,
      functionName,
      packageName,
    };
  }

  /**
   * Extracts the instance variable name from a call expression
   * e.g., for "axiosInstance.get(...)" returns "axiosInstance"
   */
  private extractInstanceVariable(
    node: ts.CallExpression,
    _sourceFile: ts.SourceFile,
  ): string | null {
    if (ts.isPropertyAccessExpression(node.expression)) {
      if (ts.isIdentifier(node.expression.expression)) {
        // Pattern: instance.get(...) - direct identifier
        return node.expression.expression.text;
      } else if (ts.isPropertyAccessExpression(node.expression.expression)) {
        // Pattern: this._axios.get(...) or obj.instance.get(...)
        return node.expression.expression.name.text;
      }
    }
    return null;
  }

  /**
   * Resolves which package a function comes from by looking at imports
   */
  private resolvePackageFromImports(
    functionName: string,
    sourceFile: ts.SourceFile,
  ): string | null {
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        const moduleSpecifier = statement.moduleSpecifier;

        if (ts.isStringLiteral(moduleSpecifier)) {
          const importPath = moduleSpecifier.text;
          let packageName = importPath;

          // Handle subpath exports: @clerk/nextjs/server -> @clerk/nextjs
          // Check if the import path has a contract, if not try the parent package
          if (!this.contracts.has(packageName)) {
            // Try removing subpath to find parent package
            // e.g., "@clerk/nextjs/server" -> "@clerk/nextjs"
            const lastSlash = importPath.lastIndexOf("/");
            if (lastSlash > 0 && importPath.startsWith("@")) {
              // For scoped packages, only remove after the package name
              const firstSlash = importPath.indexOf("/");
              if (lastSlash > firstSlash) {
                const parentPackage = importPath.substring(0, lastSlash);
                if (this.contracts.has(parentPackage)) {
                  packageName = parentPackage;
                }
              }
            }
          }

          if (!this.contracts.has(packageName)) continue;

          // Check if this import includes our function
          const importClause = statement.importClause;
          if (!importClause) continue;

          // Handle: import axios from 'axios'
          if (importClause.name?.text === functionName) {
            return packageName;
          }

          // Handle: import { get } from 'axios'
          if (
            importClause.namedBindings &&
            ts.isNamedImports(importClause.namedBindings)
          ) {
            for (const element of importClause.namedBindings.elements) {
              if (element.name.text === functionName) {
                return packageName;
              }
            }
          }

          // Handle: import * as ts from 'typescript'
          // NEW: Namespace imports support for packages with namespace methods
          if (
            importClause.namedBindings &&
            ts.isNamespaceImport(importClause.namedBindings)
          ) {
            const namespaceAlias = importClause.namedBindings.name.text;
            if (namespaceAlias === functionName) {
              return packageName;
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Extracts package name from new expressions
   * Examples: new PrismaClient() → "@prisma/client"
   *          new Stripe(key) → "stripe"
   *          new OpenAI(config) → "openai"
   */
  private extractPackageFromNewExpression(
    node: ts.Expression,
    sourceFile: ts.SourceFile,
  ): string | null {
    if (!ts.isNewExpression(node)) return null;

    const className = node.expression.getText(sourceFile);

    // Look up package name from detection rules
    const packageName = this.classToPackage.get(className);
    if (packageName) {
      return packageName;
    }

    // Fallback: resolve from imports
    return this.resolvePackageFromImports(className, sourceFile);
  }

  /**
   * Extracts package name from axios.create() call
   * Returns the package name if this is an axios.create() or similar factory call
   */
  private extractPackageFromAxiosCreate(
    node: ts.Expression,
    sourceFile: ts.SourceFile,
  ): string | null {
    // Pattern 1: axios.create(...)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const methodName = node.expression.name.text;

      // Check if this is a factory method (create, default, etc.)
      if (methodName === "create" || methodName === "default") {
        if (ts.isIdentifier(node.expression.expression)) {
          const objectName = node.expression.expression.text;

          // Check if this is from a package we track
          const packageName = this.resolvePackageFromImports(
            objectName,
            sourceFile,
          );
          if (packageName) {
            return packageName;
          }

          // Direct match (e.g., axios.create where axios is imported as 'axios')
          if (this.contracts.has(objectName)) {
            return objectName;
          }
        }
      }
    }

    // Pattern 2: createClient(...) - named function import
    // Example: import { createClient } from '@supabase/supabase-js'
    //          const supabase = createClient(url, key)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const functionName = node.expression.text;

      // Check if this is a factory function (createClient, etc.)
      if (functionName.startsWith("create") || functionName === "default") {
        // Resolve which package this function is from
        const packageName = this.resolvePackageFromImports(
          functionName,
          sourceFile,
        );
        if (packageName && this.contracts.has(packageName)) {
          return packageName;
        }
      }

      // Pattern 3: Direct package function calls
      // Example: import twilio from 'twilio'
      //          const client = twilio(accountSid, authToken)
      // This handles packages where the default export is a function that creates a client instance
      const packageName = this.resolvePackageFromImports(
        functionName,
        sourceFile,
      );
      if (packageName && this.contracts.has(packageName)) {
        return packageName;
      }
    }

    return null;
  }

  /**
   * Extracts package name from generic factory methods defined in detection rules
   * Examples:
   *   mongoose.model('User', schema) → "mongoose" (if factory_methods includes "model")
   *   prisma.client() → "prisma" (if factory_methods includes "client")
   */
  private extractPackageFromGenericFactory(
    node: ts.Expression,
    sourceFile: ts.SourceFile,
  ): string | null {
    // Pattern: objectName.methodName(...)
    // Example: mongoose.model('User', schema)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const methodName = node.expression.name.text;

      // Check if this method is registered as a factory method for any package
      const packageName = this.factoryToPackage.get(methodName);
      if (packageName) {
        // Verify the object name matches the package (or is imported from it)
        if (ts.isIdentifier(node.expression.expression)) {
          const objectName = node.expression.expression.text;

          // Check if this object is the package itself or imported from it
          const resolvedPackage = this.resolvePackageFromImports(
            objectName,
            sourceFile,
          );
          if (resolvedPackage === packageName || objectName === packageName) {
            return packageName;
          }
        }
      }
    }

    return null;
  }

  /**
   * Extracts package name from schema factory methods (z.object(), z.string(), etc.)
   * Returns the package name if this is a schema creation call
   */
  private extractPackageFromSchemaFactory(
    node: ts.Expression,
    sourceFile: ts.SourceFile,
  ): string | null {
    // Pattern: z.object(...), z.string(), z.number(), etc.
    // These are factory methods that return schema instances
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const methodName = node.expression.name.text;

      // Common zod schema factory methods
      const zodFactoryMethods = [
        "object",
        "string",
        "number",
        "boolean",
        "array",
        "tuple",
        "union",
        "intersection",
        "record",
        "map",
        "set",
        "date",
        "undefined",
        "null",
        "void",
        "any",
        "unknown",
        "never",
        "literal",
        "enum",
        "nativeEnum",
        "promise",
        "function",
        "lazy",
        "discriminatedUnion",
        "instanceof",
        "nan",
        "optional",
        "nullable",
        "coerce",
      ];

      if (zodFactoryMethods.includes(methodName)) {
        if (ts.isIdentifier(node.expression.expression)) {
          const objectName = node.expression.expression.text;

          // Check if this is 'z' from zod import
          const packageName = this.resolvePackageFromImports(
            objectName,
            sourceFile,
          );
          if (packageName === "zod") {
            return packageName;
          }

          // Direct match if imported as something else
          if (objectName === "z" || objectName === "zod") {
            // Verify it's actually from zod package
            const resolved = this.resolvePackageFromImports(
              objectName,
              sourceFile,
            );
            if (resolved) {
              return resolved;
            }
          }
        }
      }
    }

    // Pattern: z.ZodObject.create(...) - less common but possible
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const methodName = node.expression.name.text;
      if (
        methodName === "create" &&
        ts.isPropertyAccessExpression(node.expression.expression)
      ) {
        // Check if this is z.ZodObject.create()
        const className = node.expression.expression.name.text;
        if (className.startsWith("Zod")) {
          const rootExpr = node.expression.expression.expression;
          if (ts.isIdentifier(rootExpr)) {
            const packageName = this.resolvePackageFromImports(
              rootExpr.text,
              sourceFile,
            );
            if (packageName === "zod") {
              return packageName;
            }
          }
        }
      }
    }

    // Pattern: schema.extend(...), schema.merge(...), schema.pick(...), etc.
    // These also return new schema instances
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const methodName = node.expression.name.text;
      const schemaTransformMethods = [
        "extend",
        "merge",
        "pick",
        "omit",
        "partial",
        "required",
        "passthrough",
        "strict",
        "strip",
        "catchall",
        "brand",
        "default",
        "describe",
        "refine",
        "superRefine",
        "transform",
        "preprocess",
        "pipe",
        "readonly",
        "optional",
        "nullable",
        "nullish",
        "array",
        "promise",
        "or",
        "and",
      ];

      if (schemaTransformMethods.includes(methodName)) {
        // Check if the base is already a tracked schema
        // This is a bit tricky since we're in the instance detection phase
        // For now, we'll just check if it looks like a schema method call
        return null; // Will be handled by tracking the base schema
      }
    }

    return null;
  }

  /**
   * Analyzes what error handling exists around a call site
   */
  /**
   * Checks if a call is within an Express route that has error middleware
   * Pattern: app.post('/route', middleware, errorHandler)
   * where errorHandler has 4 parameters (err, req, res, next)
   */
  private isWithinExpressErrorMiddleware(
    node: ts.CallExpression,
    sourceFile: ts.SourceFile,
  ): boolean {
    // Walk up to find if this call is an argument to an Express route method
    let current: ts.Node | undefined = node;

    while (current) {
      // Check if this is an argument to app.get/post/put/delete/etc
      if (ts.isCallExpression(current)) {
        const expr = current.expression;

        // Pattern: app.post(...) or router.post(...)
        if (ts.isPropertyAccessExpression(expr)) {
          const methodName = expr.name.text;
          const objectName = ts.isIdentifier(expr.expression)
            ? expr.expression.text
            : "";

          // Check if this looks like an Express route registration
          const isExpressRoute =
            ["get", "post", "put", "delete", "patch", "all", "use"].includes(
              methodName,
            ) &&
            (objectName === "app" ||
              objectName === "router" ||
              objectName.includes("app") ||
              objectName.includes("router"));

          if (isExpressRoute && current.arguments.length >= 2) {
            // Check the arguments - look for error handler middleware
            // Error handler has signature: (err, req, res, next)
            for (let i = 1; i < current.arguments.length; i++) {
              const arg = current.arguments[i];

              // Check if this argument is a function with 4 parameters
              if (ts.isFunctionExpression(arg) || ts.isArrowFunction(arg)) {
                if (arg.parameters.length === 4) {
                  // This looks like an error handler middleware
                  return true;
                }
              }

              // Check if this is an identifier referencing a function
              if (ts.isIdentifier(arg)) {
                const funcName = arg.text;
                // Common patterns: handleError, errorHandler, handleMulterError
                if (
                  funcName.toLowerCase().includes("error") ||
                  funcName.toLowerCase().includes("handler")
                ) {
                  // Check if we can find the function definition
                  const funcDef = this.findFunctionDefinition(
                    funcName,
                    sourceFile,
                  );
                  if (funcDef && funcDef.parameters.length === 4) {
                    return true;
                  }
                }
              }
            }
          }
        }
      }

      current = current.parent;
    }

    return false;
  }

  /**
   * Checks if a call is within a NestJS controller method
   * NestJS controllers use exception filters to handle errors globally
   */
  private isWithinNestJSController(node: ts.CallExpression): boolean {
    let current: ts.Node | undefined = node;

    while (current) {
      // Check if we're inside a class with @Controller decorator
      if (ts.isClassDeclaration(current)) {
        if (this.hasDecorator(current, "Controller")) {
          return true;
        }
      }

      // Check if we're inside a method with a route decorator
      // @Get(), @Post(), @Put(), @Delete(), @Patch()
      if (ts.isMethodDeclaration(current)) {
        const routeDecorators = [
          "Get",
          "Post",
          "Put",
          "Delete",
          "Patch",
          "All",
        ];
        for (const decoratorName of routeDecorators) {
          if (this.hasDecorator(current, decoratorName)) {
            return true;
          }
        }
      }

      current = current.parent;
    }

    return false;
  }

  /**
   * Checks if a node has a specific decorator
   */
  private hasDecorator(
    node: ts.ClassDeclaration | ts.MethodDeclaration,
    decoratorName: string,
  ): boolean {
    if (!node.modifiers) return false;

    for (const modifier of node.modifiers) {
      if (ts.isDecorator(modifier)) {
        const expr = modifier.expression;

        // @Controller or @Controller('users')
        if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
          if (expr.expression.text === decoratorName) {
            return true;
          }
        } else if (ts.isIdentifier(expr)) {
          if (expr.text === decoratorName) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Finds a function definition by name in the source file
   */
  private findFunctionDefinition(
    name: string,
    sourceFile: ts.SourceFile,
  ): ts.FunctionDeclaration | ts.ArrowFunction | null {
    let foundFunction: ts.FunctionDeclaration | ts.ArrowFunction | null = null;

    const visit = (node: ts.Node) => {
      // Function declaration: function handleError(...)
      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        node.name.text === name
      ) {
        foundFunction = node;
        return;
      }

      // Variable with arrow function: const handleError = (...) => {}
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer &&
        ts.isArrowFunction(node.initializer)
      ) {
        foundFunction = node.initializer;
        return;
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return foundFunction;
  }

  private analyzeErrorHandling(
    node: ts.CallExpression,
    sourceFile: ts.SourceFile,
    hasGlobalInterceptor: boolean = false,
  ): CallSiteAnalysis {
    const analysis: CallSiteAnalysis = {
      callSite: {
        file: sourceFile.fileName,
        line: 0,
        column: 0,
        functionName: "",
        packageName: "",
      },
      hasTryCatch: false,
      hasPromiseCatch: false,
      checksResponseExists: false,
      checksStatusCode: false,
      handledStatusCodes: [],
      hasRetryLogic: false,
    };

    // If instance has global error interceptor, consider it handled
    if (hasGlobalInterceptor) {
      analysis.hasTryCatch = true; // Treat global interceptor as equivalent to try-catch
    }

    // Check for framework error handler patterns (Priority 2)
    if (!analysis.hasTryCatch) {
      // Check if within Express error middleware chain
      if (this.isWithinExpressErrorMiddleware(node, sourceFile)) {
        analysis.hasTryCatch = true;
      }

      // Check if within NestJS controller with exception filters
      if (this.isWithinNestJSController(node)) {
        analysis.hasTryCatch = true;
      }
    }

    // For route handlers (fastify, express), check if the handler callback has try-catch
    // Pattern: app.get('/route', async (req, res) => { try { ... } catch { ... } })
    if (!analysis.hasTryCatch) {
      if (this.isRouteHandlerWithTryCatch(node)) {
        analysis.hasTryCatch = true;
      }
    }

    // Check if call is inside a try-catch block
    if (!analysis.hasTryCatch) {
      analysis.hasTryCatch = this.isInTryCatch(node);
    }

    // Check for callback-based error handling (e.g., cloudinary)
    // Pattern: callback((error, result) => { if (error) return reject(error); })
    if (!analysis.hasTryCatch) {
      if (this.hasCallbackErrorHandling(node)) {
        analysis.hasTryCatch = true;
      }
    }

    // Check for resource cleanup patterns (e.g., @vercel/postgres)
    // Pattern: const client = await pool.connect(); ... finally { client.release(); }
    if (!analysis.hasTryCatch) {
      if (this.hasFinallyCleanup(node)) {
        analysis.hasTryCatch = true;
      }
    }

    // Check if there's a .catch() handler
    const parent = node.parent;
    if (
      parent &&
      ts.isPropertyAccessExpression(parent) &&
      parent.name.text === "catch"
    ) {
      analysis.hasPromiseCatch = true;
    }

    // Check if there's a .then(success, error) handler (2-argument form)
    // Pattern: promise.then(successCallback, errorCallback)
    if (
      parent &&
      ts.isPropertyAccessExpression(parent) &&
      parent.name.text === "then"
    ) {
      // Check if the .then() call has 2 arguments (success and error callbacks)
      const thenCall = parent.parent;
      if (
        thenCall &&
        ts.isCallExpression(thenCall) &&
        thenCall.arguments.length === 2
      ) {
        analysis.hasPromiseCatch = true;
      }
    }

    // Look for error.response checks in surrounding catch blocks
    const catchClause = this.findEnclosingCatchClause(node);
    if (catchClause) {
      analysis.checksResponseExists =
        this.catchChecksResponseExists(catchClause);
      analysis.checksStatusCode = this.catchChecksStatusCode(catchClause);
      analysis.handledStatusCodes = this.extractHandledStatusCodes(catchClause);
      analysis.hasRetryLogic = this.catchHasRetryLogic(catchClause, sourceFile);
    }

    return analysis;
  }

  /**
   * Checks if a node is inside a try-catch block
   */
  private isInTryCatch(node: ts.Node): boolean {
    let current: ts.Node | undefined = node;

    while (current) {
      if (ts.isTryStatement(current)) {
        return true;
      }
      current = current.parent;
    }

    // Check if this is inside a callback/arrow function that contains try-catch
    // Handles patterns like: app.get('/route', async (req, res) => { try { ... } catch { ... } })
    if (this.isInsideCallbackWithTryCatch(node)) {
      return true;
    }

    return false;
  }

  /**
   * Checks if a node is inside a callback/arrow function that contains a try-catch block
   * Handles fastify routes, socket.io event handlers, etc.
   */
  private isInsideCallbackWithTryCatch(node: ts.Node): boolean {
    let current: ts.Node | undefined = node;

    // Walk up to find arrow functions or function expressions
    while (current) {
      if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
        // Check if this function contains a try-catch
        if (this.functionContainsTryCatch(current)) {
          // Make sure the node is actually inside the try block, not just anywhere in the function
          // We want: async (req, res) => { try { await call() } catch {} }
          // Not: async (req, res) => { await call(); try { other() } catch {} }
          return this.isNodeInsideTryBlock(node, current);
        }
      }
      current = current.parent;
    }

    return false;
  }

  /**
   * Checks if a node is inside a try block within a function
   */
  private isNodeInsideTryBlock(
    node: ts.Node,
    func: ts.ArrowFunction | ts.FunctionExpression,
  ): boolean {
    if (!func.body || !ts.isBlock(func.body)) {
      return false;
    }

    let nodeIsInside = false;

    const findTry = (n: ts.Node) => {
      if (ts.isTryStatement(n)) {
        // Check if our target node is inside this try block
        const checkInside = (child: ts.Node): boolean => {
          if (child === node) {
            nodeIsInside = true;
            return true;
          }
          let found = false;
          ts.forEachChild(child, (c) => {
            if (checkInside(c)) {
              found = true;
            }
          });
          return found;
        };
        checkInside(n.tryBlock);
        if (nodeIsInside) return;
      }
      ts.forEachChild(n, findTry);
    };

    findTry(func.body);
    return nodeIsInside;
  }

  /**
   * Checks if a function contains a try-catch block in its body
   */
  private functionContainsTryCatch(
    func: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
  ): boolean {
    if (!func.body) {
      return false;
    }

    // For arrow functions with block bodies and regular functions
    if (ts.isBlock(func.body)) {
      let hasTryCatch = false;

      const visit = (node: ts.Node) => {
        if (ts.isTryStatement(node)) {
          hasTryCatch = true;
          return;
        }
        ts.forEachChild(node, visit);
      };

      visit(func.body);
      return hasTryCatch;
    }

    return false;
  }

  /**
   * Checks if this is a route/event handler registration with try-catch in the handler
   * Handles: fastify routes (app.get, app.post), socket.io events (io.on, socket.on)
   * Pattern: app.get('/route', async (req, res) => { try { ... } catch { ... } })
   */
  private isRouteHandlerWithTryCatch(node: ts.CallExpression): boolean {
    if (!ts.isPropertyAccessExpression(node.expression)) {
      return false;
    }

    const methodName = node.expression.name.text;

    // Check if this looks like a route/event handler registration
    const isRouteOrEventHandler = [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "all",
      "use",
      "on",
    ].includes(methodName);

    if (!isRouteOrEventHandler) {
      return false;
    }

    // Find the handler callback (usually last argument, or second for routes with path)
    // Route: app.get('/path', handler)
    // Event: io.on('event', handler)
    for (const arg of node.arguments) {
      if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
        // Check if this handler is async (has async keyword or contains await)
        const isAsync = !!arg.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
        );

        if (isAsync || this.functionContainsAwait(arg)) {
          // For async handlers, check if they have try-catch
          return this.functionContainsTryCatch(arg);
        }
      }
    }

    return false;
  }

  /**
   * Checks if a function contains await expressions
   */
  private functionContainsAwait(
    func: ts.ArrowFunction | ts.FunctionExpression,
  ): boolean {
    if (!func.body) {
      return false;
    }

    let hasAwait = false;

    const visit = (node: ts.Node) => {
      if (ts.isAwaitExpression(node)) {
        hasAwait = true;
        return;
      }
      ts.forEachChild(node, visit);
    };

    visit(func.body);
    return hasAwait;
  }

  /**
   * Checks if there's a finally block that cleans up resources
   * Pattern: const client = await pool.connect(); ... finally { client.release(); }
   */
  private hasFinallyCleanup(node: ts.CallExpression): boolean {
    // Find the containing function
    const containingFunction = this.findContainingFunction(node);
    if (!containingFunction || !containingFunction.body) {
      return false;
    }

    // Check if the result of this call is assigned to a variable
    const parent = node.parent;
    let variableName: string | undefined;

    if (
      parent &&
      ts.isVariableDeclaration(parent) &&
      ts.isIdentifier(parent.name)
    ) {
      variableName = parent.name.text;
    } else if (parent && ts.isAwaitExpression(parent)) {
      const awaitParent = parent.parent;
      if (
        awaitParent &&
        ts.isVariableDeclaration(awaitParent) &&
        ts.isIdentifier(awaitParent.name)
      ) {
        variableName = awaitParent.name.text;
      }
    }

    if (!variableName) {
      return false;
    }

    // Look for a finally block in the function that calls a cleanup method on this variable
    if (!ts.isBlock(containingFunction.body)) {
      return false;
    }

    let hasFinallyWithCleanup = false;

    const visit = (n: ts.Node) => {
      if (ts.isTryStatement(n) && n.finallyBlock) {
        // Check if the finally block calls a cleanup method on our variable
        // Common patterns: client.release(), connection.close(), stream.end()
        if (this.finallyBlockCallsCleanup(n.finallyBlock, variableName!)) {
          hasFinallyWithCleanup = true;
          return;
        }
      }
      ts.forEachChild(n, visit);
    };

    visit(containingFunction.body);
    return hasFinallyWithCleanup;
  }

  /**
   * Checks if a finally block calls a cleanup method on a variable
   */
  private finallyBlockCallsCleanup(
    finallyBlock: ts.Block,
    variableName: string,
  ): boolean {
    let hasCleanup = false;

    const visit = (node: ts.Node) => {
      // Look for: variable.release(), variable.close(), variable.end(), variable.destroy()
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const object = node.expression.expression;
        const method = node.expression.name.text;

        if (ts.isIdentifier(object) && object.text === variableName) {
          const cleanupMethods = [
            "release",
            "close",
            "end",
            "destroy",
            "disconnect",
            "dispose",
          ];
          if (cleanupMethods.includes(method.toLowerCase())) {
            hasCleanup = true;
            return;
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(finallyBlock);
    return hasCleanup;
  }

  /**
   * Checks if a call uses callback-based error handling
   * Pattern: callback((error, result) => { if (error) return reject(error); })
   */
  private hasCallbackErrorHandling(node: ts.CallExpression): boolean {
    // Check if any argument is a callback with error parameter
    for (const arg of node.arguments) {
      if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
        // Check if first parameter is named 'error', 'err', or 'e'
        if (arg.parameters.length >= 1) {
          const firstParam = arg.parameters[0];
          if (ts.isIdentifier(firstParam.name)) {
            const paramName = firstParam.name.text.toLowerCase();
            if (
              paramName === "error" ||
              paramName === "err" ||
              paramName === "e"
            ) {
              // Check if the function body checks this error parameter
              if (
                arg.body &&
                this.callbackChecksErrorParam(arg.body, firstParam.name.text)
              ) {
                return true;
              }
            }
          }
        }
      }
    }

    return false;
  }

  /**
   * Checks if a callback function body checks the error parameter
   * Looks for patterns like: if (error) or if (err)
   */
  private callbackChecksErrorParam(
    body: ts.ConciseBody,
    errorParamName: string,
  ): boolean {
    let checksError = false;

    const visit = (node: ts.Node) => {
      // Look for if statements that check the error parameter
      if (ts.isIfStatement(node)) {
        const condition = node.expression;

        // Direct check: if (error)
        if (ts.isIdentifier(condition) && condition.text === errorParamName) {
          checksError = true;
          return;
        }

        // Negated check: if (!error) or if (error == null)
        if (ts.isPrefixUnaryExpression(condition)) {
          if (
            ts.isIdentifier(condition.operand) &&
            condition.operand.text === errorParamName
          ) {
            checksError = true;
            return;
          }
        }

        // Binary check: if (error !== null) or if (error)
        if (ts.isBinaryExpression(condition)) {
          if (
            ts.isIdentifier(condition.left) &&
            condition.left.text === errorParamName
          ) {
            checksError = true;
            return;
          }
          if (
            ts.isIdentifier(condition.right) &&
            condition.right.text === errorParamName
          ) {
            checksError = true;
            return;
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    if (ts.isBlock(body)) {
      visit(body);
    }

    return checksError;
  }

  /**
   * Finds the enclosing catch clause for a node
   */
  private findEnclosingCatchClause(node: ts.Node): ts.CatchClause | null {
    let current: ts.Node | undefined = node;

    while (current) {
      if (ts.isTryStatement(current) && current.catchClause) {
        return current.catchClause;
      }
      current = current.parent;
    }

    return null;
  }

  /**
   * Checks if a catch block checks error.response exists
   */
  private catchChecksResponseExists(catchClause: ts.CatchClause): boolean {
    let found = false;

    const visit = (node: ts.Node) => {
      // Look for if statements checking error.response
      if (ts.isIfStatement(node)) {
        const expression = node.expression;
        // Check the if condition for error.response patterns
        const hasResponseCheck = this.expressionChecksResponse(expression);
        if (hasResponseCheck) {
          found = true;
        }
      }

      // Look for optional chaining: error.response?.status or error.response?.data
      if (ts.isPropertyAccessExpression(node) && node.questionDotToken) {
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "response"
        ) {
          found = true;
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(catchClause.block);
    return found;
  }

  /**
   * Checks if an expression checks for response property
   */
  private expressionChecksResponse(node: ts.Expression): boolean {
    // Direct check: if (error.response)
    if (ts.isPropertyAccessExpression(node) && node.name.text === "response") {
      return true;
    }

    // Negated check: if (!error.response)
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.ExclamationToken
    ) {
      if (
        ts.isPropertyAccessExpression(node.operand) &&
        node.operand.name.text === "response"
      ) {
        return true;
      }
    }

    // Binary expression: if (error.response && ...)
    if (ts.isBinaryExpression(node)) {
      return (
        this.expressionChecksResponse(node.left) ||
        this.expressionChecksResponse(node.right)
      );
    }

    // Parenthesized: if ((error.response))
    if (ts.isParenthesizedExpression(node)) {
      return this.expressionChecksResponse(node.expression);
    }

    return false;
  }

  /**
   * Checks if a catch block checks status codes
   */
  private catchChecksStatusCode(catchClause: ts.CatchClause): boolean {
    let found = false;

    const visit = (node: ts.Node) => {
      // Look for: error.response.status
      if (ts.isPropertyAccessExpression(node) && node.name.text === "status") {
        const expr = node.expression;
        if (
          ts.isPropertyAccessExpression(expr) &&
          expr.name.text === "response"
        ) {
          found = true;
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(catchClause.block);
    return found;
  }

  /**
   * Extracts which status codes are explicitly handled
   */
  private extractHandledStatusCodes(catchClause: ts.CatchClause): number[] {
    const codes: number[] = [];

    const visit = (node: ts.Node) => {
      // Look for: error.response.status === 429
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken)
      ) {
        if (ts.isNumericLiteral(node.right)) {
          const statusCode = parseInt(node.right.text, 10);
          if (statusCode >= 100 && statusCode < 600) {
            codes.push(statusCode);
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(catchClause.block);
    return codes;
  }

  /**
   * Checks if catch block has retry logic
   */
  private catchHasRetryLogic(
    catchClause: ts.CatchClause,
    sourceFile: ts.SourceFile,
  ): boolean {
    // Look for common retry patterns: retry, attempt, backoff, setTimeout, etc.
    const text = catchClause.getText(sourceFile).toLowerCase();
    return (
      text.includes("retry") ||
      text.includes("backoff") ||
      text.includes("attempt") ||
      (text.includes("settimeout") && text.includes("delay"))
    );
  }

  /**
   * Checks if a postcondition is violated at a call site
   */
  private checkPostcondition(
    callSite: CallSite,
    postcondition: Postcondition,
    analysis: CallSiteAnalysis,
    packageName: string,
    functionName: string,
    node: ts.CallExpression,
    sourceFile: ts.SourceFile,
  ): Violation | null {
    const hasAnyErrorHandling =
      analysis.hasTryCatch || analysis.hasPromiseCatch;

    // Clerk-specific: Null check detection for auth(), currentUser(), getToken()
    // Check this BEFORE generic try-catch check because these functions use null checks, not try-catch
    if (
      postcondition.id === "auth-null-not-checked" ||
      postcondition.id === "current-user-null-not-handled" ||
      postcondition.id === "get-token-null-not-handled"
    ) {
      const hasNullCheck = this.checkNullHandling(node, sourceFile);

      if (!hasNullCheck) {
        const description =
          postcondition.throws ||
          `${functionName}() result used without null check - will crash if user not authenticated.`;
        return this.createViolation(
          callSite,
          postcondition,
          packageName,
          functionName,
          description,
          "error",
        );
      } else {
        // Has null check, so this is handled correctly - don't flag as violation
        return null;
      }
    }

    // Clerk-specific: auth() called without clerkMiddleware configured
    // Check this BEFORE generic try-catch — auth() doesn't need try-catch, it needs middleware
    if (postcondition.id === "missing-clerk-middleware") {
      const middlewareExists = this.checkClerkMiddlewareExists();

      if (!middlewareExists) {
        const description =
          postcondition.throws ||
          "clerkMiddleware() not found or not exported from middleware.ts. auth() calls will fail at runtime.";
        return this.createViolation(
          callSite,
          postcondition,
          packageName,
          functionName,
          description,
          "error",
        );
      } else {
        // Middleware is properly configured - no violation
        return null;
      }
    }

    // Clerk-specific: Middleware file system check
    // Check this BEFORE generic try-catch because it requires file inspection, not try-catch
    if (postcondition.id === "middleware-not-exported") {
      const middlewareExists = this.checkClerkMiddlewareExists();

      if (!middlewareExists) {
        const description =
          postcondition.throws ||
          "Middleware file not found or clerkMiddleware not properly exported. auth() calls will fail at runtime.";
        return this.createViolation(
          callSite,
          postcondition,
          packageName,
          functionName,
          description,
          "error",
        );
      } else {
        // Middleware is properly configured - no violation
        return null;
      }
    }

    // Clerk-specific: Check for middleware matcher configuration
    if (postcondition.id === "middleware-matcher-missing") {
      const middlewarePath = this.checkFileExists("middleware.ts", [
        "middleware.ts",
        "middleware.js",
      ]);

      if (middlewarePath) {
        // Check if the middleware file exports a config with matcher
        const sourceFile = this.program.getSourceFile(middlewarePath);
        let hasMatcherConfig = false;

        if (sourceFile) {
          ts.forEachChild(sourceFile, (node) => {
            // Look for: export const config = { matcher: ... }
            if (ts.isVariableStatement(node)) {
              const modifiers = ts.getCombinedModifierFlags(
                node.declarationList.declarations[0],
              );
              if (modifiers & ts.ModifierFlags.Export) {
                for (const declaration of node.declarationList.declarations) {
                  if (
                    ts.isVariableDeclaration(declaration) &&
                    ts.isIdentifier(declaration.name) &&
                    declaration.name.text === "config"
                  ) {
                    hasMatcherConfig = true;
                    break;
                  }
                }
              }
            }
          });

          if (!hasMatcherConfig) {
            const description =
              postcondition.throws ||
              "Middleware missing matcher configuration. Will run on all routes including static assets.";
            return this.createViolation(
              callSite,
              postcondition,
              packageName,
              functionName,
              description,
              "warning",
            );
          }
        }
      }

      return null;
    }

    // Twilio-specific: Hardcoded credentials check
    if (postcondition.id === "hardcoded-credentials") {
      const hasHardcodedCredentials = this.checkHardcodedCredentials(node);

      if (hasHardcodedCredentials) {
        const description =
          postcondition.throws ||
          "Hardcoded credentials detected. Use environment variables (process.env) to avoid security risks.";
        return this.createViolation(
          callSite,
          postcondition,
          packageName,
          functionName,
          description,
          "error",
        );
      } else {
        // Credentials are from environment variables - no violation
        return null;
      }
    }

    // NEW: Generic check for any postcondition requiring error handling
    // If the postcondition specifies required_handling and has severity='error',
    // it means the call MUST have error handling
    if (postcondition.required_handling && postcondition.severity === "error") {
      if (!hasAnyErrorHandling) {
        // Generate a violation with a generic message based on the postcondition.condition
        const description = postcondition.throws
          ? `No try-catch block found. ${postcondition.throws} - this will crash the application.`
          : "No error handling found. This operation can throw errors that will crash the application.";

        return this.createViolation(
          callSite,
          postcondition,
          packageName,
          functionName,
          description,
          "error",
        );
      }
    }

    // Specific violation checks based on postcondition ID (for more detailed analysis)
    if (
      postcondition.id.includes("429") ||
      postcondition.id.includes("rate-limit")
    ) {
      // Rate limiting check
      if (!hasAnyErrorHandling) {
        return this.createViolation(
          callSite,
          postcondition,
          packageName,
          functionName,
          "No try-catch block found. Rate limit errors (429) will crash the application.",
          "error",
        );
      }

      // WARNING: Has error handling but doesn't handle 429 specifically
      if (
        !analysis.handledStatusCodes.includes(429) &&
        !analysis.hasRetryLogic
      ) {
        return this.createViolation(
          callSite,
          postcondition,
          packageName,
          functionName,
          "Rate limit response (429) is not explicitly handled. Consider implementing retry logic with exponential backoff.",
          "warning",
        );
      }
    }

    // HTTP client packages (axios, node-fetch, etc.) - check for HTTP-specific error handling
    const isHttpClient = [
      "axios",
      "node-fetch",
      "got",
      "superagent",
      "request",
    ].includes(packageName);

    if (postcondition.id.includes("network")) {
      // Network failure check
      if (!hasAnyErrorHandling) {
        return this.createViolation(
          callSite,
          postcondition,
          packageName,
          functionName,
          "No try-catch block found. Network failures will crash the application.",
          "error",
        );
      }

      // WARNING: Only for HTTP clients - check if response.exists is checked
      if (
        isHttpClient &&
        hasAnyErrorHandling &&
        !analysis.checksResponseExists
      ) {
        return this.createViolation(
          callSite,
          postcondition,
          packageName,
          functionName,
          "Generic error handling found. Consider checking if error.response exists to distinguish network failures from HTTP errors.",
          "warning",
        );
      }
    }

    if (
      postcondition.id.includes("error") &&
      postcondition.severity === "error"
    ) {
      // Generic error handling check
      if (!hasAnyErrorHandling) {
        return this.createViolation(
          callSite,
          postcondition,
          packageName,
          functionName,
          "No error handling found. Errors will crash the application.",
          "error",
        );
      }

      // WARNING: Only for HTTP clients - check if status codes are inspected
      if (isHttpClient && hasAnyErrorHandling && !analysis.checksStatusCode) {
        return this.createViolation(
          callSite,
          postcondition,
          packageName,
          functionName,
          "Generic error handling found. Consider inspecting error.response.status to distinguish between 4xx client errors and 5xx server errors for better UX.",
          "warning",
        );
      }
    }

    return null;
  }

  /**
   * Checks if a function call result has proper null handling
   * Used for Clerk functions that return null when not authenticated
   */
  private checkNullHandling(
    callNode: ts.CallExpression,
    sourceFile: ts.SourceFile,
  ): boolean {
    // Find the parent statement containing this call
    let currentNode: ts.Node = callNode;
    while (currentNode && !ts.isStatement(currentNode)) {
      currentNode = currentNode.parent;
    }

    if (!currentNode) return false;

    // Find the containing function/method
    const containingFunction = this.findContainingFunction(callNode);
    if (!containingFunction) return false;

    // Look for variable declaration or destructuring
    let variableNames: string[] = [];

    // Check if the call is assigned to a variable
    const parent = callNode.parent;

    // Case 1: await auth() directly in variable declaration
    if (ts.isAwaitExpression(parent)) {
      const awaitParent = parent.parent;
      if (ts.isVariableDeclaration(awaitParent) && awaitParent.name) {
        if (ts.isIdentifier(awaitParent.name)) {
          variableNames.push(awaitParent.name.text);
        } else if (ts.isObjectBindingPattern(awaitParent.name)) {
          // Destructured: const { userId } = await auth()
          awaitParent.name.elements.forEach((element) => {
            if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
              variableNames.push(element.name.text);
            }
          });
        }
      }
    }

    // Case 2: Direct variable declaration
    if (ts.isVariableDeclaration(parent) && parent.name) {
      if (ts.isIdentifier(parent.name)) {
        variableNames.push(parent.name.text);
      } else if (ts.isObjectBindingPattern(parent.name)) {
        parent.name.elements.forEach((element) => {
          if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
            variableNames.push(element.name.text);
          }
        });
      }
    }

    if (variableNames.length === 0) {
      // No variable captured, assume used directly (would be flagged)
      return false;
    }

    // Now check if any of these variables are null-checked before use
    let hasNullCheck = false;

    const checkForNullHandling = (node: ts.Node): void => {
      // Check for if statements with null checks
      if (ts.isIfStatement(node)) {
        const condition = node.expression;
        if (this.isNullCheckCondition(condition, variableNames, sourceFile)) {
          hasNullCheck = true;
        }
      }

      // Check for optional chaining on the variable
      if (ts.isPropertyAccessExpression(node) && node.questionDotToken) {
        const exprText = node.expression.getText(sourceFile);
        if (variableNames.includes(exprText)) {
          hasNullCheck = true;
        }
      }

      // Check for early return with null check
      if (ts.isReturnStatement(node) || ts.isExpressionStatement(node)) {
        const parent = node.parent;
        if (parent && ts.isIfStatement(parent)) {
          if (
            this.isNullCheckCondition(
              parent.expression,
              variableNames,
              sourceFile,
            )
          ) {
            hasNullCheck = true;
          }
        }
      }

      ts.forEachChild(node, checkForNullHandling);
    };

    ts.forEachChild(containingFunction, checkForNullHandling);

    return hasNullCheck;
  }

  /**
   * Checks if a condition is a null check for the given variables
   */
  private isNullCheckCondition(
    condition: ts.Expression,
    variableNames: string[],
    sourceFile: ts.SourceFile,
  ): boolean {
    const conditionText = condition.getText(sourceFile);

    // Check if any of our variables are mentioned in the condition
    const mentionsVariable = variableNames.some((varName) =>
      conditionText.includes(varName),
    );
    if (!mentionsVariable) return false;

    // Pattern: !variable or !userId
    if (
      ts.isPrefixUnaryExpression(condition) &&
      condition.operator === ts.SyntaxKind.ExclamationToken
    ) {
      const operandText = condition.operand.getText(sourceFile);
      return variableNames.includes(operandText);
    }

    // Pattern: variable === null, variable !== null, etc.
    if (ts.isBinaryExpression(condition)) {
      const operator = condition.operatorToken.kind;

      // Handle || and && by recursively checking both sides
      if (
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        return (
          this.isNullCheckCondition(
            condition.left,
            variableNames,
            sourceFile,
          ) ||
          this.isNullCheckCondition(condition.right, variableNames, sourceFile)
        );
      }

      const leftText = condition.left.getText(sourceFile);
      const rightText = condition.right.getText(sourceFile);

      const hasVariable = variableNames.some(
        (v) => leftText.includes(v) || rightText.includes(v),
      );
      const hasNullCheck =
        conditionText.includes("null") || conditionText.includes("undefined");

      const isComparisonOperator =
        operator === ts.SyntaxKind.EqualsEqualsToken ||
        operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        operator === ts.SyntaxKind.ExclamationEqualsToken ||
        operator === ts.SyntaxKind.ExclamationEqualsEqualsToken;

      if (hasVariable && hasNullCheck && isComparisonOperator) {
        return true;
      }
    }

    // Pattern: isAuthenticated or similar boolean check
    if (ts.isIdentifier(condition)) {
      return variableNames.includes(condition.text);
    }

    return false;
  }

  /**
   * Finds the containing function/method for a node
   */
  private findContainingFunction(
    node: ts.Node,
  ):
    | ts.FunctionDeclaration
    | ts.ArrowFunction
    | ts.FunctionExpression
    | ts.MethodDeclaration
    | null {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isArrowFunction(current) ||
        ts.isFunctionExpression(current) ||
        ts.isMethodDeclaration(current)
      ) {
        return current;
      }
      current = current.parent;
    }
    return null;
  }

  /**
   * Checks if a function call has hardcoded credentials (string literals)
   * vs environment variables (process.env.*)
   *
   * Returns true if hardcoded credentials are detected (violation)
   * Returns false if credentials come from environment variables (valid)
   */
  private checkHardcodedCredentials(callNode: ts.CallExpression): boolean {
    // Check each argument to the function call
    for (const arg of callNode.arguments) {
      // Check if argument is a string literal (hardcoded)
      if (ts.isStringLiteral(arg)) {
        // String literal = hardcoded credential = violation
        return true;
      }

      // Check if argument is a template expression (could be hardcoded)
      if (
        ts.isTemplateExpression(arg) ||
        ts.isNoSubstitutionTemplateLiteral(arg)
      ) {
        // Template literal without substitutions = hardcoded = violation
        if (ts.isNoSubstitutionTemplateLiteral(arg)) {
          return true;
        }
        // Template with substitutions = could be dynamic, check the spans
        // For safety, we'll flag any template literal as hardcoded
        return true;
      }

      // Check if argument is an identifier (variable)
      if (ts.isIdentifier(arg)) {
        // Need to trace back to see where this variable is defined
        // If it's from process.env, it's safe
        // For now, we'll trace variable declarations in the current scope
        const varDeclaration = this.findVariableDeclaration(arg.text, callNode);
        if (varDeclaration && varDeclaration.initializer) {
          // Check if initializer is process.env.*
          if (ts.isPropertyAccessExpression(varDeclaration.initializer)) {
            const expr = varDeclaration.initializer.expression;
            if (
              ts.isPropertyAccessExpression(expr) &&
              ts.isIdentifier(expr.expression) &&
              expr.expression.text === "process" &&
              ts.isIdentifier(expr.name) &&
              expr.name.text === "env"
            ) {
              // This is process.env.SOMETHING - safe!
              continue;
            }
          }
          // Check if initializer is a string literal
          if (ts.isStringLiteral(varDeclaration.initializer)) {
            // Variable assigned from string literal = hardcoded
            return true;
          }
        }
      }

      // Check if argument is process.env.* directly
      if (ts.isPropertyAccessExpression(arg)) {
        const expr = arg.expression;
        if (
          ts.isPropertyAccessExpression(expr) &&
          ts.isIdentifier(expr.expression) &&
          expr.expression.text === "process" &&
          ts.isIdentifier(expr.name) &&
          expr.name.text === "env"
        ) {
          // Direct process.env.* usage - safe!
          continue;
        }
        // Some other property access - could be config.apiKey, etc.
        // For safety, we'll flag it as potentially hardcoded
        // TODO: Could enhance to trace config objects
        return true;
      }

      // Check for element access: process.env['VARIABLE']
      if (ts.isElementAccessExpression(arg)) {
        const expr = arg.expression;
        if (
          ts.isPropertyAccessExpression(expr) &&
          ts.isIdentifier(expr.expression) &&
          expr.expression.text === "process" &&
          ts.isIdentifier(expr.name) &&
          expr.name.text === "env"
        ) {
          // process.env['VARIABLE'] - safe!
          continue;
        }
        // Some other element access - potentially hardcoded
        return true;
      }
    }

    // All arguments checked, no hardcoded credentials found
    return false;
  }

  /**
   * Finds a variable declaration in the scope of the given node
   */
  private findVariableDeclaration(
    variableName: string,
    node: ts.Node,
  ): ts.VariableDeclaration | null {
    let current: ts.Node | undefined = node;

    while (current) {
      // Check variable statements in this scope
      if (
        ts.isSourceFile(current) ||
        ts.isBlock(current) ||
        ts.isFunctionLike(current)
      ) {
        let foundDeclaration: ts.VariableDeclaration | null = null;

        const visitNode = (node: ts.Node): void => {
          if (foundDeclaration) return;

          if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === variableName
          ) {
            foundDeclaration = node;
            return;
          }

          // Don't recurse into nested functions/blocks
          if (
            node === current ||
            ts.isVariableStatement(node) ||
            ts.isVariableDeclarationList(node)
          ) {
            ts.forEachChild(node, visitNode);
          }
        };

        visitNode(current);
        if (foundDeclaration) {
          return foundDeclaration;
        }
      }

      current = current.parent;
    }

    return null;
  }

  /**
   * Checks if a specific file exists in the project
   * Tries multiple possible locations (root, src/, etc.)
   *
   * @param fileName - The file name to search for (e.g., 'middleware.ts')
   * @param variations - Optional variations of the file name (e.g., ['middleware.ts', 'middleware.js'])
   * @returns The full path if found, null otherwise
   */
  private checkFileExists(
    fileName: string,
    variations?: string[],
  ): string | null {
    const filesToCheck = variations || [fileName];
    const locationsToCheck = [
      "", // Root directory
      "src", // src/ directory
      "app", // app/ directory (Next.js App Router)
    ];

    for (const location of locationsToCheck) {
      for (const file of filesToCheck) {
        // Use path.resolve to get an absolute path so this.program.getSourceFile() can find it
        const fullPath = path.resolve(this.projectRoot, location, file);
        if (ts.sys.fileExists(fullPath)) {
          return fullPath;
        }
      }
    }

    return null;
  }

  /**
   * Checks if a file imports and exports specific patterns
   *
   * @param filePath - Absolute path to the file to check
   * @param importPattern - Object specifying what to look for in imports
   * @param exportPattern - Object specifying what to look for in exports
   * @returns Object with hasImport and hasExport booleans
   */
  private checkFileImportsAndExports(
    filePath: string,
    importPattern: { packageName: string; importName?: string },
    exportPattern: { type: "default" | "named"; exportName?: string },
  ): { hasImport: boolean; hasExport: boolean } {
    const sourceFile = this.program.getSourceFile(filePath);
    if (!sourceFile) {
      return { hasImport: false, hasExport: false };
    }

    let hasImport = false;
    let hasExport = false;
    let importedName: string | null = null;

    // Check imports
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = node.moduleSpecifier;
        if (ts.isStringLiteral(moduleSpecifier)) {
          const importPath = moduleSpecifier.text;

          // Check if this import matches the package pattern
          if (importPath.includes(importPattern.packageName)) {
            // If specific import name is required, check for it
            if (importPattern.importName) {
              if (
                node.importClause?.namedBindings &&
                ts.isNamedImports(node.importClause.namedBindings)
              ) {
                for (const element of node.importClause.namedBindings
                  .elements) {
                  if (element.name.text === importPattern.importName) {
                    hasImport = true;
                    importedName = importPattern.importName;
                    break;
                  }
                }
              }
            } else {
              // No specific import name required, just check package
              hasImport = true;
            }
          }
        }
      }

      // Check exports
      if (exportPattern.type === "default" && ts.isExportAssignment(node)) {
        // export default ...
        if (node.expression) {
          // Check if it's a call expression: export default clerkMiddleware()
          if (ts.isCallExpression(node.expression)) {
            const expr = node.expression.expression;
            if (ts.isIdentifier(expr)) {
              if (importedName && expr.text === importedName) {
                hasExport = true;
              } else if (!importPattern.importName) {
                // If no specific import name, just check if it's exported
                hasExport = true;
              }
            }
          }
        }
      }

      if (exportPattern.type === "named" && ts.isExportDeclaration(node)) {
        // export { ... }
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const element of node.exportClause.elements) {
            if (
              exportPattern.exportName &&
              element.name.text === exportPattern.exportName
            ) {
              hasExport = true;
              break;
            }
          }
        }
      }
    });

    return { hasImport, hasExport };
  }

  /**
   * Checks if middleware.ts exists and properly exports clerkMiddleware
   * This is specific to @clerk/nextjs middleware setup
   *
   * @returns true if middleware is properly configured, false otherwise
   */
  private checkClerkMiddlewareExists(): boolean {
    // Check standard locations first
    const middlewarePath = this.checkFileExists("middleware.ts", [
      "middleware.ts",
      "middleware.js",
    ]);

    if (middlewarePath) {
      const { hasImport, hasExport } = this.checkFileImportsAndExports(
        middlewarePath,
        { packageName: "@clerk/nextjs", importName: "clerkMiddleware" },
        { type: "default" },
      );
      if (hasImport && hasExport) return true;
    }

    // For monorepos: search all TypeScript program source files for a middleware.ts
    // that exports clerkMiddleware (e.g. apps/web/middleware.ts in a Next.js monorepo)
    for (const sourceFile of this.program.getSourceFiles()) {
      if (
        !sourceFile.fileName.includes("node_modules") &&
        (sourceFile.fileName.endsWith("/middleware.ts") ||
          sourceFile.fileName.endsWith("/middleware.js"))
      ) {
        const { hasImport, hasExport } = this.checkFileImportsAndExports(
          sourceFile.fileName,
          { packageName: "@clerk/nextjs", importName: "clerkMiddleware" },
          { type: "default" },
        );
        if (hasImport && hasExport) return true;
      }
    }

    return false;
  }

  /**
   * Creates a violation object
   */
  private createViolation(
    callSite: CallSite,
    postcondition: Postcondition,
    packageName: string,
    functionName: string,
    description: string,
    severityOverride?: "error" | "warning" | "info",
  ): Violation {
    return {
      id: `${packageName}-${postcondition.id}`,
      severity: severityOverride || postcondition.severity,
      file: callSite.file,
      line: callSite.line,
      column: callSite.column,
      package: packageName,
      function: functionName,
      contract_clause: postcondition.id,
      description,
      source_doc: postcondition.sources?.[0] || postcondition.source || "",
      suggested_fix: postcondition.required_handling,
    };
  }

  /**
   * Gets statistics about the analysis run
   */
  getStats() {
    return {
      filesAnalyzed: this.program
        .getSourceFiles()
        .filter(
          (sf) =>
            !sf.isDeclarationFile && !sf.fileName.includes("node_modules"),
        ).length,
      contractsApplied: Array.from(this.contracts.values()).reduce(
        (sum, contract) => sum + (contract.functions?.length || 0),
        0,
      ),
    };
  }
  /**
   * Analyzes S3 send() calls to detect command type
   * Pattern: s3Client.send(new GetObjectCommand(...))
   */
  private analyzeS3SendCall(
    node: ts.CallExpression,
    sourceFile: ts.SourceFile,
    s3ClientInstances: Map<string, string>,
  ): { client: string; command: string; packageName: string } | null {
    // Check if this is a .send() call
    if (!ts.isPropertyAccessExpression(node.expression)) return null;
    if (node.expression.name.text !== "send") return null;

    // Get the object being called (should be s3Client)
    let clientIdentifier: string | null = null;

    if (ts.isIdentifier(node.expression.expression)) {
      clientIdentifier = node.expression.expression.text;
    } else if (ts.isPropertyAccessExpression(node.expression.expression)) {
      // Handle this.s3Client.send() pattern
      clientIdentifier = node.expression.expression.name.text;
    }

    if (!clientIdentifier) return null;

    // Check if this identifier is a tracked S3Client instance
    const packageName =
      s3ClientInstances.get(clientIdentifier) ||
      this.resolvePackageFromImports(clientIdentifier, sourceFile);

    if (packageName !== "@aws-sdk/client-s3") return null;

    // Extract the command type from the argument
    // Pattern: send(new GetObjectCommand(...))
    if (node.arguments.length === 0) return null;

    const firstArg = node.arguments[0];
    if (!ts.isNewExpression(firstArg)) return null;

    const commandName = firstArg.expression.getText(sourceFile);

    return {
      client: clientIdentifier,
      command: commandName,
      packageName: "@aws-sdk/client-s3",
    };
  }

  /**
   * Analyzes an S3 command call and creates violations if needed
   */
  private analyzeS3Command(
    s3Analysis: { client: string; command: string; packageName: string },
    node: ts.CallExpression,
    sourceFile: ts.SourceFile,
  ): void {
    const contract = this.contracts.get(s3Analysis.packageName);
    if (!contract) return;

    // Find the send() function contract
    const sendContract = contract.functions.find((f) => f.name === "send");
    if (!sendContract) return;

    // Map command type to postcondition ID
    const commandToPostcondition = this.mapS3CommandToPostcondition(
      s3Analysis.command,
    );
    if (!commandToPostcondition) return;

    // Find the matching postcondition
    const postcondition = sendContract.postconditions?.find(
      (p) => p.id === commandToPostcondition,
    );
    if (!postcondition) return;

    // Check if this is wrapped in try-catch
    const asyncErrorAnalyzer = new AsyncErrorAnalyzer(sourceFile);

    // Find the await expression that wraps this call
    let awaitNode: ts.AwaitExpression | null = null;
    let current: ts.Node | undefined = node;

    while (current) {
      if (ts.isAwaitExpression(current) && current.expression === node) {
        awaitNode = current;
        break;
      }
      current = current.parent;
    }

    // Check if await is protected by try-catch
    let isProtected = false;
    if (awaitNode) {
      const functionNode = this.findContainingFunction(awaitNode);
      if (functionNode) {
        isProtected = asyncErrorAnalyzer.isAwaitProtected(
          awaitNode,
          functionNode,
        );
      }
    }

    // Create violation if not protected (for error severity postconditions)
    if (!isProtected && postcondition.severity === "error") {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );

      const violation: Violation = {
        id: `${s3Analysis.packageName}-${postcondition.id}`,
        severity: postcondition.severity,
        file: sourceFile.fileName,
        line: line + 1,
        column: character + 1,
        package: s3Analysis.packageName,
        function: "send",
        contract_clause: postcondition.id,
        description: `${s3Analysis.command} called without try-catch. ${postcondition.condition}`,
        source_doc: postcondition.sources?.[0] || postcondition.source || "",
        suggested_fix: postcondition.required_handling || "",
      };

      this.violations.push(violation);
    }
  }

  /**
   * Maps S3 command types to their corresponding postcondition IDs
   */
  private mapS3CommandToPostcondition(commandName: string): string | null {
    // Object operations
    const objectOps = [
      "GetObjectCommand",
      "PutObjectCommand",
      "DeleteObjectCommand",
      "HeadObjectCommand",
      "CopyObjectCommand",
    ];
    if (objectOps.includes(commandName)) {
      return "s3-object-operation-no-try-catch";
    }

    // Multipart operations
    const multipartOps = [
      "CreateMultipartUploadCommand",
      "UploadPartCommand",
      "CompleteMultipartUploadCommand",
      "AbortMultipartUploadCommand",
    ];
    if (multipartOps.includes(commandName)) {
      return "s3-multipart-no-try-catch";
    }

    // Bucket operations
    const bucketOps = [
      "CreateBucketCommand",
      "DeleteBucketCommand",
      "HeadBucketCommand",
    ];
    if (bucketOps.includes(commandName)) {
      return "s3-bucket-operation-no-try-catch";
    }

    // List operations
    const listOps = [
      "ListObjectsV2Command",
      "ListObjectsCommand",
      "ListBucketsCommand",
    ];
    if (listOps.includes(commandName)) {
      return "s3-list-operation-no-try-catch";
    }

    return null;
  }

  /**
   * Get all suppressed violations
   */
  getSuppressedViolations(): Array<{ violation: Violation; suppression: any }> {
    return this.suppressedViolations;
  }

  /**
   * Get suppression statistics
   */
  getSuppressionStatistics() {
    return getSuppressionStats(this.projectRoot);
  }

  /**
   * Get suppression manifest
   */
  getSuppressionManifest() {
    return loadManifestSync(this.projectRoot);
  }

  /**
   * Detect dead suppressions (suppressions that are no longer needed)
   */
  detectDeadSuppressions(): DeadSuppression[] {
    return detectDeadSuppressions(this.projectRoot, this.analyzerVersion);
  }

  /**
   * Format dead suppression for display
   */
  formatDeadSuppression(dead: DeadSuppression): string {
    return formatDeadSuppression(dead);
  }
}
