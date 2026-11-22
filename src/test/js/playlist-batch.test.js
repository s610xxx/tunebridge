'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const batch = require('../../main/resources/static/playlist-batch.js');

const qqUrl = 'https://y.qq.com/n/ryqq/playlist/7300098051';
const appleUrl = 'https://music.apple.com/us/playlist/x/pl.5ee8333dbe944d9f9151e97d92b35eaa';

function queued() {
  return batch.enqueue(batch.createBatch('QQ_MUSIC', 'APPLE_MUSIC'), [
    { url: qqUrl, name: '深夜写代码', trackCount: 12 },
    { url: appleUrl, name: '通勤爵士', trackCount: 0 }
  ]).batch;
}

test('exports the same API as a browser global and CommonJS module', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../main/resources/static/playlist-batch.js'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.window.TuneBridgeBatch).sort(), Object.keys(batch).sort());
  assert.equal(context.window.TuneBridgeBatch.MAX_ITEMS, batch.MAX_ITEMS);
  assert.match(context.window.TuneBridgeBatch.summaryCsv(queued()), /^序号,来源歌单/);
});

test('splits pasted links in order and explains every drop', () => {
  const parsed = batch.parseLinks([
    '  ' + qqUrl + ' ',
    appleUrl,
    qqUrl,
    'demo://builtin',
    '这不是链接',
    'x'.repeat(2001),
    ''
  ].join('\n'));

  assert.deepEqual(parsed.links, [qqUrl, appleUrl, 'demo://builtin']);
  assert.deepEqual(parsed.rejected.map((item) => item.reason), ['已在队列中', '不是歌单链接', '链接过长']);
  assert.deepEqual(batch.parseLinks(null).links, []);
});

test('stops pasting once the requested limit is reached', () => {
  const many = Array.from({ length: 14 }, (ignored, index) => 'https://y.qq.com/n/ryqq/playlist/' + index);
  const parsed = batch.parseLinks(many.join('\n'), 10);

  assert.equal(parsed.links.length, 10);
  assert.deepEqual(parsed.rejected, many.slice(10).map((value) => ({ value, reason: '超出单次上限' })));
});

test('queues each playlist once and caps one batch', () => {
  const first = batch.enqueue(batch.createBatch('QQ_MUSIC', 'APPLE_MUSIC'), [
    { url: qqUrl, name: '深夜写代码', trackCount: 12 },
    { url: appleUrl }
  ]);
  assert.equal(first.added, 2);
  assert.equal(first.batch.items[0].label, '深夜写代码');
  assert.equal(first.batch.items[0].trackCount, 12);
  assert.equal(first.batch.items[1].trackCount, 0);
  assert.equal(first.batch.items[0].status, batch.PENDING);

  const again = batch.enqueue(first.batch, [qqUrl, { url: appleUrl, name: '重复' }]);
  assert.equal(again.added, 0);
  assert.equal(again.batch.items.length, 2);

  const extra = Array.from({ length: 12 }, (ignored, index) => 'https://y.qq.com/n/ryqq/playlist/' + index);
  const capped = batch.enqueue(queued(), extra);
  assert.equal(capped.batch.items.length, batch.MAX_ITEMS);
  assert.equal(capped.added, 8);
  assert.equal(capped.overflow, 4);
});

test('rejects queue entries without a source link', () => {
  assert.throws(() => batch.enqueue(batch.createBatch(), [{}]), /批量项必须有来源歌单链接/);
  assert.throws(() => batch.enqueue(batch.createBatch(), [null]), /批量项必须有来源歌单链接/);
});

test('records server statuses and refuses to rewrite a final result', () => {
  let state = queued();
  state = batch.markItem(state, qqUrl, 'RUNNING');
  assert.equal(batch.running(state).url, qqUrl);
  state = batch.markItem(state, qqUrl, 'AWAITING_CONFIRMATION');
  assert.equal(batch.summary(state).AWAITING_CONFIRMATION, 1);

  state = batch.markItem(state, qqUrl, 'COMPLETED', {
    writtenCount: 9, targetName: '深夜写代码 · 音桥',
    targetUrl: 'https://music.apple.com/playlist/pl-9', updatedAt: '2026-11-21T12:00:00Z'
  });
  assert.equal(state.items[0].writtenCount, 9);
  assert.equal(state.items[0].updatedAt, '2026-11-21T12:00:00Z');
  assert.equal(state.items[1].status, batch.PENDING);

  assert.throws(() => batch.markItem(state, qqUrl, 'FAILED'), /已有最终结果/);
  assert.throws(() => batch.markItem(state, qqUrl, 'SUCCESS'), /未知的批量迁移状态/);
  assert.throws(() => batch.markItem(state, 'https://evil.test/x', 'RUNNING'), /队列中没有这份歌单/);
});

test('keeps finished reports in the queue and lets skipped ones go', () => {
  let state = batch.markItem(queued(), qqUrl, 'COMPLETED', { writtenCount: 3 });
  assert.equal(batch.removeItem(state, qqUrl).removed, false);
  assert.equal(batch.removeItem(state, qqUrl).batch.items.length, 2);

  const dropped = batch.removeItem(state, appleUrl);
  assert.equal(dropped.removed, true);
  assert.equal(dropped.batch.items.length, 1);
  assert.equal(batch.removeItem(state, 'https://elsewhere.test/x').removed, false);

  state = batch.markItem(state, appleUrl, 'SKIPPED', { note: '已放弃本次预览' });
  assert.equal(batch.removeItem(state, appleUrl).removed, true);
  assert.equal(batch.summary(batch.removeItem(state, appleUrl).batch).total, 1);
});

