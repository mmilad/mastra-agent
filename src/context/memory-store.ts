import { createClient, type Client, type InValue } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { assistantDatabasePath, findWorkspaceRoot, projectScopeId } from './scope.ts';

export type MemoryScope = 'user' | 'project';
export type MemoryKind = 'preference' | 'fact' | 'summary';

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  projectId: string | null;
  kind: MemoryKind;
  key: string;
  value: string;
  source: string;
  sourceId: string | null;
  rootSourceId: string;
  derivedFrom: string[];
  createdAt: string;
  updatedAt: string;
  revision: number;
  status: 'active' | 'superseded' | 'forgotten';
  replaces: string | null;
  replacedBy: string | null;
}

export interface MemoryStoreOptions {
  databasePath?: string;
  projectRoot?: string;
}

const credentialPatterns = [
  /\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|secret|credential)\s*(?::|=|is)\s*\S+/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/i,
];

export function looksLikeCredential(value: string): boolean {
  return credentialPatterns.some(pattern => pattern.test(value));
}

export class ScopedMemoryStore {
  private readonly client: Client;
  private readonly projectId: string;
  private initialized?: Promise<void>;

  constructor(options: MemoryStoreOptions = {}) {
    const projectRoot = resolve(options.projectRoot ?? findWorkspaceRoot());
    const path = resolve(options.databasePath ?? assistantDatabasePath());
    this.projectId = projectScopeId(projectRoot);
    this.client = createClient({ url: `file:${path}` });
  }

