// Decision OS — public API surface

// Core
export { DecisionOSStorage } from "./core/storage.js";
export {
  HierarchicalDecisionOSStorage,
  createHierarchicalStorage,
} from "./core/hierarchical-storage.js";
export type {
  FoundationWithSource,
  FoundationConflict,
} from "./core/hierarchical-storage.js";
export { DecisionOSService } from "./core/services.js";
export * from "./core/schemas.js";

// Observer
export { observe } from "./observer/engine.js";
export type { ObserverOutput } from "./observer/engine.js";
export { createInitialState, applyEvent } from "./observer/state.js";
export { projectActions, toFeedbackEvents } from "./observer/projections.js";
export type { ProjectionResult } from "./observer/projections.js";
export { ObserverPersistence } from "./observer/persistence.js";
export { runCycle, ObserverOrchestrator } from "./observer/orchestrator.js";
export type { CycleResult } from "./observer/orchestrator.js";
export { createLLMDetect, createHeuristicDetect } from "./observer/detect.js";
export type { DetectFn, DetectionResult, LLMDetectConfig } from "./observer/detect.js";

// Integrations
export { LiteLLMCallbackHandler } from "./integrations/litellm/callback-handler.js";
export type {
  LiteLLMCallbackConfig,
  LiteLLMCallbackEvent,
} from "./integrations/litellm/callback-handler.js";
