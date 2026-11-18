'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const backup = require('../../main/resources/static/playlist-backup.js');

const track = (title, artist = '', album = '', extra = {}) => ({
  id: '', title, artist, album, durationSec: 0, artworkUrl: '', ...extra
});

test('exports the same API as a browser global and CommonJS module', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../main/resources/static/playlist-backup.js'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.window.TuneBridgeBackup).sort(), Object.keys(backup).sort());
  assert.equal(context.window.TuneBridgeBackup.parseLines('歌')[0].title, '歌');
});

test('parses lines in order, including duplicates and optional artist and album', () => {
  assert.deepEqual(backup.parseLines('\uFEFF歌名 - 歌手\r\n歌名 - 歌手\n独唱\n标题\t歌手\t专辑\n'), [
    track('歌名', '歌手'), track('歌名', '歌手'), track('独唱'), track('标题', '歌手', '专辑')
  ]);
  assert.throws(() => backup.parseLines(' \n'), /没有曲目/);
  assert.throws(() => backup.parseLines('\t歌手'), /歌名/);
  assert.throws(() => backup.parseLines('歌\t手\t专\t多'), /字段过多/);
});

test('parses BOM, Chinese headers, escaped quotes, commas and quoted newlines', () => {
  const csv = '\uFEFF歌名,歌手,专辑,durationSec,id,artworkUrl\r\n"歌,\"\"名\"\"","歌\r\n手",专辑,12,abc,https://example.test/a\r\n重复,手,专,0,,\r\n重复,手,专,0,,\r\n';
  assert.deepEqual(backup.parseCsv(csv), [
    track('歌,"名"', '歌\r\n手', '专辑', { durationSec: 12, id: 'abc', artworkUrl: 'https://example.test/a' }),
    track('重复', '手', '专'), track('重复', '手', '专')
  ]);
});

test('CSV serialization quotes special characters and round trips ordinary data', () => {
  const tracks = [track('逗号,引号"和\n换行', '歌手', '专辑', { id: 'id', durationSec: 123, artworkUrl: 'url' })];
  const csv = backup.serializeCsv(tracks);
  assert.match(csv, /^id,title,artist,album,durationSec,artworkUrl\r\n/);
  assert.match(csv, /"逗号,引号""和\n换行"/);
  assert.deepEqual(backup.parseCsv(csv), tracks);
});

test('CSV export prefixes dangerous formulas in every column without changing JSON', () => {
  const tracks = [track('=SUM(1,2)', '+artist', '-album', { id: '@id', artworkUrl: '\turl' }),
    track('\rtitle', '  =formula', '\nvalue')];
  const csv = backup.serializeCsv(tracks);
  assert.match(csv, /'@id,"'=SUM\(1,2\)",'\+artist,'-album,0,'\turl/);
  assert.match(csv, /"'\rtitle",'  =formula,"'\nvalue"/);
  assert.deepEqual(backup.parseJson(backup.serializeJson({ name: '=name', tracks })), { name: '=name', tracks });
});

test('rejects malformed CSV and nonempty rows with missing titles', () => {
  for (const input of ['', 'artist\nartist', 'title\n', 'title,artist\n,artist',
    'title,artist\n"unterminated,artist', 'title\nfoo"bar', 'title\n"foo"bar',
    'title,artist\nfoo', 'title\nfoo,bar', 'title,歌名\na,b', 'title\n""']) {
    assert.throws(() => backup.parseCsv(input), /CSV/);
  }
  assert.deepEqual(backup.parseCsv('title,artist\n\n歌,手\n  \n'), [track('歌', '手')]);
});

test('JSON validates playlist structure and track titles, and preserves duplicates', () => {
  const playlist = { name: '歌单', tracks: [track('歌', '手'), track('歌', '手')] };
  assert.deepEqual(backup.parseJson(backup.serializeJson(playlist)), playlist);
  assert.deepEqual(backup.parseJson('\uFEFF{"name":"N","tracks":[{"title":"  原文  "}]}'), {
    name: 'N', tracks: [track('  原文  ')]
  });
  for (const input of ['{', '[]', '{}', '{"name":"N","tracks":[]}',
    '{"name":"N","tracks":[{}]}', '{"name":"N","tracks":[null]}',
    '{"name":"N","tracks":[{"title":" "}]}']) {
    assert.throws(() => backup.parseJson(input));
  }
  assert.throws(() => backup.serializeJson({ name: 'N', tracks: [] }), /没有曲目/);
  assert.throws(() => backup.serializeCsv([]), /没有曲目/);
});
