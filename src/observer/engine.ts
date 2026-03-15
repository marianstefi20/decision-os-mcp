import type {
  ObserverMetaState,
  ObserverTurn,
} from "../core/schemas.js";
import { applyEvent } from "./state.js";
import type { DetectFn } from "./detect.js";
import { createHeuristicDetect } from "./detect.js";

/**
 * Result of processing new turns through the observer engine.
 */
export interface ObserverOutput {
  state: ObserverMetaState;
  events: import("../core/schemas.js").ObserverEvent[];
  actions: import("../core/schemas.js").ObserverAction[];
}

/**
 * Process new conversation turns through the observer.
 *
 * The detect function determines how events are detected:
 * - createHeuristicDetect() for pattern matching (default, zero cost)
 * - createLLMDetect(config) for LLM-powered detection
 *
 * The rest of the pipeline (state reduction, actions, feedback)
 * is the same regardless of detection method.
 */
export async function observe(
  currentState: ObserverMetaState,
  newTurns: ObserverTurn[],
  detect?: DetectFn
): Promise<ObserverOutput> {
  const detectFn = detect ?? createHeuristicDetect();
  let state = { ...currentState };
  const allEvents: import("../core/schemas.js").ObserverEvent[] = [];
  const allActions: import("../core/schemas.js").ObserverAction[] = [];

  for (const turn of newTurns) {
    if (turn.turn_index <= state.last_processed_turn) continue;

    const detected = await detectFn(state, turn);

    for (const event of detected.events) {
      state = applyEvent(state, event);
      allEvents.push(event);
    }

    allActions.push(...detected.actions);
    state = { ...state, last_processed_turn: turn.turn_index };
  }

  // Update meta-summary
  if (allEvents.length > 0) {
    state = {
      ...state,
      meta_summary: buildMetaSummary(state),
    };
  }

  return { state, events: allEvents, actions: allActions };
}

function buildMetaSummary(state: ObserverMetaState): string {
  const parts: string[] = [];

  if (state.task_label) {
    parts.push(`Task: ${state.task_label}`);
  }
  parts.push(`Stage: ${state.task_stage}`);

  if (state.case_status !== "NONE") {
    parts.push(`Case: ${state.case_status}`);
  }

  if (state.open_pressure_summaries.length > 0) {
    parts.push(`Pressures: ${state.open_pressure_summaries.length} open`);
  }

  return parts.join(" | ");
}
