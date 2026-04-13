/**
 * CLI Command: show
 * Introspection sub-subcommands: supported-packages, version, deployment
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import chalk from 'chalk';
import { loadCorpus } from '../corpus-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Finds the default corpus path by trying:
 * 1. Published npm package (nark-corpus)
 * 2. Local development paths (for contributors)
 */
function findDefaultCorpusPath(): string {
  // Try 1: Use published npm package (production use)
  try {
    const _require = createRequire(import.meta.url);
    const corpusModule = _require('nark-corpus');
    const corpusRoot = path.dirname(corpusModule.getCorpusPath());

    if (fs.existsSync(path.join(corpusRoot, 'packages'))) {
      return corpusRoot;
    }
  } catch {
    // Package not installed - fall through to local paths
  }

  // Try 2: Look for local corpus repo (development use)
  const possiblePaths = [
    path.join(process.cwd(), '../nark-corpus'),
    path.join(process.cwd(), '../corpus'),
    path.join(process.cwd(), '../../nark-corpus'),
    path.join(process.cwd(), '../../corpus'),
    path.join(__dirname, '../../nark-corpus'),
    path.join(__dirname, '../../corpus'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(path.join(p, 'packages'))) {
      return p;
    }
  }

  // Fallback: assume sibling nark-corpus repo
  return path.join(process.cwd(), '../nark-corpus');
}

/**
 * Read nark version from package.json
 * show.ts is at dist/cli/show.js so ../../package.json = package root
 */
function readNarkVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '../../package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Create the supported-packages sub-subcommand
 */
function createSupportedPackagesCommand(): Command {
  const cmd = new Command('supported-packages');

  cmd
    .description('List all contracts in the corpus with name, version, semver range, and status')
    .option('--json', 'Output as JSON array instead of table')
    .option('--corpus <path>', 'Path to corpus directory', findDefaultCorpusPath())
    .action(async (options) => {
      try {
        if (!fs.existsSync(options.corpus)) {
          console.error(chalk.red(`Error: Corpus directory not found at ${options.corpus}`));
          console.error(chalk.yellow('Tip: Use --corpus <path> to specify corpus location'));
          process.exit(2);
        }

        const result = await loadCorpus(options.corpus, {
          includeDrafts: true,
          includeDeprecated: true,
          includeInDevelopment: true,
        });

        if (result.errors.length > 0) {
          console.error(chalk.red('Error loading corpus:'));
          result.errors.forEach(e => console.error(chalk.red(`  ${e}`)));
          process.exit(2);
        }

        // Build rows sorted alphabetically
        const rows = Array.from(result.contracts.entries())
          .map(([, contract]) => ({
            package: contract.package,
            contractVersion: contract.contract_version,
            semver: contract.semver,
            status: contract.status || 'production',
          }))
          .sort((a, b) => a.package.localeCompare(b.package));

        if (options.json) {
          console.log(JSON.stringify(rows, null, 2));
          process.exit(0);
        }

        // Compute column widths
        const headers = { package: 'Package', contractVersion: 'Version', semver: 'Semver', status: 'Status' };
        const colWidths = {
          package: Math.max(headers.package.length, ...rows.map(r => r.package.length)),
          contractVersion: Math.max(headers.contractVersion.length, ...rows.map(r => r.contractVersion.length)),
          semver: Math.max(headers.semver.length, ...rows.map(r => r.semver.length)),
          status: Math.max(headers.status.length, ...rows.map(r => r.status.length)),
        };

        const pad = (s: string, w: number) => s.padEnd(w);

        // Header
        const headerLine = [
          chalk.bold(pad(headers.package, colWidths.package)),
          chalk.bold(pad(headers.contractVersion, colWidths.contractVersion)),
          chalk.bold(pad(headers.semver, colWidths.semver)),
          chalk.bold(pad(headers.status, colWidths.status)),
        ].join('  ');
        const separator = '─'.repeat(
          colWidths.package + colWidths.contractVersion + colWidths.semver + colWidths.status + 6
        );

        console.log('');
        console.log(headerLine);
        console.log(chalk.dim(separator));

        for (const row of rows) {
          let statusColored: string;
          switch (row.status) {
            case 'production':
              statusColored = chalk.green(pad(row.status, colWidths.status));
              break;
            case 'draft':
            case 'in-development':
              statusColored = chalk.yellow(pad(row.status, colWidths.status));
              break;
            case 'deprecated':
              statusColored = chalk.dim(pad(row.status, colWidths.status));
              break;
            default:
              statusColored = pad(row.status, colWidths.status);
          }

          const line = [
            pad(row.package, colWidths.package),
            chalk.dim(pad(row.contractVersion, colWidths.contractVersion)),
            chalk.dim(pad(row.semver, colWidths.semver)),
            statusColored,
          ].join('  ');

          console.log(line);
        }

        console.log(chalk.dim(separator));
        console.log(chalk.dim(`\n${rows.length} contract${rows.length === 1 ? '' : 's'} total`));
        console.log('');
        process.exit(0);
      } catch (err) {
        console.error(chalk.red(`Internal error: ${err}`));
        process.exit(2);
      }
    });

  return cmd;
}

