'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const report = require('../../main/resources/static/history-report.js');

const completed = {
  id: 'mig_1', status: 'COMPLETED', createdAt: '2026-11-21T04:00:00Z', readOnly: true,
  source: { provider: 'QQ_MUSIC', providerLabel: 'QQ 音乐', name: '夏夜循环', owner: '阿桥', trackCount: 2 },
  target: { provider: 'APPLE_MUSIC', providerLabel: 'Apple Music', mode: 'DEMO' },
  result: { playlistId: 'pl-1', playlistName: '夏夜循环 · 音桥', playlistUrl: 'https://music.apple.com/playlist/pl-1',
    addedCount: 1, unmatchedCount: 1, totalCount: 2, matchRate: 50, skippedCount: 0, matchedCount: 2 },
  createdTarget: { playlistId: 'pl-1', playlistName: '夏夜循环 · 音桥', playlistUrl: 'https://music.apple.com/playlist/pl-1' },
  error: null, recoveryNotice: null,
  logs: [{ time: '2026-11-21T04:00:01Z', level: 'SUCCESS', message: '✓ 晴天 → 晴天（91%）' }],
  matches: [
    { index: 0, selected: true, title: '晴天', artist: '周杰伦', album: '叶惠美', durationSec: 269,
      matched: true, lowConfidence: false, targetTitle: '晴天', targetArtist: '周杰伦', targetAlbum: '叶惠美',
      targetArtworkUrl: 'https://example.test/a.jpg', score: 91, note: '标题与歌手一致' },
    { index: 1, selected: false, title: '红日', artist: '李克勤', album: ' ', durationSec: 288,
      matched: false, lowConfidence: false, targetTitle: '', targetArtist: '', targetAlbum: '',
      targetArtworkUrl: '', score: 12, note: '目标平台没有候选' }
  ]
};

test('exports the same API as a browser global and CommonJS module', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../main/resources/static/history-report.js'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.window.TuneBridgeHistoryReport).sort(), Object.keys(report).sort());
  assert.match(context.window.TuneBridgeHistoryReport.summaryCsv([completed]), /^报告ID,时间/);
});

test('summarises reports newest-first data in one CSV row each', () => {
  const preview = { ...completed, id: 'mig_2', status: 'AWAITING_CONFIRMATION', result: null, createdTarget: null };
  const lines = report.summaryCsv([completed, preview]).split('\r\n');
  assert.equal(lines[0], '报告ID,时间,状态,来源,来源歌单,目标,目标授权,来源曲目数,匹配,确认写入,未匹配,已跳过,匹配率,目标歌单,目标歌单链接,说明');
  assert.equal(lines[1], 'mig_1,2026-11-21T04:00:00Z,COMPLETED,QQ 音乐,夏夜循环,Apple Music,DEMO,2,2,1,1,0,50%,夏夜循环 · 音桥,https://music.apple.com/playlist/pl-1,');
  assert.equal(lines[2], 'mig_2,2026-11-21T04:00:00Z,AWAITING_CONFIRMATION,QQ 音乐,夏夜循环,Apple Music,DEMO,2,,,,,,,,');
  assert.equal(lines.length, 3);
  lines.slice(1).forEach((line) => assert.equal(line.split(',').length, 16));
});

test('quotes separators and blocks formula cells in exported reports', () => {
  const nasty = {
    ...completed, id: 'mig_3',
    source: { ...completed.source, name: '夏日, "精选"\n合集' },
    result: { ...completed.result, playlistName: '=HYPERLINK("http://evil.test","点我")' },
    error: '-1+1 命令'
  };
  const [header, line] = report.summaryCsv([nasty]).split('\r\n');
  assert.equal(header.split(',').length, 16);
  assert.match(line, /"夏日, ""精选""\n合集"/);
  assert.match(line, /"'=HYPERLINK\(""http:\/\/evil\.test"",""点我""\)"/);
  assert.match(line, /,'-1\+1 命令$/);
});

test('keeps the interruption notice visible when a report has no result', () => {
  const interrupted = {
    ...completed, id: 'mig_4', status: 'INTERRUPTED', result: null,
    error: '服务重启，任务已中断', recoveryNotice: '服务重启，任务已中断'
  };
  const line = report.summaryCsv([interrupted]).split('\r\n')[1];
  assert.match(line, /,服务重启，任务已中断$/);
});

test('exports the per-track report with selection, confidence and scores', () => {
  const lines = report.matchesCsv(completed).split('\r\n');
  assert.equal(lines[0], '序号,已勾选,来源歌名,来源歌手,来源专辑,时长秒,匹配,置信,相似度,目标歌名,目标歌手,目标专辑,说明');
  assert.equal(lines[1], '1,是,晴天,周杰伦,叶惠美,269,是,正常,91%,晴天,周杰伦,叶惠美,标题与歌手一致');
  assert.equal(lines[2], '2,否,红日,李克勤, ,288,否,正常,12%,,,,目标平台没有候选');
});

test('writes a readable JSON report and drops nothing needed to audit it', () => {
  const parsed = JSON.parse(report.reportJson(completed));
  assert.equal(parsed.format, 'tunebridge-migration-report');
  assert.equal(parsed.id, 'mig_1');
  assert.equal(parsed.status, 'COMPLETED');
  assert.deepEqual(parsed.target, { provider: 'APPLE_MUSIC', providerLabel: 'Apple Music', mode: 'DEMO' });
  assert.equal(parsed.result.matchRate, 50);
  assert.equal(parsed.matches.length, 2);
  assert.equal(parsed.logs[0].level, 'SUCCESS');
  assert.equal(parsed.error, null);
  assert.equal(JSON.parse(report.reportJson({ ...completed, result: null, matches: undefined })).result, null);
});

test('lets the caller render the timestamp the way the page shows it', () => {
  const line = report.summaryCsv([completed], (value) => 'LOCAL(' + value + ')').split('\r\n')[1];
  assert.match(line, /^mig_1,LOCAL\(2026-11-21T04:00:00Z\),COMPLETED,/);
  assert.match(report.summaryCsv([completed]).split('\r\n')[1], /^mig_1,2026-11-21T04:00:00Z,/);
});

test('rejects input that is not a report instead of exporting blanks', () => {
  assert.throws(() => report.summaryCsv('not-a-list'), /报告数组/);
  assert.throws(() => report.summaryCsv([null]), /第 1 份报告/);
  assert.throws(() => report.summaryCsv([{ status: 'COMPLETED' }]), /缺少报告 ID/);
  assert.throws(() => report.matchesCsv({ id: 'mig_1' }), /逐首匹配明细/);
  assert.throws(() => report.matchesCsv(null), /迁移报告对象/);
  assert.throws(() => report.reportJson(7), /迁移报告对象/);
});
