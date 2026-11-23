import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('publish allowlist fixture names approved GitHub users', async () => {
  const fixture = JSON.parse(await readFile(new URL('../src/engine/hub/fixtures/publishers.json', import.meta.url), 'utf8'));
  assert.ok(fixture.publishers.includes('raisinhvh'));
  assert.ok(!JSON.stringify(fixture).includes('not-approved'));
});
