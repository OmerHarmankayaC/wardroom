/**
 * Public entry point for the `wardroom` package.
 *
 * The surface-agnostic operation set (SDD §5.1) and the CLI that binds to it
 * (SDD §5.2) arrive in later tours. This module re-exports what exists.
 */

export {
  DURATION_GRAMMAR,
  DURATION_UNITS,
  type Duration,
  type DurationUnit,
  parseDuration,
} from './config/duration.js';
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
export {
  NotARepositoryError,
  currentBranch,
  fileAtHead,
  headCommit,
  headSubject,
  isPathTracked,
  isWorkingTreeDirty,
} from './state/git.js';
export {
  TOUR_STATES,
  type MarkerRead,
  type StateMarker,
  type TourState,
  readMarker,
  writeMarker,
} from './state/marker.js';
export { type NextAction, type ResumeResult, resume } from './state/resume.js';
export { atomicWriteFile } from './fs/atomic.js';
export { GATE_ID_PATTERN, mintGateId } from './gates/id.js';
export { asPreview, previewProblem } from './gates/preview.js';
export {
  GATE_CLASSES,
  GATE_STATUSES,
  type DeploymentPreview,
  type DestructivePreview,
  type GateClass,
  type GateEntry,
  type GatePreview,
  type GateStatus,
  type PushPreview,
  type ScopeChangePreview,
  type SecretsPreview,
  type TourBudgetPreview,
  isResolved,
} from './gates/schema.js';
export {
  GateSchemaError,
  entryPath,
  listEntryIds,
  readEntry,
  writeEntry,
} from './gates/store.js';
export {
  AUDIT_EVENTS,
  type AuditEvent,
  type AuditLine,
  appendAuditLine,
  readAuditLines,
  recordThenAct,
} from './gates/audit.js';
export {
  GateAlreadyDecidedError,
  GateNotFoundError,
  GateRefusedError,
  type EnqueueRequest,
  type QueueOptions,
  decide,
  enqueue,
  list,
  park,
  show,
} from './gates/queue.js';
export {
  COMMIT_OCCASIONS,
  WIP_SUBJECT_PREFIX,
  type CommitOccasion,
  type CommitRequest,
  type CommitVerdict,
  type JobBoundaryOccasion,
  type OtherOccasion,
  type WipStopOccasion,
  checkCommit,
} from './commit/gate.js';
export {
  type BaselineRecord,
  type DocBaseline,
  buildDocBaseline,
  readDocBaseline,
  recordClosureBaseline,
  writeDocBaseline,
} from './documents/baseline.js';
export {
  canonicalDocuments,
  documentHash,
  documentVersion,
  hasChangeLogRow,
} from './documents/set.js';
