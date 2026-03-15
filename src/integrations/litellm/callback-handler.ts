import type { ObserverTurn } from "../../core/schemas.js";
import { createInitialState } from "../../observer/state.js";
import { ObserverOrchestrator } from "../../observer/orchestrator.js";
import { ObserverPersistence } from "../../observer/persistence.js";
import { DecisionOSService } from "../../core/services.js";
import { createHierarchicalStorage } from "../../core/hierarchical-storage.js";
import type { DetectFn, LLMDetectConfig } from "../../observer/detect.js";
import { createLLMDetect, createHeuristicDetect } from "../../observer/detect.js";

/**
 * Configuration for the LiteLLM callback handler.
 */
export interface LiteLLMCallbackConfig {
  /** Path to workspace containing .decision-os/ */
  workspacePath: string;
  /** Session ID for this conversation (e.g., LiteLLM request metadata) */
  sessionId: string;
  /** LLM detection config. If omitted, falls back to heuristic detection. */
  llm?: LLMDetectConfig;
}

/**
 * A LiteLLM callback event, normalized to the fields we care about.
 */
export interface LiteLLMCallbackEvent {
  /** The type of callback */
  type: "success" | "failure" | "async_success" | "async_failure";
  /** Messages from the request (input) */
  input_messages?: Array<{
    role: string;
    content: string;
  }>;
  /** The response content (output) */
  response_content?: string;
  /** Response role (usually "assistant") */
  response_role?: string;
  /** Optional metadata from LiteLLM */
  metadata?: Record<string, unknown>;
}

/**
 * Handles LiteLLM callback events by converting them to ObserverTurns
 * and feeding them through the observer orchestrator.
 */
export class LiteLLMCallbackHandler {
  private orchestrator: ObserverOrchestrator | null = null;
  private turnCounter = 0;
  private config: LiteLLMCallbackConfig;

  constructor(config: LiteLLMCallbackConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    const storage = createHierarchicalStorage(this.config.workspacePath);
    await storage.initialize();

    const service = new DecisionOSService(storage);
    const persistence = new ObserverPersistence(storage.getProjectPath());

    // Choose detection strategy
    const detect: DetectFn = this.config.llm
      ? createLLMDetect(this.config.llm)
      : createHeuristicDetect();

    this.orchestrator = new ObserverOrchestrator(service, persistence, detect);
  }

  async handleCallback(event: LiteLLMCallbackEvent) {
    if (!this.orchestrator) {
      throw new Error("Handler not initialized. Call initialize() first.");
    }

    if (event.type !== "success" && event.type !== "async_success") {
      return null;
    }

    const turns = this.eventToTurns(event);
    if (turns.length === 0) return null;

    const initial = createInitialState(this.config.sessionId);
    return this.orchestrator.process(this.config.sessionId, turns, initial);
  }

  private eventToTurns(event: LiteLLMCallbackEvent): ObserverTurn[] {
    const turns: ObserverTurn[] = [];

    if (event.input_messages) {
      for (const msg of event.input_messages) {
        const role = normalizeRole(msg.role);
        if (role && msg.content) {
          turns.push({
            turn_index: this.turnCounter++,
            role,
            content: msg.content,
          });
        }
      }
    }

    if (event.response_content) {
      turns.push({
        turn_index: this.turnCounter++,
        role: normalizeRole(event.response_role ?? "assistant") ?? "assistant",
        content: event.response_content,
      });
    }

    return turns;
  }
}

function normalizeRole(role: string): "user" | "assistant" | "tool" | null {
  switch (role.toLowerCase()) {
    case "user": return "user";
    case "assistant": return "assistant";
    case "tool":
    case "function": return "tool";
    case "system": return null;
    default: return null;
  }
}
