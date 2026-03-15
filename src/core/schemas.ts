import { z } from "zod";

// ============================================================================
// SIGNALS - Observable context for decisions
// ============================================================================

export const RiskLevel = z.enum(["LOW", "MEDIUM", "HIGH"]);
export const Reversibility = z.enum(["EASY", "MEDIUM", "HARD"]);
export const ChangeFrequency = z.enum(["RARE", "OCCASIONAL", "FREQUENT"]);
export const Novelty = z.enum(["LOW", "MEDIUM", "HIGH"]);
export const Uncertainty = z.enum(["LOW", "MEDIUM", "HIGH"]);
export const ValidationLevel = z.enum(["BASIC", "STANDARD", "STRICT"]);
export const Confidence = z.enum(["LOW", "MEDIUM", "HIGH"]);

// NOTE: Affected surface is intentionally a free-form string to allow
// project-specific extensions via `config.yaml` (e.g., GIS_SPATIAL).
// Keep the canonical values documented here for policy checks / UI hints.
export const AffectedSurfaceCore = z.enum([
  "CORE_DOMAIN",
  "INTEGRATION",
  "DATA_MODEL",
  "INFRA_DEPLOY",
  "SECURITY_BOUNDARY",
  "UI_UX",
  "PERFORMANCE_CRITICAL",
]);

export const DiffScope = z.enum(["LOCAL", "MULTI_MODULE", "CROSS_CUTTING"]);
export const DependencyChange = z.enum(["NONE", "MINOR", "MAJOR"]);
export const Regressions = z.enum(["NONE", "MINOR", "MAJOR"]);
export const Regret = z.enum(["0", "1", "2", "3"]);
export const RegretInput = z.preprocess((value) => {
  // Accept 0..3 as numbers from loosely-typed callers, but store as strings.
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return value;
}, Regret);

export const ContextSignals = z.object({
  risk_level: RiskLevel.optional(),
  reversibility: Reversibility.optional(),
  change_frequency: ChangeFrequency.optional(),
  affected_surface: z.array(z.string()).optional(),
  novelty: Novelty.optional(),
  repo_scope: z.string().optional(), // Project-specific, e.g., "BACKEND_ONLY"
});

export const ExecutionSignals = z.object({
  diff_scope: DiffScope.optional(),
  uncertainty: Uncertainty.optional(),
  dependency_change: DependencyChange.optional(),
});

export const OutcomeSignals = z.object({
  regressions: Regressions.optional(),
  rework_within_14d: z.boolean().optional(),
  regret: Regret,
  notes: z.string().optional(),
});

export type ContextSignals = z.infer<typeof ContextSignals>;
export type ExecutionSignals = z.infer<typeof ExecutionSignals>;
export type OutcomeSignals = z.infer<typeof OutcomeSignals>;

// ============================================================================
// DECISIONS - The vocabulary for approach/posture
// ============================================================================

export const Approach = z.enum(["REUSE", "REFRAME", "BUILD", "HYBRID"]);
export const Posture = z.enum(["MINIMAL", "BALANCED", "ROBUST"]);

export const Decisions = z.object({
  approach: Approach,
  posture: Posture,
  validation_level: ValidationLevel,
  confidence: Confidence,
});

export type Decisions = z.infer<typeof Decisions>;

// ============================================================================
// PRESSURE EVENT - The primary learning artifact
// ============================================================================

export const PressureType = z.enum([
  "CHANGE",
  "IRREVERSIBILITY",
  "COGNITIVE",
  "COUPLING",
  "OPERATIONAL",
  "EXTERNAL",
]);

export const PressureEvent = z.object({
  id: z.string(), // PE-0001
  timestamp: z.string(), // ISO date
  case_id: z.string(),
  pressure_type: PressureType.optional(),
  context_tags: z.array(z.string()).optional(),
  expected: z.string(), // What we assumed
  actual: z.string(), // What happened
  adaptation: z.string(), // What we changed
  remember: z.string(), // One-liner for potential foundation
  outcome: z.string().optional(), // Filled later
  promoted_to_foundation: z.string().optional(), // Foundation ID if promoted
});

export type PressureEvent = z.infer<typeof PressureEvent>;

// ============================================================================
// CASE - Bounded unit of work
// ============================================================================

export const CaseStatus = z.enum(["ACTIVE", "COMPLETED", "ABANDONED"]);

