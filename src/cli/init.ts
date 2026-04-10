/**
 * CLI Command: init
 * Bootstraps a project for behavioral contract scanning.
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import chalk from 'chalk';

/**
 * Create the init subcommand
 */
export function createInitCommand(): Command {
  const init = new Command('init');

  init
    .description('Initialize behavioral contract scanning for this project')
    .action(async () => {
      const cwd = process.cwd();

      // Step 1 — Check for existing tsconfig.scan.json
      const tsconfigScanPath = path.join(cwd, 'tsconfig.scan.json');
      if (fs.existsSync(tsconfigScanPath)) {
        const answer = await prompt('tsconfig.scan.json already exists. Overwrite? (y/N) ');
        if (answer.trim().toLowerCase() !== 'y') {
          console.log('Aborted.');
          return;
        }
      }

      // Step 2 — Build the synthetic tsconfig
      const syntheticConfig: Record<string, unknown> = {
        include: ['**/*.ts', '**/*.tsx'],
        exclude: [
          'node_modules',
          'dist',
          'build',
          'out',
          '.next',
          '.nuxt',
          '.git',
          'coverage',
          '.turbo',
          '.vercel',
          '**/__tests__/**',
          '**/*.test.ts',
          '**/*.test.tsx',
          '**/*.spec.ts',
          '**/*.spec.tsx',
          '**/testing/**',
          '**/test/**',
          '**/tests/**',
          '**/e2e/**',
          '**/cypress/**',
          '**/playwright/**',
          '**/__mocks__/**',
          '**/__fixtures__/**',
        ],
        compilerOptions: {
          target: 'ES2020',
          module: 'commonjs',
          noLib: true,
          strict: false,
          skipLibCheck: true,
          esModuleInterop: true,
          allowJs: true,
          resolveJsonModule: true,
          moduleResolution: 'node',
          noEmit: true,
        },
      };

      // Step 3 — Merge paths/baseUrl from existing tsconfig.json
      const tsconfigPath = path.join(cwd, 'tsconfig.json');
      if (fs.existsSync(tsconfigPath)) {
        try {
          const raw = fs.readFileSync(tsconfigPath, 'utf-8');
          // Strip JS-style comments before parsing
          const stripped = raw
            .replace(/\/\/[^\n]*/g, '')
            .replace(/\/\*[\s\S]*?\*\//g, '');
          const parsed = JSON.parse(stripped);
          const parentCompilerOptions = parsed?.compilerOptions ?? {};

          const compilerOptions = syntheticConfig.compilerOptions as Record<string, unknown>;
          if (parentCompilerOptions.paths !== undefined) {
            compilerOptions.paths = parentCompilerOptions.paths;
          }
          if (parentCompilerOptions.baseUrl !== undefined) {
            compilerOptions.baseUrl = parentCompilerOptions.baseUrl;
          }
        } catch {
          console.log(chalk.dim('Warning: Could not parse tsconfig.json — skipping paths/baseUrl merge.'));
        }
      }

      // Step 4 — Write tsconfig.scan.json
      fs.writeFileSync(tsconfigScanPath, JSON.stringify(syntheticConfig, null, 2) + '\n', 'utf-8');

      // Step 5 — Update .bc-scan
      const bcScanPath = path.join(cwd, '.bc-scan');
      let bcScan: Record<string, unknown> = {};
      if (fs.existsSync(bcScanPath)) {
        try {
          const raw = fs.readFileSync(bcScanPath, 'utf-8');
          bcScan = JSON.parse(raw);
        } catch {
          // If unreadable, start fresh
          bcScan = {};
        }
      }
      bcScan.tsconfig = 'tsconfig.scan.json';
      fs.writeFileSync(bcScanPath, JSON.stringify(bcScan, null, 2) + '\n', 'utf-8');

      // Step 6 — Print success summary
      console.log(chalk.green('✓') + ' Created tsconfig.scan.json');
      console.log(chalk.green('✓') + ' Updated .bc-scan \u2192 { "tsconfig": "tsconfig.scan.json" }');
      console.log('');
      console.log(
        chalk.dim(
          'Next: review tsconfig.scan.json, add any project-specific exclusions, then commit both files.'
        )
      );
    });

  return init;
}

/**
 * Prompt the user for input via stdin and return the answer.
 */
function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
