/**
 * Configuration File Loader
 *
 * Loads and validates .behavioralcontractsrc.json config file
 */

import * as fs from 'fs';
import * as path from 'path';
import { BehavioralContractsConfig, IgnoreRule } from './types.js';

const CONFIG_FILENAME = '.behavioralcontractsrc.json';

/**
 * Load behavioral contracts configuration from project root
 *
 * @param projectRoot - Absolute path to project root
 * @returns Configuration object, or empty config if file doesn't exist
 */
export async function loadConfig(
  projectRoot: string
): Promise<BehavioralContractsConfig> {
  const configPath = path.join(projectRoot, CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    return { ignore: [] };
  }

  try {
    const content = await fs.promises.readFile(configPath, 'utf-8');
    const config: BehavioralContractsConfig = JSON.parse(content);

    // Validate config structure
    validateConfig(config);

    return config;
  } catch (error) {
    throw new Error(
      `Failed to load ${CONFIG_FILENAME}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Load configuration synchronously
 *
 * @param projectRoot - Absolute path to project root
 * @returns Configuration object
 */
export function loadConfigSync(
  projectRoot: string
): BehavioralContractsConfig {
  const configPath = path.join(projectRoot, CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    return { ignore: [] };
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config: BehavioralContractsConfig = JSON.parse(content);

    // Validate config structure
    validateConfig(config);

    return config;
  } catch (error) {
    throw new Error(
      `Failed to load ${CONFIG_FILENAME}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Validate configuration structure
 *
 * @param config - Configuration to validate
 * @throws Error if configuration is invalid
 */
function validateConfig(config: BehavioralContractsConfig): void {
  if (typeof config !== 'object' || config === null) {
    throw new Error('Configuration must be an object');
  }

  if (config.ignore && !Array.isArray(config.ignore)) {
    throw new Error('"ignore" must be an array');
  }

  if (config.ignore) {
    config.ignore.forEach((rule: IgnoreRule, index: number) => {
      validateIgnoreRule(rule, index);
    });
  }
}

/**
 * Validate a single ignore rule
 *
 * @param rule - Ignore rule to validate
 * @param index - Index in ignore array (for error messages)
 * @throws Error if rule is invalid
 */
function validateIgnoreRule(rule: IgnoreRule, index: number): void {
  if (typeof rule !== 'object' || rule === null) {
    throw new Error(`ignore[${index}]: Rule must be an object`);
  }

  // Require at least one matching criterion
  if (!rule.file && !rule.package && !rule.postconditionId) {
    throw new Error(
      `ignore[${index}]: Rule must specify at least one of: file, package, postconditionId`
    );
  }

  // Require reason
  if (!rule.reason || typeof rule.reason !== 'string') {
    throw new Error(`ignore[${index}]: Rule must have a "reason" field`);
  }

  if (rule.reason.trim().length < 10) {
    throw new Error(
      `ignore[${index}]: Reason must be at least 10 characters. Provide meaningful explanation.`
    );
  }

  // Validate file pattern if present
  if (rule.file && typeof rule.file !== 'string') {
    throw new Error(`ignore[${index}]: "file" must be a string`);
  }

  // Validate package if present
  if (rule.package && typeof rule.package !== 'string') {
    throw new Error(`ignore[${index}]: "package" must be a string`);
  }

  // Validate postconditionId if present
  if (rule.postconditionId && typeof rule.postconditionId !== 'string') {
    throw new Error(`ignore[${index}]: "postconditionId" must be a string`);
  }
}

/**
 * Check if an ignore rule matches a specific violation
 *
 * @param rule - Ignore rule from config
 * @param file - File path of violation (relative to project root)
 * @param packageName - Package name from violation
 * @param postconditionId - Postcondition ID from violation
 * @returns True if rule matches violation
 */
export function ruleMatches(
  rule: IgnoreRule,
  file: string,
  packageName: string,
  postconditionId: string
): boolean {
  // Check file pattern (glob match)
  if (rule.file) {
    const fileMatches = matchGlob(rule.file, file);
    if (!fileMatches) {
      return false;
    }
  }

  // Check package name
  if (rule.package) {
    const packageMatches = rule.package === '*' || rule.package === packageName;
    if (!packageMatches) {
      return false;
    }
  }

  // Check postcondition ID
  if (rule.postconditionId) {
    const postconditionMatches =
      rule.postconditionId === '*' || rule.postconditionId === postconditionId;
    if (!postconditionMatches) {
      return false;
    }
  }

  // All specified criteria match
  return true;
}

/**
 * Simple glob pattern matching
 *
 * Supports:
 * - * (any characters except /)
 * - ** (any characters including /)
 * - ? (single character)
 *
 * @param pattern - Glob pattern
 * @param text - Text to match against
 * @returns True if pattern matches text
 */
function matchGlob(pattern: string, text: string): boolean {
  // Convert glob pattern to regex
  let regexPattern = pattern
    // Escape regex special characters (except * and ?)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // Replace ** with placeholder
    .replace(/\*\*/g, '___DOUBLE_STAR___')
    // Replace * with regex (match anything except /)
    .replace(/\*/g, '[^/]*')
    // Replace ** placeholder with regex (match anything including /)
    .replace(/___DOUBLE_STAR___/g, '.*')
    // Replace ? with regex (match single character)
    .replace(/\?/g, '.');

  // Add anchors
  regexPattern = `^${regexPattern}$`;

  const regex = new RegExp(regexPattern);
  return regex.test(text);
}

/**
 * Find all matching rules for a violation
 *
 * @param config - Configuration object
 * @param file - File path of violation
 * @param packageName - Package name from violation
 * @param postconditionId - Postcondition ID from violation
 * @returns Array of matching rules
 */
export function findMatchingRules(
  config: BehavioralContractsConfig,
  file: string,
  packageName: string,
  postconditionId: string
): IgnoreRule[] {
  if (!config.ignore) {
    return [];
  }

  return config.ignore.filter((rule: IgnoreRule) =>
    ruleMatches(rule, file, packageName, postconditionId)
  );
}

/**
 * Create a default configuration file
 *
 * @param projectRoot - Project root directory
 */
export async function createDefaultConfig(projectRoot: string): Promise<void> {
  const configPath = path.join(projectRoot, CONFIG_FILENAME);

  if (fs.existsSync(configPath)) {
    throw new Error(`${CONFIG_FILENAME} already exists`);
  }

  const defaultConfig: BehavioralContractsConfig = {
    ignore: [
      {
        file: 'src/test/**',
        reason: 'Test files intentionally trigger errors'
      },
      {
        file: '**/*.test.ts',
        reason: 'Test files intentionally trigger errors'
      },
      {
        file: '**/*.spec.ts',
        reason: 'Test files intentionally trigger errors'
      }
    ]
  };

  await fs.promises.writeFile(
    configPath,
    JSON.stringify(defaultConfig, null, 2),
    'utf-8'
  );
}
