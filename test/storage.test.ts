import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "fs";
import { readFile, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { DecisionOSStorage } from "../src/core/storage.js";

let storage: DecisionOSStorage;
let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `decision-os-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
  storage = new DecisionOSStorage(testDir);
  await storage.initialize();
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ============================================================================
// ACTIVE CASE PERSISTENCE
// ============================================================================

describe("active case persistence", () => {
  it("persists active case to .active-case file", async () => {
    const c = await storage.createCase({ title: "test case" });
    const activeCasePath = join(testDir, ".active-case");
    expect(existsSync(activeCasePath)).toBe(true);

    const persisted = (await readFile(activeCasePath, "utf-8")).trim();
    expect(persisted).toBe(c.id);
  });

  it("restores active case on re-initialization", async () => {
    const c = await storage.createCase({ title: "test case" });

    // Create a new storage instance pointing at same dir
    const storage2 = new DecisionOSStorage(testDir);
    await storage2.initialize();

    expect(storage2.getActiveCase()).toBe(c.id);
  });

  it("clears .active-case file when set to null", async () => {
    await storage.createCase({ title: "test case" });
    await storage.setActiveCase(null);

    const activeCasePath = join(testDir, ".active-case");
    expect(existsSync(activeCasePath)).toBe(false);
  });

  it("clears stale .active-case if case directory was deleted", async () => {
    const c = await storage.createCase({ title: "test case" });

    // Manually delete the case directory
    await rm(join(testDir, "cases", c.id), { recursive: true, force: true });

    // Re-initialize — should clear stale reference
    const storage2 = new DecisionOSStorage(testDir);
    await storage2.initialize();

    expect(storage2.getActiveCase()).toBeNull();
    expect(existsSync(join(testDir, ".active-case"))).toBe(false);
  });

  it("setActiveCase updates the persisted file", async () => {
    const c1 = await storage.createCase({ title: "first case" });
    const c2 = await storage.createCase({ title: "second case" });

    // c2 is now active (createCase sets it)
    const activeCasePath = join(testDir, ".active-case");
    const persisted = (await readFile(activeCasePath, "utf-8")).trim();
    expect(persisted).toBe(c2.id);

    // Switch back to c1
    await storage.setActiveCase(c1.id);
    const persisted2 = (await readFile(activeCasePath, "utf-8")).trim();
    expect(persisted2).toBe(c1.id);
  });
});

// ============================================================================
// CASES & PRESSURE EVENTS (core mechanics)
// ============================================================================

describe("cases", () => {
  it("creates a case with auto-generated id", async () => {
    const c = await storage.createCase({ title: "Add tile caching" });
    expect(c.id).toMatch(/^\d{4}-add-tile-caching$/);
    expect(c.status).toBe("ACTIVE");
    expect(c.title).toBe("Add tile caching");
  });

  it("sets created case as active", async () => {
    const c = await storage.createCase({ title: "test" });
    expect(storage.getActiveCase()).toBe(c.id);
  });

  it("lists cases sorted by id", async () => {
    await storage.createCase({ title: "first" });
    await storage.createCase({ title: "second" });
    await storage.createCase({ title: "third" });

    const cases = await storage.listCases();
    expect(cases).toHaveLength(3);
    expect(cases[0].title).toBe("first");
    expect(cases[2].title).toBe("third");
  });

  it("closes a case with outcome signals", async () => {
    const c = await storage.createCase({ title: "test" });
    const result = await storage.closeCase(c.id, { regret: 1, notes: "could improve" });

    expect(result.case.status).toBe("COMPLETED");
    expect(result.case.signals?.outcome?.regret).toBe("1");
    expect(result.case.signals?.outcome?.notes).toBe("could improve");
  });
});

describe("pressure events", () => {
  it("logs a pressure event to the active case", async () => {
    const c = await storage.createCase({ title: "test" });
    const pe = await storage.logPressure({
      expected: "API returns 200",
      actual: "API returns 403",
      adaptation: "Added auth header",
      remember: "This API requires auth",
    });

    expect(pe.id).toMatch(/^PE-\d{4}$/);
    expect(pe.case_id).toBe(c.id);
    expect(pe.expected).toBe("API returns 200");
  });

  it("throws when logging without active case", async () => {
    await expect(
      storage.logPressure({
        expected: "x",
        actual: "y",
        adaptation: "z",
        remember: "w",
      })
    ).rejects.toThrow("No active case");
  });

  it("updates the case's pressure_events list", async () => {
    const c = await storage.createCase({ title: "test" });
    const pe = await storage.logPressure({
      expected: "x",
      actual: "y",
      adaptation: "z",
      remember: "w",
    });

    const updated = await storage.getCase(c.id);
    expect(updated?.pressure_events).toContain(pe.id);
  });

  it("searches pressure events by query", async () => {
    await storage.createCase({ title: "test" });
    await storage.logPressure({
      expected: "database query fast",
      actual: "query took 5 seconds",
      adaptation: "added index",
      remember: "Always index foreign keys",
      context_tags: ["DATABASE"],
    });
    await storage.logPressure({
      expected: "API returns JSON",
      actual: "API returns XML",
      adaptation: "added parser",
      remember: "Check content type",
    });

    const results = await storage.searchPressures("database");
    expect(results).toHaveLength(1);
    expect(results[0].remember).toBe("Always index foreign keys");
  });
});

// ============================================================================
// AUTO-FORGET
// ============================================================================

describe("auto-forget", () => {
  it("forgets case with regret 0 and no PEs", async () => {
    const c = await storage.createCase({ title: "clean task" });
    const result = await storage.closeCase(c.id, { regret: 0 });

    expect(result.forgotten).toBe(true);
    expect(existsSync(join(testDir, "cases", c.id))).toBe(false);
  });

  it("forgets case with regret 0 and all PEs promoted", async () => {
    const c = await storage.createCase({ title: "learned task" });
    const pe = await storage.logPressure({
      expected: "x",
      actual: "y",
      adaptation: "z",
      remember: "w",
      context_tags: ["TEST"],
    });

    // Promote the PE to a foundation
    await storage.promoteToFoundation({
      title: "Test foundation",
      default_behavior: "Do the thing",
      context_tags: ["TEST"],
      source_pressures: [pe.id],
    });

    const result = await storage.closeCase(c.id, { regret: 0 });
    expect(result.forgotten).toBe(true);
    expect(existsSync(join(testDir, "cases", c.id))).toBe(false);
  });

  it("keeps case with regret 0 but unpromoted PEs", async () => {
    const c = await storage.createCase({ title: "has lessons" });
    await storage.logPressure({
      expected: "x",
      actual: "y",
      adaptation: "z",
      remember: "w",
    });

    const result = await storage.closeCase(c.id, { regret: 0 });
    expect(result.forgotten).toBe(false);
    expect(existsSync(join(testDir, "cases", c.id))).toBe(true);
  });

  it("keeps case with regret 1+", async () => {
    const c = await storage.createCase({ title: "regretful task" });
    const result = await storage.closeCase(c.id, { regret: 1 });

    expect(result.forgotten).toBe(false);
    expect(existsSync(join(testDir, "cases", c.id))).toBe(true);
  });

  it("keeps case with regret 2 even without PEs", async () => {
    const c = await storage.createCase({ title: "big regret" });
    const result = await storage.closeCase(c.id, { regret: 2 });

    expect(result.forgotten).toBe(false);
    expect(result.case.status).toBe("COMPLETED");
  });

  it("clears active case after forgetting", async () => {
    const c = await storage.createCase({ title: "clean task" });
    expect(storage.getActiveCase()).toBe(c.id);

    await storage.closeCase(c.id, { regret: 0 });
    expect(storage.getActiveCase()).toBeNull();
  });
});

// ============================================================================
// SUGGEST REVIEW
// ============================================================================

describe("suggest_review", () => {
  it("returns empty review when no cases exist", async () => {
    const review = await storage.suggestReview();
    expect(review.foundation_candidates).toHaveLength(0);
    expect(review.blocking_forgetting).toHaveLength(0);
    expect(review.high_regret_no_pe).toHaveLength(0);
    expect(review.summary).toContain("Nothing to review");
  });

  it("identifies cases blocking forgetting", async () => {
    const c = await storage.createCase({ title: "blocking case" });
    await storage.logPressure({
      expected: "x",
      actual: "y",
      adaptation: "z",
      remember: "w",
    });
    await storage.closeCase(c.id, { regret: 0 });

    const review = await storage.suggestReview();
    expect(review.blocking_forgetting).toHaveLength(1);
    expect(review.blocking_forgetting[0].case_id).toBe(c.id);
    expect(review.blocking_forgetting[0].unpromoted_pe_count).toBe(1);
  });

  it("identifies high-regret cases with no PEs", async () => {
    const c = await storage.createCase({ title: "regretful case" });
    await storage.closeCase(c.id, { regret: 2 });

    const review = await storage.suggestReview();
    expect(review.high_regret_no_pe).toHaveLength(1);
    expect(review.high_regret_no_pe[0].case_id).toBe(c.id);
    expect(review.high_regret_no_pe[0].regret).toBe("2");
  });

  it("finds foundation candidates from clustered PEs", async () => {
    // Create two cases with PEs sharing context tags
    const c1 = await storage.createCase({ title: "case one" });
    await storage.logPressure({
      expected: "database fast",
      actual: "database slow",
      adaptation: "added index",
      remember: "Index foreign keys",
      context_tags: ["DATABASE", "PERFORMANCE"],
    });
    await storage.closeCase(c1.id, { regret: 1 });

    const c2 = await storage.createCase({ title: "case two" });
    await storage.logPressure({
      expected: "query returns quickly",
      actual: "query times out",
      adaptation: "optimized join",
      remember: "Watch N+1 queries",
      context_tags: ["DATABASE", "PERFORMANCE"],
    });
    await storage.closeCase(c2.id, { regret: 1 });

    const review = await storage.suggestReview();
    expect(review.foundation_candidates.length).toBeGreaterThanOrEqual(1);

    const dbCandidate = review.foundation_candidates.find(
      (fc) => fc.shared_tags.includes("DATABASE")
    );
    expect(dbCandidate).toBeDefined();
    expect(dbCandidate!.pressure_events).toHaveLength(2);
  });

  it("does not flag promoted PEs as candidates", async () => {
    const c = await storage.createCase({ title: "promoted case" });
    const pe = await storage.logPressure({
      expected: "x",
      actual: "y",
      adaptation: "z",
      remember: "w",
      context_tags: ["TEST"],
    });

    await storage.promoteToFoundation({
      title: "Test foundation",
      default_behavior: "Do the thing",
      context_tags: ["TEST"],
      source_pressures: [pe.id],
    });
    await storage.closeCase(c.id, { regret: 0 });
    // Case was forgotten (regret 0, all PEs promoted)

    const review = await storage.suggestReview();
    expect(review.foundation_candidates).toHaveLength(0);
    expect(review.blocking_forgetting).toHaveLength(0);
  });
});

// ============================================================================
// FOUNDATIONS
// ============================================================================

describe("foundations", () => {
  it("promotes pressure events to a foundation", async () => {
    const c = await storage.createCase({ title: "test" });
    const pe = await storage.logPressure({
      expected: "x",
      actual: "y",
      adaptation: "z",
      remember: "w",
      context_tags: ["AUTH"],
    });

    const foundation = await storage.promoteToFoundation({
      title: "Auth requires token",
      default_behavior: "Always pass auth token",
      context_tags: ["AUTH"],
      source_pressures: [pe.id],
    });

    expect(foundation.id).toMatch(/^F-\d{4}$/);
    expect(foundation.confidence).toBe(1);
    expect(foundation.scope).toBe("PROJECT");
  });

  it("marks promoted PEs with foundation id", async () => {
    const c = await storage.createCase({ title: "test" });
    const pe = await storage.logPressure({
      expected: "x",
      actual: "y",
      adaptation: "z",
      remember: "w",
    });

    const foundation = await storage.promoteToFoundation({
      title: "Test",
      default_behavior: "Do it",
      context_tags: ["TEST"],
      source_pressures: [pe.id],
    });

    const pressures = await storage.getPressureEvents(c.id);
    expect(pressures[0].promoted_to_foundation).toBe(foundation.id);
  });

  it("filters foundations by context_tags", async () => {
    await storage.createCase({ title: "test" });
    const pe1 = await storage.logPressure({
      expected: "x", actual: "y", adaptation: "z", remember: "w",
    });
    const pe2 = await storage.logPressure({
      expected: "a", actual: "b", adaptation: "c", remember: "d",
    });

    await storage.promoteToFoundation({
      title: "Auth thing",
      default_behavior: "Do auth",
      context_tags: ["AUTH"],
      source_pressures: [pe1.id],
    });
    await storage.promoteToFoundation({
      title: "DB thing",
      default_behavior: "Do db",
      context_tags: ["DATABASE"],
      source_pressures: [pe2.id],
    });

    const authOnly = await storage.getFoundations({ context_tags: ["AUTH"] });
    expect(authOnly).toHaveLength(1);
    expect(authOnly[0].title).toBe("Auth thing");
  });

  it("filters foundations by min_confidence", async () => {
    await storage.createCase({ title: "test" });
    const pe = await storage.logPressure({
      expected: "x", actual: "y", adaptation: "z", remember: "w",
    });

    const f = await storage.promoteToFoundation({
      title: "Low confidence",
      default_behavior: "Maybe do this",
      context_tags: ["TEST"],
      source_pressures: [pe.id],
    });

    // Foundation starts at confidence 1
    const highConfidence = await storage.getFoundations({ min_confidence: 2 });
    expect(highConfidence).toHaveLength(0);

    const lowConfidence = await storage.getFoundations({ min_confidence: 1 });
    expect(lowConfidence).toHaveLength(1);
  });

  it("removes a foundation by id", async () => {
    await storage.createCase({ title: "test" });
    const pe1 = await storage.logPressure({
      expected: "x", actual: "y", adaptation: "z", remember: "w",
    });
    const pe2 = await storage.logPressure({
      expected: "a", actual: "b", adaptation: "c", remember: "d",
    });

    const f1 = await storage.promoteToFoundation({
      title: "Keep this one",
      default_behavior: "Stay",
      context_tags: ["KEEP"],
      source_pressures: [pe1.id],
    });
    const f2 = await storage.promoteToFoundation({
      title: "Remove this one",
      default_behavior: "Go away",
      context_tags: ["REMOVE"],
      source_pressures: [pe2.id],
    });

    const removed = await storage.removeFoundation(f2.id);
    expect(removed).toBe(true);

    const remaining = await storage.getFoundations();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(f1.id);
    expect(remaining[0].title).toBe("Keep this one");
  });

  it("returns false when removing non-existent foundation", async () => {
    const removed = await storage.removeFoundation("F-9999");
    expect(removed).toBe(false);
  });

  it("returns false when no foundations file exists", async () => {
    // Fresh storage with no foundations file at all
    const removed = await storage.removeFoundation("F-0001");
    expect(removed).toBe(false);
  });
});

// ============================================================================
// QUICK PRESSURE (via logPressure with defaults)
// ============================================================================

describe("quick pressure (logPressure with defaults)", () => {
  it("accepts minimal fields with defaults filled in", async () => {
    await storage.createCase({ title: "test" });

    // Simulate what quick_pressure does in index.ts
    const remember = "Expected: API fast… but: API slow…";
    const adaptation = "(captured for review)";

    const pe = await storage.logPressure({
      expected: "API fast",
      actual: "API slow",
      adaptation,
      remember,
    });

    expect(pe.adaptation).toBe("(captured for review)");
    expect(pe.remember).toContain("API fast");
    expect(pe.remember).toContain("API slow");
  });
});

// ============================================================================
// POLICY CHECK
// ============================================================================

describe("policy check", () => {
  it("requires options comparison for high risk", () => {
    const result = storage.checkPolicy({ risk_level: "HIGH" });
    expect(result.require_options_comparison).toBe(true);
    expect(result.validation_level).toBe("STRICT");
  });

  it("returns BASIC for low risk", () => {
    const result = storage.checkPolicy({ risk_level: "LOW" });
    expect(result.require_options_comparison).toBe(false);
    expect(result.validation_level).toBe("BASIC");
  });

  it("returns STANDARD for medium risk", () => {
    const result = storage.checkPolicy({ risk_level: "MEDIUM" });
    expect(result.validation_level).toBe("STANDARD");
  });

  it("requires comparison for hard reversibility", () => {
    const result = storage.checkPolicy({ reversibility: "HARD" });
    expect(result.require_options_comparison).toBe(true);
  });

  it("requires STRICT for security boundary", () => {
    const result = storage.checkPolicy({
      affected_surface: ["SECURITY_BOUNDARY"],
    });
    expect(result.require_options_comparison).toBe(true);
    expect(result.validation_level).toBe("STRICT");
  });
});