export const Case = z.object({
  id: z.string(), // 0001-bootstrap-backend
  title: z.string(),
  goal: z.string().optional(),
  status: CaseStatus.default("ACTIVE"),
  created_at: z.string(),
  completed_at: z.string().optional(),
  context: z
    .object({
      repos: z.record(z.string()).optional(),
      touched_areas: z.array(z.string()).optional(),
      references: z
        .object({
          prs: z.array(z.string()).optional(),
          commits: z.array(z.string()).optional(),
          issues: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
  signals: z
    .object({
      context: ContextSignals.optional(),
      execution: ExecutionSignals.optional(),
      outcome: OutcomeSignals.optional(),
    })
    .optional(),
  decisions: Decisions.optional(),
  pressure_events: z.array(z.string()).optional(), // PE-IDs
});

export type Case = z.infer<typeof Case>;

// ============================================================================
// FOUNDATION - Compressed learning
// ============================================================================

export const FoundationConfidence = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export const FoundationScope = z.enum(["GLOBAL", "PROJECT"]);

export const Foundation = z.object({
  id: z.string(), // F-0001 (project) or GF-0001 (global)
  title: z.string(),
  default_behavior: z.string(), // What to do
  context_tags: z.array(z.string()), // When it applies
  counter_contexts: z.array(z.string()).optional(), // When it doesn't
  confidence: FoundationConfidence,
  scope: FoundationScope.default("PROJECT"), // GLOBAL or PROJECT
  origin_project: z.string().optional(), // Where it was first discovered
  validated_in: z.array(z.string()).optional(), // Projects that confirmed this
  exit_criteria: z.string().optional(), // When to reconsider
  source_pressures: z.array(z.string()), // PE-IDs that led to this
  created_at: z.string(),
  updated_at: z.string(),
});

export type Foundation = z.infer<typeof Foundation>;
export type FoundationScope = z.infer<typeof FoundationScope>;

// ============================================================================
// PROJECT CONFIG
// ============================================================================

export const ConfigScope = z.enum(["GLOBAL", "PROJECT"]);

export const ProjectConfig = z.object({
  project: z.string(),
  version: z.number().default(1),
  scope: ConfigScope.default("PROJECT"), // GLOBAL or PROJECT
  signals: z
    .object({
      context: z.record(z.array(z.string())).optional(), // Extended signals
    })
    .optional(),
  repos: z.record(z.string()).optional(),
});

export type ProjectConfig = z.infer<typeof ProjectConfig>;
export type ConfigScope = z.infer<typeof ConfigScope>;

// ============================================================================
// TOOL INPUT SCHEMAS
// ============================================================================

export const LogPressureInput = z.object({
  case_id: z.string().optional(), // Uses active case if not specified
  expected: z.string().describe("What you assumed would happen"),
  actual: z.string().describe("What actually happened"),
  adaptation: z.string().describe("What you changed in response"),
  remember: z.string().describe("One-liner summary for future reference"),
  pressure_type: PressureType.optional(),
  context_tags: z.array(z.string()).optional(),
});

export const CreateCaseInput = z.object({
  title: z.string().describe("Short descriptive title"),
  goal: z.string().optional().describe("What success looks like"),
  signals: ContextSignals.optional(),
  touched_areas: z.array(z.string()).optional(),
});

export const CloseCaseInput = z.object({
  case_id: z.string().optional(), // Uses active case if not specified
  regret: RegretInput.describe("0=would choose same, 3=strong regret"),
  notes: z.string().optional(),
  regressions: Regressions.optional(),
});

export const GetFoundationsInput = z.object({
  context_tags: z
    .array(z.string())
    .optional()
    .describe("Filter by context tags"),
  min_confidence: z
    .number()
    .min(0)
    .max(3)
    .optional()
    .describe("Minimum confidence level"),
});

export const PromoteToFoundationInput = z.object({
  title: z.string(),
  default_behavior: z.string().describe("What to do when this applies"),
  context_tags: z.array(z.string()),
  counter_contexts: z.array(z.string()).optional(),
  source_pressures: z.array(z.string()).describe("PE-IDs that led to this"),
  exit_criteria: z.string().optional(),
  scope: FoundationScope.optional().describe("GLOBAL or PROJECT (default: PROJECT)"),
});

export const ElevateFoundationInput = z.object({
  foundation_id: z.string().describe("ID of the foundation to elevate (e.g., F-0001)"),
  reason: z.string().optional().describe("Why this foundation is universal"),
});

export const ValidateFoundationInput = z.object({
  foundation_id: z.string().describe("ID of the foundation to validate"),
  validation_notes: z.string().optional().describe("Notes on how this applies in current project"),
});

export const CheckPolicyInput = z.object({
  signals: ContextSignals,
});

export const SearchPressuresInput = z.object({
  query: z.string().trim().min(1).describe("Search query"),
});

export const SetActiveCaseInput = z.object({
  case_id: z.string().trim().min(1).describe("Case ID to set as active"),
});

export const QuickPressureInput = z.object({
  case_id: z.string().optional(),
  expected: z.string().describe("What you assumed would happen"),
  actual: z.string().describe("What actually happened"),
  remember: z.string().optional().describe("One-liner summary (auto-generated if omitted)"),
  adaptation: z.string().optional().describe("What you changed (optional for quick capture)"),
  pressure_type: PressureType.optional(),
  context_tags: z.array(z.string()).optional(),
});

export type LogPressureInput = z.infer<typeof LogPressureInput>;
export type CreateCaseInput = z.infer<typeof CreateCaseInput>;
export type CloseCaseInput = z.infer<typeof CloseCaseInput>;
export type GetFoundationsInput = z.infer<typeof GetFoundationsInput>;
export type PromoteToFoundationInput = z.infer<typeof PromoteToFoundationInput>;
export type ElevateFoundationInput = z.infer<typeof ElevateFoundationInput>;
export type ValidateFoundationInput = z.infer<typeof ValidateFoundationInput>;
export type CheckPolicyInput = z.infer<typeof CheckPolicyInput>;
export type SearchPressuresInput = z.infer<typeof SearchPressuresInput>;
export type SetActiveCaseInput = z.infer<typeof SetActiveCaseInput>;
export type QuickPressureInput = z.infer<typeof QuickPressureInput>;

// ============================================================================
// OBSERVER — Session-local meta-state for conversation observation
// ============================================================================

export const ObserverTaskStage = z.enum(["UNKNOWN", "INTAKE", "EXECUTING", "DONE"]);
export const ObserverCaseStatus = z.enum(["NONE", "OPEN", "CLOSED"]);

export const ObserverEventType = z.enum([
  "TASK_START",
  "PRESSURE_DETECTED",
  "COMPLETION_SIGNAL",
  "CASE_OPENED",
  "CASE_CLOSED",
]);

export const ObserverEvent = z.object({
  turn_index: z.number(),
  type: ObserverEventType,
  summary: z.string(),
  artifact_id: z.string().optional(), // Decision OS ID (case ID, PE ID) from projection
});

export const ObserverMetaState = z.object({
  session_id: z.string(),
  last_processed_turn: z.number(),

  task_label: z.string().optional(),
  task_stage: ObserverTaskStage.default("UNKNOWN"),

  case_status: ObserverCaseStatus.default("NONE"),
  active_case_id: z.string().optional(),

  open_pressure_summaries: z.array(z.string()).default([]),
  decision_candidate_summaries: z.array(z.string()).default([]),
  meta_summary: z.string().default(""),

  event_log: z.array(ObserverEvent).default([]),
});

export type ObserverTaskStage = z.infer<typeof ObserverTaskStage>;
export type ObserverCaseStatus = z.infer<typeof ObserverCaseStatus>;
export type ObserverEventType = z.infer<typeof ObserverEventType>;
export type ObserverEvent = z.infer<typeof ObserverEvent>;
export type ObserverMetaState = z.infer<typeof ObserverMetaState>;

// ============================================================================
// OBSERVER — Engine I/O contract
// ============================================================================

export const ObserverTurn = z.object({
  turn_index: z.number(),
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string(),
});

export const ObserverAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("CREATE_CASE"),
    title: z.string(),
    goal: z.string().optional(),
  }),
  z.object({
    type: z.literal("LOG_PRESSURE"),
    summary: z.string(),
    expected: z.string().optional(),
    actual: z.string().optional(),
  }),
  z.object({
    type: z.literal("CLOSE_CASE"),
    notes: z.string().optional(),
  }),
]);

export type ObserverTurn = z.infer<typeof ObserverTurn>;
export type ObserverAction = z.infer<typeof ObserverAction>;
