import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface, type Interface } from 'node:readline';
import { acpSpawnSpec } from './spawn-spec.ts';

export type JsonObject = Record<string, unknown>;

export type AcpLaunch = {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Needed to launch Windows command shims such as cursor.cmd. */
  shell?: boolean | string;
  clientName?: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
};

export type AcpCapabilities = {
  authenticationMethods: JsonObject[];
  loadSession: boolean;
  sessionList: boolean;
  prompt: JsonObject;
  mcp: JsonObject;
  raw: JsonObject;
};

export type AgentClientRequest = {
  id: string | number;
  method: string;
  params: JsonObject;
  signal: AbortSignal;
};

export type AcpUpdate = {
  method: string;
  params: JsonObject;
};

export const ACP_UNHANDLED = Symbol('ACP_UNHANDLED');

export type AgentClientRequestHandler = (
  request: AgentClientRequest,
) => unknown | typeof ACP_UNHANDLED | Promise<unknown | typeof ACP_UNHANDLED>;

type RpcMessage = {
  id?: string | number | null;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  params?: JsonObject;
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const defaultTimeoutMs = 5 * 60 * 1000;
const startupTimeoutMs = 30_000;

/** Minimal ACP process client shared by providers with different launch commands. */
export class AcpWorkerClient {
  readonly events = new EventEmitter();
  readonly process: ChildProcessWithoutNullStreams;
  readonly capabilities: AcpCapabilities;

  private readonly lines: Interface;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly serverRequests = new Map<
    string | number,
    { method: string; sessionId?: string; controller: AbortController; responded: boolean }
  >();
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private closed = false;
  private stderr = '';
  private clientRequestHandler?: AgentClientRequestHandler;
  sessionId?: string;

  private constructor(
    launch: AcpLaunch,
    process: ChildProcessWithoutNullStreams,
    lines: Interface,
    capabilities: AcpCapabilities,
  ) {
    this.process = process;
    this.lines = lines;
    this.capabilities = capabilities;
    this.requestTimeoutMs = launch.requestTimeoutMs ?? defaultTimeoutMs;
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    process.on('error', (error) => this.finish(error));
    process.on('exit', (code, signal) => {
      this.finish(new Error(`ACP process exited (${signal ?? code}). ${this.stderr.trim()}`.trim()));
    });
    lines.on('line', (line) => this.receiveLine(line));
  }

  static async start(launch: AcpLaunch): Promise<AcpWorkerClient> {
    const spec = acpSpawnSpec(launch);
    const child = spawn(spec.command, spec.args, {
      cwd: launch.cwd,
      env: launch.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    const lines = createInterface({ input: child.stdout });
    const client = new AcpWorkerClient(launch, child, lines, {
      authenticationMethods: [],
      loadSession: false,
      sessionList: false,
      prompt: {},
      mcp: {},
      raw: {},
    });

    try {
      const result = (await client.request(
        'initialize',
        {
          protocolVersion: 1,
          clientInfo: {
            name: launch.clientName ?? 'mastra-assistant',
            version: launch.clientVersion ?? '0.1.0',
          },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
        startupTimeoutMs,
      )) as JsonObject;
      const raw = (result.agentCapabilities ?? {}) as JsonObject;
      client.capabilities.authenticationMethods = Array.isArray(result.authMethods)
        ? (result.authMethods as JsonObject[])
        : [];
      const sessionCapabilities = raw.sessionCapabilities as JsonObject | undefined;
      client.capabilities.loadSession = raw.loadSession === true;
      client.capabilities.sessionList =
        typeof sessionCapabilities === 'object' && sessionCapabilities !== null && 'list' in sessionCapabilities;
      client.capabilities.prompt = (raw.promptCapabilities ?? {}) as JsonObject;
      client.capabilities.mcp = (raw.mcpCapabilities ?? {}) as JsonObject;
      client.capabilities.raw = raw;
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  setClientRequestHandler(handler: AgentClientRequestHandler): void {
    this.clientRequestHandler = handler;
  }

  async newSession(cwd: string, mcpServers: unknown[] = []): Promise<string> {
    const result = (await this.request('session/new', { cwd, mcpServers })) as JsonObject;
    if (typeof result.sessionId !== 'string') {
      throw new Error('ACP agent did not return a session ID');
    }
    this.sessionId = result.sessionId;
    return result.sessionId;
  }

  async loadSession(sessionId: string, cwd: string, mcpServers: unknown[] = []): Promise<void> {
    if (!this.capabilities.loadSession) {
      throw new Error('This ACP agent did not advertise session load/resume support');
    }
    await this.request('session/load', { sessionId, cwd, mcpServers });
    this.sessionId = sessionId;
  }

  async authenticate(methodId: string, scopes?: string[]): Promise<void> {
    await this.request('authenticate', { methodId, ...(scopes ? { scopes } : {}) });
  }

  async prompt(sessionId: string, text: string, signal?: AbortSignal): Promise<JsonObject> {
    if (signal?.aborted) throw new Error('ACP prompt was cancelled before dispatch');
    const abort = () => {
      void this.cancel(sessionId);
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      return (await this.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text }] },
        this.requestTimeoutMs,
      )) as JsonObject;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async cancel(sessionId = this.sessionId): Promise<void> {
    if (!sessionId || this.closed) return;
    this.notify('session/cancel', { sessionId });
    for (const [id, request] of [...this.serverRequests]) {
      if (request.sessionId !== sessionId) continue;
      request.controller.abort(new Error('ACP session cancelled'));
      const response = this.cancellationResponse(request.method);
      if (response === undefined) {
        if (!request.responded) {
          this.send({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Unsupported blocking ACP client request: ${request.method}` },
          });
          request.responded = true;
        }
      } else {
        this.respondToAgentRequest(id, request, response);
      }
    }
  }

  /**
   * Terminates the worker and resolves once it has exited (or after a short
   * grace period), so callers can safely delete its working directory on Windows.
   */
  close(): Promise<void> {
    const alive = this.process.exitCode === null && this.process.signalCode === null;
    // A client can be marked closed (for example after a suspended permission) while
    // its process is still running, so always wait for the process when it is alive.
    const exited = new Promise<void>((resolve) => {
      if (!alive) return resolve();
      this.process.once('exit', () => resolve());
      setTimeout(resolve, 5_000).unref();
    });
    if (this.closed) {
      if (alive) this.process.kill('SIGTERM');
      return exited;
    }
    this.lines.close();
    if (alive) this.process.kill('SIGTERM');
    this.finish(new Error('ACP process closed by client'));
    return exited;
  }

  private async request(method: string, params: JsonObject, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (this.closed) throw new Error('ACP process is closed');
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} request timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
    });
    try {
      this.send({ jsonrpc: '2.0', id, method, params });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) clearTimeout(pending.timer);
      this.pending.delete(id);
      throw error;
    }
    return response;
  }

  private notify(method: string, params: JsonObject): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(message: JsonObject): void {
    if (this.closed || !this.process.stdin.writable) {
      throw new Error('ACP process closed its input');
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receiveLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.events.emit('protocolError', new Error('ACP agent wrote invalid JSON to stdout'));
      return;
    }
    if (message.method) {
      if (message.id !== undefined && message.id !== null) {
        void this.handleClientRequest(message as RpcMessage & { id: string | number });
      } else {
        this.events.emit('update', { method: message.method, params: message.params ?? {} } satisfies AcpUpdate);
      }
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(
        new Error(`ACP ${pending.method} error ${message.error.code ?? ''}: ${message.error.message ?? 'unknown error'}`),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private async handleClientRequest(message: RpcMessage & { id: string | number }): Promise<void> {
    const sessionId = typeof message.params?.sessionId === 'string' ? message.params.sessionId : undefined;
    const request = { method: message.method!, sessionId, controller: new AbortController(), responded: false };
    this.serverRequests.set(message.id, request);
    try {
      const handler = this.clientRequestHandler
        ? Promise.resolve(
            this.clientRequestHandler({
              id: message.id,
              method: message.method!,
              params: message.params ?? {},
              signal: request.controller.signal,
            }),
          )
        : Promise.resolve(this.defaultClientResponse(message.method!));
      const cancelled = new Promise<symbol>((resolve) => {
        request.controller.signal.addEventListener('abort', () => resolve(Symbol.for('acp.cancelled')), { once: true });
      });
      const result = await Promise.race([handler, cancelled]);
      if (result === Symbol.for('acp.cancelled')) {
        this.respondToAgentRequest(message.id, request, this.cancellationResponse(request.method));
      } else if (result === ACP_UNHANDLED) {
        this.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Unsupported blocking ACP client request: ${request.method}` },
        });
        request.responded = true;
      } else {
        this.respondToAgentRequest(message.id, request, result);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.events.emit('clientRequestRejected', { method: message.method, error });
      if (!request.responded) {
        this.send({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: this.clientRequestHandler ? -32603 : -32601,
            message: this.clientRequestHandler
              ? `ACP client request handler failed: ${errorMessage}`
              : `Unsupported blocking ACP client request: ${message.method}`,
          },
        });
        request.responded = true;
      }
    } finally {
      this.serverRequests.delete(message.id);
    }
  }

  private respondToAgentRequest(id: string | number, request: { responded: boolean }, result: unknown): void {
    if (request.responded) return;
    request.responded = true;
    this.send({ jsonrpc: '2.0', id, result: result as JsonObject });
  }

  private cancellationResponse(method: string): unknown {
    switch (method) {
      case 'session/request_permission':
      case 'cursor/ask_question':
      case 'cursor/create_plan':
        return { outcome: { outcome: 'cancelled' } };
      default:
        return undefined;
    }
  }

  private defaultClientResponse(method: string): unknown {
    switch (method) {
      case 'session/request_permission':
      case 'cursor/ask_question':
      case 'cursor/create_plan':
        return { outcome: { outcome: 'cancelled' } };
      default:
        throw new Error(`Unsupported blocking ACP client request: ${method}`);
    }
  }

  private finish(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    this.events.emit('closed', error);
  }
}