test('lets a failed or interrupted playlist queue again without touching the rest', () => {
  let state = batch.markItem(queued(), qqUrl, 'FAILED', { note: '匹配失败，请稍后重新匹配' });
  state = batch.markItem(state, appleUrl, 'COMPLETED', { writtenCount: 4 });

  const retried = batch.retryItem(state, qqUrl);
  assert.equal(retried.retried, true);
  assert.deepEqual(
    { status: retried.batch.items[0].status, note: retried.batch.items[0].note, updatedAt: retried.batch.items[0].updatedAt },
    { status: 'PENDING', note: '', updatedAt: null }
  );
  assert.equal(retried.batch.items[1].status, 'COMPLETED');
  assert.equal(batch.summary(retried.batch).PENDING, 1);

  const written = batch.retryItem(state, appleUrl);
  assert.equal(written.retried, false);
  assert.equal(written.batch.items[1].status, 'COMPLETED');
  assert.throws(() => batch.retryItem(state, 'https://elsewhere.test/x'), /队列中没有这份歌单/);

  // Anything without a written result can also leave the queue so the link can be re-added.
  assert.equal(batch.removeItem(state, qqUrl).removed, true);
  assert.equal(batch.removeItem(state, appleUrl).removed, false);
  const interrupted = batch.markItem(queued(), appleUrl, 'INTERRUPTED', { note: '服务重启，任务已中断' });
  assert.equal(batch.removeItem(interrupted, appleUrl).removed, true);

  const skipped = batch.markItem(queued(), qqUrl, batch.SKIPPED, { note: '已放弃本次预览，未写入' });
  assert.equal(batch.retryItem(skipped, qqUrl).batch.items[0].status, 'PENDING');
  assert.deepEqual(batch.REMOVABLE, [batch.PENDING, batch.SKIPPED, 'FAILED', 'INTERRUPTED']);
  assert.deepEqual(batch.RETRYABLE, [batch.SKIPPED, 'FAILED', 'INTERRUPTED']);
});

test('summarises the batch for the panel and the export', () => {
  let state = queued();
  assert.equal(batch.summary(state).active, true);
  assert.equal(batch.summary(state).finished, false);

  state = batch.markItem(state, qqUrl, 'COMPLETED', { writtenCount: 9 });
  state = batch.markItem(state, appleUrl, 'INTERRUPTED', { note: '服务在写入阶段重启' });
  const totals = batch.summary(state);

  assert.equal(totals.total, 2);
  assert.equal(totals.COMPLETED, 1);
  assert.equal(totals.INTERRUPTED, 1);
  assert.equal(totals.writtenTracks, 9);
  assert.equal(totals.finished, true);
  assert.equal(totals.active, false);
  assert.equal(batch.nextPending(state), null);
  assert.equal(batch.summary(batch.createBatch()).total, 0);
  assert.equal(batch.summary(batch.createBatch()).finished, false);

  state = batch.enqueue(state, ['https://y.qq.com/n/ryqq/playlist/9']).batch;
  state = batch.markItem(state, 'https://y.qq.com/n/ryqq/playlist/9', 'SKIPPED', { note: '用户停止' });
  assert.equal(batch.summary(state).SKIPPED, 1);
  assert.equal(batch.summary(state).finished, true);
});

test('labels statuses for readers and keeps unknown ones visible', () => {
  assert.equal(batch.statusLabel('AWAITING_CONFIRMATION'), '等待确认');
  assert.equal(batch.statusLabel('SKIPPED'), '已跳过');
  assert.equal(batch.statusLabel('WEIRD'), 'WEIRD');
  assert.equal(batch.statusLabel(undefined), '未知');
});

test('exports one CSV row per queued playlist with the spreadsheet guard', () => {
  let state = queued();
  state = batch.markItem(state, qqUrl, 'COMPLETED', {
    writtenCount: 9, targetName: '=HYPERLINK("http://evil.test","点我")',
    targetUrl: 'https://music.apple.com/playlist/pl-9', updatedAt: '2026-11-21T12:00:00Z'
  });
  state = batch.markItem(state, appleUrl, 'FAILED', { note: '目标平台没有候选, 请核对' });

  const lines = batch.summaryCsv(state, () => '本地时间').split('\r\n');
  assert.equal(lines[0].split(',').length, 10);
  assert.equal(lines.length, 3);
  assert.ok(lines[1].startsWith('1,深夜写代码,' + qqUrl + ',12,已完成,9,'));
  assert.ok(lines[1].includes('"\'=HYPERLINK(""http://evil.test"",""点我"")"'));
  assert.ok(lines[1].endsWith('https://music.apple.com/playlist/pl-9,,本地时间'));
  assert.ok(lines[2].startsWith('2,通勤爵士,' + appleUrl + ',,失败,0,,,'));
  assert.ok(lines[2].endsWith(',"目标平台没有候选, 请核对",本地时间'));

  const header = batch.summaryCsv(batch.createBatch());
  assert.equal(header.split('\r\n').length, 1);
  assert.ok(header.startsWith('序号,来源歌单'));
});
