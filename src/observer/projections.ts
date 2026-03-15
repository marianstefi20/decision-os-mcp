import type { ObserverAction, ObserverEvent } from "../core/schemas.js";
import { DecisionOSService } from "../core/services.js";

/**
 * Project observer actions into Decision OS core operations.
 * Each action maps to one or more service calls.
 *
 * Returns a log of what was executed for auditability.
 */
export async function projectActions(
  service: DecisionOSService,
  actions: ObserverAction[]
): Promise<ProjectionResult[]> {
  const results: ProjectionResult[] = [];

  for (const action of actions) {
    try {
      const result = await projectAction(service, action);
      results.push(result);
    } catch (error) {
      results.push({
        action,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

export interface ProjectionResult {
  action: ObserverAction;
  success: boolean;
  error?: string;
  artifact_id?: string;
}

/**
 * Convert successful projection results into feedback events
 * that should be applied back to observer state.
 *
 * This closes the loop: observe → project → feedback → state update.
 */
export function toFeedbackEvents(
  results: ProjectionResult[],
  turnIndex: number
): ObserverEvent[] {
  const events: ObserverEvent[] = [];

  for (const result of results) {
    if (!result.success) continue;

    switch (result.action.type) {
      case "CREATE_CASE":
        events.push({
          turn_index: turnIndex,
          type: "CASE_OPENED",
          summary: `Case created: ${result.artifact_id}`,
          artifact_id: result.artifact_id,
        });
        break;

      case "CLOSE_CASE":
        events.push({
          turn_index: turnIndex,
          type: "CASE_CLOSED",
          summary: `Case closed: ${result.artifact_id}`,
          artifact_id: result.artifact_id,
        });
        break;

      // LOG_PRESSURE doesn't need feedback — the pressure summary
      // is already in state from PRESSURE_DETECTED
    }
  }

  return events;
}

async function projectAction(
  service: DecisionOSService,
  action: ObserverAction
): Promise<ProjectionResult> {
  switch (action.type) {
    case "CREATE_CASE": {
      const caseData = await service.createCase({
        title: action.title,
        goal: action.goal,
      });
      return {
        action,
        success: true,
        artifact_id: caseData.id,
      };
    }

    case "LOG_PRESSURE": {
      const pressure = await service.quickPressure({
        expected: action.expected ?? action.summary,
        actual: action.actual ?? action.summary,
        remember: action.summary,
      });
      return {
        action,
        success: true,
        artifact_id: pressure.id,
      };
    }

    case "CLOSE_CASE": {
      const result = await service.closeCase({
        regret: 0, // Observer-initiated closes default to regret 0
        notes: action.notes,
      });
      return {
        action,
        success: true,
        artifact_id: result.case.id,
      };
    }
  }
}
