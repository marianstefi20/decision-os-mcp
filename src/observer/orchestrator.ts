import type { ObserverMetaState, ObserverTurn, ObserverEvent } from "../core/schemas.js";
import { DecisionOSService } from "../core/services.js";
import { observe } from "./engine.js";
import type { ObserverOutput } from "./engine.js";
import type { DetectFn } from "./detect.js";
import { applyEvent } from "./state.js";
import { projectActions, toFeedbackEvents } from "./projections.js";
import type { ProjectionResult } from "./projections.js";
import { ObserverPersistence } from "./persistence.js";

/**
 * Full result of one orchestrator cycle.
 */
export interface CycleResult {
  /** Updated observer state (with feedback applied) */
  state: ObserverMetaState;
  /** Events detected from conversation turns */
  detected: ObserverEvent[];
  /** Feedback events from projections (CASE_OPENED, CASE_CLOSED) */
  feedback: ObserverEvent[];
  /** Results of projecting actions into Decision OS */
  projections: ProjectionResult[];
}

/**
 * Run one full observer cycle:
 *
 * 1. Detect events from new turns
 * 2. Project actions into Decision OS
 * 3. Feed projection results back into state
 * 4. Rebuild meta-summary
 *
 * This is the single entry point for processing new conversation messages.
 */
export async function runCycle(
  state: ObserverMetaState,
  newTurns: ObserverTurn[],
  service: DecisionOSService,
  detect?: DetectFn
): Promise<CycleResult> {
  // 1. Detect events and collect actions
  const output: ObserverOutput = await observe(state, newTurns, detect);

  // 2. Project actions into Decision OS core
  const projections = await projectActions(service, output.actions);

  // 3. Feed projection results back into state
  const lastTurn = newTurns.length > 0
    ? newTurns[newTurns.length - 1].turn_index
    : output.state.last_processed_turn;

  const feedback = toFeedbackEvents(projections, lastTurn);

  let finalState = output.state;
  for (const event of feedback) {
    finalState = applyEvent(finalState, event);
  }

  return {
    state: finalState,
    detected: output.events,
    feedback,
    projections,
  };
}

/**
 * Orchestrator that manages the full lifecycle including persistence.
 * Wraps runCycle with load/save.
 */
export class ObserverOrchestrator {
  private detect?: DetectFn;

  constructor(
    private service: DecisionOSService,
    private persistence: ObserverPersistence,
    detect?: DetectFn
  ) {
    this.detect = detect;
  }

  /**
   * Process new conversation turns for a session.
   * Loads state, runs the cycle, saves state, returns result.
   */
  async process(
    sessionId: string,
    newTurns: ObserverTurn[],
    initialState?: ObserverMetaState
  ): Promise<CycleResult> {
    // Load existing state or use provided initial state
    const state = (await this.persistence.load(sessionId)) ?? initialState;
    if (!state) {
      throw new Error(
        `No existing session "${sessionId}" and no initial state provided`
      );
    }

    // Run the cycle
    const result = await runCycle(state, newTurns, this.service, this.detect);

    // Persist updated state
    await this.persistence.save(result.state);

    return result;
  }
}
