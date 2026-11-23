import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundled = await build({ entryPoints: ['src/engine/runtime/rangeEdit.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { applyRangeEdit, mergeLineRanges, rangeHash } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('range edits reject stale reads and report current lines', () => {
  const result = applyRangeEdit('one\ntwo\nthree', { startLine: 2, endLine: 2, expected: 'old', replacement: 'new' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Current lines 2-2:\ntwo/);
});

test('range edits re-anchor only a unique moved window', () => {
  assert.deepEqual(applyRangeEdit('added\none\ntwo', { startLine: 1, endLine: 2, expected: 'one\ntwo', replacement: 'new' }),
    { ok: true, text: 'added\nnew', startLine: 2, endLine: 2 });
  const ambiguous = applyRangeEdit('other\none\nother\none', { startLine: 1, endLine: 1, expected: 'one', replacement: 'new' });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error, /appears in 2 places/);
});

test('range hashes round trip; overlapping ranges merge; CRLF stays intact', () => {
  assert.deepEqual(mergeLineRanges([{ startLine: 3, endLine: 5 }, { startLine: 1, endLine: 3 }]), [{ startLine: 1, endLine: 5 }]);
  assert.deepEqual(applyRangeEdit('a\r\nb\r\nc', { startLine: 2, endLine: 2, expected: rangeHash(['a', 'b', 'c'], 2, 2), replacement: 'x\ny' }),
    { ok: true, text: 'a\r\nx\r\ny\r\nc', startLine: 2, endLine: 3 });
  const pastEnd = applyRangeEdit('a\nb', { startLine: 2, endLine: 4, replacement: 'x' });
  assert.equal(pastEnd.ok, false);
  assert.match(pastEnd.error, /past the end/);
});

test('text expectations re-anchor on a window sized by their own line count', () => {
  assert.deepEqual(applyRangeEdit('one\ntwo\nthree\nfour', { startLine: 1, endLine: 1, expected: 'three\nfour', replacement: 'X' }),
    { ok: true, text: 'one\ntwo\nX', startLine: 3, endLine: 3 });
  assert.deepEqual(applyRangeEdit('one\r\ntwo\r\nthree\r\nfour', { startLine: 1, endLine: 1, expected: 'three\r\nfour', replacement: 'X' }),
    { ok: true, text: 'one\r\ntwo\r\nX', startLine: 3, endLine: 3 });
  const ambiguous = applyRangeEdit('a\nb\na\nb', { startLine: 1, endLine: 1, expected: 'a\nb', replacement: 'X' });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error, /appears in 2 places/);
});

test('mixed line endings stay mixed outside the edited range', () => {
  const mixed = 'a\r\nb\nc\r\nd';
  assert.deepEqual(applyRangeEdit(mixed, { startLine: 2, endLine: 2, replacement: 'x' }),
    { ok: true, text: 'a\r\nx\nc\r\nd', startLine: 2, endLine: 2 });
  assert.deepEqual(applyRangeEdit(mixed, { startLine: 1, endLine: 2, expected: 'a\r\nb', replacement: 'x' }),
    { ok: true, text: 'x\nc\r\nd', startLine: 1, endLine: 1 });
  assert.deepEqual(applyRangeEdit(mixed, { startLine: 4, endLine: 4, replacement: 'x\ny' }),
    { ok: true, text: 'a\r\nb\nc\r\nx\r\ny', startLine: 4, endLine: 5 });
  assert.deepEqual(applyRangeEdit('a\r\nb\nc\nd', { startLine: 4, endLine: 4, replacement: 'x\ny' }),
    { ok: true, text: 'a\r\nb\nc\nx\ny', startLine: 4, endLine: 5 });
});
