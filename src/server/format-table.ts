import { homedir } from "os";
import type { Case, PressureEvent } from "../core/schemas.js";
import type { FoundationWithSource, FoundationConflict } from "../core/hierarchical-storage.js";

export interface GetContextResult {
  project: string;
  active_case: Case | null;
  recent_pressures: PressureEvent[];
  relevant_foundations: FoundationWithSource[];
  conflicts: FoundationConflict[];
  layers: string[];
}

/**
 * Render get_context output as a compact markdown table.
 * Optimized for start-of-conversation foundation loading (~400 tokens for 14 foundations).
 */
export function formatContextTable(context: GetContextResult): string {
  const foundations = context.relevant_foundations;
  const home = homedir();
  const layers = context.layers.map(l =>
    l.includes(home) && !l.startsWith(home + "/.decision-os")
      ? l.replace(home, "~")
      : l.startsWith(home + "/.decision-os")
        ? "~/.decision-os"
        : l
  );

  let table = `# Foundations (${context.project})\n`;
  table += `Layers: ${layers.join(" → ")}\n`;

  if (context.active_case) {
    table += `Active case: ${context.active_case.id} — "${context.active_case.title}"\n`;
  }

  if (foundations.length === 0) {
    table += "\nNo foundations yet.\n";
  } else {
    table += "\n| ID | Foundation | Scope | Conf | Applies | NOT |\n";
    table += "|---|---|---|---|---|---|\n";
    for (const f of foundations) {
      const scope = f._source_scope === "GLOBAL" ? "GLOBAL" : "PROJECT";
      const tags = (f.context_tags ?? []).join(", ") || "—";
      const counter = (f.counter_contexts ?? []).join(", ") || "—";
      table += `| ${f.id} | ${f.title} | ${scope} | ${f.confidence}/3 | ${tags} | ${counter} |\n`;
    }
  }

  if (context.conflicts.length > 0) {
    table += "\n**Conflicts:**\n";
    for (const c of context.conflicts) {
      table += `- ${c.title}: ${c.recommendation}\n`;
    }
  }

  return table;
}
