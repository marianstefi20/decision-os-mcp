import OpenAI from "openai";
import type {
  ObserverMetaState,
  ObserverTurn,
  ObserverEvent,
  ObserverAction,
} from "../core/schemas.js";

/**
 * Detection result from analyzing a turn.
 */
export interface DetectionResult {
  events: ObserverEvent[];
  actions: ObserverAction[];
}

/**
 * A function that analyzes a turn against the current state
 * and returns detected events + actions.
 */
export type DetectFn = (
  state: ObserverMetaState,
  turn: ObserverTurn
) => Promise<DetectionResult>;

// ============================================================================
// LLM DETECTION
// ============================================================================

/**
 * Configuration for the LLM-powered detector.
 */
export interface LLMDetectConfig {
  /** Model ID (e.g., "claude-sonnet-4-20250514", "gpt-4o", "gemini-2.5-flash") */
  model: string;
  /** API key for the provider */
  apiKey: string;
  /** Base URL for the provider API (e.g., "https://api.openai.com/v1") */
  baseURL: string;
  /** Max tokens for the detection response */
  maxTokens?: number;
}

const DEFAULT_MAX_TOKENS = 512;

const SYSTEM_PROMPT = `You are a process observer for an engineering task. You watch conversation turns and detect whether the **process state** has changed.

You are NOT solving the task. You are only classifying what happened to the process.

You detect exactly three types of events:

1. **TASK_START** — A user has initiated a piece of work (feature, bugfix, refactor, investigation). Only detect this once per session when work begins.

2. **PRESSURE_DETECTED** — Reality diverged from expectation. This includes:
   - An assumption broke (something didn't work as expected)
   - A hidden dependency or constraint appeared
   - Scope shifted or grew unexpectedly
   - Ambiguity accumulated requiring a decision
   - A tradeoff had to be made
   - The approach had to change mid-execution
   This is NOT routine work. It's the moment where something surprised, blocked, or forced adaptation.

3. **COMPLETION_SIGNAL** — The work appears to be done. Tests pass, feature works, task is wrapped up.

For each event you detect, provide:
- type: one of TASK_START, PRESSURE_DETECTED, COMPLETION_SIGNAL
- summary: a concise description of what happened
- For PRESSURE_DETECTED, also provide:
  - expected: what was assumed or expected
  - actual: what actually happened

If nothing noteworthy happened (routine work, clarifications, normal progress), return an empty events array.

Respond with JSON only. No markdown, no explanation.`;

function buildUserPrompt(state: ObserverMetaState, turn: ObserverTurn): string {
  const stateContext = [
    `Session: ${state.session_id}`,
    `Task stage: ${state.task_stage}`,
    `Case status: ${state.case_status}`,
    state.task_label ? `Task: ${state.task_label}` : null,
    state.open_pressure_summaries.length > 0
      ? `Open pressures: ${state.open_pressure_summaries.join("; ")}`
      : null,
  ].filter(Boolean).join("\n");

  return `Current observer state:
${stateContext}

New turn (index ${turn.turn_index}, role: ${turn.role}):
${turn.content}

What process events, if any, occurred in this turn? Respond with:
{"events": [{"type": "...", "summary": "...", "expected": "...", "actual": "..."}]}

Rules:
- Only detect TASK_START if task_stage is UNKNOWN
- Only detect PRESSURE_DETECTED or COMPLETION_SIGNAL if task_stage is not UNKNOWN and not DONE
- Return {"events": []} if nothing noteworthy happened`;
}

interface LLMResponse {
  events: Array<{
    type: "TASK_START" | "PRESSURE_DETECTED" | "COMPLETION_SIGNAL";
    summary: string;
    expected?: string;
    actual?: string;
  }>;
}

/**
 * Create an LLM-powered detection function.
 */
