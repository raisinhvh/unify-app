import assert from 'node:assert/strict';
import { parseCursorModelList } from '../dist/unify/cursorModels.mjs';

// Real `cursor-agent models` output: heading, blank line, "slug - Name" rows, a default marker and zero-width noise.
const output = [
  'Available models',
  '',
  'auto - Auto (default)',
  'gpt-5.2 - GPT-5.2',
  'grok-4.7-low-fast - Grok 4.7  Low Fast​​',
  '\u001B[2mclaude-opus-5-thinking-high - Claude Opus 5 1M Thinking\u001B[0m',
  'gpt-5.2 - GPT-5.2 again',
  'Tip: use --model to pick one',
].join('\r\n');

assert.deepEqual(parseCursorModelList(output), [
  { value: 'auto', name: 'Auto' },
  { value: 'gpt-5.2', name: 'GPT-5.2' },
  { value: 'grok-4.7-low-fast', name: 'Grok 4.7 Low Fast' },
  { value: 'claude-opus-5-thinking-high', name: 'Claude Opus 5 1M Thinking' },
]);

assert.deepEqual(parseCursorModelList('Not logged in. Run cursor-agent login.'), []);

console.log('cursor-models: ok');
