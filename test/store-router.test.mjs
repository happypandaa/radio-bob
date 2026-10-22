import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { controlIntent } from '../server/router.mjs';

test('播放器控制只匹配完整指令，不吞掉音乐需求或否定句', () => {
  assert.equal(controlIntent('下一首！'), 'next');
  assert.equal(controlIntent(' 暂停一下 '), 'pause');
  assert.equal(controlIntent('不要暂停'), null);
  assert.equal(controlIntent('下一首想听爵士'), null);
});

test('重启后恢复队列、品味和历史，公开状态不包含网易云凭证', () => {
  const root = mkdtempSync(join(tmpdir(), 'radio-bob-store-'));
  let store = createStore(root);
  try {
    store.set('musicCookie', 'test-secret');
    store.set('queue', [{ id: '1', title: 'Track', artist: 'Artist' }]);
    store.setTaste('喜欢器乐');
    store.addMessage('user', '听一首歌');
    store.close();
    store = createStore(root);
    const state = store.state();
    assert.equal(state.queue[0].id, '1');
    assert.equal(state.messages[0].content, '听一首歌');
    assert.equal(state.taste, '喜欢器乐');
    assert.equal(JSON.stringify(state).includes('test-secret'), false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
