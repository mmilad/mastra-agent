import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { handleGithubCiWebhook } from '../../src/signals/ci-webhook.ts';
import { registerSubscription } from '../../src/signals/subscriptions.ts';
import { registerSignalRuntime } from '../../src/signals/runtime.ts';

test('github webhook rejects when secret unset', async () => {
  const previous = process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.GITHUB_WEBHOOK_SECRET;
  try {
    const response = await handleGithubCiWebhook(new Request('http://localhost/webhooks/github', { method: 'POST', body: '{}' }));
    assert.equal(response.status, 503);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = previous;
  }
});

test('github webhook verifies signature and accepts ci_run', async () => {
  const secret = 'test-secret';
  process.env.GITHUB_WEBHOOK_SECRET = secret;
  registerSignalRuntime({
    getAgent: () => ({
      subscribeToThread: async () => {},
      sendNotificationSignal: async () => ({ record: { id: 'ci1' } }),
    }),
  });
  registerSubscription({
    provider: 'github',
    externalKey: 'acme/widget',
    workspaceId: 'local-user:project:abc123',
    conversationId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  });
  const body = JSON.stringify({ repository: { full_name: 'acme/widget' }, action: 'completed' });
  const signature = `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
  const response = await handleGithubCiWebhook(
    new Request('http://localhost/webhooks/github', {
      method: 'POST',
      body,
      headers: {
        'x-hub-signature-256': signature,
        'x-github-event': 'workflow_run',
        'x-github-delivery': 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a99',
      },
    }),
  );
  assert.ok(response.status === 202 || response.status === 200);
});