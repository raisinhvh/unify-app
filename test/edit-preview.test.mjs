import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundled = await build({ entryPoints: ['src/engine/runtime/editPreview.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { parsePartialJson, isEditTool, editTargets, buildEditPreview, errorText } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const preview = (name, input, files = {}, streaming = false) => buildEditPreview({ name, input, files, streaming, displayPath: path => path.replaceAll('\\', '/') });

test('partial JSON repairs strings, escapes, keys and nested arrays', () => {
  assert.deepEqual(parsePartialJson('{"path":"hello'), { path: 'hello' });
  assert.deepEqual(parsePartialJson('{"path":"hello\\'), { path: 'hello' });
  assert.deepEqual(parsePartialJson('{"path":"hello\\u1'), { path: 'hello' });
  assert.deepEqual(parsePartialJson('{"path":"ok","new_'), { path: 'ok' });
  assert.deepEqual(parsePartialJson('{"path":"ok","edits":[{"old_string":"a"}'), { path: 'ok', edits: [{ old_string: 'a' }] });
  assert.deepEqual(parsePartialJson('{"a":true,"b":tru'), { a: true });
  assert.deepEqual(parsePartialJson('{"a":1,"b":-1'), { a: 1, b: -1 });
});

test('Edit in a large file diffs only the changed lines, and a missing old_string changes nothing', () => {
  const content = Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`).join('\n');
  const result = preview('Edit', { path: 'x', old_string: 'line 4000', new_string: 'changed' }, { x: content });
  assert.equal(result.deletions, 1);
  assert.equal(result.additions, 1);
  assert.equal(result.lines.length, 8);
  assert.deepEqual(result.lines.find(line => line.kind === 'removed'), { kind: 'removed', text: 'line 4000', oldLine: 4000 });
  assert.deepEqual(result.lines.at(-1), { kind: 'context', text: 'line 4003', oldLine: 4003, newLine: 4003 });
  const missing = preview('Edit', { path: 'x', old_string: 'not here', new_string: 'y' }, { x: content });
  assert.equal(missing.lines.length, 0);
});

test('tool names, patch targets and error extraction', () => {
  for (const name of ['Edit', 'MultiEdit', 'Write', 'str_replace', 'str_replace_based_edit_tool', 'write_file', 'edit_file', 'edit_range', 'apply_patch', 'NotebookEdit', 'mcp__server__StrReplace']) assert.equal(isEditTool(name), true);
  assert.deepEqual(editTargets('apply_patch', { command: ['apply_patch', '*** Add File: a\n*** Delete File: b\n*** Update File: a'] }), ['a', 'b']);
  assert.equal(errorText([{ type: 'text', text: ' <tool_use_error>oops</tool_use_error> ' }]), 'oops');
});

test('Edit has whole-file numbers and surrounding context', () => {
  const result = preview('Edit', { path: 'x', old_string: 'four', new_string: 'FOUR' }, { x: 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight' });
  assert.equal(result.deletions, 1);
  assert.equal(result.additions, 1);
  assert.deepEqual(result.lines.find(line => line.kind === 'removed'), { kind: 'removed', text: 'four', oldLine: 4 });
  assert.deepEqual(result.lines.find(line => line.kind === 'added'), { kind: 'added', text: 'FOUR', newLine: 4 });
  assert.equal(result.lines[0].text, 'one');
  assert.equal(result.lines.at(-1).text, 'seven');
});

test('streaming Edit handles missing and partial replacement', () => {
  assert.equal(preview('Edit', { path: 'x', old_string: 'old' }, { x: 'old' }, true).deletions, 1);
  assert.equal(preview('Edit', { path: 'x', old_string: 'old', new_string: 'ne' }, { x: 'old' }, true).lines.find(line => line.kind === 'added').text, 'ne');
});

test('MultiEdit, Write and edit_range calculate changes', () => {
  const multi = preview('MultiEdit', { path: 'x', edits: [{ old_string: 'a', new_string: 'A' }, { old_string: 'c', new_string: 'C' }] }, { x: 'a\nb\nc' });
  assert.equal(multi.additions, 2);
  assert.equal(multi.deletions, 2);
  assert.deepEqual(preview('Write', { path: 'new', content: 'a\nb\n' }).lines.map(line => line.newLine), [1, 2]);
  assert.equal(preview('write_file', { path: 'x', content: 'a\nB' }, { x: 'a\nb' }).additions, 1);
  assert.equal(preview('edit_range', { path: 'x', startLine: 2, endLine: 2, replacement: 'B' }, { x: 'a\nb\nc' }).lines.find(line => line.kind === 'added').newLine, 2);
});

test('patch counts distinct files, CRLF and truncation', () => {
  const patch = '*** Begin Patch\n*** Update File: a\n@@ one\n one\n-two\n+TWO\n*** Add File: b\n+new\n*** End Patch';
  const result = preview('apply_patch', { patch }, { a: 'one\r\ntwo\r\n' });
  assert.equal(result.files, 2);
  assert.equal(result.additions, 2);
  assert.equal(result.deletions, 1);
  assert.equal(result.lines[0].text, 'one');
  assert.equal(preview('Write', { path: 'x', content: 'a\r\nB\r\n' }, { x: 'a\r\nb\r\n' }).lines.find(line => line.kind === 'added').text, 'B');
  const huge = preview('Write', { path: 'x', content: Array.from({ length: 450 }, (_, index) => `${index}`).join('\n') });
  assert.equal(huge.additions, 450);
  assert.equal(huge.lines.length, 400);
  assert.equal(huge.truncated, true);
});
