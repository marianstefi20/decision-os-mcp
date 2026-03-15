import type { ObserverMetaState, ObserverEvent } from "../core/schemas.js";
import { randomUUID } from "crypto";

/**
 * Create a fresh observer meta-state for a new session.
 */
export function createInitialState(sessionId?: string): ObserverMetaState {
  return {
    session_id: sessionId ?? randomUUID(),
    last_processed_turn: -1,
    task_stage: "UNKNOWN",
    case_status: "NONE",
    open_pressure_summaries: [],
    decision_candidate_summaries: [],
    meta_summary: "",
    event_log: [],
  };
}

/**
 * Apply an event to the observer meta-state, returning a new state.
 * Pure function — no side effects.
 */
export function applyEvent(
  state: ObserverMetaState,
  event: ObserverEvent
): ObserverMetaState {
  const updated = {
    ...state,
    last_processed_turn: event.turn_index,
    event_log: [...state.event_log, event],
  };

  switch (event.type) {
    case "TASK_START":
      return {
        ...updated,
        task_stage: "INTAKE",
        task_label: event.summary,
      };

    case "CASE_OPENED":
      return {
        ...updated,
        case_status: "OPEN",
        active_case_id: event.artifact_id,
      };

    case "PRESSURE_DETECTED":
      return {
        ...updated,
        open_pressure_summaries: [
          ...updated.open_pressure_summaries,
          event.summary,
        ],
      };

    case "CASE_CLOSED":
      return {
        ...updated,
        case_status: "CLOSED",
        task_stage: "DONE",
        active_case_id: undefined,
      };

    case "COMPLETION_SIGNAL":
      return {
        ...updated,
        task_stage: "DONE",
      };

    default:
      return updated;
  }
}
