import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { observe } from "../src/observer/engine.js";
import { createInitialState, applyEvent } from "../src/observer/state.js";
import { projectActions, toFeedbackEvents } from "../src/observer/projections.js";
import { ObserverPersistence } from "../src/observer/persistence.js";
import { runCycle, ObserverOrchestrator } from "../src/observer/orchestrator.js";
import { DecisionOSService } from "../src/core/services.js";
import { HierarchicalDecisionOSStorage } from "../src/core/hierarchical-storage.js";
import type { ObserverMetaState, ObserverTurn } from "../src/core/schemas.js";

// ============================================================================
// STATE
// ============================================================================

describe("observer state", () => {
  it("creates initial state with defaults", () => {
    const state = createInitialState("test-session");
    expect(state.session_id).toBe("test-session");
    expect(state.last_processed_turn).toBe(-1);
    expect(state.task_stage).toBe("UNKNOWN");
    expect(state.case_status).toBe("NONE");
    expect(state.event_log).toHaveLength(0);
  });

  it("applies TASK_START event", () => {
    const state = createInitialState();
    const updated = applyEvent(state, {
      turn_index: 0,
      type: "TASK_START",
      summary: "Add caching layer",
    });
    expect(updated.task_stage).toBe("INTAKE");
    expect(updated.task_label).toBe("Add caching layer");
    expect(updated.last_processed_turn).toBe(0);
    expect(updated.event_log).toHaveLength(1);
  });

  it("applies PRESSURE_DETECTED event", () => {
    let state = createInitialState();
    state = applyEvent(state, {
      turn_index: 0,
      type: "TASK_START",
      summary: "Task",
    });
    const updated = applyEvent(state, {
      turn_index: 1,
      type: "PRESSURE_DETECTED",
      summary: "API returned 403 unexpectedly",
    });
    expect(updated.open_pressure_summaries).toHaveLength(1);
    expect(updated.open_pressure_summaries[0]).toBe(
      "API returned 403 unexpectedly"
    );
  });

  it("applies COMPLETION_SIGNAL event", () => {
    let state = createInitialState();
    state = applyEvent(state, {
      turn_index: 0,
      type: "TASK_START",
      summary: "Task",
    });
    const updated = applyEvent(state, {
      turn_index: 5,
      type: "COMPLETION_SIGNAL",
      summary: "Task appears complete",
    });
    expect(updated.task_stage).toBe("DONE");
  });

  it("applies CASE_OPENED event and captures case ID", () => {
    const state = createInitialState();
    const updated = applyEvent(state, {
      turn_index: 0,
      type: "CASE_OPENED",
      summary: "Case created: 0001-auth-module",
      artifact_id: "0001-auth-module",
    });
    expect(updated.case_status).toBe("OPEN");
    expect(updated.active_case_id).toBe("0001-auth-module");
  });

  it("applies CASE_CLOSED event and clears case ID", () => {
    let state = createInitialState();
    state = applyEvent(state, {
      turn_index: 0,
      type: "CASE_OPENED",
      summary: "Case created: 0001-test",
      artifact_id: "0001-test",
    });
    expect(state.active_case_id).toBe("0001-test");

    const updated = applyEvent(state, {
      turn_index: 5,
      type: "CASE_CLOSED",
      summary: "Case closed",
    });
    expect(updated.case_status).toBe("CLOSED");
    expect(updated.task_stage).toBe("DONE");
    expect(updated.active_case_id).toBeUndefined();
  });
});

// ============================================================================
// ENGINE — DETECTION
// ============================================================================

