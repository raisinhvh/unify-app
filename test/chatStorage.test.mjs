import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatStorageInstructions, chatStoragePath, chatStorageRel, removeChatStorage } from '../dist/runtime/chatStorage.mjs';

test('chat storage lives under .unify/chats/<chatId>', () => {
  assert.equal(chatStorageRel('abc-123_X'), '.unify/chats/abc-123_X');
  assert.equal(chatStoragePath(join('home', 'proj'), 'abc'), join('home', 'proj', '.unify', 'chats', 'abc'));
});

test('unsafe chat IDs are rejected', () => {
  for (const id of ['', '../x', 'a/b', 'a\\b', 'a b', 'a.b', '..', 'x\u0000y']) {
    assert.throws(() => chatStorageRel(id), /Unsafe chat ID/, JSON.stringify(id));
    assert.throws(() => chatStoragePath('/proj', id), /Unsafe chat ID/, JSON.stringify(id));
  }
});

test('instructions name the absolute folder and the project rule', () => {
  const text = chatStorageInstructions(join('home', 'proj'), 'abc');
  assert.ok(text.includes(join('home', 'proj', '.unify', 'chats', 'abc')));
  assert.match(text, /deleted when the chat is deleted/);
  assert.match(text, /Never leave throwaway/);
  assert.throws(() => chatStorageInstructions('/proj', 'bad/id'), /Unsafe chat ID/);
});

test('removing chat storage deletes only that chat\'s folder and tolerates a missing one', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-chat-storage-'));
  try {
    const mine = chatStoragePath(base, 'chat1');
    const other = chatStoragePath(base, 'chat2');
    await mkdir(join(mine, 'nested'), { recursive: true });
    await mkdir(other, { recursive: true });
    await writeFile(join(mine, 'nested', 'render.png'), 'x');
    await writeFile(join(other, 'keep.txt'), 'y');
    await removeChatStorage(base, 'chat1');
    assert.equal(existsSync(mine), false);
    assert.equal(existsSync(join(other, 'keep.txt')), true);
    await assert.doesNotReject(removeChatStorage(base, 'chat1'));
    await assert.rejects(removeChatStorage(base, '../x'), /Unsafe chat ID/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
