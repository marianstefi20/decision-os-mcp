#!/usr/bin/env node

/**
 * CLI entry point for the observer, called by the LiteLLM Python shim.
 *
 * Reads a JSON event from stdin with the shape:
 * {
 *   session_id: string,
 *   workspace_path: string,
 *   messages: Array<{ role: string, content: string }>,
 *   response: { role: string, content: string }
 * }
 *
 * Runs one observer cycle and prints the result to stdout.
 *
 * Environment variables for LLM-powered detection:
 *   OBSERVER_MODEL    - model ID (e.g. "claude-sonnet-4-20250514")
 *   OBSERVER_API_KEY  - API key for the provider
 *   OBSERVER_BASE_URL - base URL (e.g. "https://api.openai.com/v1")
 *
 * If none are set, falls back to heuristic detection.
 */

import { createHierarchicalStorage } from "../../core/hierarchical-storage.js";
import { DecisionOSService } from "../../core/services.js";
import { ObserverPersistence } from "../../observer/persistence.js";
import { ObserverOrchestrator } from "../../observer/orchestrator.js";
import { createInitialState } from "../../observer/state.js";
import { createLLMDetect, createHeuristicDetect } from "../../observer/detect.js";
import type { DetectFn } from "../../observer/detect.js";
import type { ObserverTurn } from "../../core/schemas.js";

interface CliInput {
  session_id: string;
  workspace_path: string;
  messages: Array<{ role: string; content: string }>;
  response: { role: string; content: string };
  turn_offset?: number;
}

function buildDetectFn(): DetectFn {
  const model = process.env.OBSERVER_MODEL;
  const apiKey = process.env.OBSERVER_API_KEY;
  const baseURL = process.env.OBSERVER_BASE_URL;

  if (model && apiKey && baseURL) {
    return createLLMDetect({ model, apiKey, baseURL });
  }

  return createHeuristicDetect();
}

async function main() {
  // Read JSON from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();

  if (!raw) {
    console.error("No input received on stdin");
    process.exit(1);
  }

  let input: CliInput;
  try {
    input = JSON.parse(raw);
  } catch {
    console.error("Invalid JSON on stdin");
    process.exit(1);
  }

  // Initialize storage and service
  const storage = createHierarchicalStorage(input.workspace_path);
  await storage.initialize();

  const service = new DecisionOSService(storage);
  const persistence = new ObserverPersistence(storage.getProjectPath());
  const detect = buildDetectFn();
  const orchestrator = new ObserverOrchestrator(service, persistence, detect);

  // Build turns from messages + response
  const turnOffset = input.turn_offset ?? 0;
  const turns: ObserverTurn[] = [];

  for (let i = 0; i < input.messages.length; i++) {
    const msg = input.messages[i];
    const role = normalizeRole(msg.role);
    if (role && msg.content) {
      turns.push({
        turn_index: turnOffset + i,
        role,
        content: msg.content,
      });
    }
  }

  // Add the response
  if (input.response?.content) {
    turns.push({
      turn_index: turnOffset + input.messages.length,
      role: normalizeRole(input.response.role) ?? "assistant",
      content: input.response.content,
    });
  }

  if (turns.length === 0) {
    console.log(JSON.stringify({ status: "no_turns" }));
    return;
  }

  // Run the observer cycle
  const initial = createInitialState(input.session_id);
  const result = await orchestrator.process(input.session_id, turns, initial);

  // Output result
  console.log(JSON.stringify({
    status: "ok",
    session_id: input.session_id,
    task_stage: result.state.task_stage,
    case_status: result.state.case_status,
    active_case_id: result.state.active_case_id,
    detected_events: result.detected.map((e) => e.type),
    feedback_events: result.feedback.map((e) => e.type),
    projections: result.projections.map((p) => ({
      action: p.action.type,
      success: p.success,
      artifact_id: p.artifact_id,
      error: p.error,
    })),
  }));
}

function normalizeRole(role: string): "user" | "assistant" | "tool" | null {
  switch (role.toLowerCase()) {
    case "user": return "user";
    case "assistant": return "assistant";
    case "tool":
    case "function": return "tool";
    default: return null;
  }
}

main().catch((err) => {
  console.error("Observer CLI error:", err);
  process.exit(1);
});
