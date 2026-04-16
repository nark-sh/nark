/**
 * Package Discovery Module
 *
 * Scans a project to discover all packages used, check which have contracts,
 * and provide coverage statistics.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as ts from "typescript";
import {
  DiscoveredPackage,
  PackageDiscoveryResult,
  PackageContract,
} from "./types.js";

export class PackageDiscovery {
  private pathAliases: Set<string> = new Set();

  constructor(private corpusContracts: Map<string, PackageContract>) {}

  /**
   * Discover all packages used in a project
   */
  async discoverPackages(
    projectRoot: string,
    tsconfigPath: string,
  ): Promise<PackageDiscoveryResult> {
    // Step 1: Read package.json dependencies
    const packageJsonDeps = await this.readPackageJson(projectRoot);

    // Step 2: Scan source files for actual imports (returns both import map and program)
    const { imports: importedPackages, program } =
      await this.scanImports(tsconfigPath);

    // Step 3: Merge and dedupe
    const allPackages = this.mergePackages(packageJsonDeps, importedPackages);

    // Step 4: Check which have contracts
    const packagesWithContracts = this.checkContracts(allPackages);

    // Step 5: Count call sites for each package using the shared TS program
    const callSiteCounts = this.countCallSites(program, importedPackages);
    for (const pkg of packagesWithContracts) {
      pkg.callSiteCount = callSiteCounts.get(pkg.name) ?? 0;
    }

    // Step 6: Calculate statistics
    const withContracts = packagesWithContracts.filter(
      (p) => p.hasContract,
    ).length;
    const withoutContracts = packagesWithContracts.length - withContracts;

    return {
      total: packagesWithContracts.length,
      withContracts,
      withoutContracts,
      packages: packagesWithContracts,
    };
  }

  /**
   * Read dependencies from package.json
   */
  private async readPackageJson(
    projectRoot: string,
  ): Promise<Map<string, { version: string }>> {
    const packages = new Map<string, { version: string }>();

    const addDeps = (packageJson: any) => {
      const deps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };
      for (const [name, version] of Object.entries(deps)) {
        if (!packages.has(name)) {
          packages.set(name, { version: version as string });
        }
      }
    };

    try {
      const packageJsonPath = path.join(projectRoot, "package.json");
      const content = await fs.readFile(packageJsonPath, "utf-8");
      const packageJson = JSON.parse(content);
      addDeps(packageJson);

      // For monorepos: if root has workspaces or very few deps, also scan
      // common workspace locations to collect per-package dependencies.
      if (packages.size < 5 || packageJson.workspaces) {
        const workspaceDirs = ["packages", "apps", "services", "libs"];
        for (const wsDir of workspaceDirs) {
          try {
            const entries = await fs.readdir(path.join(projectRoot, wsDir), {
              withFileTypes: true,
            });
            for (const entry of entries) {
              if (!entry.isDirectory()) continue;
              try {
                const wsPackageJson = JSON.parse(
                  await fs.readFile(
                    path.join(projectRoot, wsDir, entry.name, "package.json"),
                    "utf-8",
                  ),
                );
                addDeps(wsPackageJson);
              } catch {
                // individual workspace missing package.json — skip
              }
            }
          } catch {
            // workspace directory doesn't exist — skip
          }
        }
      }
    } catch {
      // No package.json found — this is expected when scanning a non-project directory.
      // Silently continue; we'll still discover packages from import statements.
    }

    return packages;
  }

  /**
   * Scan TypeScript source files for import statements.
   * Returns both the import map and the TS program so callers can reuse the program.
   */
  private async scanImports(tsconfigPath: string): Promise<{
    imports: Map<string, Set<string>>;
    program: ts.Program | null;
  }> {
    const imports = new Map<string, Set<string>>(); // packageName -> Set<fileName>
    let program: ts.Program | null = null;

    try {
      // Load tsconfig
      const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
      const parsedConfig = ts.parseJsonConfigFileContent(
        configFile.config ?? {},
        ts.sys,
        path.dirname(tsconfigPath),
      );

      // Extract path aliases to filter them out
      this.extractPathAliases(configFile.config ?? {}, tsconfigPath);

      // Fallback: if tsconfig yielded no files (e.g. monorepo root with only
      // project references and no include), scan the directory directly.
      let fileNames = parsedConfig.fileNames;
      let compilerOptions = parsedConfig.options;
      if (fileNames.length === 0) {
        const projectRoot = path.dirname(tsconfigPath);
        fileNames = ts.sys.readDirectory(
          projectRoot,
          [".ts", ".tsx"],
          ["node_modules", "dist", "build", ".git"],
          undefined,
        );
        compilerOptions = { skipLibCheck: true, allowJs: false };
        // Silent fallback — the verbose log in the CLI will show this if needed
      }

      // Create program (shared with countCallSites)
      program = ts.createProgram(fileNames, compilerOptions);

      // Scan each source file
      for (const sourceFile of program.getSourceFiles()) {
        if (sourceFile.isDeclarationFile) continue;
        if (sourceFile.fileName.includes("node_modules")) continue;

        this.extractImportsFromFile(sourceFile, imports);
      }
    } catch {
      // Failed to scan imports — continue without import-based discovery
    }

    return { imports, program };
  }

  /**
   * Count call sites for each imported package.
   *
   * A "call site" is any CallExpression whose callee resolves to an identifier
   * that originated from a package import — either directly or through tracked
   * bindings. The count is used as a proxy for how heavily a package is used,
   * not as an exhaustive list of every invocation.
   *
   * ── What is counted ────────────────────────────────────────────────────────
   *
   * Import bindings (ES modules and CJS):
   *   import axios from 'axios'                   → axios.get()
   *   import * as AWS from '@aws-sdk/…'            → AWS.S3Client()
   *   import { S3Client } from '@aws-sdk/…'        → new S3Client()
   *   const stripe = require('stripe')             → stripe.charges.create()
   *   const { S3Client } = require('@aws-sdk/…')   → S3Client tracked
   *
   * Instance variables (VariableDeclaration and class PropertyDeclaration):
   *   const s3 = new S3Client(…)                  → s3.send()
   *   const t  = nodemailer.createTransport(…)     → t.sendMail()
   *   const c  = await pool.connect()             → c.query()
   *   const b  = primaryClient                    → b.send()  (alias)
   *   private s3 = new S3Client(…)                → this.s3.send()
   *
   * Typed parameters (resolved against the import map):
   *   constructor(private s3: S3Client)            → this.s3.send()
   *   async upload(client: S3Client)               → client.send()
   *
   * this.property dispatch:
   *   this.s3.send(…)    — property name "s3" looked up in the identifier map
   *   this.stripe.charges.create(…)  — outermost property "stripe" looked up
   *
   * ── What is NOT counted (known ceiling) ────────────────────────────────────
   *
   * These patterns require TypeScript's type checker
   * (program.getTypeChecker().getTypeAtLocation()) and are deliberately out of
   * scope to keep scan time O(AST nodes) with no type-resolution overhead:
   *
   *   const c = getS3Client()          opaque return type from another file
   *   const c = x as S3Client          type assertion
   *   clients[0].send()                ElementAccessExpression (index access)
   *   (isDev ? a : b).send()           conditional expression as callee
   *
   * Adding type-checker resolution would be isolated to this method and
   * collectInstanceVariables() but would increase per-file analysis time
   * significantly. Revisit if user feedback shows the gap is material.
   *
   * ── Implementation note ────────────────────────────────────────────────────
   *
   * We build a per-file localIdentifier → packageName reverse map for O(1)
   * lookups during the AST walk. collectInstanceVariables() extends that map
   * with derived bindings before the walk begins.
   */
  private countCallSites(
    program: ts.Program | null,
    importedPackages: Map<string, Set<string>>,
  ): Map<string, number> {
    const counts = new Map<string, number>();

    if (!program || importedPackages.size === 0) {
      return counts;
    }

    // Initialize counts for all imported packages
    for (const packageName of importedPackages.keys()) {
      counts.set(packageName, 0);
    }

    // Build a map from local identifier names to the package(s) they came from.
    // We need to scan each file's imports to collect the local binding names.
    const identifierToPackage = new Map<string, string>();

    for (const sourceFile of program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;
      if (sourceFile.fileName.includes("node_modules")) continue;

      // Collect local identifiers introduced by import declarations for this file
      const fileIdentifiers = this.extractLocalIdentifiers(sourceFile);
      for (const [localName, packageName] of fileIdentifiers) {
        if (importedPackages.has(packageName)) {
          identifierToPackage.set(localName, packageName);
        }
      }
    }

    // Walk the AST of every non-node_modules file counting call expressions
    for (const sourceFile of program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;
      if (sourceFile.fileName.includes("node_modules")) continue;

      // Re-collect file-level identifiers so we only match ones in scope
      const fileIdentifiers = this.extractLocalIdentifiers(sourceFile);
      const fileIdentifierToPackage = new Map<string, string>();
      for (const [localName, packageName] of fileIdentifiers) {
        if (importedPackages.has(packageName)) {
          fileIdentifierToPackage.set(localName, packageName);
        }
      }

      if (fileIdentifierToPackage.size === 0) continue;

      // Extend the map with instance variables: `const s3 = new S3Client()`
      // where S3Client is already in fileIdentifierToPackage.
      this.collectInstanceVariables(sourceFile, fileIdentifierToPackage);

      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          const rootName = this.extractCalleeRootIdentifier(node);
          if (rootName === "this") {
            // this.prop.method() — check the property name immediately on `this`
            const propName = this.extractThisPropertyName(node);
            if (propName && fileIdentifierToPackage.has(propName)) {
              const packageName = fileIdentifierToPackage.get(propName)!;
              counts.set(packageName, (counts.get(packageName) ?? 0) + 1);
            }
          } else if (rootName && fileIdentifierToPackage.has(rootName)) {
            const packageName = fileIdentifierToPackage.get(rootName)!;
            counts.set(packageName, (counts.get(packageName) ?? 0) + 1);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    return counts;
  }

  /**
   * Extract local identifier names introduced by import declarations in a source file.
   * Returns a Map<localName, packageName>.
   */
  private extractLocalIdentifiers(
    sourceFile: ts.SourceFile,
  ): Map<string, string> {
    const result = new Map<string, string>();

    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = node.moduleSpecifier;
        if (!ts.isStringLiteral(moduleSpecifier)) return;
        const packageName = this.extractPackageName(moduleSpecifier.text);
        if (!packageName) return;

        const importClause = node.importClause;
        if (!importClause) return;

        // Default import: import axios from 'axios' -> "axios" local name
        if (importClause.name) {
          result.set(importClause.name.text, packageName);
        }

        // Namespace import: import * as axios from 'axios' -> "axios"
        if (
          importClause.namedBindings &&
          ts.isNamespaceImport(importClause.namedBindings)
        ) {
          result.set(importClause.namedBindings.name.text, packageName);
        }

        // Named imports: import { get, post } from 'axios' -> "get", "post"
        if (
          importClause.namedBindings &&
          ts.isNamedImports(importClause.namedBindings)
        ) {
          for (const specifier of importClause.namedBindings.elements) {
            result.set(specifier.name.text, packageName);
          }
        }
      }

      // require() bindings:
      //   const stripe = require('stripe')            -> "stripe"
      //   const { S3Client } = require('@aws-sdk/..') -> "S3Client"
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isCallExpression(node.initializer)
      ) {
        const call = node.initializer;
        const isRequire =
          ts.isIdentifier(call.expression) &&
          call.expression.text === "require" &&
          call.arguments.length === 1 &&
          ts.isStringLiteral(call.arguments[0]);
        if (isRequire) {
          const packageName = this.extractPackageName(
            (call.arguments[0] as ts.StringLiteral).text,
          );
          if (packageName) {
            // const stripe = require('stripe')
            if (ts.isIdentifier(node.name)) {
              result.set(node.name.text, packageName);
            }
            // const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
            if (ts.isObjectBindingPattern(node.name)) {
              for (const element of node.name.elements) {
                if (ts.isIdentifier(element.name)) {
                  result.set(element.name.text, packageName);
                }
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    return result;
  }

  /**
   * Extend identifierToPackage with all local names that refer to an imported
   * package's instance or value, beyond the direct import bindings.
   *
   * Handles:
   *   const s3 = new S3Client(...)                  variable from constructor
   *   const t  = nodemailer.createTransport(...)     variable from factory call
   *   const c  = await pool.connect()               variable from async factory
   *   const b  = primary                            identifier alias
   *   private s3 = new S3Client(...)                class property (any of above)
   *   constructor(private s3: S3Client)              constructor injection
   *   async upload(client: S3Client)                typed function parameter
   *
   * Mutates the passed map in place.
   */
  private collectInstanceVariables(
    sourceFile: ts.SourceFile,
    identifierToPackage: Map<string, string>,
  ): void {
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const varName = node.name.text;
        const init = node.initializer;
        if (init) {
          // const s3 = new S3Client(...)
          const newExpr = ts.isNewExpression(init)
            ? init
            : ts.isAwaitExpression(init) && ts.isNewExpression(init.expression)
              ? init.expression
              : null;
          if (newExpr) {
            const ctorName = this.extractNewExpressionCtorName(newExpr);
            if (ctorName && identifierToPackage.has(ctorName)) {
              identifierToPackage.set(varName, identifierToPackage.get(ctorName)!);
            }
          }

          // const transport = nodemailer.createTransport(...)
          // const client = await pool.connect()
          const callExpr = ts.isCallExpression(init)
            ? init
            : ts.isAwaitExpression(init) && ts.isCallExpression(init.expression)
              ? init.expression
              : null;
          if (callExpr) {
            const rootName = this.extractCalleeRootIdentifier(callExpr);
            if (rootName && identifierToPackage.has(rootName)) {
              identifierToPackage.set(varName, identifierToPackage.get(rootName)!);
            }
          }

          // const backup = primary  (identifier alias)
          if (ts.isIdentifier(init) && identifierToPackage.has(init.text)) {
            identifierToPackage.set(varName, identifierToPackage.get(init.text)!);
          }
        }
      }

      // Class property declarations: private s3 = new S3Client(...)
      if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
        const propName = node.name.text;
        const init = node.initializer;
        if (init) {
          const newExpr = ts.isNewExpression(init)
            ? init
            : ts.isAwaitExpression(init) && ts.isNewExpression(init.expression)
              ? init.expression
              : null;
          if (newExpr) {
            const ctorName = this.extractNewExpressionCtorName(newExpr);
            if (ctorName && identifierToPackage.has(ctorName)) {
              identifierToPackage.set(propName, identifierToPackage.get(ctorName)!);
            }
          }

          const callExpr = ts.isCallExpression(init)
            ? init
            : ts.isAwaitExpression(init) && ts.isCallExpression(init.expression)
              ? init.expression
              : null;
          if (callExpr) {
            const rootName = this.extractCalleeRootIdentifier(callExpr);
            if (rootName && identifierToPackage.has(rootName)) {
              identifierToPackage.set(propName, identifierToPackage.get(rootName)!);
            }
          }

          // private backup = this.primary  (property alias — handled via this.prop tracking)
          if (ts.isIdentifier(init) && identifierToPackage.has(init.text)) {
            identifierToPackage.set(propName, identifierToPackage.get(init.text)!);
          }
        }
      }

      // Typed parameters — covers constructor injection and typed function params:
      //   constructor(private s3: S3Client) {}
      //   async upload(client: S3Client) { client.send(...) }
      if (
        ts.isConstructorDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)
      ) {
        for (const param of node.parameters) {
          if (!ts.isIdentifier(param.name)) continue;
          if (!param.type || !ts.isTypeReferenceNode(param.type)) continue;
          const typeName = ts.isIdentifier(param.type.typeName)
            ? param.type.typeName.text
            : null;
          if (typeName && identifierToPackage.has(typeName)) {
            identifierToPackage.set(
              param.name.text,
              identifierToPackage.get(typeName)!,
            );
          }
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  /**
   * Extract the constructor name from a NewExpression.
   * Handles: new S3Client() -> "S3Client"
   * Handles: new AWS.S3() -> "AWS" (root identifier)
   */
  private extractNewExpressionCtorName(node: ts.NewExpression): string | null {
    let expr: ts.Expression = node.expression;
    while (ts.isPropertyAccessExpression(expr)) {
      expr = expr.expression;
    }
    if (ts.isIdentifier(expr)) {
      return expr.text;
    }
    return null;
  }

  /**
   * Extract the property name immediately on `this` for a call like this.prop.method().
   * Returns null for direct calls like this.method() (no intermediate property).
   *
   * Examples:
   * - this.s3.send(...)               -> "s3"
   * - this.stripe.charges.create(...) -> "stripe"
   * - this.method()                   -> null (direct call, no instance property)
   */
  private extractThisPropertyName(node: ts.CallExpression): string | null {
    let expr: ts.Expression = node.expression;
    let prev: ts.PropertyAccessExpression | null = null;

    while (ts.isPropertyAccessExpression(expr)) {
      prev = expr;
      expr = expr.expression;
    }

    // Root must be `this` and there must be at least one property access
    if (!ts.isIdentifier(expr) || expr.text !== "this" || prev === null) {
      return null;
    }

    // this.method() — prev IS the callee, no intermediate instance property
    if (prev === node.expression) {
      return null;
    }

    // After the loop, prev is the PropertyAccess directly on `this`:
    // this.s3.send()               -> prev = "this.s3",  prev.name.text = "s3"
    // this.stripe.charges.create() -> prev = "this.stripe", prev.name.text = "stripe"
    return prev.name.text;
  }

  /**
   * Extract the root identifier name from a call expression's callee.
   *
   * Examples:
   * - axios.get(...)        -> "axios"
   * - stripe.charges.create(...) -> "stripe"
   * - get(...)              -> "get"
   * - foo.bar.baz(...)      -> "foo"
   */
  private extractCalleeRootIdentifier(node: ts.CallExpression): string | null {
    let expr: ts.Expression = node.expression;

    // Drill through property access chains: a.b.c -> start from leftmost
    while (ts.isPropertyAccessExpression(expr)) {
      expr = expr.expression;
    }

    if (ts.isIdentifier(expr)) {
      return expr.text;
    }

    return null;
  }

  /**
   * Extract path aliases from tsconfig to filter them out
   *
   * Examples:
   * - "@/*" -> "@"
   * - "@/components/*" -> "@/components"
   * - "~/*" -> "~"
   */
  private extractPathAliases(config: any, tsconfigPath: string): void {
    this.pathAliases.clear();

    // Check current config
    const paths = config.compilerOptions?.paths;
    if (paths) {
      for (const alias of Object.keys(paths)) {
        // Extract the base alias (remove /* suffix)
        const baseAlias = alias.replace(/\/\*$/, "");
        this.pathAliases.add(baseAlias);
      }
    }

    // Check extends (recursively load parent tsconfig)
    if (config.extends) {
      try {
        const extendsPath = path.resolve(
          path.dirname(tsconfigPath),
          config.extends,
        );
        const parentConfig = ts.readConfigFile(extendsPath, ts.sys.readFile);
        if (parentConfig.config) {
          this.extractPathAliases(parentConfig.config, extendsPath);
        }
      } catch {
        // Ignore errors loading parent config
      }
    }
  }

  /**
   * Extract import statements from a TypeScript source file
   */
  private extractImportsFromFile(
    sourceFile: ts.SourceFile,
    imports: Map<string, Set<string>>,
  ): void {
    const visit = (node: ts.Node) => {
      // Handle: import { x } from 'package'
      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = node.moduleSpecifier;
        if (ts.isStringLiteral(moduleSpecifier)) {
          const packageName = this.extractPackageName(moduleSpecifier.text);
          if (packageName) {
            if (!imports.has(packageName)) {
              imports.set(packageName, new Set());
            }
            imports.get(packageName)!.add(sourceFile.fileName);
          }
        }
      }

      // Handle: require('package')
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.Identifier) {
          const identifier = node.expression as ts.Identifier;
          if (identifier.text === "require" && node.arguments.length > 0) {
            const arg = node.arguments[0];
            if (ts.isStringLiteral(arg)) {
              const packageName = this.extractPackageName(arg.text);
              if (packageName) {
                if (!imports.has(packageName)) {
                  imports.set(packageName, new Set());
                }
                imports.get(packageName)!.add(sourceFile.fileName);
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  /**
   * Extract the package name from an import path
   *
   * Examples:
   * - 'axios' -> 'axios'
   * - '@prisma/client' -> '@prisma/client'
   * - 'axios/lib/core' -> 'axios'
   * - './local' -> null
   * - '../relative' -> null
   * - '@/components' -> null (path alias)
   */
  private extractPackageName(importPath: string): string | null {
    // Ignore relative imports
    if (importPath.startsWith(".")) {
      return null;
    }

    // Ignore path aliases (e.g., @/*, ~/* from tsconfig.json)
    for (const alias of this.pathAliases) {
      if (importPath === alias || importPath.startsWith(alias + "/")) {
        return null;
      }
    }

    // Ignore Node.js built-ins
    const builtins = [
      "fs",
      "path",
      "crypto",
      "http",
      "https",
      "os",
      "util",
      "events",
      "stream",
      "buffer",
      "child_process",
      "url",
      "querystring",
      "net",
      "zlib",
      "assert",
      "readline",
      "process",
      "fs/promises",
    ];
    if (builtins.includes(importPath)) {
      return null;
    }

    // Handle scoped packages: @scope/package or @scope/package/subpath
    if (importPath.startsWith("@")) {
      const parts = importPath.split("/");
      if (parts.length >= 2) {
        return `${parts[0]}/${parts[1]}`;
      }
      return null;
    }

    // Handle regular packages: package or package/subpath
    const parts = importPath.split("/");
    return parts[0];
  }

  /**
   * Merge packages from package.json and actual imports
   */
  private mergePackages(
    packageJsonDeps: Map<string, { version: string }>,
    importedPackages: Map<string, Set<string>>,
  ): Map<
    string,
    {
      version: string;
      source: "package.json" | "import" | "both";
      usedIn: string[];
    }
  > {
    const merged = new Map();

    // Add all package.json dependencies
    for (const [name, { version }] of packageJsonDeps) {
      merged.set(name, {
        version,
        source: "package.json" as const,
        usedIn: [],
      });
    }

    // Add/update with actual imports
    for (const [name, files] of importedPackages) {
      if (merged.has(name)) {
        const existing = merged.get(name);
        existing.source = "both";
        existing.usedIn = Array.from(files);
      } else {
        // Package is imported but not in package.json (might be transitive)
        merged.set(name, {
          version: "unknown",
          source: "import" as const,
          usedIn: Array.from(files),
        });
      }
    }

    return merged;
  }

  /**
   * Check which packages have contracts in the corpus
   */
  private checkContracts(
    packages: Map<
      string,
      {
        version: string;
        source: "package.json" | "import" | "both";
        usedIn: string[];
      }
    >,
  ): DiscoveredPackage[] {
    const result: DiscoveredPackage[] = [];

    for (const [name, { version, source, usedIn }] of packages) {
      const contract = this.corpusContracts.get(name);

      result.push({
        name,
        version,
        source,
        hasContract: contract !== undefined,
        contractVersion: contract?.contract_version,
        usedIn,
        callSiteCount: 0, // Will be populated by countCallSites after merge
      });
    }

    // Sort by: contracts first, then alphabetically
    result.sort((a, b) => {
      if (a.hasContract !== b.hasContract) {
        return a.hasContract ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return result;
  }

  /**
   * Generate a coverage report
   */
  generateCoverageReport(discovery: PackageDiscoveryResult): string {
    const lines: string[] = [];
    const coveragePercent =
      discovery.total > 0
        ? ((discovery.withContracts / discovery.total) * 100).toFixed(1)
        : "0.0";

    lines.push("");
    lines.push(
      "════════════════════════════════════════════════════════════════",
    );
    lines.push("Package Discovery & Coverage");
    lines.push(
      "════════════════════════════════════════════════════════════════",
    );
    lines.push("");
    lines.push(`Total packages: ${discovery.total}`);
    lines.push(
      `Packages with contracts: ${discovery.withContracts} (${coveragePercent}%)`,
    );
    lines.push(`Packages without contracts: ${discovery.withoutContracts}`);
    lines.push("");

    if (discovery.withContracts > 0) {
      lines.push("✓ Packages with contracts:");
      for (const pkg of discovery.packages.filter((p) => p.hasContract)) {
        lines.push(
          `  ${pkg.name}@${pkg.version} (contract v${pkg.contractVersion})`,
        );
      }
      lines.push("");
    }

    if (discovery.withoutContracts > 0 && discovery.withoutContracts <= 20) {
      lines.push("⚠ Packages without contracts:");
      for (const pkg of discovery.packages.filter((p) => !p.hasContract)) {
        lines.push(`  ${pkg.name}@${pkg.version}`);
      }
      lines.push("");
    } else if (discovery.withoutContracts > 20) {
      lines.push(
        `⚠ ${discovery.withoutContracts} packages without contracts (showing top 20):`,
      );
      for (const pkg of discovery.packages
        .filter((p) => !p.hasContract)
        .slice(0, 20)) {
        lines.push(`  ${pkg.name}@${pkg.version}`);
      }
      lines.push(`  ... and ${discovery.withoutContracts - 20} more`);
      lines.push("");
    }

    return lines.join("\n");
  }
}
