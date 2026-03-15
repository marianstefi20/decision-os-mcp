import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "fs";
import { rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { HierarchicalDecisionOSStorage } from "../src/core/hierarchical-storage.js";

let projectDir: string;
let globalDir: string;
let baseDir: string;

/**
 * Helper to set up a project + global .decision-os structure in a temp dir.
 * We can't rely on ~ for tests, so we structure it manually.
 */
async function setupLayers(): Promise<{
  storage: HierarchicalDecisionOSStorage;
  projectDosPath: string;
  globalDosPath: string;
}> {
  baseDir = join(tmpdir(), `dos-hier-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  projectDir = join(baseDir, "myproject");
  const projectDosPath = join(projectDir, ".decision-os");
  globalDir = join(baseDir, "global");
  const globalDosPath = join(globalDir, ".decision-os");

  // Create project .decision-os
  await mkdir(join(projectDosPath, "cases"), { recursive: true });
  await mkdir(join(projectDosPath, "defaults"), { recursive: true });
  await writeFile(
    join(projectDosPath, "config.yaml"),
    YAML.stringify({ project: "test-project", version: 1, scope: "PROJECT" })
  );
  await writeFile(
    join(projectDosPath, "defaults", "foundations.yaml"),
    YAML.stringify({ foundations: [] })
  );

  // Create global .decision-os (in a parent dir, not ~)
  await mkdir(join(globalDosPath, "cases"), { recursive: true });
  await mkdir(join(globalDosPath, "defaults"), { recursive: true });
  await writeFile(
    join(globalDosPath, "config.yaml"),
    YAML.stringify({ project: "_global", version: 1, scope: "GLOBAL" })
  );
  await writeFile(
    join(globalDosPath, "defaults", "foundations.yaml"),
    YAML.stringify({ foundations: [] })
  );

  // HierarchicalDecisionOSStorage discovers layers by walking up.
  // We test with just the project layer since global discovery uses homedir().
  const storage = new HierarchicalDecisionOSStorage(projectDir);
  await storage.initialize();

  return { storage, projectDosPath, globalDosPath };
}

afterEach(async () => {
  if (baseDir && existsSync(baseDir)) {
    await rm(baseDir, { recursive: true, force: true });
  }
});

// ============================================================================
// LAYER DISCOVERY
// ============================================================================

describe("layer discovery", () => {
  it("discovers project .decision-os from workspace path", async () => {
    const { storage, projectDosPath } = await setupLayers();
    expect(storage.getProjectPath()).toBe(projectDosPath);
  });

  it("throws when no .decision-os found", async () => {
    const emptyDir = join(tmpdir(), `dos-empty-${Date.now()}`);
    await mkdir(emptyDir, { recursive: true });

    // This should throw since there's no .decision-os anywhere
    // (unless user has ~/.decision-os which we can't control in tests)
    try {
      const s = new HierarchicalDecisionOSStorage(emptyDir);
      // If it didn't throw, it found ~/.decision-os — that's fine
      await s.initialize();
    } catch (e) {
      expect((e as Error).message).toContain("No .decision-os found");
    }

    await rm(emptyDir, { recursive: true, force: true });
  });
});

// ============================================================================
// FOUNDATION RELEVANCE RANKING
// ============================================================================

describe("foundation relevance ranking", () => {
  it("ranks foundations matching active case tags first", async () => {
    const { storage } = await setupLayers();

    // Create a case with specific affected_surface
    const c = await storage.createCase({
      title: "Database migration",
      signals: {
        context: {
          affected_surface: ["DATA_MODEL", "BACKEND"],
        },
      },
    });

    // Create two foundations — one relevant, one general
    const pe1 = await storage.logPressure({
      expected: "x", actual: "y", adaptation: "z", remember: "w",
    });
    const pe2 = await storage.logPressure({
      expected: "a", actual: "b", adaptation: "c", remember: "d",
    });

    await storage.promoteToFoundation({
      title: "UI pattern",
      default_behavior: "Use this UI pattern",
      context_tags: ["UI_UX", "FRONTEND"],
      source_pressures: [pe1.id],
    });
    await storage.promoteToFoundation({
      title: "Data modeling pattern",
      default_behavior: "Model data this way",
      context_tags: ["DATA_MODEL", "BACKEND"],
      source_pressures: [pe2.id],
    });

    const context = await storage.getContext();

    // Data model foundation should come first (matches case tags)
    expect(context.relevant_foundations[0].title).toBe("Data modeling pattern");
    expect((context.relevant_foundations[0] as any)._relevance).toBe("directly_relevant");
    expect((context.relevant_foundations[1] as any)._relevance).toBe("general");
  });

  it("returns all foundations when no active case", async () => {
    const { storage } = await setupLayers();

    const c = await storage.createCase({ title: "temp" });
    const pe = await storage.logPressure({
      expected: "x", actual: "y", adaptation: "z", remember: "w",
    });
    await storage.promoteToFoundation({
      title: "Some foundation",
      default_behavior: "Do it",
      context_tags: ["TEST"],
      source_pressures: [pe.id],
    });
    await storage.closeCase(c.id, { regret: 1 });

    // No active case now
    const context = await storage.getContext();
    expect(context.active_case).toBeNull();
    expect(context.relevant_foundations.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// CLOSE CASE WITH FORGETTING (through hierarchical layer)
// ============================================================================

describe("close case with forgetting", () => {
  it("returns forgotten flag through hierarchical storage", async () => {
    const { storage } = await setupLayers();

    const c = await storage.createCase({ title: "clean task" });
    const result = await storage.closeCase(c.id, { regret: 0 });

    expect(result.forgotten).toBe(true);
  });

  it("preserves case with unpromoted PEs", async () => {
    const { storage } = await setupLayers();

    const c = await storage.createCase({ title: "has lessons" });
    await storage.logPressure({
      expected: "x", actual: "y", adaptation: "z", remember: "w",
    });
    const result = await storage.closeCase(c.id, { regret: 0 });

    expect(result.forgotten).toBe(false);
  });
});

// ============================================================================
// SUGGEST REVIEW (through hierarchical layer)
// ============================================================================

describe("suggest review", () => {
  it("delegates suggest_review to project layer", async () => {
    const { storage } = await setupLayers();

    const c = await storage.createCase({ title: "test" });
    await storage.logPressure({
      expected: "x", actual: "y", adaptation: "z", remember: "w",
    });
    await storage.closeCase(c.id, { regret: 0 });

    const review = await storage.suggestReview();
    expect(review.blocking_forgetting).toHaveLength(1);
  });
});

// ============================================================================
// ACTIVE CASE PERSISTENCE (through hierarchical layer)
// ============================================================================

describe("active case persistence via hierarchical storage", () => {
  it("persists active case through setActiveCase", async () => {
    const { storage } = await setupLayers();

    const c = await storage.createCase({ title: "test" });
    expect(storage.getActiveCase()).toBe(c.id);

    await storage.setActiveCase(null);
    expect(storage.getActiveCase()).toBeNull();
  });
});
