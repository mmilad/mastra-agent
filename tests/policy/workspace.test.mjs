import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  choosePermissionOption,
  inspectPermissionRequest,
  taskFingerprint,
} from '../../src/policy/workspace.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mastra-policy-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'hello.ts'), 'export {}');
  return root;
}

test('allows a path-bound edit inside the explicitly selected workspace', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scope = inspectPermissionRequest(root, 'session/request_permission', {
    toolCall: {
      kind: 'edit',
      title: 'Edit src/hello.ts',
      content: [{ type: 'diff', path: join(root, 'src', 'hello.ts') }],
    },
  });
  assert.equal(scope.inWorkspace, true);
  assert.equal(scope.automaticallyAllowed, true);
});

test('requires approval before deleting a file, even inside the workspace', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scope = inspectPermissionRequest(root, 'session/request_permission', {
    toolCall: { kind: 'delete', content: [{ type: 'diff', path: join(root, 'src', 'hello.ts') }] },
  });
  assert.equal(scope.inWorkspace, true);
  assert.equal(scope.automaticallyAllowed, false);
  assert.match(scope.reason, /consequential/);
});

test('holds paths outside the workspace for approval', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outside = join(dirname(root), 'outside.txt');
  const scope = inspectPermissionRequest(root, 'session/request_permission', {
    toolCall: { kind: 'edit', content: [{ type: 'diff', path: outside }] },
  });
  assert.equal(scope.inWorkspace, false);
  assert.equal(scope.automaticallyAllowed, false);
  assert.match(scope.reason, /outside the authorized project workspace/);
});

test('resolves symlinks before deciding whether a path is in scope', (t) => {
  const root = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'mastra-outside-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  try {
    symlinkSync(outside, join(root, 'linked'));
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.skip(`Symlink creation is not permitted in this environment (${error.code}).`);
      return;
    }
    throw error;
  }
  const scope = inspectPermissionRequest(root, 'session/request_permission', {
    toolCall: { kind: 'edit', content: [{ type: 'diff', path: join(root, 'linked', 'new.txt') }] },
  });
  assert.equal(scope.inWorkspace, false);
  assert.equal(scope.automaticallyAllowed, false);
});

test('allows only the small command allowlist and rejects shell composition', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const request = (command) => inspectPermissionRequest(root, 'session/request_permission', {
    toolCall: { kind: 'execute', rawInput: { command, cwd: root } },
  });
  assert.equal(request('npm run check').automaticallyAllowed, true);
  assert.equal(request('npm run test:policy').automaticallyAllowed, true);
  assert.equal(request('npm run test:acp:providers').automaticallyAllowed, false);
  assert.equal(request('npm run unknown-task').automaticallyAllowed, false);
  assert.equal(request('npm run check -- --project /etc').automaticallyAllowed, false);
  assert.equal(request('cat ~/.ssh/id_rsa').automaticallyAllowed, false);
  assert.equal(request('npm run check && cat ~/.ssh/id_rsa').automaticallyAllowed, false);
});

test('permission choices use provider option kinds, not provider-specific IDs', () => {
  const params = { options: [
    { optionId: 'allow-once', kind: 'allow_once' },
    { optionId: 'accept_execpolicy_amendment', kind: 'allow_always' },
    { optionId: 'reject-once', kind: 'reject_once' },
  ] };
  assert.deepEqual(choosePermissionOption(params, true), {
    outcome: { outcome: 'selected', optionId: 'allow-once' },
  });
  assert.deepEqual(choosePermissionOption(params, false), {
    outcome: { outcome: 'selected', optionId: 'reject-once' },
  });
});

test('task fingerprints are deterministic', () => {
  assert.equal(taskFingerprint('do the work'), taskFingerprint('do the work'));
  assert.notEqual(taskFingerprint('do the work'), taskFingerprint(' do the work '));
  assert.notEqual(taskFingerprint('do the work'), taskFingerprint('do other work'));
});
