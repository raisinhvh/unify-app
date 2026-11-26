import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withExplorer, parseExplorerRanges, formatExplorerRanges } from '../dist/runtime/explorer.mjs';
import { delegationInstructions, messageAgentsByNameNote, messageByNameHint, takeMessageByNameHint } from '../dist/runtime/delegation.mjs';

test('explorer is opt-in and user profiles take precedence', () => {
  const profiles = [{ name: 'other' }];
  assert.deepEqual(withExplorer(profiles, {}), profiles);
  const result = withExplorer(profiles, { model: 'small', effort: 'low', speed: 'Fast' });
  assert.deepEqual(result[1], { name: 'explorer', description: 'Searches and reads files and returns a concise answer.', model: 'small', effort: 'low', speed: 'Fast', mode: 'read-only' });
  const custom = [{ name: 'explorer', model: 'custom' }];
  assert.deepEqual(withExplorer(custom, { model: 'small' }), custom);
});

test('explorer parses merged ranges, first reason, malformed lines and caps results', () => {
  const body = ['src/a.ts:3-5 first', 'src/a.ts:5-8 second', 'invalid line', 'src/a.ts:0-3 invalid',
    ...Array.from({ length: 20 }, (_, index) => `src/b${index}.ts:1-2 reason`)];
  const parsed = parseExplorerRanges(`Answer.\n\n\`\`\`ranges\n${body.join('\n')}\n\`\`\``);
  assert.equal(parsed.text, 'Answer.');
  assert.deepEqual(parsed.ranges[0], { path: 'src/a.ts', startLine: 3, endLine: 8, why: 'first' });
  assert.equal(parsed.ranges.length, 12);
  assert.equal(parseExplorerRanges('No block.').text, 'No block.');
  assert.deepEqual(parseExplorerRanges('Answer\n\`\`\`ranges\nbroken\n\`\`\`').ranges, []);
  assert.match(formatExplorerRanges(parsed.ranges), /src\/a\.ts:3-8 first/);
  assert.equal(formatExplorerRanges([]), '');
});

test('explorer instructions are opt-in', () => {
  assert.equal(delegationInstructions(true), delegationInstructions(true, { explorer: false }));
  assert.equal(delegationInstructions(false), delegationInstructions(false, { explorer: true }));
  assert.match(delegationInstructions(true, { explorer: true }), /delegate to explorer/);
});

test('a batch strips each start reply\'s message hint so it can add one note', () => {
  const outcome = { text: `Started subagent Arp (Sonnet (High)) in the background as task bg-1.${messageByNameHint('Arp')}\n\nMessages from other agents: hi` };
  assert.equal(takeMessageByNameHint(outcome), 'Arp');
  assert.equal(outcome.text, 'Started subagent Arp (Sonnet (High)) in the background as task bg-1.\n\nMessages from other agents: hi');
  assert.equal(takeMessageByNameHint({ text: 'Started subagent "x" in the background as task bg-2.' }), undefined);
  assert.equal(messageAgentsByNameNote('Arp'), 'Message any of these agents by their name. Ex: { "to": "Arp" }');
});
