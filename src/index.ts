/**
 * Public entry point for the `wardroom` package.
 *
 * The surface-agnostic operation set (SDD §5.1) and the CLI that binds to it
 * (SDD §5.2) arrive in later tours. This module re-exports what exists.
 */

export { ConfigError, loadConfig } from './config/load.js';
export { type WardroomPaths, ensureRunDir, wardroomPaths } from './config/paths.js';
export {
  AUTH_MODES,
  type AuthMode,
  PROJECT_LEVELS,
  type ProjectConfig,
  type ProjectLevel,
  type ProjectStack,
  type UsageBudget,
} from './config/schema.js';
export {
  RUNTIME_IGNORE_ENTRY,
  applyTrackingPolicy,
  runtimeIgnoreEntries,
} from './config/tracking.js';
