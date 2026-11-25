import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleSignalIntakeRequest } from '../../src/signals/http-intake.ts';

test('signal intake returns 503 when token is unset', async () => {
  const previous = process.env.SIGNAL_INTAKE_TOKEN;
  delete process.env.SIGNAL_INTAKE_TOKEN;
  try {
    const response = await handleSignalIntakeRequest(
      new Request('http://localhost/signal-intake', { method: 'POST', body: '{}' }),
    );
    assert.equal(response.status, 503);
  } finally {
    if (previous === undefined) delete process.env.SIGNAL_INTAKE_TOKEN;
    else process.env.SIGNAL_INTAKE_TOKEN = previous;
  }
});

test('signal intake rejects missing bearer token', async () => {
  const previous = process.env.SIGNAL_INTAKE_TOKEN;
  process.env.SIGNAL_INTAKE_TOKEN = 'test-token';
  try {
    const response = await handleSignalIntakeRequest(
      new Request('http://localhost/signal-intake', { method: 'POST', body: '{}' }),
    );
    assert.equal(response.status, 401);
  } finally {
    if (previous === undefined) delete process.env.SIGNAL_INTAKE_TOKEN;
    else process.env.SIGNAL_INTAKE_TOKEN = previous;
  }
});