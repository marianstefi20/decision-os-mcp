#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import { HierarchicalDecisionOSStorage, createHierarchicalStorage } from "../core/hierarchical-storage.js";
import { formatContextTable } from "./format-table.js";
import {
  LogPressureInput,
  CreateCaseInput,
  CloseCaseInput,
  GetFoundationsInput,
  PromoteToFoundationInput,
  ElevateFoundationInput,
  ValidateFoundationInput,
  CheckPolicyInput,
  SearchPressuresInput,
  SetActiveCaseInput,
  QuickPressureInput,
} from "../core/schemas.js";

// ============================================================================
// CONFIGURATION
// ============================================================================

// NOTE:
// - Prefer explicit DECISION_OS_PATH (Cursor config sets this per-project)
// - Fall back to process.cwd() and walk up to find .decision-os
// - The hierarchical storage will discover GLOBAL (~/.decision-os) automatically
const DEFAULT_WORKSPACE_PATH =
  process.env.DECISION_OS_PATH ??
  (process.env.PWD ?? process.cwd());

// Cache of storage instances per workspace path
const storageCache = new Map<string, HierarchicalDecisionOSStorage>();

/**
 * Get or create a hierarchical storage instance for the given workspace path.
 */
async function getStorage(workspacePath?: string): Promise<HierarchicalDecisionOSStorage> {
  const path = workspacePath ?? DEFAULT_WORKSPACE_PATH;
  
  if (!storageCache.has(path)) {
    const storage = createHierarchicalStorage(path);
    await storage.initialize();
    storageCache.set(path, storage);
  }
  
  return storageCache.get(path)!;
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

// Common workspace_path property for all tools
const WORKSPACE_PATH_PROP = {
  workspace_path: {
    type: "string",
    description: "Path to workspace (optional, auto-detected from DECISION_OS_PATH or cwd)",
  },
} as const;

const TOOLS: Tool[] = [
  {
    name: "get_context",
    description: `Get the current Decision OS context. Call this at the start of a task to understand:
- Active case (if any)
- Recent pressure events
- Relevant foundations (from both project and global scopes)
- Any conflicts between project and global foundations

Returns the project name, active case details, applicable foundations with source scope, and detected conflicts.`,
    inputSchema: {
      type: "object",
      properties: {
        ...WORKSPACE_PATH_PROP,
        format: {
          type: "string",
          enum: ["json", "table"],
          description: 'Output format. "table" returns a compact markdown table of foundations — ideal for start-of-conversation context loading. "json" returns full context with active case, pressures, and conflicts (default).',
        },
      },
    },
    annotations: {
      title: "Get Context",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "log_pressure",
    description: `Log a pressure event when reality differs from expectation.

Call this IMMEDIATELY when you encounter something unexpected:
- Something failed that you predicted would work
- You had to change approach mid-implementation
- You discovered a constraint not in your initial context

This is the primary learning mechanism. Be specific about what you expected vs what happened.`,
    inputSchema: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description: "Case ID (uses active case if not specified)",
        },
        expected: {
          type: "string",
          description: "What you assumed would happen",
        },
        actual: {
          type: "string",
          description: "What actually happened",
        },
        adaptation: {
          type: "string",
          description: "What you changed in response",
        },
        remember: {
          type: "string",
          description:
            "One-liner summary for future reference (potential foundation)",
        },
        pressure_type: {
          type: "string",
          enum: [
            "CHANGE",
            "IRREVERSIBILITY",
            "COGNITIVE",
            "COUPLING",
            "OPERATIONAL",
            "EXTERNAL",
          ],
          description: "Category of pressure",
        },
        context_tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Tags for context (e.g., BACKEND, SUPABASE, AUTH)",
        },
      },
      required: ["expected", "actual", "adaptation", "remember"],
    },
    annotations: {
      title: "Log Pressure Event",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "quick_pressure",
    description: `Quick-capture a pressure event with minimal friction.

Use this when you want to capture a surprise fast without filling all fields.
Only requires expected and actual — adaptation and remember are optional
(remember is auto-generated from expected vs actual if omitted).

Prefer this over log_pressure when in the middle of debugging or rapid iteration.
Capturing too much is better than missing surprises.`,
    inputSchema: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description: "Case ID (uses active case if not specified)",
        },
        expected: {
          type: "string",
          description: "What you assumed would happen",
        },
        actual: {
          type: "string",
          description: "What actually happened",
        },
        remember: {
          type: "string",
          description: "One-liner summary (auto-generated if omitted)",
        },
        adaptation: {
          type: "string",
          description: "What you changed (optional for quick capture)",
        },
        pressure_type: {
          type: "string",
          enum: [
            "CHANGE",
            "IRREVERSIBILITY",
            "COGNITIVE",
            "COUPLING",
            "OPERATIONAL",
            "EXTERNAL",
          ],
          description: "Category of pressure (optional)",
        },
        context_tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for context (optional)",
        },
      },
      required: ["expected", "actual"],
    },
    annotations: {
      title: "Quick Pressure Capture",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "create_case",
    description: `Create a new case (unit of work) and set it as active.

A case represents a bounded piece of work: feature, bugfix, refactor, spike.
Creating a case provides context for logging pressure events.`,
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short descriptive title",
        },
        goal: {
          type: "string",
          description: "What success looks like",
        },
        signals: {
          type: "object",
          description: "Context signals (risk_level, reversibility, etc.)",
          properties: {
            risk_level: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
            reversibility: { type: "string", enum: ["EASY", "MEDIUM", "HARD"] },
            change_frequency: {
              type: "string",
              enum: ["RARE", "OCCASIONAL", "FREQUENT"],
            },
            affected_surface: {
              type: "array",
              items: { type: "string" },
            },
            novelty: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
            repo_scope: { type: "string" },
          },
        },
        touched_areas: {
          type: "array",
          items: { type: "string" },
          description: "Areas of codebase being touched",
        },
      },
      required: ["title"],
    },
    annotations: {
      title: "Create Case",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "close_case",
    description: `Close a case with outcome signals.

Call this when work is complete. The regret score (0-3) is critical:
- 0: Would choose the same approach again
- 1: Minor improvements possible
- 2: Significant regret, different approach likely better
- 3: Strong regret, wrong posture/approach`,
    inputSchema: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description: "Case ID (uses active case if not specified)",
        },
        regret: {
          type: ["string", "number"],
          enum: ["0", "1", "2", "3", 0, 1, 2, 3],
          description: "0=would choose same, 3=strong regret",
        },
        notes: {
          type: "string",
          description: "Outcome notes, lessons learned",
        },
        regressions: {
          type: "string",
          enum: ["NONE", "MINOR", "MAJOR"],
          description: "Any regressions introduced",
        },
      },
      required: ["regret"],
    },
    annotations: {
      title: "Close Case",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "set_active_case",
    description: `Set the active case for the current session.

Pressure events will be logged to the active case by default.`,
    inputSchema: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description: "Case ID to set as active",
        },
      },
      required: ["case_id"],
    },
    annotations: {
      title: "Set Active Case",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_foundations",
    description: `Get project foundations (compressed learnings).

Foundations are promoted from repeated pressure events. They represent
project-specific defaults with confidence levels (0-3).

Query by context tags or minimum confidence to get relevant foundations.`,
    inputSchema: {
      type: "object",
      properties: {
        context_tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter by context tags",
        },
        min_confidence: {
          type: "number",
          minimum: 0,
          maximum: 3,
          description: "Minimum confidence level (0-3)",
        },
      },
    },
    annotations: {
      title: "Get Foundations",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "search_pressures",
    description: `Search past pressure events.

Use this to find relevant past learnings before implementing something.
Searches across expected, actual, adaptation, remember, and context_tags.`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
      },
      required: ["query"],
    },
    annotations: {
      title: "Search Pressure Events",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "check_policy",
    description: `Check what policy requires for given signals.

Returns:
- Whether MINIMAL vs ROBUST options comparison is required
- Required validation level (BASIC/STANDARD/STRICT)
- Any warnings or requirements

Call this before implementation to understand constraints.`,
    inputSchema: {
      type: "object",
      properties: {
        signals: {
          type: "object",
          description: "Context signals to check",
          properties: {
            risk_level: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
            reversibility: { type: "string", enum: ["EASY", "MEDIUM", "HARD"] },
            repo_scope: { type: "string" },
            affected_surface: {
              type: "array",
              items: { type: "string" },
            },
            uncertainty: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
          },
        },
      },
      required: ["signals"],
    },
    annotations: {
      title: "Check Policy",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "promote_to_foundation",
    description: `Promote pressure events to a foundation.

When you see a pattern across multiple pressure events, promote them
to a foundation. Foundations start with confidence 1/3 and evolve
based on future outcomes.

Use scope: "GLOBAL" to create a universal foundation in ~/.decision-os
that applies across all projects. Default is "PROJECT" (local only).`,
    inputSchema: {
      type: "object",
      properties: {
        ...WORKSPACE_PATH_PROP,
        title: {
          type: "string",
          description: "Foundation title",
        },
        default_behavior: {
          type: "string",
          description: "What to do when this applies",
        },
        context_tags: {
          type: "array",
          items: { type: "string" },
          description: "When this foundation applies",
        },
        counter_contexts: {
          type: "array",
          items: { type: "string" },
          description: "When this foundation does NOT apply",
        },
        source_pressures: {
          type: "array",
          items: { type: "string" },
          description: "PE-IDs that led to this foundation",
        },
        exit_criteria: {
          type: "string",
          description: "When to reconsider this foundation",
        },
        scope: {
          type: "string",
          enum: ["GLOBAL", "PROJECT"],
          description: "GLOBAL (universal) or PROJECT (local). Default: PROJECT",
        },
      },
      required: ["title", "default_behavior", "context_tags", "source_pressures"],
    },
    annotations: {
      title: "Promote to Foundation",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "elevate_foundation",
    description: `Elevate a project foundation to global scope.

Use when a project-specific learning has proven universal.
The foundation will be copied to ~/.decision-os with a GF- prefix.

Strong signal for elevation:
- Foundation has confidence 2+
- Pattern has been validated across multiple implementations
- Learning applies regardless of tech stack`,
    inputSchema: {
      type: "object",
      properties: {
        ...WORKSPACE_PATH_PROP,
        foundation_id: {
          type: "string",
          description: "ID of the foundation to elevate (e.g., F-0001)",
        },
        reason: {
          type: "string",
          description: "Why this foundation is universal",
        },
      },
      required: ["foundation_id"],
    },
    annotations: {
      title: "Elevate Foundation to Global",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "validate_foundation",
    description: `Validate that a global foundation applies in the current project.

Increases confidence and adds current project to validated_in list.
Strong signal for keeping foundation at global scope.

Use when you observe a global foundation being correct in a new project context.`,
    inputSchema: {
      type: "object",
      properties: {
        ...WORKSPACE_PATH_PROP,
        foundation_id: {
          type: "string",
          description: "ID of the foundation to validate",
        },
        validation_notes: {
          type: "string",
          description: "Notes on how this applies in current project",
        },
      },
      required: ["foundation_id"],
    },
    annotations: {
      title: "Validate Foundation",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "suggest_review",
    description: `Review the project for unextracted learnings and forgetting opportunities.

Call this periodically (e.g., after closing several cases) to:
- Find clusters of unpromoted pressure events that could become foundations
- Identify cases blocking forgetting (regret 0 but unpromoted PEs remain — promote or discard to unblock)
- Flag high-regret cases with no PEs (possible missed captures)

This is the retrospective mechanism. Knowledge lives in foundations, not cases.`,
    inputSchema: {
      type: "object",
      properties: {
        ...WORKSPACE_PATH_PROP,
      },
    },
    annotations: {
      title: "Suggest Review",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "list_cases",
    description: `List all cases in the project.

Returns all cases with their status, useful for finding past work
or setting an active case.`,
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: {
      title: "List Cases",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

// ============================================================================
// SERVER
// ============================================================================

async function main() {
  // Pre-initialize default storage to fail fast if config is broken
  try {
    await getStorage();
    console.error(`Decision OS initialized from ${DEFAULT_WORKSPACE_PATH}`);
  } catch (error) {
    console.error(
      `Failed to initialize Decision OS from ${DEFAULT_WORKSPACE_PATH}:`,
      error
    );
    console.error(
      "Set DECISION_OS_PATH environment variable to your .decision-os folder, " +
      "or ensure ~/.decision-os exists for global foundations."
    );
    process.exit(1);
  }

  const server = new Server(
    {
      name: "decision-os",
      version: "0.5.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const rawArgs = (args ?? {}) as Record<string, unknown>;
    const workspacePath = rawArgs.workspace_path as string | undefined;

    try {
      const storage = await getStorage(workspacePath);

      switch (name) {
        case "get_context": {
          const format = rawArgs.format as string | undefined;
          const context = await storage.getContext();

          if (format === "table") {
            return { content: [{ type: "text", text: formatContextTable(context) }] };
          }

          // Default: full JSON format
          let conflictWarning = "";
          if (context.conflicts.length > 0) {
            conflictWarning = "\n\n⚠️ FOUNDATION CONFLICTS DETECTED:\n" +
              context.conflicts.map(c =>
                `- ${c.title}: ${c.recommendation}`
              ).join("\n");
          }

          // Annotate foundations with scope
          const annotatedFoundations = context.relevant_foundations.map(f => ({
            ...f,
            scope_indicator: f._source_scope === "GLOBAL" ? "🌐 GLOBAL" : "📁 PROJECT",
          }));

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ...context,
                  relevant_foundations: annotatedFoundations,
                }, null, 2) + conflictWarning,
              },
            ],
          };
        }

        case "log_pressure": {
          const input = LogPressureInput.parse(rawArgs);
          const pressure = await storage.logPressure(input);
          return {
            content: [
              {
                type: "text",
                text: `Logged pressure event ${pressure.id}:\n${JSON.stringify(pressure, null, 2)}`,
              },
            ],
          };
        }

        case "quick_pressure": {
          const input = QuickPressureInput.parse(rawArgs);
          const remember = input.remember ??
            `Expected: ${input.expected.slice(0, 40)}… but: ${input.actual.slice(0, 40)}…`;
          const adaptation = input.adaptation ?? "(captured for review)";
          const pressure = await storage.logPressure({
            case_id: input.case_id,
            expected: input.expected,
            actual: input.actual,
            adaptation,
            remember,
            pressure_type: input.pressure_type,
            context_tags: input.context_tags,
          });
          return {
            content: [
              {
                type: "text",
                text: `⚡ Quick-captured pressure event ${pressure.id}:\n${JSON.stringify(pressure, null, 2)}`,
              },
            ],
          };
        }

        case "create_case": {
          const input = CreateCaseInput.parse(rawArgs);
          const caseData = await storage.createCase({
            title: input.title,
            goal: input.goal,
            signals: input.signals ? { context: input.signals } : undefined,
            touched_areas: input.touched_areas,
          });
          return {
            content: [
              {
                type: "text",
                text: `Created case ${caseData.id} (now active):\n${JSON.stringify(caseData, null, 2)}`,
              },
            ],
          };
        }

        case "close_case": {
          const input = CloseCaseInput.parse(rawArgs);
          const caseId = input.case_id || storage.getActiveCase();
          if (!caseId) {
            throw new Error("No active case. Specify case_id.");
          }
          const result = await storage.closeCase(caseId, {
            regret: input.regret,
            notes: input.notes,
            regressions: input.regressions,
          });
          const forgottenMsg = result.forgotten
            ? `\n\n🧹 Case forgotten — no novel pressure retained. Knowledge lives in foundations.`
            : "";
          return {
            content: [
              {
                type: "text",
                text: `Closed case ${result.case.id}:\n${JSON.stringify(result.case, null, 2)}${forgottenMsg}`,
              },
            ],
          };
        }

        case "set_active_case": {
          const input = SetActiveCaseInput.parse(rawArgs);
          const caseData = await storage.getCase(input.case_id);
          if (!caseData) {
            throw new Error(`Case not found: ${input.case_id}`);
          }
          await storage.setActiveCase(input.case_id);
          return {
            content: [
              {
                type: "text",
                text: `Set active case to ${input.case_id}: "${caseData.title}"`,
              },
            ],
          };
        }

        case "get_foundations": {
          const input = GetFoundationsInput.parse(rawArgs);
          const foundations = await storage.getFoundations(input);
          
          // Annotate with scope indicator
          const annotated = foundations.map(f => ({
            ...f,
            scope_indicator: f._source_scope === "GLOBAL" ? "🌐 GLOBAL" : "📁 PROJECT",
          }));
          
          return {
            content: [
              {
                type: "text",
                text:
                  annotated.length > 0
                    ? JSON.stringify(annotated, null, 2)
                    : "No foundations found matching criteria.",
              },
            ],
          };
        }

        case "search_pressures": {
          const input = SearchPressuresInput.parse(rawArgs);
          const pressures = await storage.searchPressures(input.query);
          return {
            content: [
              {
                type: "text",
                text:
                  pressures.length > 0
                    ? `Found ${pressures.length} pressure events:\n${JSON.stringify(pressures, null, 2)}`
                    : "No pressure events found matching query.",
              },
            ],
          };
        }

        case "check_policy": {
          const input = CheckPolicyInput.parse(rawArgs);
          const result = storage.checkPolicy(input.signals);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case "promote_to_foundation": {
          const input = PromoteToFoundationInput.parse(rawArgs);
          const config = await storage.getConfig();
          const foundation = await storage.promoteToFoundation({
            ...input,
            origin_project: config.project,
          });
          
          const scopeLabel = foundation.scope === "GLOBAL" ? "🌐 GLOBAL" : "📁 PROJECT";
          return {
            content: [
              {
                type: "text",
                text: `Created ${scopeLabel} foundation ${foundation.id} (confidence: 1/3):\n${JSON.stringify(foundation, null, 2)}`,
              },
            ],
          };
        }

        case "elevate_foundation": {
          const input = ElevateFoundationInput.parse(rawArgs);
          const previousId = input.foundation_id;
          const foundation = await storage.elevateFoundation(input);
          return {
            content: [
              {
                type: "text",
                text: `🌐 Elevated to GLOBAL foundation ${foundation.id}:\n${JSON.stringify(foundation, null, 2)}\n\n` +
                  `Project copy ${previousId} retired — knowledge now lives in global scope.\n` +
                  `This foundation will now apply across all projects.`,
              },
            ],
          };
        }

        case "validate_foundation": {
          const input = ValidateFoundationInput.parse(rawArgs);
          const foundation = await storage.validateFoundation(input);
          return {
            content: [
              {
                type: "text",
                text: `✓ Validated foundation ${foundation.id} in this project.\n` +
                  `Validated in ${foundation.validated_in?.length ?? 0} project(s): ${foundation.validated_in?.join(", ") ?? "none"}\n` +
                  `Confidence: ${foundation.confidence}/3\n\n${JSON.stringify(foundation, null, 2)}`,
              },
            ],
          };
        }

        case "suggest_review": {
          const review = await storage.suggestReview();
          return {
            content: [
              {
                type: "text",
                text: `Review Summary: ${review.summary}\n\n${JSON.stringify(review, null, 2)}`,
              },
            ],
          };
        }

        case "list_cases": {
          const cases = await storage.listCases();
          const activeCase = storage.getActiveCase();
          const summary = cases.map((c) => ({
            id: c.id,
            title: c.title,
            status: c.status,
            active: c.id === activeCase,
          }));
          return {
            content: [
              {
                type: "text",
                text:
                  cases.length > 0
                    ? JSON.stringify(summary, null, 2)
                    : "No cases found.",
              },
            ],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const message =
        error instanceof ZodError
          ? `Invalid input: ${error.issues
              .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
              .join("; ")}`
          : error instanceof Error
            ? error.message
            : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${message}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Decision OS MCP server running");
}

main().catch(console.error);