/**
 * Create the version sub-subcommand
 */
function createVersionSubcommand(): Command {
  const cmd = new Command('version');

  cmd
    .description('Show nark version, Node version, corpus path, and contract count')
    .option('--json', 'Output as JSON object')
    .action(async (options) => {
      try {
        const narkVersion = readNarkVersion();
        const nodeVersion = process.version;
        const corpusPath = findDefaultCorpusPath();

        let contractCount: number | string = 'unavailable';
        try {
          if (fs.existsSync(corpusPath)) {
            const result = await loadCorpus(corpusPath, {
              includeDrafts: true,
              includeDeprecated: true,
              includeInDevelopment: true,
            });
            contractCount = result.contracts.size;
          }
        } catch {
          // Leave as 'unavailable'
        }

        if (options.json) {
          console.log(JSON.stringify({ narkVersion, nodeVersion, corpusPath, contractCount }, null, 2));
          process.exit(0);
        }

        console.log('');
        console.log(`${chalk.bold('nark')}          ${chalk.green(narkVersion)}`);
        console.log(`${chalk.dim('node')}          ${chalk.dim(nodeVersion)}`);
        console.log(`${chalk.dim('corpus')}        ${chalk.dim(corpusPath)}`);
        console.log(`${chalk.dim('contracts')}     ${chalk.dim(String(contractCount))}`);
        console.log('');
        process.exit(0);
      } catch (err) {
        console.error(chalk.red(`Internal error: ${err}`));
        process.exit(2);
      }
    });

  return cmd;
}

/**
 * Create the deployment sub-subcommand
 */
function createDeploymentSubcommand(): Command {
  const cmd = new Command('deployment');

  cmd
    .description('Show login status from ~/.nark/credentials')
    .option('--json', 'Output as JSON object')
    .action((options) => {
      try {
        const credentialsPath = path.join(os.homedir(), '.nark', 'credentials');

        let loggedIn = false;
        let orgName: string | undefined;
        let email: string | undefined;
        let plan: string | undefined;

        if (fs.existsSync(credentialsPath)) {
          try {
            const raw = fs.readFileSync(credentialsPath, 'utf-8');
            const creds = JSON.parse(raw);
            if (creds && creds.token) {
              loggedIn = true;
              orgName = creds.orgName;
              email = creds.email;
              plan = creds.plan;
            }
          } catch {
            // JSON parse error or missing token — treat as not logged in
          }
        }

        if (options.json) {
          if (loggedIn) {
            console.log(JSON.stringify({ loggedIn: true, orgName, email, plan }, null, 2));
          } else {
            console.log(JSON.stringify({ loggedIn: false }, null, 2));
          }
          process.exit(0);
        }

        console.log('');
        if (loggedIn) {
          console.log(chalk.green('Logged in to nark.sh'));
          if (orgName) console.log(`  ${chalk.dim('org')}     ${orgName}`);
          if (email) console.log(`  ${chalk.dim('email')}   ${email}`);
          if (plan) console.log(`  ${chalk.dim('plan')}    ${plan}`);
        } else {
          console.log(chalk.yellow('Not logged in. Run `nark login` to connect to nark.sh'));
        }
        console.log('');
        process.exit(0);
      } catch (err) {
        console.error(chalk.red(`Internal error: ${err}`));
        process.exit(2);
      }
    });

  return cmd;
}

/**
 * Create the show command with three sub-subcommands
 */
export function createShowCommand(): Command {
  const show = new Command('show');

  show.description('Introspect nark state: supported packages, version info, deployment status');

  show.addCommand(createSupportedPackagesCommand());
  show.addCommand(createVersionSubcommand());
  show.addCommand(createDeploymentSubcommand());

  return show;
}
