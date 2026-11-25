/**
 * Stub subscription table (MAST-72): maps external repo keys to workspace + optional conversation.
 * Replace with durable storage before production webhooks.
 */
export type SignalSubscription = {
  provider: 'github';
  externalKey: string;
  workspaceId: string;
  conversationId?: string;
};

const table = new Map<string, SignalSubscription>();

function key(provider: string, externalKey: string): string {
  return `${provider}:${externalKey}`;
}

export function registerSubscription(sub: SignalSubscription): void {
  table.set(key(sub.provider, sub.externalKey), sub);
}

export function resolveSubscription(provider: 'github', externalKey: string): SignalSubscription | undefined {
  return table.get(key(provider, externalKey));
}

/** Dev default when GITHUB_DEFAULT_REPO is set (owner/repo). */
export function bootstrapDefaultGitHubSubscription(workspaceId: string, conversationId?: string): void {
  const repo = process.env.GITHUB_DEFAULT_REPO?.trim();
  if (!repo) return;
  registerSubscription({ provider: 'github', externalKey: repo, workspaceId, conversationId });
}