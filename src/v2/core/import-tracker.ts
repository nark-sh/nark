/**
 * Import Tracker
 *
 * Extracts and tracks import statements from TypeScript source files.
 * Builds a map of imported symbols to their package information.
 */

import * as ts from 'typescript';
import { ImportInfo } from '../types/index.js';

/**
 * Import Tracker
 *
 * Responsible for extracting import information from source files.
 */
export class ImportTracker {
  private typeChecker: ts.TypeChecker;
  private knownPackages: Set<string>;

  constructor(typeChecker: ts.TypeChecker, knownPackages?: Set<string>) {
    this.typeChecker = typeChecker;
    this.knownPackages = knownPackages ?? new Set();
  }

  /**
   * Extract all imports from a source file
   *
   * @param sourceFile - The source file to analyze
   * @returns Map of imported names to import info
   */
  public extractImports(sourceFile: ts.SourceFile): Map<string, ImportInfo> {
    const importMap = new Map<string, ImportInfo>();

    // Visit all import declarations
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isImportDeclaration(node)) {
        this.processImportDeclaration(node, importMap);
      }
    });

    return importMap;
  }

  /**
   * Process a single import declaration
   */
  private processImportDeclaration(
    node: ts.ImportDeclaration,
    importMap: Map<string, ImportInfo>
  ): void {
    // Get module specifier (package name)
    const moduleSpecifier = node.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpecifier)) {
      return;
    }

    const rawPath = moduleSpecifier.text;
    const packageName = this.normalizePackageName(rawPath);

    // Handle different import kinds
    const clause = node.importClause;
    if (!clause) {
      // Side-effect import: import 'package'
      importMap.set(packageName, {
        packageName,
        importedName: packageName,
        kind: 'side-effect',
        declaration: node,
      });
      return;
    }

    // Default import: import foo from 'package'
    if (clause.name) {
      const importedName = clause.name.text;
      importMap.set(importedName, {
        packageName,
        importedName,
        kind: 'default',
        declaration: node,
      });
    }

    // Named bindings
    if (clause.namedBindings) {
      this.processNamedBindings(clause.namedBindings, packageName, node, importMap);
    }
  }

  /**
   * Process named bindings (named imports or namespace imports)
   */
  private processNamedBindings(
    bindings: ts.NamedImportBindings,
    packageName: string,
    declaration: ts.ImportDeclaration,
    importMap: Map<string, ImportInfo>
  ): void {
    // Namespace import: import * as foo from 'package'
    if (ts.isNamespaceImport(bindings)) {
      const importedName = bindings.name.text;
      importMap.set(importedName, {
        packageName,
        importedName,
        kind: 'namespace',
        declaration,
      });
      return;
    }

    // Named imports: import { foo, bar as baz } from 'package'
    if (ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const importedName = element.name.text;
        const originalName = element.propertyName?.text || importedName;

        importMap.set(importedName, {
          packageName,
          importedName,
          kind: 'named',
          originalName: originalName !== importedName ? originalName : undefined,
          declaration,
        });
      }
    }
  }

  /**
   * Trace a symbol back to its import
   *
   * Given a symbol, find which package it was imported from.
   * Returns null if the symbol is not from an import.
   */
  public traceToImport(symbol: ts.Symbol, importMap: Map<string, ImportInfo>): ImportInfo | null {
    // Check if symbol name is in import map
    const importInfo = importMap.get(symbol.name);
    if (importInfo) {
      return importInfo;
    }

    // Try to trace through declarations
    const declarations = symbol.getDeclarations();
    if (!declarations || declarations.length === 0) {
      return null;
    }

    for (const declaration of declarations) {
      // Check if declaration is from an import
      const sourceFile = declaration.getSourceFile();
      if (sourceFile.isDeclarationFile) {
        // This is from a .d.ts file - try to extract package name
        const fileName = sourceFile.fileName;
        const packageName = this.extractPackageNameFromPath(fileName);
        if (packageName) {
          return {
            packageName,
            importedName: symbol.name,
            kind: 'named',
            declaration: declaration as any, // Not a real ImportDeclaration, but we need to store something
          };
        }
      }
    }

    return null;
  }

  /**
   * Normalize a raw import path to the contract package name.
   *
   * Handles subpath exports: "@clerk/nextjs/server" → "@clerk/nextjs"
   * when "@clerk/nextjs" is a known contract package but "@clerk/nextjs/server" is not.
   *
   * Mirrors V1 analyzer's resolvePackageFromImports() normalization logic.
   */
  private normalizePackageName(rawPath: string): string {
    if (this.knownPackages.size === 0 || this.knownPackages.has(rawPath)) {
      return rawPath;
    }

    // Scoped package subpath: "@clerk/nextjs/server" or "@mcp/sdk/client/index.js" → try parent paths
    // Strips one subpath segment at a time until a known package is found or the base is reached.
    if (rawPath.startsWith('@')) {
      const firstSlash = rawPath.indexOf('/');
      let lastSlash = rawPath.lastIndexOf('/');
      while (lastSlash > firstSlash) {
        const parent = rawPath.substring(0, lastSlash);
        if (this.knownPackages.has(parent)) {
          return parent;
        }
        lastSlash = parent.lastIndexOf('/');
      }
      return rawPath;
    }

    // Non-scoped subpath: "next-auth/jwt" → try "next-auth"
    const slashIdx = rawPath.indexOf('/');
    if (slashIdx > 0) {
      const parent = rawPath.substring(0, slashIdx);
      if (this.knownPackages.has(parent)) {
        return parent;
      }
    }

    return rawPath;
  }

  /**
   * Extract package name from a file path
   *
   * Examples:
   *   /path/to/node_modules/axios/index.d.ts -> axios
   *   /path/to/node_modules/@prisma/client/index.d.ts -> @prisma/client
   */
  private extractPackageNameFromPath(filePath: string): string | null {
    const nodeModulesIndex = filePath.lastIndexOf('node_modules/');
    if (nodeModulesIndex === -1) {
      return null;
    }

    const afterNodeModules = filePath.substring(nodeModulesIndex + 'node_modules/'.length);
    const parts = afterNodeModules.split('/');

    // Handle scoped packages (@org/package)
    if (parts[0].startsWith('@')) {
      return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
    }

    // Handle regular packages
    return parts[0];
  }

  /**
   * Get package name for a node
   *
   * Attempts to determine which package a node belongs to.
   * Returns null if cannot be determined.
   */
  public getPackageForNode(node: ts.Node, importMap: Map<string, ImportInfo>): string | null {
    // Try to get symbol for node
    const symbol = this.typeChecker.getSymbolAtLocation(node);
    if (!symbol) {
      return null;
    }

    // Trace symbol to import
    const importInfo = this.traceToImport(symbol, importMap);
    return importInfo?.packageName || null;
  }
}
