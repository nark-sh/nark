/**
 * Wrapper-shell Configuration Loader
 *
 * Loads `.nark/suppress.yaml` for per-project callback-wrapper extensions.
 *
 * Schema:
 *   callback_wrappers:
 *     - MyCustomTryCatchWrapper
 *     - AnotherSafeAsyncHelper
 *
 * Project-level extension hook for the §8 callback-wrapper-shell suppression
 * heuristic. Built-in wrapper pattern list lives in contract-matcher.ts; this
 * file lets project owners append additional wrapper names without forking
 * the scanner.
 *
 * Evidence: concern-20260515-section8-promisecall-promisestate-wrapper-shells
 *           suggested_resolution requested Level-1 project-level extension as
 *           free side-product of the Level-2 built-in heuristic.
 */

import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

const WRAPPER_CONFIG_FILENAME = ".nark/suppress.yaml";

export interface WrapperConfig {
  /**
   * Extra wrapper-name identifiers to treat as callback-wrapper shells.
   * Merged with the built-in pattern list at suppression time.
   */
  callback_wrappers?: string[];
}

/**
 * Synchronously load `.nark/suppress.yaml` from the project root.
 * Returns an empty config if the file is missing or malformed.
 *
 * Defensive: malformed YAML is treated as "no extra wrappers" rather than a
 * hard failure, because a typo in a per-project extension should not break
 * the scanner for that project.
 */
export function loadWrapperConfigSync(projectRoot: string): WrapperConfig {
  const configPath = path.join(projectRoot, WRAPPER_CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = parseYaml(content);

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const result: WrapperConfig = {};

    if (Array.isArray(parsed.callback_wrappers)) {
      result.callback_wrappers = parsed.callback_wrappers.filter(
        (v: unknown): v is string => typeof v === "string" && v.length > 0,
      );
    }

    return result;
  } catch {
    // Malformed YAML — silently fall back to no extra wrappers.
    return {};
  }
}
