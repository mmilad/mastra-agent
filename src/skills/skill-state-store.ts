import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { assistantDatabasePath, projectScopeId } from '../context/scope.ts';

export class SkillStateStore {
  private readonly db: DatabaseSync;

  constructor(databasePath = assistantDatabasePath()) {
    const path = resolve(databasePath);
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS assistant_thread_skills (
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      conflicts_json TEXT NOT NULL,
      loaded_at TEXT NOT NULL,
      PRIMARY KEY (project_id, thread_id, skill_name)
    )`);
  }

  async loadOrRecord(input: {
    projectRoot: string;
    threadId: string;
    name: string;
    conflicts: string[];
  }): Promise<{ conflicts: string[] }> {
    const projectId = projectScopeId(input.projectRoot);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare(
        'SELECT skill_name, conflicts_json FROM assistant_thread_skills WHERE project_id = ? AND thread_id = ?',
      ).all(projectId, input.threadId) as Array<{ skill_name: string; conflicts_json: string }>;
      const loaded = existing.map(row => ({ name: row.skill_name, conflicts: parseConflicts(row.conflicts_json) }));
      const conflicts = loaded
        .filter(skill => input.conflicts.includes(skill.name) || skill.conflicts.includes(input.name))
        .map(skill => skill.name);
      if (conflicts.length) {
        this.db.exec('ROLLBACK');
        return { conflicts };
      }
      this.db.prepare(`INSERT OR IGNORE INTO assistant_thread_skills
        (project_id, thread_id, skill_name, conflicts_json, loaded_at) VALUES (?, ?, ?, ?, ?)`)
        .run(projectId, input.threadId, input.name, JSON.stringify(input.conflicts), new Date().toISOString());
      this.db.exec('COMMIT');
      return { conflicts: [] };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.db.close(); }
}

function parseConflicts(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
