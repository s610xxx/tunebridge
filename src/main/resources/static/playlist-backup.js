(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TuneBridgeBackup = factory();
  }
}(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const fields = ['id', 'title', 'artist', 'album', 'durationSec', 'artworkUrl'];
  const aliases = { '歌名': 'title', '歌手': 'artist', '专辑': 'album' };

  function textInput(value, format) {
    if (typeof value !== 'string') throw new Error(format + '内容必须是文本');
    return value.replace(/^\uFEFF/, '');
  }

  function normalizeTrack(track, location) {
    if (!track || typeof track !== 'object' || Array.isArray(track)) {
      throw new Error(location + '必须是曲目对象');
    }
    if (typeof track.title !== 'string' || !track.title.trim()) {
      throw new Error(location + '缺少有效歌名');
    }
    const result = {};
    for (const field of fields) {
      const value = track[field];
      if (field === 'durationSec') {
        if (value == null || value === '') {
          result[field] = 0;
        } else if ((typeof value !== 'number' && typeof value !== 'string') ||
                   (typeof value === 'string' && !value.trim()) ||
                   !Number.isFinite(Number(value)) || Number(value) < 0) {
          throw new Error(location + '的 durationSec 必须是非负数字');
        } else {
          result[field] = Number(value);
        }
      } else {
        if (value != null && typeof value !== 'string') {
          throw new Error(location + '的 ' + field + ' 必须是文本');
        }
        result[field] = value == null ? '' : value;
      }
    }
    return result;
  }

  function normalizeTracks(tracks) {
    if (!Array.isArray(tracks)) throw new Error('tracks 必须是数组');
    if (!tracks.length) throw new Error('歌单没有曲目');
    return tracks.map((track, index) => normalizeTrack(track, '第 ' + (index + 1) + ' 首曲目'));
  }

  function parseLines(text) {
    const lines = textInput(text, '文本').split(/\r\n|\n|\r/);
    const tracks = [];
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      let parts;
      if (line.includes('\t')) {
        parts = line.split('\t');
        if (parts.length > 3) throw new Error('第 ' + (index + 1) + ' 行格式错误：字段过多');
      } else {
        const separator = line.indexOf(' - ');
        parts = separator < 0 ? [line] : [line.slice(0, separator), line.slice(separator + 3)];
      }
      tracks.push(normalizeTrack({ title: parts[0].trim(), artist: (parts[1] || '').trim(), album: (parts[2] || '').trim() }, '第 ' + (index + 1) + ' 行'));
    });
    if (!tracks.length) throw new Error('文本没有曲目');
    return tracks;
  }

  function readCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let state = 'start';
    let line = 1;
    let rowLine = 1;
    let rowHasContent = false;
    const finishField = () => { row.push(field); field = ''; state = 'start'; };
    const finishRow = () => {
      finishField();
      rows.push({ values: row, line: rowLine, blank: !rowHasContent });
      row = [];
      rowHasContent = false;
      rowLine = line;
    };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (state === 'quoted') {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else state = 'closed';
        } else {
          field += ch;
          if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line++;
        }
        continue;
      }
      if (ch === ',') {
        rowHasContent = true;
        finishField();
      } else if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        line++;
        finishRow();
      } else if (ch === '"') {
        if (state !== 'start') throw new Error('CSV 第 ' + line + ' 行存在非法引号');
        state = 'quoted';
        rowHasContent = true;
      } else {
        if (state === 'closed') throw new Error('CSV 第 ' + line + ' 行的引号后存在非法字符');
        state = 'unquoted';
        field += ch;
        if (!/\s/.test(ch)) rowHasContent = true;
      }
    }
    if (state === 'quoted') throw new Error('CSV 第 ' + rowLine + ' 行的引号未闭合');
    if (row.length || field || state !== 'start' || rowHasContent) finishRow();
    return rows;
  }

  function parseCsv(text) {
    const rows = readCsv(textInput(text, 'CSV'));
    if (!rows.length || rows[0].blank) throw new Error('CSV 缺少表头和曲目');
    const headers = rows[0].values.map(value => aliases[value.trim()] || value.trim());
    if (!headers.includes('title')) throw new Error('CSV 表头缺少 title（歌名）');
    const seen = new Set();
    for (const header of headers) {
      if (fields.includes(header)) {
        if (seen.has(header)) throw new Error('CSV 表头重复：' + header);
        seen.add(header);
      }
    }
    const tracks = [];
    for (const row of rows.slice(1)) {
      if (row.blank) continue;
      if (row.values.length !== headers.length) throw new Error('CSV 第 ' + row.line + ' 行字段数量与表头不一致');
      const track = {};
      headers.forEach((header, index) => {
        if (fields.includes(header)) track[header] = row.values[index];
      });
      tracks.push(normalizeTrack(track, 'CSV 第 ' + row.line + ' 行'));
    }
    if (!tracks.length) throw new Error('CSV 没有曲目');
    return tracks;
  }

  function parseJson(text) {
    let data;
    try {
      data = JSON.parse(textInput(text, 'JSON'));
    } catch (error) {
      throw new Error('JSON 格式错误：' + error.message);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('JSON 歌单必须是对象');
    if (typeof data.name !== 'string') throw new Error('JSON 歌单的 name 必须是文本');
    return { name: data.name, tracks: normalizeTracks(data.tracks) };
  }

  function serializeCsv(tracks) {
    const safeCell = value => {
      let text = String(value);
      if (/^[\t\r\n ]*[=+\-@\t\r\n]/.test(text)) text = "'" + text;
      return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    };
    return [fields.join(','), ...normalizeTracks(tracks).map(track => fields.map(field => safeCell(track[field])).join(','))].join('\r\n');
  }

  function serializeJson(playlist) {
    if (!playlist || typeof playlist !== 'object' || Array.isArray(playlist) || typeof playlist.name !== 'string') {
      throw new Error('歌单必须是包含文本 name 和 tracks 数组的对象');
    }
    return JSON.stringify({ name: playlist.name, tracks: normalizeTracks(playlist.tracks) }, null, 2);
  }

  return { parseLines, parseCsv, parseJson, serializeCsv, serializeJson };
}));