describe("observer engine", () => {
  it("detects TASK_START from user request", async () => {
    const state = createInitialState();
    const result = await observe(state, [
      { turn_index: 0, role: "user", content: "Please implement a caching layer for the API" },
    ]);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe("TASK_START");
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].type).toBe("CREATE_CASE");
  });

  it("does not detect TASK_START from assistant messages", async () => {
    const state = createInitialState();
    const result = await observe(state, [
      { turn_index: 0, role: "assistant", content: "I'll implement the caching layer" },
    ]);

    expect(result.events).toHaveLength(0);
  });

  it("does not re-detect TASK_START when task is active", async () => {
    let state = createInitialState();
    const first = await observe(state, [
      { turn_index: 0, role: "user", content: "Please implement a caching layer" },
    ]);
    state = first.state;

    const second = await observe(state, [
      { turn_index: 1, role: "user", content: "Also add a retry mechanism" },
    ]);

    // Should not trigger another TASK_START
    const taskStarts = second.events.filter((e) => e.type === "TASK_START");
    expect(taskStarts).toHaveLength(0);
  });

  it("detects pressure from surprise indicators", async () => {
    let state = createInitialState();
    state = (await observe(state, [
      { turn_index: 0, role: "user", content: "Please fix the auth flow" },
    ])).state;

    const result = await observe(state, [
      {
        turn_index: 1,
        role: "assistant",
        content:
          "I didn't expect this — the API actually returns a 403 error instead of 401. Turns out the token format changed.",
      },
    ]);

    const pressures = result.events.filter(
      (e) => e.type === "PRESSURE_DETECTED"
    );
    expect(pressures).toHaveLength(1);
    expect(result.actions.some((a) => a.type === "LOG_PRESSURE")).toBe(true);
  });

  it("does not detect pressure with single weak signal", async () => {
    let state = createInitialState();
    state = (await observe(state, [
      { turn_index: 0, role: "user", content: "Please fix the auth flow" },
    ])).state;

    const result = await observe(state, [
      {
        turn_index: 1,
        role: "assistant",
        content: "The code looks straightforward, I'll update the handler.",
      },
    ]);

    const pressures = result.events.filter(
      (e) => e.type === "PRESSURE_DETECTED"
    );
    expect(pressures).toHaveLength(0);
  });

  it("detects completion signal", async () => {
    let state = createInitialState();
    state = (await observe(state, [
      { turn_index: 0, role: "user", content: "Please implement the feature" },
    ])).state;

    const result = await observe(state, [
      {
        turn_index: 1,
        role: "assistant",
        content: "Done! All tests pass and the feature is successfully implemented.",
      },
    ]);

    const completions = result.events.filter(
      (e) => e.type === "COMPLETION_SIGNAL"
    );
    expect(completions).toHaveLength(1);
    expect(result.actions.some((a) => a.type === "CLOSE_CASE")).toBe(true);
  });

  it("does not detect completion when no task is active", async () => {
    const state = createInitialState();
    const result = await observe(state, [
      {
        turn_index: 0,
        role: "assistant",
        content: "Everything is done and all tests pass.",
      },
    ]);

    expect(result.events).toHaveLength(0);
  });

  it("skips already-processed turns", async () => {
    let state = createInitialState();
    const first = await observe(state, [
      { turn_index: 0, role: "user", content: "Please implement a feature" },
    ]);
    state = first.state;

    // Re-send the same turn
    const second = await observe(state, [
      { turn_index: 0, role: "user", content: "Please implement a feature" },
    ]);

    expect(second.events).toHaveLength(0);
  });

  it("processes multiple turns incrementally", async () => {
    const state = createInitialState();
    const result = await observe(state, [
      { turn_index: 0, role: "user", content: "Please build the auth module" },
      {
        turn_index: 1,
        role: "assistant",
        content:
          "I didn't expect the error — actually the endpoint returns 500 instead of 200. Turns out it's a different API.",
      },
      {
        turn_index: 2,
        role: "assistant",
        content: "Done! Everything is working, all tests pass successfully.",
      },
    ]);

    expect(result.events.map((e) => e.type)).toEqual([
      "TASK_START",
      "PRESSURE_DETECTED",
      "COMPLETION_SIGNAL",
    ]);
    expect(result.state.task_stage).toBe("DONE");
    expect(result.state.last_processed_turn).toBe(2);
  });
});

