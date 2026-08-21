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
  TREE_CHANGE_TYPES,
  type TreeChange,
  type TreeChangeType,
  currentBranch,
  fileAtHead,
  headCommit,
  headSubject,
  isPathTracked,
  isWorkingTreeDirty,
  workingTreeChanges,
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
export {
  IllegalTransitionError,
  type TourEvent,
  type TourEventType,
  type Transition,
  type TransitionRules,
  advance,
  transition,
} from './state/machine.js';
export { atomicWriteFile } from './fs/atomic.js';
export { GATE_ID_PATTERN, mintGateId } from './gates/id.js';
export { asPreview, previewProblem } from './gates/preview.js';
export {
  GATE_CLASSES,
  GATE_STATUSES,
  type DeploymentPreview,
  type DestructivePreview,
  type DirtyTreePreview,
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
export { dirtyTreeGateRequest } from './gates/dirty-tree.js';
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
  type CommitOccasionKind,
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
  versionCarryingDocuments,
} from './documents/set.js';
export { isFilledString, isJsonObject } from './json/guards.js';
export {
  JOB_STATUSES,
  NO_OPEN_TOUR_STATEMENT,
  type JobStatus,
  type OpenTourBlock,
  type OpenTourRead,
  type TourJob,
  clearOpenTour,
  parseOpenTourBlock,
  readOpenTour,
  renderOpenTourBlock,
  updateJobStatus,
  writeOpenTour,
} from './progress/open-tour.js';
export {
  ROLES,
  type RoleDefinition,
  type RoleName,
  type RolePermissions,
} from './roles/schema.js';
export { roleDefinition } from './roles/definition.js';
export {
  FILE_RULE_TOOL,
  RUNTIME_DENY_RULE,
  anchoredPath,
  fileRule,
  rolePermissions,
} from './roles/permissions.js';
export {
  BANNED_PERMISSION_MODES,
  ROLE_PERMISSION_MODE,
  RoleSessionRefusedError,
  type BuildRoleSessionInput,
  type RoleSession,
  buildRoleSession,
} from './roles/session.js';
export { GATE_REACHING_TOOLS, gateClassesReachableBy } from './gates/classify.js';
export {
  PermissionRuleRefusedError,
  checkAllowRules,
  documentDenyRules,
} from './roles/permissions.js';
export { tourLogDirectory } from './documents/set.js';
export {
  type ClassifiedDetail,
  type ToolCallClassification,
  classifyToolCall,
} from './gates/classify.js';
export {
  type GateInterceptor,
  type GateInterceptorInput,
  createGateInterceptor,
  decisionOutcome,
} from './roles/intercept.js';
export {
  type Notifier,
  type ParkedNotification,
  deliver,
  parkedNotification,
} from './gates/notify.js';
export { type InterceptionOutcome, isErrorOutcome, parkingDeadline } from './roles/intercept.js';
export { formatDuration } from './config/duration.js';
export { GATE_BEARING_STATES } from './state/marker.js';
export { RUN_DIR_NAME, WARDROOM_DIR_NAME } from './config/paths.js';
export { commandSegments, isCommitCall } from './gates/classify.js';
export { type PermissionSupplierInput, createPermissionSupplier } from './roles/supplier.js';
export { stagedPaths } from './state/git.js';
export {
  type VerificationFailure,
  type VerificationResult,
  type VerifyRunner,
  runVerification,
} from './verify/run.js';
export type { CommitGateOptions } from './commit/gate.js';
