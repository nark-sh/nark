/**
 * Corpus Loader - loads and validates behavioral contract files
 */

import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import * as YAML from 'yaml';
import AjvModule from 'ajv';
import type { PackageContract, CorpusLoadResult } from './types.js';

// Handle ESM/CJS interop for Ajv
const Ajv = (AjvModule as any).default || AjvModule;

export interface LoadCorpusOptions {
  includeDrafts?: boolean;
  includeDeprecated?: boolean;
  includeInDevelopment?: boolean;
}

/**
 * Loads all behavioral contracts from the corpus directory
 */
export async function loadCorpus(
  corpusPath: string,
  options: LoadCorpusOptions = {}
): Promise<CorpusLoadResult> {
  const contracts = new Map<string, PackageContract>();
  const errors: string[] = [];
  const skipped: { package: string; status: string; reason: string }[] = [];
  const contractFileMap = new Map<string, string[]>();

  // Find all contract.yaml files
  const contractFiles = await glob('**/contract.yaml', {
    cwd: path.join(corpusPath, 'packages'),
    absolute: true,
  });

  if (contractFiles.length === 0) {
    errors.push(`No contract files found in ${corpusPath}/packages`);
    return { contracts, errors };
  }

  // Load JSON Schema for validation
  const schemaPath = path.join(corpusPath, 'schema', 'contract.schema.json');
  let schema: any;

  try {
    const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
    schema = JSON.parse(schemaContent);
  } catch (err) {
    errors.push(`Failed to load schema from ${schemaPath}: ${err}`);
    return { contracts, errors };
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  // Load and validate each contract
  for (const filePath of contractFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const contract = YAML.parse(content) as PackageContract;

      // Get contract status (default to 'production' if not specified)
      const status = contract.status || 'production';

      // Skip in-development contracts silently (to avoid errors during development)
      if (status === 'in-development' && !options.includeInDevelopment) {
        skipped.push({
          package: contract.package || path.basename(path.dirname(filePath)),
          status: 'in-development',
          reason: 'Contract is in development (use --include-drafts to include)'
        });
        continue;
      }

      // Skip draft contracts before validation when not including drafts
      // (avoids failing on draft contracts with schema issues)
      if (status === 'draft' && !options.includeDrafts) {
        skipped.push({
          package: contract.package || path.basename(path.dirname(filePath)),
          status: 'draft',
          reason: 'Draft contract excluded (use --include-drafts to include)'
        });
        continue;
      }

      // Validate against JSON Schema
      const valid = validate(contract);

      if (!valid) {
        // If it's in-development and validation fails, skip silently
        if (status === 'in-development') {
          skipped.push({
            package: contract.package || path.basename(path.dirname(filePath)),
            status: 'in-development',
            reason: 'Contract validation failed (in-development)'
          });
          continue;
        }

        const validationErrors = validate.errors
          ?.map((err: any) => `  ${err.instancePath} ${err.message}`)
          .join('\n');
        errors.push(`Invalid contract ${filePath}:\n${validationErrors}`);
        continue;
      }

      // Filter by status
      if (status === 'draft' && !options.includeDrafts) {
        skipped.push({
          package: contract.package,
          status: 'draft',
          reason: 'Draft contract excluded (use --include-drafts to include)'
        });
        continue;
      }

      if (status === 'deprecated' && !options.includeDeprecated) {
        skipped.push({
          package: contract.package,
          status: 'deprecated',
          reason: 'Deprecated contract excluded (use --include-deprecated to include)'
        });
        continue;
      }

      // Check for duplicate package names
      if (contracts.has(contract.package)) {
        errors.push(
          `Duplicate contract for package "${contract.package}" found at ${filePath}`
        );
        continue;
      }

      contracts.set(contract.package, contract);
      if (!contractFileMap.has(contract.package)) contractFileMap.set(contract.package, []);
      contractFileMap.get(contract.package)!.push(filePath);
    } catch (err) {
      errors.push(`Failed to load contract ${filePath}: ${err}`);
    }
  }

  return { contracts, errors, skipped, contractFiles: contractFileMap };
}

/**
 * Loads a single contract file (for testing)
 */
export function loadContractFile(filePath: string): PackageContract {
  const content = fs.readFileSync(filePath, 'utf-8');
  return YAML.parse(content) as PackageContract;
}

/**
 * Validates a contract object against the schema
 */
export function validateContract(
  contract: PackageContract,
  schemaPath: string
): { valid: boolean; errors: string[] } {
  const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
  const schema = JSON.parse(schemaContent);

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const valid = validate(contract);

  const errors = valid
    ? []
    : (validate.errors?.map((err: any) => `${err.instancePath} ${err.message}`) || []);

  return { valid, errors };
}

/**
 * Gets the list of packages that have contracts in the corpus
 */
export function getAvailablePackages(corpusPath: string): string[] {
  const packagesDir = path.join(corpusPath, 'packages');

  if (!fs.existsSync(packagesDir)) {
    return [];
  }

  return fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);
}

/**
 * Finds which packages from the corpus are actually used in a TypeScript project
 */
export function findUsedPackages(
  projectPackageJson: string,
  availableContracts: Map<string, PackageContract>
): string[] {
  try {
    const packageJson = JSON.parse(fs.readFileSync(projectPackageJson, 'utf-8'));
    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    return Array.from(availableContracts.keys()).filter(
      packageName => packageName in dependencies
    );
  } catch (err) {
    console.warn(`Could not read ${projectPackageJson}: ${err}`);
    return [];
  }
}
