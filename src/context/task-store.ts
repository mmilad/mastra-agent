import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { assistantDatabasePath } from './scope.ts';

export type StoredTask = {
  taskId: string;
  projectRoot: string;
  status: string;
  objective: string;
  brief: unknown;
  taskText: string;
  createdAt: string;
  updatedAt: string;
  progress: string[];
  approval?: unknown;
  workerOutput?: string;
  workerStopReason?: string;
  error?: string;
};

export interface TaskStore {
  upsert(task: StoredTask): void;
  loadAll(): StoredTask[];
  close?(): void;
}

export class SqliteTaskStore implements TaskStore {
  private readonly db: DatabaseSync;

  constructor(databasePath = join(dirname(assistantDatabasePath()), 'assistant-tasks.db')) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS assistant_tasks (
      task_id TEXT PRIMARY KEY,
      project_root TEXT NOT NULL,
      status TEXT NOT NULL,
      objective TEXT NOT NULL,
      brief_json TEXT NOT NULL,
      task_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      progress_json TEXT NOT NULL,
      approval_json TEXT,
      worker_output TEXT,
      worker_stop_reason TEXT,
      error TEXT
    )`);
  }

  upsert(task: StoredTask): void {
    this.db.prepare(`INSERT INTO assistant_tasks
      (task_id, project_root, status, objective, brief_json, task_text, created_at, updated_at,
       progress_json, approval_json, worker_output, worker_stop_reason, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET project_root=excluded.project_root, status=excluded.status,
       objective=excluded.objective, brief_json=excluded.brief_json, task_text=excluded.task_text,
       created_at=excluded.created_at, updated_at=excluded.updated_at, progress_json=excluded.progress_json,
       approval_json=excluded.approval_json, worker_output=excluded.worker_output,
       worker_stop_reason=excluded.worker_stop_reason, error=excluded.error`).run(
      task.taskId, task.projectRoot, task.status, task.objective, JSON.stringify(task.brief), task.taskText,
      task.createdAt, task.updatedAt, JSON.stringify(task.progress), task.approval ? JSON.stringify(task.approval) : null,
      task.workerOutput ?? null, task.workerStopReason ?? null, task.error ?? null,
    );
  }

  loadAll(): StoredTask[] {
    return this.db.prepare('SELECT * FROM assistant_tasks ORDER BY created_at').all().map((row) => ({
      taskId: String(row.task_id), projectRoot: String(row.project_root), status: String(row.status),
      objective: String(row.objective), brief: JSON.parse(String(row.brief_json)), taskText: String(row.task_text),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      progress: JSON.parse(String(row.progress_json)),
      ...(row.approval_json == null ? {} : { approval: JSON.parse(String(row.approval_json)) }),
      ...(row.worker_output == null ? {} : { workerOutput: String(row.worker_output) }),
      ...(row.worker_stop_reason == null ? {} : { workerStopReason: String(row.worker_stop_reason) }),
      ...(row.error == null ? {} : { error: String(row.error) }),
    }));
  }

  close(): void { this.db.close(); }
}

export const taskStore = new SqliteTaskStore();
