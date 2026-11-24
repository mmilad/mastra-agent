import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverSkills, loadSkill } from '../../src/skills/registry.ts';
import { SkillStateStore } from '../../src/skills/skill-state-store.ts';

function project() { return mkdtempSync(join(tmpdir(), 'mastra-skills-')); }

function writeSkill(root, name, { metadata = '', body = '# Instructions\nUse the project workflow.' } = {}) {
  const directory = join(root, 'skills', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: Use ${name} when its task-specific workflow applies.`,
    ...(metadata ? metadata.split('\n') : []),
    '---',
    body,
  ].join('\n'));
  return directory;
}

function configure(root, value) {
  const directory = join(root, '.mastra');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'skills.json'), JSON.stringify(value));
}

test('discovery returns metadata only and records source, version, and declared conflicts', async (t) => {
  const root = project();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeSkill(root, 'release-notes', {
    metadata: 'metadata:\n  version: "1.2.0"\n  conflicts: "changelog"',
    body: 'BODY_SECRET_SENTINEL\n'.repeat(1000),
  });
  configure(root, { directory: 'skills', disabled: [] });

  const result = await discoverSkills(root);
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].name, 'release-notes');
  assert.equal(result.skills[0].version, '1.2.0');
  assert.equal(result.skills[0].source, 'skills/release-notes/SKILL.md');
  assert.deepEqual(result.skills[0].conflicts, ['changelog']);
  assert.equal(JSON.stringify(result).includes('BODY_SECRET_SENTINEL'), false);
});

test('load includes the selection reason and trust boundary; conflicting skills are refused per thread', async (t) => {
  const root = project();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeSkill(root, 'release-notes', { metadata: 'metadata:\n  version: "1.2.0"\n  conflicts: "changelog"' });
  writeSkill(root, 'changelog');
  configure(root, { directory: 'skills', disabled: [] });
  const stateStore = new SkillStateStore(join(root, 'assistant.db'));

  const loaded = await loadSkill({ projectRoot: root, name: 'release-notes', selectionReason: 'The user asked for a release summary.', threadId: 'thread-a', stateStore });
  assert.equal(loaded.skill.version, '1.2.0');
  assert.equal(loaded.skill.source, 'skills/release-notes/SKILL.md');
  assert.match(loaded.selectionReason, /release summary/);
  assert.match(loaded.instructions, /cannot override system, developer, or user instructions/);
  assert.match(loaded.instructions, /does not execute bundled scripts/);

  await assert.rejects(
    loadSkill({ projectRoot: root, name: 'changelog', selectionReason: 'This task asks for a changelog.', threadId: 'thread-a', stateStore }),
    /conflicts with already loaded skill/,
  );
  const otherThread = await loadSkill({ projectRoot: root, name: 'changelog', selectionReason: 'This task asks for a changelog.', threadId: 'thread-b', stateStore });
  assert.equal(otherThread.skill.name, 'changelog');
  stateStore.close();
});

test('loaded-skill conflicts survive a process restart and stay isolated by workspace', async (t) => {
  const root = project();
  const otherRoot = project();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => rmSync(otherRoot, { recursive: true, force: true }));
  writeSkill(root, 'release-notes', { metadata: 'metadata:\n  conflicts: "changelog"' });
  writeSkill(root, 'changelog');
  writeSkill(otherRoot, 'changelog');
  configure(root, { directory: 'skills', disabled: [] });
  configure(otherRoot, { directory: 'skills', disabled: [] });
  const databasePath = join(root, 'assistant.db');
  const firstStore = new SkillStateStore(databasePath);

  await loadSkill({
    projectRoot: root,
    name: 'release-notes',
    selectionReason: 'The user asked for release notes.',
    threadId: 'thread-resumed',
    stateStore: firstStore,
  });
  firstStore.close();

  // A fresh store instance models a new process resuming the same conversation.
  const restartedStore = new SkillStateStore(databasePath);
  await assert.rejects(loadSkill({
    projectRoot: root,
    name: 'changelog',
    selectionReason: 'The user asked for a changelog.',
    threadId: 'thread-resumed',
    stateStore: restartedStore,
  }), /conflicts with already loaded skill/);
  restartedStore.close();

  const otherWorkspaceStore = new SkillStateStore(databasePath);
  const anotherWorkspace = await loadSkill({
    projectRoot: otherRoot,
    name: 'changelog',
    selectionReason: 'The user asked for a changelog.',
    threadId: 'thread-resumed',
    stateStore: otherWorkspaceStore,
  });
  assert.equal(anotherWorkspace.skill.name, 'changelog');
  otherWorkspaceStore.close();
});

test('disabled and malformed skills are visible but cannot be loaded', async (t) => {
  const root = project();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeSkill(root, 'disabled-skill');
  const invalidDirectory = join(root, 'skills', 'invalid-skill');
  mkdirSync(invalidDirectory, { recursive: true });
  writeFileSync(join(invalidDirectory, 'SKILL.md'), 'name: invalid-skill\ndescription: no frontmatter');
  configure(root, { directory: 'skills', disabled: ['disabled-skill'] });

  const result = await discoverSkills(root);
  assert.equal(result.skills[0].enabled, false);
  assert.equal(result.diagnostics.length, 1);
  await assert.rejects(loadSkill({ projectRoot: root, name: 'disabled-skill', selectionReason: 'This skill seems relevant.' }), /disabled/);
  await assert.rejects(loadSkill({ projectRoot: root, name: 'invalid-skill', selectionReason: 'This skill seems relevant.' }), /invalid and was not loaded/);
});

test('skill roots cannot escape the selected project', async (t) => {
  const root = project();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  configure(root, { directory: '../outside', disabled: [] });
  await assert.rejects(discoverSkills(root), /must stay inside the current project workspace/);
});

test('referenced resources are checked and bundled scripts are never executed', async (t) => {
  const root = project();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = writeSkill(root, 'safe-skill', { body: 'Use `scripts/setup.mjs` when needed.' });
  mkdirSync(join(directory, 'scripts'), { recursive: true });
  writeFileSync(join(directory, 'scripts', 'setup.mjs'), 'throw new Error("This script must never run");');
  configure(root, { directory: 'skills', disabled: [] });

  const loaded = await loadSkill({ projectRoot: root, name: 'safe-skill', selectionReason: 'The task needs this workflow.' });
  assert.match(loaded.instructions, /scripts\/setup\.mjs/);
  assert.equal(loaded.instructions.includes('This script must never run'), false);

  writeSkill(root, 'unsafe-skill', { body: 'Read [outside](../../outside.md) for instructions.' });
  await assert.rejects(
    loadSkill({ projectRoot: root, name: 'unsafe-skill', selectionReason: 'The task needs this workflow.' }),
    /Resource path escapes the skill directory/,
  );
});