  private init(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        await this.client.executeMultiple(`
        CREATE TABLE IF NOT EXISTS assistant_memory (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL CHECK (scope IN ('user', 'project')),
          project_id TEXT,
          kind TEXT NOT NULL CHECK (kind IN ('preference', 'fact', 'summary')),
          memory_key TEXT NOT NULL,
          value TEXT NOT NULL,
          source TEXT NOT NULL,
          source_id TEXT,
          root_source_id TEXT NOT NULL,
          derived_from TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          revision INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'forgotten')),
          replaces TEXT,
          replaced_by TEXT
        );
        CREATE INDEX IF NOT EXISTS assistant_memory_scope_idx
          ON assistant_memory(scope, project_id, status, kind, memory_key);
        CREATE INDEX IF NOT EXISTS assistant_memory_source_idx
          ON assistant_memory(root_source_id, status);
        `);
        const columns = await this.client.execute('PRAGMA table_info(assistant_memory)');
        if (!columns.rows.some(row => String(row.name) === 'derived_from')) {
          await this.client.execute("ALTER TABLE assistant_memory ADD COLUMN derived_from TEXT NOT NULL DEFAULT '[]'");
        }
      })();
    }
    return this.initialized;
  }

  private scopeClause(scope: MemoryScope): { sql: string; args: InValue[] } {
    return scope === 'user'
      ? { sql: "scope = 'user' AND project_id IS NULL", args: [] }
      : { sql: "scope = 'project' AND project_id = ?", args: [this.projectId] };
  }

  async list(options: { scope?: MemoryScope; kind?: MemoryKind; query?: string; includeHistory?: boolean } = {}): Promise<MemoryRecord[]> {
    await this.init();
    const scopes = options.scope ? [options.scope] : ['user', 'project'] as const;
    const clauses = scopes.map(scope => this.scopeClause(scope));
    const where = [`(${clauses.map(item => `(${item.sql})`).join(' OR ')})`];
    const args: InValue[] = clauses.flatMap(item => item.args);
    if (!options.includeHistory) where.push("status = 'active'");
    if (options.kind) { where.push('kind = ?'); args.push(options.kind); }
    if (options.query?.trim()) {
      where.push('(memory_key LIKE ? OR value LIKE ?)');
      args.push(`%${options.query.trim()}%`, `%${options.query.trim()}%`);
    }
    const result = await this.client.execute({
      sql: `SELECT * FROM assistant_memory WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT 200`,
      args,
    });
    return result.rows.map(rowToRecord);
  }

  async remember(input: {
    scope: MemoryScope;
    kind: MemoryKind;
    key: string;
    value: string;
    source: string;
    sourceId?: string;
    derivedFrom?: string[];
    correct?: boolean;
  }): Promise<MemoryRecord> {
    const key = input.key.trim();
    const value = input.value.trim();
    const source = input.source.trim();
    if (!key || !value || !source) throw new Error('Memory key, value, and source are required.');
    if (looksLikeCredential(`${key}\n${value}`)) throw new Error('This looks like a credential and was not stored. Keep credentials in the approved secret store.');
    await this.init();
    const scope = this.scopeClause(input.scope);
    const tx = await this.client.transaction('write');
    try {
      const current = await tx.execute({
        sql: `SELECT * FROM assistant_memory WHERE ${scope.sql} AND kind = ? AND memory_key = ? AND status = 'active' ORDER BY revision DESC LIMIT 1`,
        args: [...scope.args, input.kind, key],
      });
      const previous = current.rows[0] ? rowToRecord(current.rows[0]) : undefined;
      if (previous && !input.correct && previous.value !== value) {
        throw new Error(`Memory key “${key}” already has a different value. Use the correction operation to replace it.`);
      }
      if (previous?.value === value) {
        await tx.commit();
        return previous;
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      const projectId = input.scope === 'project' ? this.projectId : null;
      const record: MemoryRecord = {
        id, scope: input.scope, projectId, kind: input.kind, key, value, source,
        sourceId: input.sourceId ?? null,
        rootSourceId: input.sourceId ?? previous?.rootSourceId ?? id,
        derivedFrom: input.derivedFrom ?? [],
        createdAt: now, updatedAt: now, revision: (previous?.revision ?? 0) + 1,
        status: 'active', replaces: previous?.id ?? null, replacedBy: null,
      };
      if (previous) {
        await tx.execute({
          sql: "UPDATE assistant_memory SET status = 'superseded', replaced_by = ?, updated_at = ? WHERE id = ?",
          args: [id, now, previous.id],
        });
      }
      await tx.execute({
        sql: `INSERT INTO assistant_memory
          (id, scope, project_id, kind, memory_key, value, source, source_id, root_source_id, derived_from, created_at, updated_at, revision, status, replaces, replaced_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
        args: [record.id, record.scope, record.projectId, record.kind, record.key, record.value, record.source,
          record.sourceId, record.rootSourceId, JSON.stringify(record.derivedFrom), record.createdAt, record.updatedAt, record.revision, record.replaces],
      });
      await tx.commit();
      return record;
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  async forget(input: { scope: MemoryScope; recordId?: string; key?: string }): Promise<{ forgotten: number; rootSourceId?: string }> {
    await this.init();
    const scope = this.scopeClause(input.scope);
    const tx = await this.client.transaction('write');
    try {
      const target = input.recordId
        ? await tx.execute({ sql: `SELECT * FROM assistant_memory WHERE ${scope.sql} AND id = ? LIMIT 1`, args: [...scope.args, input.recordId] })
          : input.key
          ? await tx.execute({ sql: `SELECT * FROM assistant_memory WHERE ${scope.sql} AND memory_key = ? ORDER BY revision DESC LIMIT 1`, args: [...scope.args, input.key.trim()] })
          : undefined;
      if (!target?.rows[0]) throw new Error('No matching memory record exists in that scope.');
      const record = rowToRecord(target.rows[0]);
      const candidates = await tx.execute({
        sql: `SELECT id, derived_from FROM assistant_memory WHERE (${scope.sql}) AND memory_key = ?`,
        args: [...scope.args, record.key],
      });
      const all = await tx.execute({ sql: `SELECT id, derived_from FROM assistant_memory WHERE ${scope.sql}`, args: scope.args });
      const deletedIds = new Set(candidates.rows.map(row => String(row.id)));
      collectDerivedIds(all.rows, deletedIds);
      const ids = [...deletedIds];
      const placeholders = ids.map(() => '?').join(', ');
      const result = await tx.execute({
        sql: `DELETE FROM assistant_memory WHERE (${scope.sql}) AND id IN (${placeholders})`,
        args: [...scope.args, ...ids],
      });
      await tx.commit();
      return { forgotten: Number(result.rowsAffected), rootSourceId: record.rootSourceId };
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  async forgetSource(input: { scope: MemoryScope; sourceId: string }): Promise<number> {
    await this.init();
    const scope = this.scopeClause(input.scope);
    const all = await this.client.execute({ sql: `SELECT id, source_id, root_source_id, derived_from FROM assistant_memory WHERE ${scope.sql}`, args: scope.args });
    const deletedIds = new Set(all.rows
      .filter(row => row.source_id === input.sourceId || row.root_source_id === input.sourceId)
      .map(row => String(row.id)));
    collectDerivedIds(all.rows, deletedIds);
    if (deletedIds.size === 0) return 0;
    const ids = [...deletedIds];
    const placeholders = ids.map(() => '?').join(', ');
    const result = await this.client.execute({
      sql: `DELETE FROM assistant_memory WHERE (${scope.sql}) AND id IN (${placeholders})`,
      args: [...scope.args, ...ids],
    });
    return Number(result.rowsAffected);
  }

  async export(): Promise<{ version: 1; exportedAt: string; projectId: string; memories: Array<Pick<MemoryRecord, 'id' | 'scope' | 'kind' | 'key' | 'value' | 'source' | 'sourceId' | 'createdAt' | 'updatedAt' | 'revision'>> }> {
    const records = (await this.list()).filter(record => !looksLikeCredential(`${record.key}\n${record.value}\n${record.source}\n${record.sourceId ?? ''}`));
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      projectId: this.projectId,
      memories: records.map(({ id, scope, kind, key, value, source, sourceId, createdAt, updatedAt, revision }) =>
        ({ id, scope, kind, key, value, source, sourceId, createdAt, updatedAt, revision })),
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  let derivedFrom: string[] = [];
  try { derivedFrom = JSON.parse(String(row.derived_from ?? '[]')) as string[]; } catch { /* treat malformed legacy data as unlinked */ }
  return {
    id: String(row.id), scope: row.scope as MemoryScope, projectId: row.project_id == null ? null : String(row.project_id),
    kind: row.kind as MemoryKind, key: String(row.memory_key), value: String(row.value), source: String(row.source),
    sourceId: row.source_id == null ? null : String(row.source_id), rootSourceId: String(row.root_source_id),
    derivedFrom,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), revision: Number(row.revision),
    status: row.status as MemoryRecord['status'], replaces: row.replaces == null ? null : String(row.replaces),
    replacedBy: row.replaced_by == null ? null : String(row.replaced_by),
  };
}

function collectDerivedIds(rows: Array<Record<string, unknown>>, deletedIds: Set<string>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const id = String(row.id);
      if (deletedIds.has(id)) continue;
      let parents: string[] = [];
      try { parents = JSON.parse(String(row.derived_from ?? '[]')) as string[]; } catch { /* ignore malformed lineage */ }
      if (parents.some(parent => deletedIds.has(parent))) {
        deletedIds.add(id);
        changed = true;
      }
    }
  }
}
