import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorContextDiff } from '../dist/runtime/editorContext.mjs';

const first = 'IDE context\nOpen files: a.ts, b.ts\nActive file: a.ts\nCursor: line 1, column 1\nDiagnostics: none';
const moved = first.replace('line 1', 'line 2');
test('editor context sends first state and ignores identical state', () => {
  assert.equal(editorContextDiff(first, first), '');
  assert.equal(editorContextDiff(undefined, first), first);
});
test('editor context sends only the new cursor', () => {
  assert.equal(editorContextDiff(first, moved), 'Cursor: line 2, column 1');
});
test('editor context reports opened and closed files, including with cursor movement', () => {
  assert.equal(editorContextDiff(first, first.replace('a.ts, b.ts', 'a.ts, b.ts, c.ts')), 'Opened files: c.ts');
  assert.equal(editorContextDiff(first, first.replace('a.ts, b.ts', 'a.ts')), 'Closed files: b.ts');
  assert.equal(editorContextDiff(first, first.replace('a.ts, b.ts', 'b.ts, c.ts')), 'Opened files: c.ts\nClosed files: a.ts');
  assert.equal(editorContextDiff(first, moved.replace('a.ts, b.ts', 'b.ts, c.ts')), 'Opened files: c.ts\nClosed files: a.ts\nCursor: line 2, column 1');
  assert.equal(editorContextDiff(first, first.replace('a.ts, b.ts', '(none)')), 'Closed files: a.ts, b.ts');
});
test('editor context sends full state when other context changes', () => {
  const changed = first.replace('Diagnostics: none', 'Diagnostics: error');
  assert.equal(editorContextDiff(first, changed), changed);
});
