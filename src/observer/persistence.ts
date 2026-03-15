import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { ObserverMetaState } from "../core/schemas.js";

/**
 * Persist and restore observer session state under .decision-os/observer/sessions/.
 * Each session is stored as a JSON file keyed by session_id.
 */
export class ObserverPersistence {
  private sessionsDir: string;

  constructor(basePath: string) {
    this.sessionsDir = join(basePath, "observer", "sessions");
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.sessionsDir)) {
      await mkdir(this.sessionsDir, { recursive: true });
    }
  }

  async save(state: ObserverMetaState): Promise<void> {
    await this.initialize();
    const filePath = join(this.sessionsDir, `${state.session_id}.json`);
    await writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
  }

  async load(sessionId: string): Promise<ObserverMetaState | null> {
    const filePath = join(this.sessionsDir, `${sessionId}.json`);
    if (!existsSync(filePath)) return null;

    const content = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    return ObserverMetaState.parse(parsed);
  }

  async listSessions(): Promise<string[]> {
    if (!existsSync(this.sessionsDir)) return [];
    const entries = await readdir(this.sessionsDir);
    return entries
      .filter((e) => e.endsWith(".json"))
      .map((e) => e.replace(/\.json$/, ""));
  }
}
