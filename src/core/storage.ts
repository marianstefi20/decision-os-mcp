import { readFile, writeFile, mkdir, readdir, rm, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import YAML from "yaml";
import { z } from "zod";
import {
  Case as CaseSchema,
  PressureEvent as PressureEventSchema,
  Foundation as FoundationSchema,
  ProjectConfig as ProjectConfigSchema,
} from "./schemas.js";
import type { Case, PressureEvent, Foundation, ProjectConfig } from "./schemas.js";

const PressureEventsFileSchema = z.object({
  events: z.array(PressureEventSchema).default([]),
});

const FoundationsFileSchema = z.object({
  foundations: z.array(FoundationSchema).default([]),
});

/**
 * Storage layer for Decision OS data.
 * Manages reading/writing cases, pressure events, and foundations
 * to the .decision-os folder structure.
 */
export class DecisionOSStorage {
  private _basePath: string;
  private activeCase: string | null = null;
  private nextPressureId: number = 1;
  private nextCaseId: number = 1;
  private nextFoundationId: number = 1;

  constructor(basePath: string) {
    this._basePath = basePath;
  }

  get basePath(): string {
    return this._basePath;
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  async initialize(): Promise<void> {
    // Ensure directory structure exists
    await this.ensureDir(this._basePath);
    await this.ensureDir(join(this._basePath, "cases"));
    await this.ensureDir(join(this._basePath, "defaults"));

    // Create config if it doesn't exist
    const configPath = join(this._basePath, "config.yaml");
    if (!existsSync(configPath)) {
      const defaultConfig: ProjectConfig = {
        project: "unnamed-project",
        version: 1,
        scope: "PROJECT",
      };
      await this.writeYaml(configPath, defaultConfig);
    }

    // Restore persisted active case
    await this.restoreActiveCase();

    // Initialize counters from existing data
    await this.initializeCounters();
  }

  private async restoreActiveCase(): Promise<void> {
    const activeCasePath = join(this._basePath, ".active-case");
    if (existsSync(activeCasePath)) {
      const caseId = (await readFile(activeCasePath, "utf-8")).trim();
      if (caseId && existsSync(join(this._basePath, "cases", caseId, "case.yaml"))) {
        this.activeCase = caseId;
        console.error(`Restored active case: ${caseId}`);
      } else {
        // Stale reference, clean up
        await unlink(activeCasePath).catch(() => {});
      }
    }
  }

  private async persistActiveCase(): Promise<void> {
    const activeCasePath = join(this._basePath, ".active-case");
    if (this.activeCase) {
      await writeFile(activeCasePath, this.activeCase, "utf-8");
    } else {
      await unlink(activeCasePath).catch(() => {});
    }
  }

  private async initializeCounters(): Promise<void> {
    // Scan existing cases for highest ID
    const cases = await this.listCases();
    for (const c of cases) {
      const match = c.id.match(/^(\d+)/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num >= this.nextCaseId) {
          this.nextCaseId = num + 1;
        }
      }

      // Also scan pressure events in each case
      const pressures = await this.getPressureEvents(c.id);
      for (const p of pressures) {
        const peMatch = p.id.match(/PE-(\d+)/);
        if (peMatch) {
          const num = parseInt(peMatch[1], 10);
          if (num >= this.nextPressureId) {
            this.nextPressureId = num + 1;
          }
        }
      }
    }

    // Scan foundations (both F- and GF- prefixes)
    const foundations = await this.getFoundations();
    for (const f of foundations) {
      const fMatch = f.id.match(/(?:G?F)-(\d+)/);
      if (fMatch) {
        const num = parseInt(fMatch[1], 10);
        if (num >= this.nextFoundationId) {
          this.nextFoundationId = num + 1;
        }
      }
    }
  }

  // ============================================================================
  // CONFIG
  // ============================================================================

  async getConfig(): Promise<ProjectConfig> {
    const configPath = join(this._basePath, "config.yaml");
    return this.readYamlValidated(configPath, ProjectConfigSchema, "project config");
  }

  async updateConfig(config: Partial<ProjectConfig>): Promise<void> {
    const current = await this.getConfig();
    const updated = { ...current, ...config };
    const validated = ProjectConfigSchema.parse(updated);
    await this.writeYaml(join(this._basePath, "config.yaml"), validated);
  }

  // ============================================================================
  // ACTIVE CASE
  // ============================================================================

  getActiveCase(): string | null {
    return this.activeCase;
  }

  async setActiveCase(caseId: string | null): Promise<void> {
    this.activeCase = caseId;
    await this.persistActiveCase();
  }

  // ============================================================================
  // CASES
  // ============================================================================

  async listCases(): Promise<Case[]> {
    const casesDir = join(this._basePath, "cases");
    if (!existsSync(casesDir)) return [];

    const entries = await readdir(casesDir, { withFileTypes: true });
    const cases: Case[] = [];

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith("_")) {
        const casePath = join(casesDir, entry.name, "case.yaml");
        if (existsSync(casePath)) {
          try {
            const caseData = await this.readYamlValidated(
              casePath,
              CaseSchema,
              "case"
            );
            cases.push(caseData);
          } catch {
            // Skip invalid cases
          }
        }
      }
    }

    return cases.sort((a, b) => a.id.localeCompare(b.id));
  }

  async getCase(caseId: string): Promise<Case | null> {
    const casePath = join(this._basePath, "cases", caseId, "case.yaml");
    if (!existsSync(casePath)) return null;
    return this.readYamlValidated(casePath, CaseSchema, "case");
  }

  async createCase(input: {
    title: string;
    goal?: string;
    signals?: Case["signals"];
    touched_areas?: string[];
  }): Promise<Case> {
    const id = `${String(this.nextCaseId).padStart(4, "0")}-${this.slugify(input.title)}`;
    this.nextCaseId++;

    const resolvedGoal =
      typeof input.goal === "string" && input.goal.trim().length > 0
        ? input.goal.trim()
        : input.title;

    const caseData: Case = {
      id,
      title: input.title,
      goal: resolvedGoal,
      status: "ACTIVE",
      created_at: new Date().toISOString(),
      context: {
        touched_areas: input.touched_areas,
      },
      signals: input.signals,
      pressure_events: [],
    };
    const validated = CaseSchema.parse(caseData);

    const caseDir = join(this._basePath, "cases", id);
    await this.ensureDir(caseDir);
    await this.writeYaml(join(caseDir, "case.yaml"), validated);

    // Create empty pressures file
    await this.writeYaml(join(caseDir, "pressures.yaml"), { events: [] });

    // Set as active
    await this.setActiveCase(validated.id);

    return validated;
  }

  async updateCase(caseId: string, updates: Partial<Case>): Promise<Case> {
    const current = await this.getCase(caseId);
    if (!current) {
      throw new Error(`Case not found: ${caseId}`);
    }

    const updated = { ...current, ...updates };
    const validated = CaseSchema.parse(updated);
    await this.writeYaml(
      join(this._basePath, "cases", caseId, "case.yaml"),
      validated
    );
    return validated;
  }

  async closeCase(
    caseId: string,
    outcome: {
      regret: string | number;
      notes?: string;
      regressions?: string;
    }
  ): Promise<{ case: Case; forgotten: boolean }> {
    const normalizedRegret = String(outcome.regret) as "0" | "1" | "2" | "3";
    const current = await this.getCase(caseId);
    const existingSignals = current?.signals ?? {};
    const updated = await this.updateCase(caseId, {
      status: "COMPLETED",
      completed_at: new Date().toISOString(),
      signals: {
        ...existingSignals,
        outcome: {
          regret: normalizedRegret,
          notes: outcome.notes,
          regressions: outcome.regressions as "NONE" | "MINOR" | "MAJOR",
        },
      },
    });

    if (this.activeCase === caseId) {
      await this.setActiveCase(null);
    }

    // Auto-forget: delete cases with regret 0 and no unpromoted PEs
    let forgotten = false;
    if (normalizedRegret === "0") {
      const pressures = await this.getPressureEvents(caseId);
      const allPromoted = pressures.length === 0 ||
        pressures.every(p => p.promoted_to_foundation);

      if (allPromoted) {
        await this.forgetCase(caseId);
        forgotten = true;
      }
    }

    return { case: updated, forgotten };
  }

  /**
   * Delete a case directory. Knowledge lives in foundations, not cases.
   * Cases with no novel pressure (regret 0, no unpromoted PEs) are forgotten.
   */
  async forgetCase(caseId: string): Promise<void> {
    const caseDir = join(this._basePath, "cases", caseId);
    if (existsSync(caseDir)) {
      await rm(caseDir, { recursive: true, force: true });
      console.error(`Forgot case ${caseId}: no novel pressure retained`);
    }
  }

  // ============================================================================
  // PRESSURE EVENTS
  // ============================================================================

  async getPressureEvents(caseId: string): Promise<PressureEvent[]> {
    const pressuresPath = join(
      this._basePath,
      "cases",
      caseId,
      "pressures.yaml"
    );
    if (!existsSync(pressuresPath)) return [];

    const data = await this.readYamlValidated(
      pressuresPath,
      PressureEventsFileSchema,
      "pressure events"
    );
    return data.events;
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
    const caseId = input.case_id || this.activeCase;
    if (!caseId) {
      throw new Error("No active case. Create a case first or specify case_id.");
    }

    const caseData = await this.getCase(caseId);
    if (!caseData) {
      throw new Error(`Case not found: ${caseId}`);
    }

    const id = `PE-${String(this.nextPressureId).padStart(4, "0")}`;
    this.nextPressureId++;

    const pressure: PressureEvent = {
      id,
      timestamp: new Date().toISOString(),
      case_id: caseId,
      pressure_type: input.pressure_type as PressureEvent["pressure_type"],
      context_tags: input.context_tags,
      expected: input.expected,
      actual: input.actual,
      adaptation: input.adaptation,
      remember: input.remember,
    };
    const validated = PressureEventSchema.parse(pressure);

    // Add to case's pressure events
    const pressures = await this.getPressureEvents(caseId);
    pressures.push(validated);
    await this.writeYaml(
      join(this._basePath, "cases", caseId, "pressures.yaml"),
      { events: pressures }
    );

    // Update case's pressure_events list
    const currentPEs = caseData.pressure_events || [];
    await this.updateCase(caseId, {
      pressure_events: [...currentPEs, id],
    });

    return validated;
  }

  async searchPressures(query: string): Promise<PressureEvent[]> {
    const cases = await this.listCases();
    const allPressures: PressureEvent[] = [];

    for (const c of cases) {
      const pressures = await this.getPressureEvents(c.id);
      allPressures.push(...pressures);
    }

    const lowerQuery = query.toLowerCase();
    return allPressures.filter(
      (p) =>
        p.expected.toLowerCase().includes(lowerQuery) ||
        p.actual.toLowerCase().includes(lowerQuery) ||
        p.adaptation.toLowerCase().includes(lowerQuery) ||
        p.remember.toLowerCase().includes(lowerQuery) ||
        p.context_tags?.some((t) => t.toLowerCase().includes(lowerQuery))
    );
  }

  // ============================================================================
  // FOUNDATIONS
  // ============================================================================

  async getFoundations(filters?: {
    context_tags?: string[];
    min_confidence?: number;
  }): Promise<Foundation[]> {
    const foundationsPath = join(this._basePath, "defaults", "foundations.yaml");
    if (!existsSync(foundationsPath)) return [];

    const data = await this.readYamlValidated(
      foundationsPath,
      FoundationsFileSchema,
      "foundations"
    );
    let foundations = data.foundations;

    if (filters?.context_tags?.length) {
      foundations = foundations.filter((f) =>
        f.context_tags.some((t) => filters.context_tags!.includes(t))
      );
    }

    if (filters?.min_confidence !== undefined) {
      foundations = foundations.filter(
        (f) => f.confidence >= filters.min_confidence!
      );
    }

    return foundations;
  }

  async promoteToFoundation(input: {
    title: string;
    default_behavior: string;
    context_tags: string[];
    counter_contexts?: string[];
    source_pressures: string[];
    exit_criteria?: string;
    scope?: "GLOBAL" | "PROJECT";
    origin_project?: string;
  }): Promise<Foundation> {
    // Use GF- prefix for global foundations, F- for project
    const scope = input.scope ?? "PROJECT";
    const prefix = scope === "GLOBAL" ? "GF" : "F";
    const id = `${prefix}-${String(this.nextFoundationId).padStart(4, "0")}`;
    this.nextFoundationId++;

    const foundation: Foundation = {
      id,
      title: input.title,
      default_behavior: input.default_behavior,
      context_tags: input.context_tags,
      counter_contexts: input.counter_contexts,
      confidence: 1, // Start at 1/3
      scope,
      origin_project: input.origin_project,
      validated_in: input.origin_project ? [input.origin_project] : undefined,
      exit_criteria: input.exit_criteria,
      source_pressures: input.source_pressures,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const validated = FoundationSchema.parse(foundation);

    const foundationsPath = join(this._basePath, "defaults", "foundations.yaml");
    let data: { foundations: Foundation[] };

    if (existsSync(foundationsPath)) {
      data = await this.readYamlValidated(
        foundationsPath,
        FoundationsFileSchema,
        "foundations"
      );
    } else {
      data = { foundations: [] };
    }

    data.foundations.push(validated);
    await this.writeYaml(foundationsPath, data);

    // Mark source pressures as promoted
    for (const peId of input.source_pressures) {
      await this.markPressurePromoted(peId, id);
    }

    return validated;
  }

  async updateFoundation(
    foundationId: string,
    updates: Partial<Foundation>
  ): Promise<Foundation> {
    const foundationsPath = join(this._basePath, "defaults", "foundations.yaml");
    if (!existsSync(foundationsPath)) {
      throw new Error(`Foundation not found: ${foundationId}`);
    }

    const data = await this.readYamlValidated(
      foundationsPath,
      FoundationsFileSchema,
      "foundations"
    );

    const idx = data.foundations.findIndex((f) => f.id === foundationId);
    if (idx === -1) {
      throw new Error(`Foundation not found: ${foundationId}`);
    }

    const updated = {
      ...data.foundations[idx],
      ...updates,
      updated_at: new Date().toISOString(),
    };
    const validated = FoundationSchema.parse(updated);
    data.foundations[idx] = validated;

    await this.writeYaml(foundationsPath, data);
    return validated;
  }

  /**
   * Remove a foundation by ID. Used when elevating a project foundation
   * to global scope — the project copy is retired.
   */
  async removeFoundation(foundationId: string): Promise<boolean> {
    const foundationsPath = join(this._basePath, "defaults", "foundations.yaml");
    if (!existsSync(foundationsPath)) return false;

    const data = await this.readYamlValidated(
      foundationsPath,
      FoundationsFileSchema,
      "foundations"
    );

    const idx = data.foundations.findIndex((f) => f.id === foundationId);
    if (idx === -1) return false;

    data.foundations.splice(idx, 1);
    await this.writeYaml(foundationsPath, data);
    return true;
  }

  private async markPressurePromoted(
    pressureId: string,
    foundationId: string
  ): Promise<void> {
    const cases = await this.listCases();
    for (const c of cases) {
      const pressures = await this.getPressureEvents(c.id);
      const idx = pressures.findIndex((p) => p.id === pressureId);
      if (idx !== -1) {
        pressures[idx].promoted_to_foundation = foundationId;
        await this.writeYaml(
          join(this._basePath, "cases", c.id, "pressures.yaml"),
          { events: pressures }
        );
        return;
      }
    }
  }

  // ============================================================================
  // SUGGEST REVIEW (retrospective)
  // ============================================================================

  async suggestReview(): Promise<{
    foundation_candidates: Array<{
      theme: string;
      pressure_events: string[];
      remember_lines: string[];
      shared_tags: string[];
    }>;
    blocking_forgetting: Array<{
      case_id: string;
      title: string;
      unpromoted_pe_count: number;
      pe_ids: string[];
    }>;
    high_regret_no_pe: Array<{
      case_id: string;
      title: string;
      regret: string;
    }>;
    summary: string;
  }> {
    const cases = await this.listCases();
    const allUnpromoted: PressureEvent[] = [];
    const blockingForgetting: Array<{
      case_id: string;
      title: string;
      unpromoted_pe_count: number;
      pe_ids: string[];
    }> = [];
    const highRegretNoPE: Array<{
      case_id: string;
      title: string;
      regret: string;
    }> = [];

    for (const c of cases) {
      if (c.status !== "COMPLETED") continue;

      const pressures = await this.getPressureEvents(c.id);
      const unpromoted = pressures.filter(p => !p.promoted_to_foundation);
      const regret = c.signals?.outcome?.regret;

      // Collect all unpromoted PEs for pattern detection
      allUnpromoted.push(...unpromoted);

      // Cases blocking forgetting: regret 0 but unpromoted PEs remain
      if (regret === "0" && unpromoted.length > 0) {
        blockingForgetting.push({
          case_id: c.id,
          title: c.title,
          unpromoted_pe_count: unpromoted.length,
          pe_ids: unpromoted.map(p => p.id),
        });
      }

      // High regret with no PEs: possible missed captures
      if (regret && parseInt(regret) >= 2 && pressures.length === 0) {
        highRegretNoPE.push({
          case_id: c.id,
          title: c.title,
          regret,
        });
      }
    }

    // Group unpromoted PEs by shared context_tags
    const tagGroups = new Map<string, PressureEvent[]>();
    for (const pe of allUnpromoted) {
      const tags = pe.context_tags ?? [];
      for (const tag of tags) {
        if (!tagGroups.has(tag)) tagGroups.set(tag, []);
        tagGroups.get(tag)!.push(pe);
      }
    }

    // Find clusters of 2+ PEs with shared tags as foundation candidates
    const foundationCandidates: Array<{
      theme: string;
      pressure_events: string[];
      remember_lines: string[];
      shared_tags: string[];
    }> = [];
    const seenPECombos = new Set<string>();

    for (const [tag, pes] of tagGroups) {
      if (pes.length < 2) continue;
      const peIds = pes.map(p => p.id).sort().join(",");
      if (seenPECombos.has(peIds)) continue;
      seenPECombos.add(peIds);

      // Find all shared tags across this group
      const sharedTags = [...new Set(
        pes.flatMap(p => p.context_tags ?? [])
      )].filter(t =>
        pes.every(p => p.context_tags?.includes(t))
      );

      foundationCandidates.push({
        theme: tag,
        pressure_events: pes.map(p => p.id),
        remember_lines: pes.map(p => `${p.id}: ${p.remember}`),
        shared_tags: sharedTags,
      });
    }

    // Build summary
    const parts: string[] = [];
    if (foundationCandidates.length > 0) {
      parts.push(`${foundationCandidates.length} foundation candidate(s) from clustered PEs`);
    }
    if (blockingForgetting.length > 0) {
      parts.push(`${blockingForgetting.length} case(s) blocking forgetting (regret 0 but unpromoted PEs)`);
    }
    if (highRegretNoPE.length > 0) {
      parts.push(`${highRegretNoPE.length} high-regret case(s) with no PEs (possible missed captures)`);
    }
    if (parts.length === 0) {
      parts.push("Nothing to review. All learnings extracted or cases forgotten.");
    }

    return {
      foundation_candidates: foundationCandidates,
      blocking_forgetting: blockingForgetting,
      high_regret_no_pe: highRegretNoPE,
      summary: parts.join(". ") + ".",
    };
  }

  // ============================================================================
  // POLICY CHECK
  // ============================================================================

  checkPolicy(signals: {
    risk_level?: string;
    reversibility?: string;
    repo_scope?: string;
    affected_surface?: string[];
    uncertainty?: string;
  }): {
    require_options_comparison: boolean;
    validation_level: string;
    warnings: string[];
  } {
    const warnings: string[] = [];
    let requireComparison = false;
    let validationLevel = "BASIC";

    // Check if options comparison required
    if (
      signals.reversibility === "HARD" ||
      signals.risk_level === "HIGH" ||
      signals.repo_scope === "CROSS_REPO" ||
      signals.affected_surface?.includes("CORE_DOMAIN") ||
      signals.affected_surface?.includes("DATA_MODEL") ||
      signals.affected_surface?.includes("SECURITY_BOUNDARY") ||
      signals.uncertainty === "HIGH"
    ) {
      requireComparison = true;
      warnings.push(
        "Policy requires MINIMAL vs ROBUST options comparison before implementation."
      );
    }

    // Determine validation level
    if (
      signals.risk_level === "HIGH" ||
      signals.reversibility === "HARD" ||
      signals.affected_surface?.includes("SECURITY_BOUNDARY") ||
      signals.affected_surface?.includes("INFRA_DEPLOY") ||
      signals.affected_surface?.includes("PERFORMANCE_CRITICAL") ||
      signals.affected_surface?.includes("DATA_MODEL") ||
      signals.uncertainty === "HIGH"
    ) {
      validationLevel = "STRICT";
    } else if (
      signals.risk_level === "MEDIUM" ||
      signals.repo_scope === "CROSS_REPO" ||
      signals.affected_surface?.includes("INTEGRATION") ||
      signals.affected_surface?.includes("CORE_DOMAIN")
    ) {
      validationLevel = "STANDARD";
    }

    return {
      require_options_comparison: requireComparison,
      validation_level: validationLevel,
      warnings,
    };
  }

  // ============================================================================
  // CONTEXT (for LLM)
  // ============================================================================

  async getContext(): Promise<{
    project: string;
    active_case: Case | null;
    recent_pressures: PressureEvent[];
    relevant_foundations: Foundation[];
  }> {
    const config = await this.getConfig();
    const activeCase = this.activeCase
      ? await this.getCase(this.activeCase)
      : null;

    let recentPressures: PressureEvent[] = [];
    if (activeCase) {
      recentPressures = await this.getPressureEvents(activeCase.id);
    }

    const foundations = await this.getFoundations();

    return {
      project: config.project,
      active_case: activeCase,
      recent_pressures: recentPressures.slice(-5), // Last 5
      relevant_foundations: foundations.filter((f) => f.confidence >= 1),
    };
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  private async ensureDir(path: string): Promise<void> {
    if (!existsSync(path)) {
      await mkdir(path, { recursive: true });
    }
  }

  private async readYamlValidated<Schema extends z.ZodTypeAny>(
    path: string,
    schema: Schema,
    label: string
  ): Promise<z.output<Schema>> {
    const content = await readFile(path, "utf-8");
    const parsed = YAML.parse(content);
    const result = schema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new Error(`Invalid ${label} in ${path}: ${issues}`);
    }
    return result.data;
  }

  private async writeYaml(path: string, data: unknown): Promise<void> {
    await this.ensureDir(dirname(path));
    const content = YAML.stringify(data, { lineWidth: 0 });
    await writeFile(path, content, "utf-8");
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50);
  }
}
