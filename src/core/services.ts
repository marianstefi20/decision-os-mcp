import { HierarchicalDecisionOSStorage } from "./hierarchical-storage.js";
import type { Case, PressureEvent, Foundation } from "./schemas.js";

/**
 * Thin service layer over HierarchicalDecisionOSStorage.
 * Provides the same operations the MCP tools use, callable without MCP.
 * The observer uses this to project detected events into Decision OS.
 */
export class DecisionOSService {
  constructor(private storage: HierarchicalDecisionOSStorage) {}

  async createCase(input: {
    title: string;
    goal?: string;
    signals?: Case["signals"];
    touched_areas?: string[];
  }): Promise<Case> {
    return this.storage.createCase({
      title: input.title,
      goal: input.goal,
      signals: input.signals ? { context: input.signals.context } : undefined,
      touched_areas: input.touched_areas,
    });
  }

  async closeCase(input: {
    case_id?: string;
    regret: string | number;
    notes?: string;
    regressions?: string;
  }): Promise<{ case: Case; forgotten: boolean }> {
    const caseId = input.case_id || this.storage.getActiveCase();
    if (!caseId) {
      throw new Error("No active case. Specify case_id.");
    }
    return this.storage.closeCase(caseId, {
      regret: input.regret,
      notes: input.notes,
      regressions: input.regressions,
    });
  }

  async logPressure(input: {
    case_id?: string;
    expected: string;
    actual: string;
    adaptation: string;
    remember: string;
    pressure_type?: string;
    context_tags?: string[];
  }): Promise<PressureEvent> {
    return this.storage.logPressure(input);
  }

  async quickPressure(input: {
    case_id?: string;
    expected: string;
    actual: string;
    remember?: string;
    adaptation?: string;
    pressure_type?: string;
    context_tags?: string[];
  }): Promise<PressureEvent> {
    const remember = input.remember ??
      `Expected: ${input.expected.slice(0, 40)}… but: ${input.actual.slice(0, 40)}…`;
    const adaptation = input.adaptation ?? "(captured for review)";
    return this.storage.logPressure({
      case_id: input.case_id,
      expected: input.expected,
      actual: input.actual,
      adaptation,
      remember,
      pressure_type: input.pressure_type,
      context_tags: input.context_tags,
    });
  }

  getActiveCase(): string | null {
    return this.storage.getActiveCase();
  }

  async getContext() {
    return this.storage.getContext();
  }
}
