import { describe, it, expect } from "vitest";
import { formatContextTable, type GetContextResult } from "./format-table.js";
import type { FoundationWithSource } from "../core/hierarchical-storage.js";

function makeFoundation(overrides: Partial<FoundationWithSource> & { id: string; title: string }): FoundationWithSource {
  return {
    default_behavior: "test behavior",
    context_tags: [],
    confidence: 1 as 0 | 1 | 2 | 3,
    scope: "PROJECT",
    source_pressures: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    _source_layer: "/tmp/test/.decision-os",
    _source_scope: "PROJECT",
    ...overrides,
  };
}

function makeContext(overrides: Partial<GetContextResult> = {}): GetContextResult {
  return {
    project: "test-project",
    active_case: null,
    recent_pressures: [],
    relevant_foundations: [],
    conflicts: [],
    layers: ["/tmp/test/.decision-os"],
    ...overrides,
  };
}

describe("formatContextTable", () => {
  it("renders header with project name and layers", () => {
    const table = formatContextTable(makeContext());

    expect(table).toContain("# Foundations (test-project)");
    expect(table).toContain("Layers: /tmp/test/.decision-os");
  });

  it("shows 'No foundations yet' when empty", () => {
    const table = formatContextTable(makeContext());

    expect(table).toContain("No foundations yet.");
    expect(table).not.toContain("| ID |");
  });

  it("renders foundations as markdown table rows", () => {
    const context = makeContext({
      relevant_foundations: [
        makeFoundation({
          id: "F-0001",
          title: "Use svh not dvh on iOS",
          _source_scope: "PROJECT",
          confidence: 1,
          context_tags: ["iOS-Safari", "CSS"],
          counter_contexts: ["non-iOS"],
        }),
        makeFoundation({
          id: "GF-0001",
          title: "First-principles data modeling",
          _source_scope: "GLOBAL",
          _source_layer: "/Users/test/.decision-os",
          confidence: 2,
          context_tags: ["ARCHITECTURE"],
        }),
      ],
    });
    const table = formatContextTable(context);

    // Table header
    expect(table).toContain("| ID | Foundation | Scope | Conf | Applies | NOT |");
    expect(table).toContain("|---|---|---|---|---|---|");

    // Project foundation row
    expect(table).toContain("| F-0001 | Use svh not dvh on iOS | PROJECT | 1/3 | iOS-Safari, CSS | non-iOS |");

    // Global foundation row
    expect(table).toContain("| GF-0001 | First-principles data modeling | GLOBAL | 2/3 | ARCHITECTURE | — |");
  });

  it("shows active case when present", () => {
    const context = makeContext({
      active_case: {
        id: "0042-fix-map-bug",
        title: "Fix map rendering on mobile",
        status: "ACTIVE",
        created_at: "2026-01-01T00:00:00Z",
      },
    });
    const table = formatContextTable(context);

    expect(table).toContain('Active case: 0042-fix-map-bug — "Fix map rendering on mobile"');
  });

  it("does not show active case line when none", () => {
    const table = formatContextTable(makeContext());

    expect(table).not.toContain("Active case:");
  });

  it("shows conflicts when detected", () => {
    const context = makeContext({
      conflicts: [
        {
          title: "Viewport handling",
          global_foundation: makeFoundation({ id: "GF-0001", title: "Use dvh" }),
          project_foundation: makeFoundation({ id: "F-0001", title: "Use svh" }),
          recommendation: "Project version takes precedence",
        },
      ],
    });
    const table = formatContextTable(context);

    expect(table).toContain("**Conflicts:**");
    expect(table).toContain("- Viewport handling: Project version takes precedence");
  });

  it("shortens home directory paths in layers", () => {
    const home = process.env.HOME!;
    const context = makeContext({
      layers: [
        `${home}/Documents/MyProject/.decision-os`,
        `${home}/.decision-os`,
      ],
    });
    const table = formatContextTable(context);

    expect(table).toContain("~/Documents/MyProject/.decision-os");
    expect(table).toContain("~/.decision-os");
    expect(table).not.toContain(home);
  });

  it("uses dash for missing counter_contexts", () => {
    const context = makeContext({
      relevant_foundations: [
        makeFoundation({
          id: "F-0001",
          title: "Test foundation",
          context_tags: ["TAG"],
          // no counter_contexts
        }),
      ],
    });
    const table = formatContextTable(context);

    expect(table).toMatch(/\| F-0001 .+\| — \|$/m);
  });

  it("joins multiple layers with arrow separator", () => {
    const context = makeContext({
      layers: ["/project/.decision-os", "/workspace/.decision-os"],
    });
    const table = formatContextTable(context);

    expect(table).toContain("Layers: /project/.decision-os → /workspace/.decision-os");
  });
});