// ============================================================================
// PROJECTIONS — Integration with Decision OS core
// ============================================================================

describe("observer projections", () => {
  let testDir: string;
  let service: DecisionOSService;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dos-observer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const projectDir = join(testDir, "myproject");
    const dosPath = join(projectDir, ".decision-os");
    await mkdir(join(dosPath, "cases"), { recursive: true });
    await mkdir(join(dosPath, "defaults"), { recursive: true });

    const { writeFile } = await import("fs/promises");
    const YAML = (await import("yaml")).default;
    await writeFile(
      join(dosPath, "config.yaml"),
      YAML.stringify({ project: "test-project", version: 1, scope: "PROJECT" })
    );
    await writeFile(
      join(dosPath, "defaults", "foundations.yaml"),
      YAML.stringify({ foundations: [] })
    );

    const storage = new HierarchicalDecisionOSStorage(projectDir);
    await storage.initialize();
    service = new DecisionOSService(storage);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("projects CREATE_CASE action into a real case", async () => {
    const results = await projectActions(service, [
      { type: "CREATE_CASE", title: "Observer-detected task" },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].artifact_id).toMatch(/^\d{4}-observer-detected-task$/);
    expect(service.getActiveCase()).toBe(results[0].artifact_id);
  });

  it("projects LOG_PRESSURE action", async () => {
    // Need a case first
    await service.createCase({ title: "test" });

    const results = await projectActions(service, [
      {
        type: "LOG_PRESSURE",
        summary: "API returned 403 unexpectedly",
        expected: "API returns 200",
        actual: "API returns 403",
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].artifact_id).toMatch(/^PE-\d{4}$/);
  });

  it("projects CLOSE_CASE action", async () => {
    await service.createCase({ title: "test" });

    const results = await projectActions(service, [
      { type: "CLOSE_CASE", notes: "Auto-detected completion" },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(service.getActiveCase()).toBeNull();
  });

  it("handles errors gracefully", async () => {
    // No active case — LOG_PRESSURE should fail
    const results = await projectActions(service, [
      { type: "LOG_PRESSURE", summary: "should fail" },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain("No active case");
  });

  it("projects full observer flow end-to-end", async () => {
    // Simulate: user request -> pressure -> completion
    let state = createInitialState("e2e-test");

    const turns: ObserverTurn[] = [
      { turn_index: 0, role: "user", content: "Please implement the auth module" },
      {
        turn_index: 1,
        role: "assistant",
        content:
          "Unexpected error — actually the endpoint returns 500. Turns out the auth service was updated.",
      },
      {
        turn_index: 2,
        role: "assistant",
        content: "Done! Everything is complete, all tests pass successfully.",
      },
    ];

    const output = await observe(state, turns);

    // Project all actions
    const results = await projectActions(service, output.actions);

    // Should have: CREATE_CASE, LOG_PRESSURE, CLOSE_CASE
    const successful = results.filter((r) => r.success);
    expect(successful.length).toBeGreaterThanOrEqual(2); // At least case + close
    expect(results.find((r) => r.action.type === "CREATE_CASE")?.success).toBe(true);
  });

  it("toFeedbackEvents converts CREATE_CASE result to CASE_OPENED", () => {
    const feedback = toFeedbackEvents(
      [
        {
          action: { type: "CREATE_CASE", title: "test" },
          success: true,
          artifact_id: "0001-test",
        },
      ],
      0
    );

    expect(feedback).toHaveLength(1);
    expect(feedback[0].type).toBe("CASE_OPENED");
    expect(feedback[0].artifact_id).toBe("0001-test");
  });

  it("toFeedbackEvents converts CLOSE_CASE result to CASE_CLOSED", () => {
    const feedback = toFeedbackEvents(
      [
        {
          action: { type: "CLOSE_CASE", notes: "done" },
          success: true,
          artifact_id: "0001-test",
        },
      ],
      5
    );

    expect(feedback).toHaveLength(1);
    expect(feedback[0].type).toBe("CASE_CLOSED");
    expect(feedback[0].artifact_id).toBe("0001-test");
  });

  it("toFeedbackEvents skips failed projections", () => {
    const feedback = toFeedbackEvents(
      [
        {
          action: { type: "LOG_PRESSURE", summary: "failed" },
          success: false,
          error: "No active case",
        },
      ],
      1
    );

    expect(feedback).toHaveLength(0);
  });

  it("toFeedbackEvents skips LOG_PRESSURE (no feedback needed)", () => {
    const feedback = toFeedbackEvents(
      [
        {
          action: { type: "LOG_PRESSURE", summary: "pressure" },
          success: true,
          artifact_id: "PE-0001",
        },
      ],
      1
    );

    expect(feedback).toHaveLength(0);
  });
});

// ============================================================================
// PERSISTENCE
// ============================================================================

describe("observer persistence", () => {
  let testDir: string;
  let persistence: ObserverPersistence;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dos-persist-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
    persistence = new ObserverPersistence(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("saves and loads session state", async () => {
    const state = createInitialState("persist-test");
    const updated = applyEvent(state, {
      turn_index: 0,
      type: "TASK_START",
      summary: "Test task",
    });

    await persistence.save(updated);
    const loaded = await persistence.load("persist-test");

    expect(loaded).not.toBeNull();
    expect(loaded!.session_id).toBe("persist-test");
    expect(loaded!.task_stage).toBe("INTAKE");
    expect(loaded!.task_label).toBe("Test task");
    expect(loaded!.event_log).toHaveLength(1);
  });

  it("returns null for non-existent session", async () => {
    const loaded = await persistence.load("does-not-exist");
    expect(loaded).toBeNull();
  });

  it("lists saved sessions", async () => {
    await persistence.save(createInitialState("session-a"));
    await persistence.save(createInitialState("session-b"));

    const sessions = await persistence.listSessions();
    expect(sessions.sort()).toEqual(["session-a", "session-b"]);
  });

  it("creates observer directory structure on save", async () => {
    const freshDir = join(testDir, "fresh");
    const freshPersistence = new ObserverPersistence(freshDir);

    await freshPersistence.save(createInitialState("auto-create"));
    expect(existsSync(join(freshDir, "observer", "sessions", "auto-create.json"))).toBe(true);
  });

  it("overwrites existing session on re-save", async () => {
    let state = createInitialState("overwrite-test");
    await persistence.save(state);

    state = applyEvent(state, {
      turn_index: 0,
      type: "TASK_START",
      summary: "Updated task",
    });
    await persistence.save(state);

    const loaded = await persistence.load("overwrite-test");
    expect(loaded!.task_label).toBe("Updated task");
    expect(loaded!.event_log).toHaveLength(1);
  });
});

// ============================================================================
// ORCHESTRATOR — Full cycle with feedback loop
// ============================================================================

describe("observer orchestrator", () => {
  let testDir: string;
  let service: DecisionOSService;
  let dosPath: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dos-orch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const projectDir = join(testDir, "myproject");
    dosPath = join(projectDir, ".decision-os");
    await mkdir(join(dosPath, "cases"), { recursive: true });
    await mkdir(join(dosPath, "defaults"), { recursive: true });

    const { writeFile } = await import("fs/promises");
    const YAML = (await import("yaml")).default;
    await writeFile(
      join(dosPath, "config.yaml"),
      YAML.stringify({ project: "test-project", version: 1, scope: "PROJECT" })
    );
    await writeFile(
      join(dosPath, "defaults", "foundations.yaml"),
      YAML.stringify({ foundations: [] })
    );

    const storage = new HierarchicalDecisionOSStorage(projectDir);
    await storage.initialize();
    service = new DecisionOSService(storage);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("runCycle feeds projection results back into state", async () => {
    const state = createInitialState("cycle-test");

    const result = await runCycle(
      state,
      [{ turn_index: 0, role: "user", content: "Please implement the auth module" }],
      service
    );

    // Should detect TASK_START and project CREATE_CASE
    expect(result.detected.map((e) => e.type)).toContain("TASK_START");

    // Feedback should include CASE_OPENED
    expect(result.feedback.map((e) => e.type)).toContain("CASE_OPENED");

    // State should reflect the case ID from the projection
    expect(result.state.case_status).toBe("OPEN");
    expect(result.state.active_case_id).toMatch(/^\d{4}-/);
  });

  it("runCycle full lifecycle: open → pressure → close", async () => {
    let state = createInitialState("lifecycle-test");

    // Turn 0: task start → case opens
    const r1 = await runCycle(
      state,
      [{ turn_index: 0, role: "user", content: "Please build the caching layer" }],
      service
    );
    state = r1.state;
    expect(state.case_status).toBe("OPEN");
    expect(state.active_case_id).toBeDefined();
    const caseId = state.active_case_id!;

    // Turn 1: pressure detected
    const r2 = await runCycle(
      state,
      [{
        turn_index: 1,
        role: "assistant",
        content: "I didn't expect this error — actually the cache returns stale data. Turns out the TTL config was wrong.",
      }],
      service
    );
    state = r2.state;
    expect(state.open_pressure_summaries.length).toBeGreaterThanOrEqual(1);
    expect(state.active_case_id).toBe(caseId); // Case still open

    // Turn 2: completion → case closes
    const r3 = await runCycle(
      state,
      [{
        turn_index: 2,
        role: "assistant",
        content: "Done! Everything is complete, all tests pass successfully.",
      }],
      service
    );
    state = r3.state;
    expect(state.case_status).toBe("CLOSED");
    expect(state.active_case_id).toBeUndefined();
    expect(state.task_stage).toBe("DONE");

    // Event log should have the full sequence
    const types = state.event_log.map((e) => e.type);
    expect(types).toContain("TASK_START");
    expect(types).toContain("CASE_OPENED");
    expect(types).toContain("PRESSURE_DETECTED");
    expect(types).toContain("COMPLETION_SIGNAL");
    expect(types).toContain("CASE_CLOSED");
  });

  it("ObserverOrchestrator persists state between calls", async () => {
    const persistence = new ObserverPersistence(dosPath);
    const orchestrator = new ObserverOrchestrator(service, persistence);
    const initial = createInitialState("persist-cycle");

    // First call — provides initial state
    const r1 = await orchestrator.process("persist-cycle", [
      { turn_index: 0, role: "user", content: "Please fix the login flow" },
    ], initial);

    expect(r1.state.case_status).toBe("OPEN");

    // Second call — loads state from persistence (no initial state needed)
    const r2 = await orchestrator.process("persist-cycle", [
      {
        turn_index: 1,
        role: "assistant",
        content: "Done! Everything is finished, all tests pass successfully.",
      },
    ]);

    expect(r2.state.case_status).toBe("CLOSED");
    expect(r2.state.task_stage).toBe("DONE");

    // Verify persisted state matches
    const loaded = await persistence.load("persist-cycle");
    expect(loaded!.case_status).toBe("CLOSED");
    expect(loaded!.event_log.length).toBeGreaterThanOrEqual(3);
  });

  it("ObserverOrchestrator throws when no state exists", async () => {
    const persistence = new ObserverPersistence(dosPath);
    const orchestrator = new ObserverOrchestrator(service, persistence);

    await expect(
      orchestrator.process("nonexistent", [
        { turn_index: 0, role: "user", content: "hello" },
      ])
    ).rejects.toThrow("No existing session");
  });
});
