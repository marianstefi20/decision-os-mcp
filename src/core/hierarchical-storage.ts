import { existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { DecisionOSStorage } from "./storage.js";
import type { Foundation, Case, PressureEvent, ProjectConfig } from "./schemas.js";

/**
 * Extended Foundation type with source layer information for conflict visibility
 */
export interface FoundationWithSource extends Foundation {
  _source_layer: string; // Path to the .decision-os folder this came from
  _source_scope: "GLOBAL" | "PROJECT";
}

/**
 * Conflict information when foundations overlap across scopes
 */
export interface FoundationConflict {
  title: string;
  global_foundation: Foundation;
  project_foundation: Foundation;
  recommendation: string;
}

/**
 * Hierarchical storage layer for Decision OS.
 * Manages GLOBAL → PROJECT cascading scope model.
 * 
 * Resolution order: PROJECT wins over GLOBAL for conflicts.
 * Global foundations are recommendations, not rules.
 */
export class HierarchicalDecisionOSStorage {
  private layers: DecisionOSStorage[] = []; // [project, global] - nearest first
  private projectLayer: DecisionOSStorage;
  private globalLayer: DecisionOSStorage | null = null;

  constructor(workspacePath: string) {
    this.layers = this.discoverLayers(workspacePath);
    
    if (this.layers.length === 0) {
      throw new Error(`No .decision-os found starting from ${workspacePath}`);
    }
    
    this.projectLayer = this.layers[0];
    this.globalLayer = this.layers.length > 1 ? this.layers[this.layers.length - 1] : null;
  }

  /**
   * Discover all .decision-os layers by walking up from workspace path.
   * Returns [nearest, ..., global] order.
   */
  private discoverLayers(startPath: string): DecisionOSStorage[] {
    const layers: DecisionOSStorage[] = [];
    const seenPaths = new Set<string>();
    
    // First, check if startPath itself is or contains .decision-os
    let currentPath = startPath;
    
    // If startPath ends with .decision-os, use its parent as start
    if (currentPath.endsWith(".decision-os")) {
      currentPath = dirname(currentPath);
    }
    
    // Walk up directory tree looking for .decision-os folders
    while (currentPath !== "/" && currentPath !== dirname(currentPath)) {
      const dosPath = join(currentPath, ".decision-os");
      
      if (existsSync(dosPath) && !seenPaths.has(dosPath)) {
        seenPaths.add(dosPath);
        layers.push(new DecisionOSStorage(dosPath));
      }
      
      currentPath = dirname(currentPath);
    }
    
    // Always include global ~/.decision-os if it exists
    const globalPath = join(homedir(), ".decision-os");
    if (existsSync(globalPath) && !seenPaths.has(globalPath)) {
      seenPaths.add(globalPath);
      layers.push(new DecisionOSStorage(globalPath));
    }
    
    return layers;
  }

  /**
   * Initialize all layers
   */
  async initialize(): Promise<void> {
    for (const layer of this.layers) {
      await layer.initialize();
    }
  }

  /**
   * Get the base path of the project layer
   */
  getProjectPath(): string {
    return this.projectLayer.basePath;
  }

  /**
   * Get the base path of the global layer (if exists)
   */
  getGlobalPath(): string | null {
    return this.globalLayer ? this.globalLayer.basePath : null;
  }

  // ============================================================================
  // CONFIG
  // ============================================================================

  async getConfig(): Promise<ProjectConfig> {
    return this.projectLayer.getConfig();
  }

  async updateConfig(config: Partial<ProjectConfig>): Promise<void> {
    return this.projectLayer.updateConfig(config);
  }

  // ============================================================================
  // ACTIVE CASE (project-local)
  // ============================================================================

  getActiveCase(): string | null {
    return this.projectLayer.getActiveCase();
  }

  async setActiveCase(caseId: string | null): Promise<void> {
    await this.projectLayer.setActiveCase(caseId);
  }

  // ============================================================================
  // CASES (project-local)
  // ============================================================================

  async listCases(): Promise<Case[]> {
    return this.projectLayer.listCases();
  }

  async getCase(caseId: string): Promise<Case | null> {
    return this.projectLayer.getCase(caseId);
  }

  async createCase(input: Parameters<DecisionOSStorage["createCase"]>[0]): Promise<Case> {
    return this.projectLayer.createCase(input);
  }

  async updateCase(caseId: string, updates: Partial<Case>): Promise<Case> {
    return this.projectLayer.updateCase(caseId, updates);
  }

  async closeCase(
    caseId: string,
    outcome: Parameters<DecisionOSStorage["closeCase"]>[1]
  ): Promise<{ case: Case; forgotten: boolean }> {
    return this.projectLayer.closeCase(caseId, outcome);
  }

  // ============================================================================
  // PRESSURE EVENTS (project-local)
  // ============================================================================

  async getPressureEvents(caseId: string): Promise<PressureEvent[]> {
    return this.projectLayer.getPressureEvents(caseId);
  }

  async logPressure(input: Parameters<DecisionOSStorage["logPressure"]>[0]): Promise<PressureEvent> {
    return this.projectLayer.logPressure(input);
  }

  async searchPressures(query: string): Promise<PressureEvent[]> {
    // Search only in project layer (per user's answer to Q3)
    return this.projectLayer.searchPressures(query);
  }

  // ============================================================================
  // FOUNDATIONS (merged across layers)
  // ============================================================================

  /**
   * Get merged foundations from all layers.
   * Project foundations take precedence over global on title conflict.
   * Returns foundations annotated with source information.
   */
  async getFoundations(filters?: {
    context_tags?: string[];
    min_confidence?: number;
  }): Promise<FoundationWithSource[]> {
    const seen = new Map<string, FoundationWithSource>(); // Track by title
    const merged: FoundationWithSource[] = [];

    for (const layer of this.layers) {
      const foundations = await layer.getFoundations(filters);
      const layerPath = layer.basePath;
      const isGlobal = layerPath === join(homedir(), ".decision-os");

      for (const f of foundations) {
        const annotated: FoundationWithSource = {
          ...f,
          _source_layer: layerPath,
          _source_scope: isGlobal ? "GLOBAL" : "PROJECT",
        };

        if (!seen.has(f.title)) {
          // First occurrence (nearest layer) wins
          seen.set(f.title, annotated);
          merged.push(annotated);
        }
        // If already seen, project wins over global (first layer is project)
      }
    }

    return merged;
  }

  /**
   * Detect conflicts where project and global have foundations with same title
   * or overlapping context_tags.
   */
  async detectConflicts(): Promise<FoundationConflict[]> {
    if (!this.globalLayer) return [];

    const projectFoundations = await this.projectLayer.getFoundations();
    const globalFoundations = await this.globalLayer.getFoundations();
    const conflicts: FoundationConflict[] = [];

    for (const pf of projectFoundations) {
      // Check for title match
      const titleMatch = globalFoundations.find(
        (gf) => gf.title.toLowerCase() === pf.title.toLowerCase()
      );
      
      if (titleMatch) {
        conflicts.push({
          title: pf.title,
          global_foundation: titleMatch,
          project_foundation: pf,
          recommendation: `Project foundation "${pf.title}" shadows global foundation. ` +
            `Project version will be used. Consider if global should be updated or removed.`,
        });
        continue;
      }

      // Check for overlapping context_tags
      for (const gf of globalFoundations) {
        const overlappingTags = pf.context_tags.filter((t) =>
          gf.context_tags.includes(t)
        );
        
        if (overlappingTags.length > 0 && pf.title !== gf.title) {
          // Different titles but same context - potential friction
          const pfBehavior = pf.default_behavior.toLowerCase();
          const gfBehavior = gf.default_behavior.toLowerCase();
          
          // Simple heuristic: if behaviors seem contradictory
          const contradictory = 
            (pfBehavior.includes("always") && gfBehavior.includes("never")) ||
            (pfBehavior.includes("never") && gfBehavior.includes("always")) ||
            (pfBehavior.includes("prefer") && gfBehavior.includes("avoid"));
          
          if (contradictory) {
            conflicts.push({
              title: `${pf.title} vs ${gf.title}`,
              global_foundation: gf,
              project_foundation: pf,
              recommendation: `Potential conflict: Both apply to [${overlappingTags.join(", ")}] ` +
                `but may have contradictory guidance. Review and clarify.`,
            });
          }
        }
      }
    }

    return conflicts;
  }

  /**
   * Promote pressure events to a foundation in the specified scope.
   */
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
    const scope = input.scope ?? "PROJECT";
    const config = await this.projectLayer.getConfig();
    const originProject = input.origin_project ?? config.project;
    
    const targetLayer = scope === "GLOBAL" && this.globalLayer 
      ? this.globalLayer 
      : this.projectLayer;

    // Create foundation with scope and origin metadata
    const foundation = await targetLayer.promoteToFoundation({
      title: input.title,
      default_behavior: input.default_behavior,
      context_tags: input.context_tags,
      counter_contexts: input.counter_contexts,
      source_pressures: input.source_pressures,
      exit_criteria: input.exit_criteria,
      scope,
      origin_project: originProject,
    });

    return foundation;
  }

  /**
   * Elevate a project foundation to global scope.
   * Creates a new foundation in global with GF- prefix.
   */
  async elevateFoundation(input: {
    foundation_id: string;
    reason?: string;
  }): Promise<Foundation> {
    if (!this.globalLayer) {
      throw new Error(
        "No global .decision-os found at ~/.decision-os. " +
        "Create it first with: mkdir -p ~/.decision-os/defaults && " +
        "echo 'foundations: []' > ~/.decision-os/defaults/foundations.yaml"
      );
    }

    // Find the foundation in project layer
    const projectFoundations = await this.projectLayer.getFoundations();
    const foundation = projectFoundations.find((f) => f.id === input.foundation_id);
    
    if (!foundation) {
      throw new Error(`Foundation not found in project: ${input.foundation_id}`);
    }

    const config = await this.projectLayer.getConfig();

    // Create in global with GF- prefix (scope: GLOBAL triggers the prefix)
    const globalFoundation = await this.globalLayer.promoteToFoundation({
      title: foundation.title,
      default_behavior: foundation.default_behavior + 
        (input.reason ? `\n\n[Elevated from ${config.project}: ${input.reason}]` : ""),
      context_tags: foundation.context_tags,
      counter_contexts: foundation.counter_contexts,
      source_pressures: foundation.source_pressures,
      exit_criteria: foundation.exit_criteria,
      scope: "GLOBAL",
      origin_project: config.project,
    });

    // Retire the project copy — knowledge now lives in global
    await this.projectLayer.removeFoundation(input.foundation_id);
    console.error(
      `Retired project foundation ${input.foundation_id} — elevated to ${globalFoundation.id}`
    );

    return globalFoundation;
  }

  /**
   * Cross-validate that a global foundation applies in the current project.
   * Increases confidence and adds project to validated_in list.
   */
  async validateFoundation(input: {
    foundation_id: string;
    validation_notes?: string;
  }): Promise<Foundation> {
    // Find the foundation across all layers
    const allFoundations = await this.getFoundations();
    const foundation = allFoundations.find((f) => f.id === input.foundation_id);
    
    if (!foundation) {
      throw new Error(`Foundation not found: ${input.foundation_id}`);
    }

    const config = await this.projectLayer.getConfig();
    
    // Update validated_in
    const validatedIn = [...(foundation.validated_in ?? [])];
    if (!validatedIn.includes(config.project)) {
      validatedIn.push(config.project);
    }

    // Increase confidence if validated in multiple projects (3+ validations = confidence boost)
    let newConfidence = foundation.confidence;
    if (validatedIn.length >= 3 && newConfidence < 3) {
      newConfidence = Math.min(3, newConfidence + 1) as 0 | 1 | 2 | 3;
    }

    // Update the foundation in its source layer
    const targetLayer = foundation._source_scope === "GLOBAL" && this.globalLayer
      ? this.globalLayer
      : this.projectLayer;

    // Use the updateFoundation method to persist
    const updatedFoundation = await targetLayer.updateFoundation(input.foundation_id, {
      validated_in: validatedIn,
      confidence: newConfidence,
    });
    
    return updatedFoundation;
  }

  // ============================================================================
  // SUGGEST REVIEW (delegates to project layer)
  // ============================================================================

  async suggestReview(): ReturnType<DecisionOSStorage["suggestReview"]> {
    return this.projectLayer.suggestReview();
  }

  // ============================================================================
  // POLICY CHECK (delegates to project layer)
  // ============================================================================

  checkPolicy(signals: Parameters<DecisionOSStorage["checkPolicy"]>[0]): ReturnType<DecisionOSStorage["checkPolicy"]> {
    return this.projectLayer.checkPolicy(signals);
  }

  // ============================================================================
  // CONTEXT (merged)
  // ============================================================================

  async getContext(): Promise<{
    project: string;
    active_case: Case | null;
    recent_pressures: PressureEvent[];
    relevant_foundations: FoundationWithSource[];
    conflicts: FoundationConflict[];
    layers: string[];
  }> {
    const config = await this.getConfig();
    const activeCase = this.getActiveCase()
      ? await this.getCase(this.getActiveCase()!)
      : null;

    let recentPressures: PressureEvent[] = [];
    if (activeCase) {
      recentPressures = await this.getPressureEvents(activeCase.id);
    }

    const allFoundations = await this.getFoundations();
    const active = allFoundations.filter((f) => f.confidence >= 1);
    const conflicts = await this.detectConflicts();

    // Rank foundations by relevance to active case
    const ranked = this.rankFoundationsByRelevance(active, activeCase);

    return {
      project: config.project,
      active_case: activeCase,
      recent_pressures: recentPressures.slice(-5),
      relevant_foundations: ranked,
      conflicts,
      layers: this.layers.map((l) => l["basePath"]),
    };
  }

  /**
   * Rank foundations by relevance to the active case.
   * Foundations matching the case's affected_surface or touched_areas
   * are marked "directly_relevant" and sorted first.
   */
  private rankFoundationsByRelevance(
    foundations: FoundationWithSource[],
    activeCase: Case | null
  ): FoundationWithSource[] {
    if (!activeCase) return foundations;

    // Collect case context tags from signals and touched_areas
    const caseTags = new Set<string>();
    const surfaces = activeCase.signals?.context?.affected_surface ?? [];
    for (const s of surfaces) caseTags.add(s.toUpperCase());
    const areas = activeCase.context?.touched_areas ?? [];
    for (const a of areas) caseTags.add(a.toUpperCase());

    if (caseTags.size === 0) return foundations;

    // Score each foundation by tag overlap
    const scored = foundations.map((f) => {
      const overlap = f.context_tags.filter((t) =>
        caseTags.has(t.toUpperCase())
      ).length;
      return { foundation: f, overlap };
    });

    // Sort: directly relevant first, then general
    scored.sort((a, b) => b.overlap - a.overlap);

    return scored.map(({ foundation, overlap }) => ({
      ...foundation,
      _relevance: overlap > 0 ? "directly_relevant" as const : "general" as const,
    }));
  }
}

/**
 * Create a hierarchical storage instance, discovering layers from workspace path.
 * Falls back to creating project-only storage if no hierarchy found.
 */
export function createHierarchicalStorage(workspacePath: string): HierarchicalDecisionOSStorage {
  return new HierarchicalDecisionOSStorage(workspacePath);
}
