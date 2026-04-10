/**
 * AST Analyzer - uses TypeScript Compiler API to detect behavioral contract violations
 */

import * as ts from 'typescript';
import * as path from 'path';
import type {
  PackageContract,
  Violation,
  CallSite,
  CallSiteAnalysis,
  AnalyzerConfig,
  Postcondition,
} from './types.js';
import { ReactQueryAnalyzer } from './analyzers/react-query-analyzer.js';
import { AsyncErrorAnalyzer } from './analyzers/async-error-analyzer.js';

/**
 * Main analyzer that coordinates the verification process
 */
export class Analyzer {
  private program: ts.Program;
  private contracts: Map<string, PackageContract>;
  private violations: Violation[] = [];
  private projectRoot: string;

  constructor(config: AnalyzerConfig, contracts: Map<string, PackageContract>) {
    this.contracts = contracts;

    // Create TypeScript program
    const configFile = ts.readConfigFile(config.tsconfigPath, ts.sys.readFile);
    const parsedConfig = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(config.tsconfigPath)
    );

    // Store project root for file system operations
    this.projectRoot = path.dirname(config.tsconfigPath);

    this.program = ts.createProgram({
      rootNames: parsedConfig.fileNames,
      options: parsedConfig.options,
    });
  }

  /**
   * Analyzes all files in the program and returns violations
   */
  analyze(): Violation[] {
    this.violations = [];

    for (const sourceFile of this.program.getSourceFiles()) {
      // Skip declaration files and node_modules
      if (sourceFile.isDeclarationFile || sourceFile.fileName.includes('node_modules')) {
        continue;
      }

      this.analyzeFile(sourceFile);
    }

    return this.violations;
  }

  /**
   * Analyzes a single source file
   */
  private analyzeFile(sourceFile: ts.SourceFile): void {
    const self = this;

    // Track variables that are AxiosInstance objects
    const axiosInstances = new Map<string, string>(); // variableName -> packageName
    const instancesWithInterceptors = new Set<string>(); // variableName

    // Track variables that are schema instances (zod, yup, etc.)
    // Maps variable name to package name (e.g., "userSchema" -> "zod")
    const schemaInstances = new Map<string, string>();

    // Detect global React Query error handlers once per file
    const reactQueryAnalyzer = new ReactQueryAnalyzer(sourceFile, this.program.getTypeChecker());
    const globalHandlers = reactQueryAnalyzer.detectGlobalHandlers(sourceFile);

    // First pass: find all package instance declarations and interceptors
    function findAxiosInstances(node: ts.Node): void {
      // Look for: const instance = axios.create(...)
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const varName = node.name.getText(sourceFile);

        // Check for factory methods (axios.create, etc.)
        const packageName = self.extractPackageFromAxiosCreate(node.initializer, sourceFile);
        if (packageName) {
          axiosInstances.set(varName, packageName);
        }

        // Check for new expressions (new PrismaClient(), new Stripe(), etc.)
        const newPackageName = self.extractPackageFromNewExpression(node.initializer, sourceFile);
        if (newPackageName) {
          axiosInstances.set(varName, newPackageName);
        }

        // Check for schema factory methods (z.object(), z.string(), etc.)
        const schemaPackageName = self.extractPackageFromSchemaFactory(node.initializer, sourceFile);
        if (schemaPackageName) {
          schemaInstances.set(varName, schemaPackageName);
        }

      }

      // Look for: this._axios = axios.create(...) or this.db = new PrismaClient()
      if (ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(node.left)) {
        const varName = node.left.name.text;

        // Check for factory methods
        const packageName = self.extractPackageFromAxiosCreate(node.right, sourceFile);
        if (packageName) {
          axiosInstances.set(varName, packageName);
        }

        // Check for new expressions
        const newPackageName = self.extractPackageFromNewExpression(node.right, sourceFile);
        if (newPackageName) {
          axiosInstances.set(varName, newPackageName);
        }

        // Check for schema factory methods
        const schemaPackageName = self.extractPackageFromSchemaFactory(node.right, sourceFile);
        if (schemaPackageName) {
          schemaInstances.set(varName, schemaPackageName);
        }
      }

      // Look for: private _axios: AxiosInstance or private prisma: PrismaClient
      if (ts.isPropertyDeclaration(node) && node.type) {
        const varName = node.name.getText(sourceFile);
        if (ts.isTypeReferenceNode(node.type) &&
            ts.isIdentifier(node.type.typeName)) {
          const typeName = node.type.typeName.text;

          // Map type names to package names
          const typeToPackage: Record<string, string> = {
            'AxiosInstance': 'axios',
            'PrismaClient': '@prisma/client',
            'PrismaService': '@prisma/client',
            'Twilio': 'twilio',
          };

          if (typeToPackage[typeName]) {
            axiosInstances.set(varName, typeToPackage[typeName]);
          }
        }
      }

      // Look for: constructor(private readonly prisma: PrismaService)
      // TypeScript/NestJS pattern where constructor parameters with modifiers create implicit properties
      if (ts.isParameter(node) &&
          (node.modifiers?.some(m => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.PublicKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword)) &&
          node.type &&
          ts.isIdentifier(node.name)) {
        const varName = node.name.text;
        if (ts.isTypeReferenceNode(node.type) &&
            ts.isIdentifier(node.type.typeName)) {
          const typeName = node.type.typeName.text;

          // Map type names to package names
          const typeToPackage: Record<string, string> = {
            'AxiosInstance': 'axios',
            'PrismaClient': '@prisma/client',
            'PrismaService': '@prisma/client',
            'Twilio': 'twilio',
          };

          if (typeToPackage[typeName]) {
            axiosInstances.set(varName, typeToPackage[typeName]);
          }
        }
      }

      // Look for: instance.interceptors.response.use(...)
      if (ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression)) {
        const callText = node.expression.getText(sourceFile);
        // Match patterns like: axiosInstance.interceptors.response.use or instance.interceptors.request.use
        if (callText.includes('.interceptors.response.use') ||
            callText.includes('.interceptors.request.use')) {
          // Extract the instance variable name (first part before .interceptors)
          const parts = callText.split('.');
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
    this.detectAsyncErrors(sourceFile, asyncErrorAnalyzer);

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
          schemaInstances
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
  private detectAsyncErrors(sourceFile: ts.SourceFile, asyncErrorAnalyzer: AsyncErrorAnalyzer): void {
    const self = this;

    function visitForAsyncFunctions(node: ts.Node): void {
      // Check if this is an async function
      if (asyncErrorAnalyzer.isAsyncFunction(node)) {
        const unprotectedAwaits = asyncErrorAnalyzer.findUnprotectedAwaits(node);

        // For each unprotected await, check if any contract requires error handling
        for (const detection of unprotectedAwaits) {
          // Try to determine which package this await is calling
          // This is a simplified approach - we create a violation for any unprotected await
          // that might be calling a package function
          const violation = self.createAsyncErrorViolation(
            sourceFile,
            detection,
            node
          );

          if (violation) {
            self.violations.push(violation);
          }
        }
      }

      // Continue traversing
      ts.forEachChild(node, visitForAsyncFunctions);
    }

    visitForAsyncFunctions(sourceFile);

    // Also detect empty/ineffective catch blocks
    const catchBlocks = asyncErrorAnalyzer.findAllCatchBlocks(sourceFile);
    for (const catchBlock of catchBlocks) {
      const effectiveness = asyncErrorAnalyzer.isCatchBlockEffective(catchBlock);

      if (effectiveness.isEmpty || effectiveness.hasConsoleOnly) {
        const violation = this.createEmptyCatchViolation(
          sourceFile,
          catchBlock,
          effectiveness
        );

        if (violation) {
          this.violations.push(violation);
        }
      }
    }
  }

  /**
   * Creates a violation for unprotected async calls
   */
  private createAsyncErrorViolation(
    sourceFile: ts.SourceFile,
    detection: { line: number; column: number; awaitText: string; functionName: string },
    _functionNode: ts.Node
  ): Violation | null {
    // Look for contracts that have async-related postconditions
    // For now, we'll check react-hook-form as it has the async-submit-unhandled-error postcondition

    // Extract the await expression to see what's being called
    const awaitText = detection.awaitText.toLowerCase();

    // Check if this looks like it could be a contract violation
    // (API call, database operation, etc.)
    const likelyApiCall =
      awaitText.includes('fetch') ||
      awaitText.includes('api') ||
      awaitText.includes('.get') ||
      awaitText.includes('.post') ||
      awaitText.includes('.put') ||
      awaitText.includes('.delete') ||
      awaitText.includes('.patch') ||
      awaitText.includes('axios') ||
      awaitText.includes('prisma') ||
      awaitText.includes('supabase') ||
      awaitText.includes('stripe') ||
      awaitText.includes('.create') ||
      awaitText.includes('.update') ||
      awaitText.includes('.query') ||
      awaitText.includes('.mutate');

    if (!likelyApiCall) {
      return null;
    }

    // Try to find a matching contract with async error postconditions
    let matchingPostcondition: Postcondition | undefined;
    let matchingPackageName: string | undefined;
    let matchingFunctionName: string | undefined;

    for (const [packageName, contract] of this.contracts.entries()) {
      for (const func of contract.functions) {
        // Check if any postcondition mentions async errors
        const asyncErrorPostcondition = func.postconditions?.find(
          pc => pc.id?.includes('async') || pc.id?.includes('unhandled')
        );

        if (asyncErrorPostcondition) {
          matchingPostcondition = asyncErrorPostcondition;
          matchingPackageName = packageName;
          matchingFunctionName = func.name;
          break;
        }
      }
      if (matchingPostcondition) break;
    }

    // If we found a matching contract, create a violation
    if (matchingPostcondition && matchingPackageName && matchingFunctionName) {
      const description = `Async function '${detection.functionName}' contains unprotected await expression. ${detection.awaitText.substring(0, 50)}... may throw unhandled errors.`;

      return {
        id: `${matchingPackageName}-${matchingPostcondition.id}`,
        severity: 'error',
        file: sourceFile.fileName,
        line: detection.line,
        column: detection.column,
        package: matchingPackageName,
        function: matchingFunctionName,
        contract_clause: matchingPostcondition.id,
        description,
        source_doc: matchingPostcondition.source,
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
    effectiveness: { isEmpty: boolean; hasConsoleOnly: boolean; hasCommentOnly: boolean; hasUserFeedback: boolean }
  ): Violation | null {
    // Look for contracts with empty-catch-block postconditions
    let matchingPostcondition: Postcondition | undefined;
    let matchingPackageName: string | undefined;
    let matchingFunctionName: string | undefined;

    for (const [packageName, contract] of this.contracts.entries()) {
      for (const func of contract.functions) {
        const emptyCatchPostcondition = func.postconditions?.find(
          pc => pc.id?.includes('empty-catch') || pc.id?.includes('silent-failure')
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

    if (!matchingPostcondition || !matchingPackageName || !matchingFunctionName) {
      return null;
    }

    const location = sourceFile.getLineAndCharacterOfPosition(catchBlock.getStart());
    const description = effectiveness.isEmpty
      ? 'Empty catch block - errors are silently swallowed. Users receive no feedback when operations fail.'
      : 'Catch block only logs to console without user feedback. Consider using toast.error() or setError().';

    return {
      id: `${matchingPackageName}-${matchingPostcondition.id}`,
      severity: effectiveness.isEmpty ? 'error' : 'warning',
      file: sourceFile.fileName,
      line: location.line + 1,
      column: location.character + 1,
      package: matchingPackageName,
      function: matchingFunctionName,
      contract_clause: matchingPostcondition.id,
      description,
      source_doc: matchingPostcondition.source,
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
    globalHandlers: { hasQueryCacheOnError: boolean; hasMutationCacheOnError: boolean },
    schemaInstances: Map<string, string>
  ): void {
    // Check if this is a React Query hook
    const reactQueryAnalyzer = new ReactQueryAnalyzer(sourceFile, this.program.getTypeChecker());
    const hookName = reactQueryAnalyzer.isReactQueryHook(node);

    if (hookName) {
      this.analyzeReactQueryHook(node, sourceFile, hookName, reactQueryAnalyzer, globalHandlers);
      return;
    }

    const callSite = this.extractCallSite(node, sourceFile, axiosInstances, schemaInstances);
    if (!callSite) return;

    const contract = this.contracts.get(callSite.packageName);
    if (!contract) return;

    // NEW: Handle namespace methods
    // Check if this call has a namespace (e.g., ts.sys.readFile())
    const namespace = (node as any).__namespace;

    // Match function contract, considering namespace if present
    const functionContract = contract.functions.find(f => {
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
    const hasGlobalInterceptor = instanceVar ? instancesWithInterceptors.has(instanceVar) : false;

    // Analyze what error handling exists at this call site
    const analysis = this.analyzeErrorHandling(node, sourceFile, hasGlobalInterceptor);

    // Check each postcondition
    for (const postcondition of functionContract.postconditions || []) {
      if (postcondition.severity !== 'error') continue;
      if (!postcondition.required_handling) continue;

      const violation = this.checkPostcondition(
        callSite,
        postcondition,
        analysis,
        contract.package,
        functionContract.name,
        node,
        sourceFile
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
    globalHandlers: { hasQueryCacheOnError: boolean; hasMutationCacheOnError: boolean }
  ): void {
    // Check if we have a contract for React Query
    const contract = this.contracts.get('@tanstack/react-query');
    if (!contract) return;

    // Find the function contract for this hook
    const functionContract = contract.functions.find(f => f.name === hookName);
    if (!functionContract) return;

    // Extract hook call information
    const hookCall = reactQueryAnalyzer.extractHookCall(node, hookName);
    if (!hookCall) return;

    // Find the containing component
    const componentNode = reactQueryAnalyzer.findContainingComponent(node);
    if (!componentNode) return;

    // Check for deferred error handling (mutateAsync with try-catch)
    let hasDeferredErrorHandling = false;
    if (hookName === 'useMutation') {
      // Check if this mutation is assigned to a variable and later used with try-catch
      const parent = node.parent;
      if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        const mutationVarName = parent.name.text;
        hasDeferredErrorHandling = this.checkMutateAsyncInTryCatch(
          mutationVarName,
          componentNode,
          sourceFile
        );
      }
    }

    // Analyze error handling
    const errorHandling = reactQueryAnalyzer.analyzeHookErrorHandling(hookCall, componentNode);

    // Credit global handlers if they exist
    if (hookName === 'useQuery' || hookName === 'useInfiniteQuery') {
      if (globalHandlers.hasQueryCacheOnError) {
        errorHandling.hasGlobalHandler = true;
      }
    } else if (hookName === 'useMutation') {
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
        hasDeferredErrorHandling
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
    sourceFile: ts.SourceFile
  ): boolean {
    let foundInTryCatch = false;

    const visit = (node: ts.Node): void => {
      // Look for: mutation.mutateAsync(...) or await mutation.mutateAsync(...)
      if (ts.isCallExpression(node)) {
        if (ts.isPropertyAccessExpression(node.expression)) {
          const objName = node.expression.expression.getText(sourceFile);
          const methodName = node.expression.name.text;

          if (objName === mutationVarName && methodName === 'mutateAsync') {
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
    hasDeferredErrorHandling: boolean = false
  ): Violation | null {
    // Only check error severity postconditions
    if (postcondition.severity !== 'error') return null;

    const clauseId = postcondition.id;

    // Check query-error-unhandled
    if (clauseId === 'query-error-unhandled' ||
        clauseId === 'mutation-error-unhandled' ||
        clauseId === 'infinite-query-error-unhandled') {

      // Error is handled if ANY of these are true:
      // 1. Error state is checked (isError, error)
      // 2. onError callback is provided
      // 3. Global error handler is configured
      // 4. Deferred error handling (mutateAsync + try-catch)
      if (errorHandling.hasErrorStateCheck ||
          errorHandling.hasOnErrorCallback ||
          errorHandling.hasGlobalHandler ||
          hasDeferredErrorHandling) {
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
        description: 'No error handling found. Errors will crash the application.',
        source_doc: postcondition.source,
        suggested_fix: postcondition.required_handling,
      };
    }

    // Check mutation-optimistic-update-rollback
    if (clauseId === 'mutation-optimistic-update-rollback') {
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
          description: 'Optimistic update without rollback. UI will show incorrect data on error.',
          source_doc: postcondition.source,
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
    _sourceFile: ts.SourceFile
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
        // Call expression but not on a property access
        break;
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
    schemaInstances: Map<string, string>
  ): CallSite | null {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));

    // Try to determine the function and package being called
    let functionName: string | null = null;
    let packageName: string | null = null;

    if (ts.isPropertyAccessExpression(node.expression)) {
      // Walk the full property access chain to handle both simple and chained calls
      // Simple: axios.get() → { root: 'axios', chain: [], method: 'get' }
      // Chained: prisma.user.create() → { root: 'prisma', chain: ['user'], method: 'create' }
      // Property: this.prisma.user.create() → { root: 'this', chain: ['prisma', 'user'], method: 'create' }
      // Namespace: ts.sys.readFile() → { root: 'ts', chain: ['sys'], method: 'readFile' }
      const chainInfo = this.walkPropertyAccessChain(node.expression, sourceFile);

      if (chainInfo) {
        functionName = chainInfo.method;
        let rootIdentifier = chainInfo.root;

        // Special handling for 'this.property' patterns
        if (rootIdentifier === 'this' && chainInfo.chain.length > 0) {
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
          packageName = this.resolvePackageFromImports(rootIdentifier, sourceFile);
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
              f => f.namespace === namespace && f.name === functionName
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
  private extractInstanceVariable(node: ts.CallExpression, _sourceFile: ts.SourceFile): string | null {
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
  private resolvePackageFromImports(functionName: string, sourceFile: ts.SourceFile): string | null {
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
            const lastSlash = importPath.lastIndexOf('/');
            if (lastSlash > 0 && importPath.startsWith('@')) {
              // For scoped packages, only remove after the package name
              const firstSlash = importPath.indexOf('/');
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
          if (importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
            for (const element of importClause.namedBindings.elements) {
              if (element.name.text === functionName) {
                return packageName;
              }
            }
          }

          // Handle: import * as ts from 'typescript'
          // NEW: Namespace imports support for packages with namespace methods
          if (importClause.namedBindings && ts.isNamespaceImport(importClause.namedBindings)) {
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
    sourceFile: ts.SourceFile
  ): string | null {
    if (!ts.isNewExpression(node)) return null;

    const className = node.expression.getText(sourceFile);

    // Map class names to package names
    const classToPackage: Record<string, string> = {
      'PrismaClient': '@prisma/client',
      'PrismaService': '@prisma/client', // NestJS wrapper around PrismaClient
      'Stripe': 'stripe',
      'OpenAI': 'openai',
      'Twilio': 'twilio',
    };

    if (classToPackage[className]) {
      return classToPackage[className];
    }

    // Fallback: resolve from imports
    return this.resolvePackageFromImports(className, sourceFile);
  }

  /**
   * Extracts package name from axios.create() call
   * Returns the package name if this is an axios.create() or similar factory call
   */
  private extractPackageFromAxiosCreate(node: ts.Expression, sourceFile: ts.SourceFile): string | null {
    // Pattern 1: axios.create(...)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text;

      // Check if this is a factory method (create, default, etc.)
      if (methodName === 'create' || methodName === 'default') {
        if (ts.isIdentifier(node.expression.expression)) {
          const objectName = node.expression.expression.text;

          // Check if this is from a package we track
          const packageName = this.resolvePackageFromImports(objectName, sourceFile);
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
      if (functionName.startsWith('create') || functionName === 'default') {
        // Resolve which package this function is from
        const packageName = this.resolvePackageFromImports(functionName, sourceFile);
        if (packageName && this.contracts.has(packageName)) {
          return packageName;
        }
      }

      // Pattern 3: Direct package function calls
      // Example: import twilio from 'twilio'
      //          const client = twilio(accountSid, authToken)
      // This handles packages where the default export is a function that creates a client instance
      const packageName = this.resolvePackageFromImports(functionName, sourceFile);
      if (packageName && this.contracts.has(packageName)) {
        return packageName;
      }
    }

    return null;
  }

  /**
   * Extracts package name from schema factory methods (z.object(), z.string(), etc.)
   * Returns the package name if this is a schema creation call
   */
  private extractPackageFromSchemaFactory(node: ts.Expression, sourceFile: ts.SourceFile): string | null {
    // Pattern: z.object(...), z.string(), z.number(), etc.
    // These are factory methods that return schema instances
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text;

      // Common zod schema factory methods
      const zodFactoryMethods = [
        'object', 'string', 'number', 'boolean', 'array', 'tuple',
        'union', 'intersection', 'record', 'map', 'set', 'date',
        'undefined', 'null', 'void', 'any', 'unknown', 'never',
        'literal', 'enum', 'nativeEnum', 'promise', 'function',
        'lazy', 'discriminatedUnion', 'instanceof', 'nan', 'optional',
        'nullable', 'coerce'
      ];

      if (zodFactoryMethods.includes(methodName)) {
        if (ts.isIdentifier(node.expression.expression)) {
          const objectName = node.expression.expression.text;

          // Check if this is 'z' from zod import
          const packageName = this.resolvePackageFromImports(objectName, sourceFile);
          if (packageName === 'zod') {
            return packageName;
          }

          // Direct match if imported as something else
          if (objectName === 'z' || objectName === 'zod') {
            // Verify it's actually from zod package
            const resolved = this.resolvePackageFromImports(objectName, sourceFile);
            if (resolved) {
              return resolved;
            }
          }
        }
      }
    }

    // Pattern: z.ZodObject.create(...) - less common but possible
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text;
      if (methodName === 'create' && ts.isPropertyAccessExpression(node.expression.expression)) {
        // Check if this is z.ZodObject.create()
        const className = node.expression.expression.name.text;
        if (className.startsWith('Zod')) {
          const rootExpr = node.expression.expression.expression;
          if (ts.isIdentifier(rootExpr)) {
            const packageName = this.resolvePackageFromImports(rootExpr.text, sourceFile);
            if (packageName === 'zod') {
              return packageName;
            }
          }
        }
      }
    }

    // Pattern: schema.extend(...), schema.merge(...), schema.pick(...), etc.
    // These also return new schema instances
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text;
      const schemaTransformMethods = [
        'extend', 'merge', 'pick', 'omit', 'partial', 'required',
        'passthrough', 'strict', 'strip', 'catchall', 'brand',
        'default', 'describe', 'refine', 'superRefine', 'transform',
        'preprocess', 'pipe', 'readonly', 'optional', 'nullable',
        'nullish', 'array', 'promise', 'or', 'and'
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
  private analyzeErrorHandling(
    node: ts.CallExpression,
    sourceFile: ts.SourceFile,
    hasGlobalInterceptor: boolean = false
  ): CallSiteAnalysis {
    const analysis: CallSiteAnalysis = {
      callSite: {
        file: sourceFile.fileName,
        line: 0,
        column: 0,
        functionName: '',
        packageName: '',
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

    // Check if call is inside a try-catch block
    if (!analysis.hasTryCatch) {
      analysis.hasTryCatch = this.isInTryCatch(node);
    }

    // Check if there's a .catch() handler
    const parent = node.parent;
    if (parent && ts.isPropertyAccessExpression(parent) && parent.name.text === 'catch') {
      analysis.hasPromiseCatch = true;
    }

    // Look for error.response checks in surrounding catch blocks
    const catchClause = this.findEnclosingCatchClause(node);
    if (catchClause) {
      analysis.checksResponseExists = this.catchChecksResponseExists(catchClause);
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

    return false;
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
        if (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'response') {
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
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'response') {
      return true;
    }

    // Negated check: if (!error.response)
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      if (ts.isPropertyAccessExpression(node.operand) && node.operand.name.text === 'response') {
        return true;
      }
    }

    // Binary expression: if (error.response && ...)
    if (ts.isBinaryExpression(node)) {
      return this.expressionChecksResponse(node.left) || this.expressionChecksResponse(node.right);
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
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'status') {
        const expr = node.expression;
        if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'response') {
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
      if (ts.isBinaryExpression(node) &&
          (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
           node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken)) {

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
  private catchHasRetryLogic(catchClause: ts.CatchClause, sourceFile: ts.SourceFile): boolean {
    // Look for common retry patterns: retry, attempt, backoff, setTimeout, etc.
    const text = catchClause.getText(sourceFile).toLowerCase();
    return text.includes('retry') ||
           text.includes('backoff') ||
           text.includes('attempt') ||
           (text.includes('settimeout') && text.includes('delay'));
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
    sourceFile: ts.SourceFile
  ): Violation | null {
    const hasAnyErrorHandling = analysis.hasTryCatch || analysis.hasPromiseCatch;

    // Clerk-specific: Null check detection for auth(), currentUser(), getToken()
    // Check this BEFORE generic try-catch check because these functions use null checks, not try-catch
    if (postcondition.id === 'auth-null-not-checked' ||
        postcondition.id === 'current-user-null-not-handled' ||
        postcondition.id === 'get-token-null-not-handled') {

      const hasNullCheck = this.checkNullHandling(node, sourceFile);

      if (!hasNullCheck) {
        const description = postcondition.throws ||
          `${functionName}() result used without null check - will crash if user not authenticated.`;
        return this.createViolation(callSite, postcondition, packageName, functionName, description, 'error');
      } else {
        // Has null check, so this is handled correctly - don't flag as violation
        return null;
      }
    }

    // Clerk-specific: Middleware file system check
    // Check this BEFORE generic try-catch because it requires file inspection, not try-catch
    if (postcondition.id === 'middleware-not-exported') {
      const middlewareExists = this.checkClerkMiddlewareExists();

      if (!middlewareExists) {
        const description = postcondition.throws ||
          'Middleware file not found or clerkMiddleware not properly exported. auth() calls will fail at runtime.';
        return this.createViolation(callSite, postcondition, packageName, functionName, description, 'error');
      } else {
        // Middleware is properly configured - no violation
        return null;
      }
    }

    // Clerk-specific: Check for middleware matcher configuration
    if (postcondition.id === 'middleware-matcher-missing') {
      const middlewarePath = this.checkFileExists('middleware.ts', ['middleware.ts', 'middleware.js']);

      if (middlewarePath) {
        // Check if the middleware file exports a config with matcher
        const sourceFile = this.program.getSourceFile(middlewarePath);
        let hasMatcherConfig = false;

        if (sourceFile) {
          ts.forEachChild(sourceFile, (node) => {
            // Look for: export const config = { matcher: ... }
            if (ts.isVariableStatement(node)) {
              const modifiers = ts.getCombinedModifierFlags(node.declarationList.declarations[0]);
              if (modifiers & ts.ModifierFlags.Export) {
                for (const declaration of node.declarationList.declarations) {
                  if (ts.isVariableDeclaration(declaration) &&
                      ts.isIdentifier(declaration.name) &&
                      declaration.name.text === 'config') {
                    hasMatcherConfig = true;
                    break;
                  }
                }
              }
            }
          });

          if (!hasMatcherConfig) {
            const description = postcondition.throws ||
              'Middleware missing matcher configuration. Will run on all routes including static assets.';
            return this.createViolation(callSite, postcondition, packageName, functionName, description, 'warning');
          }
        }
      }

      return null;
    }

    // Twilio-specific: Hardcoded credentials check
    if (postcondition.id === 'hardcoded-credentials') {
      const hasHardcodedCredentials = this.checkHardcodedCredentials(node);

      if (hasHardcodedCredentials) {
        const description = postcondition.throws ||
          'Hardcoded credentials detected. Use environment variables (process.env) to avoid security risks.';
        return this.createViolation(callSite, postcondition, packageName, functionName, description, 'error');
      } else {
        // Credentials are from environment variables - no violation
        return null;
      }
    }

    // NEW: Generic check for any postcondition requiring error handling
    // If the postcondition specifies required_handling and has severity='error',
    // it means the call MUST have error handling
    if (postcondition.required_handling && postcondition.severity === 'error') {
      if (!hasAnyErrorHandling) {
        // Generate a violation with a generic message based on the postcondition description
        const description = postcondition.throws
          ? `No try-catch block found. ${postcondition.throws} - this will crash the application.`
          : 'No error handling found. This operation can throw errors that will crash the application.';

        return this.createViolation(callSite, postcondition, packageName, functionName, description, 'error');
      }
    }

    // Specific violation checks based on postcondition ID (for more detailed analysis)
    if (postcondition.id.includes('429') || postcondition.id.includes('rate-limit')) {
      // Rate limiting check
      if (!hasAnyErrorHandling) {
        return this.createViolation(callSite, postcondition, packageName, functionName,
          'No try-catch block found. Rate limit errors (429) will crash the application.', 'error');
      }

      // WARNING: Has error handling but doesn't handle 429 specifically
      if (!analysis.handledStatusCodes.includes(429) && !analysis.hasRetryLogic) {
        return this.createViolation(callSite, postcondition, packageName, functionName,
          'Rate limit response (429) is not explicitly handled. Consider implementing retry logic with exponential backoff.', 'warning');
      }
    }

    if (postcondition.id.includes('network')) {
      // Network failure check
      if (!hasAnyErrorHandling) {
        return this.createViolation(callSite, postcondition, packageName, functionName,
          'No try-catch block found. Network failures will crash the application.', 'error');
      }

      // WARNING: Has error handling but doesn't check response.exists
      if (hasAnyErrorHandling && !analysis.checksResponseExists) {
        return this.createViolation(callSite, postcondition, packageName, functionName,
          'Generic error handling found. Consider checking if error.response exists to distinguish network failures from HTTP errors.', 'warning');
      }
    }

    if (postcondition.id.includes('error') && postcondition.severity === 'error') {
      // Generic error handling check
      if (!hasAnyErrorHandling) {
        return this.createViolation(callSite, postcondition, packageName, functionName,
          'No error handling found. Errors will crash the application.', 'error');
      }

      // WARNING: Has generic error handling but doesn't inspect status codes
      if (hasAnyErrorHandling && !analysis.checksStatusCode) {
        return this.createViolation(callSite, postcondition, packageName, functionName,
          'Generic error handling found. Consider inspecting error.response.status to distinguish between 4xx client errors and 5xx server errors for better UX.', 'warning');
      }
    }

    return null;
  }

  /**
   * Checks if a function call result has proper null handling
   * Used for Clerk functions that return null when not authenticated
   */
  private checkNullHandling(callNode: ts.CallExpression, sourceFile: ts.SourceFile): boolean {

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
          awaitParent.name.elements.forEach(element => {
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
        parent.name.elements.forEach(element => {
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
          if (this.isNullCheckCondition(parent.expression, variableNames, sourceFile)) {
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
  private isNullCheckCondition(condition: ts.Expression, variableNames: string[], sourceFile: ts.SourceFile): boolean {
    const conditionText = condition.getText(sourceFile);

    // Check if any of our variables are mentioned in the condition
    const mentionsVariable = variableNames.some(varName => conditionText.includes(varName));
    if (!mentionsVariable) return false;

    // Pattern: !variable or !userId
    if (ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken) {
      const operandText = condition.operand.getText(sourceFile);
      return variableNames.includes(operandText);
    }

    // Pattern: variable === null, variable !== null, etc.
    if (ts.isBinaryExpression(condition)) {
      const operator = condition.operatorToken.kind;

      // Handle || and && by recursively checking both sides
      if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.AmpersandAmpersandToken) {
        return this.isNullCheckCondition(condition.left, variableNames, sourceFile) ||
               this.isNullCheckCondition(condition.right, variableNames, sourceFile);
      }

      const leftText = condition.left.getText(sourceFile);
      const rightText = condition.right.getText(sourceFile);

      const hasVariable = variableNames.some(v => leftText.includes(v) || rightText.includes(v));
      const hasNullCheck = conditionText.includes('null') || conditionText.includes('undefined');

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
  private findContainingFunction(node: ts.Node): ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration | null {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isFunctionDeclaration(current) ||
          ts.isArrowFunction(current) ||
          ts.isFunctionExpression(current) ||
          ts.isMethodDeclaration(current)) {
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
      if (ts.isTemplateExpression(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
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
            if (ts.isPropertyAccessExpression(expr) &&
                ts.isIdentifier(expr.expression) &&
                expr.expression.text === 'process' &&
                ts.isIdentifier(expr.name) &&
                expr.name.text === 'env') {
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
        if (ts.isPropertyAccessExpression(expr) &&
            ts.isIdentifier(expr.expression) &&
            expr.expression.text === 'process' &&
            ts.isIdentifier(expr.name) &&
            expr.name.text === 'env') {
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
        if (ts.isPropertyAccessExpression(expr) &&
            ts.isIdentifier(expr.expression) &&
            expr.expression.text === 'process' &&
            ts.isIdentifier(expr.name) &&
            expr.name.text === 'env') {
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
  private findVariableDeclaration(variableName: string, node: ts.Node): ts.VariableDeclaration | null {
    let current: ts.Node | undefined = node;

    while (current) {
      // Check variable statements in this scope
      if (ts.isSourceFile(current) || ts.isBlock(current) || ts.isFunctionLike(current)) {
        let foundDeclaration: ts.VariableDeclaration | null = null;

        const visitNode = (node: ts.Node): void => {
          if (foundDeclaration) return;

          if (ts.isVariableDeclaration(node) &&
              ts.isIdentifier(node.name) &&
              node.name.text === variableName) {
            foundDeclaration = node;
            return;
          }

          // Don't recurse into nested functions/blocks
          if (node === current || ts.isVariableStatement(node) || ts.isVariableDeclarationList(node)) {
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
  private checkFileExists(fileName: string, variations?: string[]): string | null {
    const filesToCheck = variations || [fileName];
    const locationsToCheck = [
      '', // Root directory
      'src', // src/ directory
      'app', // app/ directory (Next.js App Router)
    ];

    for (const location of locationsToCheck) {
      for (const file of filesToCheck) {
        const fullPath = path.join(this.projectRoot, location, file);
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
    exportPattern: { type: 'default' | 'named'; exportName?: string }
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
              if (node.importClause?.namedBindings &&
                  ts.isNamedImports(node.importClause.namedBindings)) {
                for (const element of node.importClause.namedBindings.elements) {
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
      if (exportPattern.type === 'default' && ts.isExportAssignment(node)) {
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

      if (exportPattern.type === 'named' && ts.isExportDeclaration(node)) {
        // export { ... }
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const element of node.exportClause.elements) {
            if (exportPattern.exportName && element.name.text === exportPattern.exportName) {
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
    // Check if middleware.ts or middleware.js exists
    const middlewarePath = this.checkFileExists('middleware.ts', [
      'middleware.ts',
      'middleware.js'
    ]);

    if (!middlewarePath) {
      return false;
    }

    // Check if the middleware file imports and exports clerkMiddleware
    const { hasImport, hasExport } = this.checkFileImportsAndExports(
      middlewarePath,
      { packageName: '@clerk/nextjs', importName: 'clerkMiddleware' },
      { type: 'default' }
    );

    return hasImport && hasExport;
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
    severityOverride?: 'error' | 'warning' | 'info'
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
      source_doc: postcondition.source,
      suggested_fix: postcondition.required_handling,
    };
  }

  /**
   * Gets statistics about the analysis run
   */
  getStats() {
    return {
      filesAnalyzed: this.program.getSourceFiles().filter(
        sf => !sf.isDeclarationFile && !sf.fileName.includes('node_modules')
      ).length,
      contractsApplied: Array.from(this.contracts.values()).reduce(
        (sum, contract) => sum + (contract.functions?.length || 0),
        0
      ),
    };
  }
}
