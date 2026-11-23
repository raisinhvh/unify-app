import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appliesTo,
  audiencesFor,
  audiencesForMany,
} from '../dist/unify/knowledgeAudience.mjs';
import {
  filterRuleText,
  instructionsForAudience,
  writeAudienceInstructions,
} from '../dist/instructions/audiences.mjs';

const MAIN = { kind: 'main' };
const BUILDER = { kind: 'subagent', profile: 'Builder' };
const OTHER = { kind: 'subagent', profile: 'Other' };

async function roots() {
  const base = await mkdtemp(join(tmpdir(), 'unify-knowledge-audience-'));
  const result = { workspace: join(base, 'ws'), unifyHome: join(base, 'unify') };
  for (const dir of Object.values(result)) await mkdir(dir, { recursive: true });
  return result;
}

async function fixture() {
  const r = await roots();
  await writeFile(join(r.unifyHome, 'AGENTS.md'), [
    '# Global rules',
    '',
    '## Main only',
    '',
    'Delegate work.',
    '',
    '## Shared',
    '',
    'Always test.',
    '',
    '## Subagents only',
    '',
    'Report early.',
    '',
    '## Builder only',
    '',
    'Review carefully.',
    '',
  ].join('\n'));
  await writeFile(join(r.workspace, 'AGENTS.md'), [
    '# Project rules',
    '',
    '## Project main',
    '',
    'Use repo docs.',
    '',
    '## Project notes',
    '',
    'Keep this.',
    '',
  ].join('\n'));
  const knowledgeFile = join(r.unifyHome, 'knowledge.json');
  await writeFile(knowledgeFile, JSON.stringify({
    items: {
      'rule:global:main-only': { audiences: ['main'] },
      'rule:global:shared': { audiences: ['everyone'] },
      'rule:global:subagents-only': { audiences: ['subagents'] },
      'rule:global:builder-only': { audiences: ['profile:Builder'] },
      'rule:project:project-main': { audiences: ['main'] },
    },
  }, null, 2));
  return { ...r, knowledgeFile };
}

test('appliesTo routes every audience kind to the right agent', () => {
  assert.equal(appliesTo(['everyone'], MAIN), true);
  assert.equal(appliesTo(['everyone'], BUILDER), true);

  assert.equal(appliesTo(['main'], MAIN), true);
  assert.equal(appliesTo(['main'], BUILDER), false);

  assert.equal(appliesTo(['subagents'], MAIN), false);
  assert.equal(appliesTo(['subagents'], BUILDER), true);
  assert.equal(appliesTo(['subagents'], OTHER), true);

  assert.equal(appliesTo(['profile:Builder'], MAIN), false);
  assert.equal(appliesTo(['profile:Builder'], BUILDER), true);
  assert.equal(appliesTo(['profile:Builder'], OTHER), false);

  assert.equal(appliesTo(['main', 'profile:Builder'], BUILDER), true);
  assert.equal(appliesTo([], MAIN), true);
  assert.equal(appliesTo(undefined, OTHER), true);
});

test('knowledge.audiences off makes every rule apply to everyone', () => {
  assert.equal(appliesTo(['main'], OTHER, { enabled: false }), true);
  assert.equal(appliesTo(['profile:Builder'], MAIN, { enabled: false }), true);
  assert.equal(appliesTo(['main'], MAIN, { enabled: true }), true);
  assert.equal(appliesTo(['main'], OTHER, { enabled: true }), false);
});

test('audiencesFor reads knowledge.json and defaults missing metadata to everyone', async () => {
  const r = await fixture();
  assert.deepEqual(audiencesFor('rule:global:main-only', { knowledgeFile: r.knowledgeFile }), ['main']);
  assert.deepEqual(audiencesFor('rule:global:builder-only', { knowledgeFile: r.knowledgeFile }), ['profile:Builder']);
  assert.deepEqual(audiencesFor('rule:global:missing', { knowledgeFile: r.knowledgeFile }), ['everyone']);
  assert.deepEqual(audiencesFor('rule:global:missing', { knowledgeFile: join(r.unifyHome, 'absent.json') }), ['everyone']);
  assert.deepEqual(
    audiencesForMany(['rule:global:shared', 'rule:project:project-main'], { knowledgeFile: r.knowledgeFile }),
    [['everyone'], ['main']],
  );
});