export function createLLMDetect(config: LLMDetectConfig): DetectFn {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  return async (state, turn): Promise<DetectionResult> => {
    const response = await client.chat.completions.create({
      model: config.model,
      max_completion_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(state, turn) },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return { events: [], actions: [] };

    let parsed: LLMResponse;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { events: [], actions: [] };
    }

    if (!parsed.events || !Array.isArray(parsed.events)) {
      return { events: [], actions: [] };
    }

    const events: ObserverEvent[] = [];
    const actions: ObserverAction[] = [];

    for (const evt of parsed.events) {
      // Validate event type
      if (!["TASK_START", "PRESSURE_DETECTED", "COMPLETION_SIGNAL"].includes(evt.type)) {
        continue;
      }

      // Enforce the same guards as heuristic detection
      if (evt.type === "TASK_START" && state.task_stage !== "UNKNOWN") continue;
      if (evt.type !== "TASK_START" && (state.task_stage === "UNKNOWN" || state.task_stage === "DONE")) continue;

      events.push({
        turn_index: turn.turn_index,
        type: evt.type,
        summary: evt.summary,
      });

      switch (evt.type) {
        case "TASK_START":
          actions.push({ type: "CREATE_CASE", title: evt.summary });
          break;
        case "PRESSURE_DETECTED":
          actions.push({
            type: "LOG_PRESSURE",
            summary: evt.summary,
            expected: evt.expected,
            actual: evt.actual,
          });
          break;
        case "COMPLETION_SIGNAL":
          actions.push({ type: "CLOSE_CASE", notes: evt.summary });
          break;
      }
    }

    return { events, actions };
  };
}

// ============================================================================
// HEURISTIC DETECTION (kept as fallback / testing)
// ============================================================================

const TASK_START_PATTERNS = [
  /\b(implement|build|create|add|fix|refactor|migrate|update|set up|configure)\b/i,
  /\b(can you|please|i need|let'?s|we need to|i want to)\b/i,
];

const PRESSURE_PATTERNS = [
  /\b(unexpected|surprising|didn'?t expect|thought .+ would|assumed)\b/i,
  /\b(error|failed|broke|broken|doesn'?t work|not working)\b/i,
  /\b(actually|instead|turns out|realized)\b/i,
  /\b(blocker|blocked|stuck|can'?t figure out)\b/i,
  /\b(changed approach|had to change|pivot|rethink)\b/i,
];

const COMPLETION_PATTERNS = [
  /\b(done|complete|finished|all set|that'?s it|wrapped up)\b/i,
  /\b(everything.+working|tests? pass|all tests?)\b/i,
  /\b(ready for review|ready to merge|lgtm)\b/i,
  /\b(successfully|implemented|deployed)\b/i,
];

/**
 * Create a heuristic detection function (pattern matching).
 * Useful for testing or as a zero-cost fallback.
 */
export function createHeuristicDetect(): DetectFn {
  return async (state, turn): Promise<DetectionResult> => {
    const events: ObserverEvent[] = [];
    const actions: ObserverAction[] = [];
    const content = turn.content.toLowerCase();

    if (
      turn.role === "user" &&
      state.task_stage === "UNKNOWN" &&
      TASK_START_PATTERNS.some((p) => p.test(content))
    ) {
      const label = extractTaskLabel(turn.content);
      events.push({ turn_index: turn.turn_index, type: "TASK_START", summary: label });
      actions.push({ type: "CREATE_CASE", title: label });
    }

    if (state.task_stage !== "UNKNOWN" && state.task_stage !== "DONE") {
      const matches = PRESSURE_PATTERNS.filter((p) => p.test(content));
      if (matches.length >= 2) {
        const summary = turn.content.slice(0, 120).replace(/\n/g, " ").trim();
        events.push({ turn_index: turn.turn_index, type: "PRESSURE_DETECTED", summary });
        actions.push({ type: "LOG_PRESSURE", summary });
      }
    }

    if (
      turn.role === "assistant" &&
      state.task_stage !== "UNKNOWN" &&
      state.task_stage !== "DONE" &&
      COMPLETION_PATTERNS.filter((p) => p.test(content)).length >= 2
    ) {
      events.push({ turn_index: turn.turn_index, type: "COMPLETION_SIGNAL", summary: "Task appears complete" });
      actions.push({ type: "CLOSE_CASE", notes: "Auto-detected completion" });
    }

    return { events, actions };
  };
}

function extractTaskLabel(content: string): string {
  const firstSentence = content.split(/[.!?\n]/)[0].trim();
  if (firstSentence.length <= 80) return firstSentence;
  return firstSentence.slice(0, 77) + "...";
}
