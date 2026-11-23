import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, readFile, access, stat, rm, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shareInstructions } from '../dist/instructions/share.mjs';

const START = '<!-- unify:shared-rules:start (managed by Unify; edit global rules in Unify instead) -->';
const END = '<!-- unify:shared-rules:end -->';
const exists = path => access(path).then(() => true, () => false);
const text = path => readFile(path, 'utf8');

async function roots(t) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-share-'));
  // A Windows sandbox may refuse to remove a junction, leaving only a temp folder behind.
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => undefined));
  const result = { unifyHome: join(base, 'dsh'), agentsHome: join(base, 'agents'), directory: join(base, 'account') };
  await mkdir(result.unifyHome);
  await mkdir(result.agentsHome);
  return result;
}

async function skill(home, name, body = name) {
  const dir = join(home, 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), body);
  return dir;
}

test('Claude preserves user rules, updates in place, avoids writes, and removes its block', async t => {
  const r = await roots(t);
  await mkdir(r.directory);
  const file = join(r.directory, 'CLAUDE.md');
  const user = '# Private rules\r\nKeep these bytes.  ';
  await writeFile(file, user);
  await writeFile(join(r.unifyHome, 'AGENTS.md'), '# Global\nBe brief. \n\n');
  assert.deepEqual(await shareInstructions(r.directory, r, true), { rules: true, skills: [] });
  const initial = `${user}\n\n${START}\n# Global\nBe brief.\n${END}`;
  assert.equal(await text(file), initial);
  await utimes(file, 1000000000, 1000000000);
  const before = (await stat(file)).mtimeMs;
  await shareInstructions(r.directory, r, true);
  assert.equal((await stat(file)).mtimeMs, before);
  assert.equal(await text(file), initial);
  await writeFile(file, initial + '\r\nUser suffix.  \r\n');
  await writeFile(join(r.unifyHome, 'AGENTS.md'), 'Updated');
  await shareInstructions(r.directory, r, true);
  assert.equal(await text(file), `${user}\n\n${START}\nUpdated\n${END}\r\nUser suffix.  \r\n`);
  assert.deepEqual(await shareInstructions(r.directory, r, false), { rules: false, skills: [] });
  assert.equal(await text(file), user + '\r\nUser suffix.  \r\n');
});

test('rules created solely by sharing are deleted on disable or a blank/missing source', async t => {
  const r = await roots(t);
  const file = join(r.directory, 'CLAUDE.md');
  const source = join(r.unifyHome, 'AGENTS.md');
  await shareInstructions(r.directory, r, true);
  assert.equal(await exists(r.directory), false);
  await writeFile(source, 'Global');
  await shareInstructions(r.directory, r, true);
  assert.equal(await text(file), `${START}\nGlobal\n${END}`);
  await shareInstructions(r.directory, r, false);
  assert.equal(await exists(file), false);
  for (const missing of [false, true]) {
    await writeFile(source, 'Global');
    await shareInstructions(r.directory, r, true);
    if (missing) await rm(source);
    else await writeFile(source, ' \n\t');
    assert.equal((await shareInstructions(r.directory, r, true)).rules, false);
    assert.equal(await exists(file), false);
  }
  await writeFile(file, ' \n\t');
  await shareInstructions(r.directory, r, false);
  assert.equal(await text(file), ' \n\t');
});

test('skills copy nested files, update and prune while preserving unmanaged CLI directories', async t => {
  const r = await roots(t);
  const source = await skill(r.unifyHome, 'review');
  await mkdir(join(source, 'references'));
  await writeFile(join(source, 'references', 'old.txt'), 'old');
  await skill(r.unifyHome, 'collision', 'source');
  await skill(r.directory, 'collision', 'user');
  await skill(r.directory, 'synced', 'CLI synced');
  await skill(r.directory, '.system', 'CLI system');
  const manifest = join(r.directory, 'skills', '.unify-shared.json');
  const target = join(r.directory, 'skills', 'review');
  assert.deepEqual((await shareInstructions(r.directory, r, true)).skills, ['review']);
  assert.equal(await text(join(target, 'references', 'old.txt')), 'old');
  const value = JSON.parse(await text(manifest));
  assert.equal(value.version, 1);
  assert.match(value.skills.review.fingerprint, /^[a-f0-9]{64}$/);
  await utimes(join(target, 'SKILL.md'), 1000000000, 1000000000);
  await utimes(manifest, 1000000000, 1000000000);
  const before = (await stat(join(target, 'SKILL.md'))).mtimeMs;
  await shareInstructions(r.directory, r, true);
  assert.equal((await stat(join(target, 'SKILL.md'))).mtimeMs, before);
  assert.equal((await stat(manifest)).mtimeMs, 1000000000000);
  await rm(join(source, 'references', 'old.txt'));
  await writeFile(join(source, 'references', 'new.txt'), 'new');
  await shareInstructions(r.directory, r, true);
  assert.equal(await exists(join(target, 'references', 'old.txt')), false);
  assert.equal(await text(join(target, 'references', 'new.txt')), 'new');
  await rm(source, { recursive: true });
  assert.deepEqual((await shareInstructions(r.directory, r, true)).skills, []);
  assert.equal(await exists(target), false);
  assert.equal(await exists(manifest), false);
  await skill(r.unifyHome, 'review');
  await shareInstructions(r.directory, r, true);
  await shareInstructions(r.directory, r, false);
  assert.equal(await exists(target), false);
  assert.equal(await exists(manifest), false);
  for (const [name, body] of [['collision', 'user'], ['synced', 'CLI synced'], ['.system', 'CLI system']]) {
    assert.equal(await text(join(r.directory, 'skills', name, 'SKILL.md')), body);
  }
});