test('filterRuleText keeps the heading and body of applicable sections', async () => {
  const r = await fixture();
  const text = await readFile(join(r.unifyHome, 'AGENTS.md'), 'utf8');
  const main = filterRuleText(text, 'global', MAIN, { knowledgeFile: r.knowledgeFile });
  assert.match(main, /^# Global rules/);
  assert.match(main, /## Main only\n\nDelegate work\./);
  assert.match(main, /## Shared\n\nAlways test\./);
  assert.doesNotMatch(main, /Subagents only|Builder only/);

  const builder = filterRuleText(text, 'global', BUILDER, { knowledgeFile: r.knowledgeFile });
  assert.match(builder, /## Subagents only/);
  assert.match(builder, /## Builder only/);
  assert.doesNotMatch(builder, /Main only/);

  const other = filterRuleText(text, 'global', OTHER, { knowledgeFile: r.knowledgeFile });
  assert.match(other, /## Subagents only/);
  assert.doesNotMatch(other, /Main only|Builder only/);

  const legacy = filterRuleText(text, 'global', OTHER, { knowledgeFile: r.knowledgeFile, enabled: false });
  assert.match(legacy, /## Main only/);
  assert.match(legacy, /## Builder only/);
});

test('instructionsForAudience filters global and project rules', async () => {
  const r = await fixture();
  const options = { knowledgeFile: r.knowledgeFile };

  const main = await instructionsForAudience(r, MAIN, options);
  assert.match(main, /## Main only/);
  assert.match(main, /## Project main/);
  assert.match(main, /## Project notes/);
  assert.match(main, /## Shared/);
  assert.doesNotMatch(main, /## Subagents only/);
  assert.doesNotMatch(main, /## Builder only/);

  const builder = await instructionsForAudience(r, BUILDER, options);
  assert.match(builder, /## Shared/);
  assert.match(builder, /## Subagents only/);
  assert.match(builder, /## Builder only/);
  assert.match(builder, /## Project notes/);
  assert.doesNotMatch(builder, /## Main only/);
  assert.doesNotMatch(builder, /## Project main/);
});

test('rules without audience metadata all reach every agent', async () => {
  const r = await roots();
  await writeFile(join(r.unifyHome, 'AGENTS.md'), '## Legacy\n\nOld rules.\n\n## Another\n\nMore rules.\n');
  await mkdir(join(r.workspace), { recursive: true });
  const text = await instructionsForAudience(r, OTHER, { knowledgeFile: join(r.unifyHome, 'missing.json') });
  assert.match(text, /## Legacy/);
  assert.match(text, /## Another/);
});

test('writeAudienceInstructions writes a filtered file and removes it when nothing applies', async () => {
  const r = await fixture();
  const home = join(r.unifyHome, 'agents', 'builder');
  const written = await writeAudienceInstructions(r, BUILDER, home, {
    knowledgeFile: r.knowledgeFile,
    fileName: 'AGENTS.audience.md',
  });
  assert.equal(written, join(home, 'AGENTS.audience.md'));
  const text = await readFile(written, 'utf8');
  assert.match(text, /## Builder only/);
  assert.doesNotMatch(text, /## Main only/);

  const onlyMain = await roots();
  await writeFile(join(onlyMain.unifyHome, 'AGENTS.md'), '## Main only\n\nDelegate.\n');
  await writeFile(join(onlyMain.unifyHome, 'knowledge.json'), JSON.stringify({ items: { 'rule:global:main-only': { audiences: ['main'] } } }));
  const removed = await writeAudienceInstructions(onlyMain, OTHER, join(onlyMain.unifyHome, 'subagent'), {
    knowledgeFile: join(onlyMain.unifyHome, 'knowledge.json'),
  });
  assert.equal(removed, undefined);
});
