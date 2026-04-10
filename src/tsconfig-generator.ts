/**
 * Auto-generates minimal tsconfig.json for analysis
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

interface TsConfigOptions {
  projectDir: string;
  includeTests?: boolean;
}

/**
 * Detects project structure and generates appropriate include patterns
 */
function detectIncludePatterns(projectDir: string): string[] {
  const patterns: string[] = [];

  // Check for common monorepo structures
  const possibleDirs = ['packages', 'apps', 'libs', 'src'];

  for (const dir of possibleDirs) {
    const fullPath = path.join(projectDir, dir);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      patterns.push(`${dir}/**/*.ts`);
      patterns.push(`${dir}/**/*.tsx`);
    }
  }

  // If no standard dirs found, include all TS files
  if (patterns.length === 0) {
    patterns.push('**/*.ts', '**/*.tsx');
  }

  return patterns;
}

/**
 * Generates a minimal tsconfig.json suitable for analysis
 */
export function generateMinimalTsconfig(tsconfigPath: string, options?: TsConfigOptions): void {
  const projectDir = options?.projectDir || path.dirname(tsconfigPath);
  const includeTests = options?.includeTests || false;

  // Detect include patterns based on project structure
  const includePatterns = detectIncludePatterns(projectDir);

  // Build exclude patterns
  const excludePatterns = [
    'node_modules',
    'dist',
    'build',
    'out',
    '**/node_modules',
    '**/dist',
    '**/build',
    '**/out',
    '**/.next',
    '**/coverage',
  ];

  // Exclude test files unless explicitly requested
  if (!includeTests) {
    excludePatterns.push(
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
      '**/__tests__',
      '**/__mocks__',
    );
  }

  // Check if there's a base config to extend
  const possibleBaseConfigs = [
    '_tsconfig.base.json',
    'tsconfig.base.json',
    'tsconfig.settings.json',
  ];

  let extendsPath: string | undefined;
  for (const baseConfig of possibleBaseConfigs) {
    const fullPath = path.join(projectDir, baseConfig);
    if (fs.existsSync(fullPath)) {
      extendsPath = `./${baseConfig}`;
      break;
    }
  }

  // Build the config object
  const config: any = {
    compilerOptions: {
      target: 'ES2020',
      module: 'commonjs',
      lib: ['ES2020'],
      moduleResolution: 'node',
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      allowSyntheticDefaultImports: true,
      strict: false, // Don't enforce strict mode for analysis
      noEmit: true, // We're only analyzing, not compiling
    },
    include: includePatterns,
    exclude: excludePatterns,
  };

  // Add extends if base config exists
  if (extendsPath) {
    config.extends = extendsPath;
  }

  // Write the config file
  const configJson = JSON.stringify(config, null, 2);
  fs.writeFileSync(tsconfigPath, configJson, 'utf-8');

  console.log(chalk.dim(`  Generated tsconfig.json with patterns:`));
  console.log(chalk.dim(`    include: ${includePatterns.join(', ')}`));
  if (extendsPath) {
    console.log(chalk.dim(`    extends: ${extendsPath}`));
  }
}

/**
 * Ensures tsconfig.json exists, generating if necessary
 */
export function ensureTsconfig(tsconfigPath: string): void {
  if (!fs.existsSync(tsconfigPath)) {
    const projectDir = path.dirname(tsconfigPath);
    console.log(chalk.yellow(`  tsconfig.json not found, generating minimal config...`));
    generateMinimalTsconfig(tsconfigPath, { projectDir });
  }
}