test('Claude gives agentsHome precedence and returns managed names sorted', async t => {
  const r = await roots(t);
  await skill(r.unifyHome, 'same', 'dsh');
  await skill(r.agentsHome, 'same', 'agents');
  await skill(r.unifyHome, 'z-last');
  await skill(r.agentsHome, 'a-first');
  assert.deepEqual((await shareInstructions(r.directory, r, true)).skills, ['a-first', 'same', 'z-last']);
  assert.equal(await text(join(r.directory, 'skills', 'same', 'SKILL.md')), 'agents');
  await rm(join(r.agentsHome, 'skills', 'same'), { recursive: true });
  await shareInstructions(r.directory, r, true);
  assert.equal(await text(join(r.directory, 'skills', 'same', 'SKILL.md')), 'dsh');
});

test('corrupt manifests protect existing copies and invalid names cannot escape skills', async t => {
  const r = await roots(t);
  await skill(r.unifyHome, 'existing', 'source');
  await skill(r.directory, 'existing', 'private');
  await skill(r.unifyHome, '.hidden');
  await skill(r.unifyHome, 'bad_name');
  await skill(r.unifyHome, 'valid');
  const manifest = join(r.directory, 'skills', '.unify-shared.json');
  await writeFile(manifest, '{bad json');
  assert.deepEqual((await shareInstructions(r.directory, r, true)).skills, ['valid']);
  assert.equal(await text(join(r.directory, 'skills', 'existing', 'SKILL.md')), 'private');
  await writeFile(manifest, JSON.stringify({ version: 1, skills: { '../outside': { fingerprint: 'x' } } }));
  await shareInstructions(r.directory, r, false);
  assert.equal(await text(join(r.directory, 'skills', 'existing', 'SKILL.md')), 'private');
  assert.equal(await exists(join(r.directory, 'skills', 'valid')), true);
});

test('oversized skills are skipped without preventing other skills or rules', async t => {
  const r = await roots(t);
  await writeFile(join(r.unifyHome, 'AGENTS.md'), 'Rules still shared');
  const large = await skill(r.unifyHome, 'large');
  await writeFile(join(large, 'large.bin'), Buffer.alloc(5 * 1024 * 1024));
  const many = await skill(r.unifyHome, 'many');
  for (let i = 0; i < 200; i++) await writeFile(join(many, `${i}.txt`), 'x');
  await skill(r.unifyHome, 'okay');
  assert.deepEqual(await shareInstructions(r.directory, r, true), { rules: true, skills: ['okay'] });
  assert.equal(await exists(join(r.directory, 'skills', 'large')), false);
  assert.equal(await exists(join(r.directory, 'skills', 'many')), false);
});

test('source junctions and nested symlinks are skipped', async t => {
  const r = await roots(t);
  const source = await skill(r.unifyHome, 'real');
  const outside = join(r.agentsHome, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'private');
  try {
    await symlink(source, join(r.unifyHome, 'skills', 'linked'), 'junction');
    await symlink(outside, join(source, 'linked-folder'), 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Symlinks unavailable'); return; }
    throw error;
  }
  assert.deepEqual((await shareInstructions(r.directory, r, true)).skills, ['real']);
  assert.equal(await exists(join(r.directory, 'skills', 'real', 'linked-folder')), false);
});

test('rules errors propagate after skills still get a chance to share', async t => {
  const r = await roots(t);
  await mkdir(join(r.unifyHome, 'AGENTS.md'));
  await skill(r.unifyHome, 'okay');
  await assert.rejects(shareInstructions(r.directory, r, true));
  assert.equal(await text(join(r.directory, 'skills', 'okay', 'SKILL.md')), 'okay');
});
