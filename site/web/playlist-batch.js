(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TuneBridgeBatch = factory();
  }
}(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const MAX_ITEMS = 10;
  const PENDING = 'PENDING';
  const RUNNING = 'RUNNING';
  const SKIPPED = 'SKIPPED';
  const TERMINAL = ['COMPLETED', 'FAILED', 'INTERRUPTED', SKIPPED];
  const ALLOWED = [PENDING, RUNNING, 'AWAITING_CONFIRMATION'].concat(TERMINAL);
  /** Rows that never produced a written playlist can be queued again, or dropped entirely. */
  const RETRYABLE = [SKIPPED, 'FAILED', 'INTERRUPTED'];
  const REMOVABLE = [PENDING].concat(RETRYABLE);
  const columns = ['序号', '来源歌单', '来源链接', '来源曲目数', '状态', '写入曲目',
    '目标歌单', '目标歌单链接', '说明', '更新时间'];

  function createBatch(source, target) {
    return { source: name(source), target: name(target), items: [] };
  }

  function name(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  /** Splits pasted source links, keeping order and reporting why each line was dropped. */
  function parseLinks(text, limit = MAX_ITEMS) {
    const links = [];
    const rejected = [];
    const seen = new Set();
    String(text == null ? '' : text).split(/[\r\n]+/).forEach((line) => {
      const value = line.trim();
      if (!value) return;
      if (value.length > 2000) {
        rejected.push({ value: value.slice(0, 60), reason: '链接过长' });
      } else if (!/^(https?:\/\/|demo:\/\/|backup:\/\/)/i.test(value)) {
        rejected.push({ value, reason: '不是歌单链接' });
      } else if (seen.has(value)) {
        rejected.push({ value, reason: '已在队列中' });
      } else if (links.length >= Math.max(0, Number(limit) || 0)) {
        rejected.push({ value, reason: '超出单次上限' });
      } else {
        seen.add(value);
        links.push(value);
      }
    });
    return { links, rejected };
  }

  function normalize(entry) {
    if (typeof entry === 'string') return { url: name(entry), label: '', trackCount: 0 };
    if (!entry || typeof entry !== 'object' || !name(entry.url)) {
      throw new Error('批量项必须有来源歌单链接');
    }
    const count = Number(entry.trackCount);
    return {
      url: name(entry.url),
      label: name(entry.label || entry.name),
      trackCount: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
    };
  }

  /** Appends entries that are not already queued, capped so one batch stays reviewable. */
  function enqueue(batch, entries) {
    const list = Array.isArray(entries) ? entries : [entries];
    const items = (batch && Array.isArray(batch.items) ? batch.items : []).slice();
    const queued = new Set(items.map((item) => item.url));
    let added = 0;
    let overflow = 0;
    list.forEach((raw) => {
      const entry = normalize(raw);
      if (queued.has(entry.url)) return;
      if (items.length >= MAX_ITEMS) {
        overflow += 1;
        return;
      }
      queued.add(entry.url);
      items.push({
        url: entry.url, label: entry.label, trackCount: entry.trackCount, status: PENDING,
        writtenCount: 0, targetName: '', targetUrl: '', note: '', updatedAt: null
      });
      added += 1;
    });
    return { batch: { ...batch, items }, added, overflow };
  }

  function findIndex(batch, url) {
    const items = batch && Array.isArray(batch.items) ? batch.items : [];
    return items.findIndex((item) => item.url === name(url));
  }

  /** Records a server status or a local skip for one queued playlist. */
  function markItem(batch, url, status, patch = {}) {
    const value = name(status).toUpperCase();
    if (!ALLOWED.includes(value)) throw new Error('未知的批量迁移状态：' + status);
    const items = (batch && Array.isArray(batch.items) ? batch.items : []).slice();
    const index = findIndex({ items }, url);
    if (index < 0) throw new Error('队列中没有这份歌单');
    if (TERMINAL.includes(items[index].status) && items[index].status !== value) {
      throw new Error('该歌单已有最终结果，不再改写');
    }
    items[index] = {
      ...items[index],
      status: value,
      writtenCount: pick(patch.writtenCount, items[index].writtenCount),
      targetName: pick(patch.targetName, items[index].targetName),
      targetUrl: pick(patch.targetUrl, items[index].targetUrl),
      note: pick(patch.note, items[index].note),
      updatedAt: TERMINAL.includes(value) ? (patch.updatedAt || new Date().toISOString()) : items[index].updatedAt
    };
    return { ...batch, items };
  }

  function pick(value, fallback) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
    return String(value);
  }

  /** Written and waiting rows stay; anything without a result can be dropped and re-added. */
  function removeItem(batch, url) {
    const index = findIndex(batch, url);
    if (index < 0) return { batch, removed: false };
    if (!REMOVABLE.includes(batch.items[index].status)) return { batch, removed: false };
    const items = batch.items.slice();
    items.splice(index, 1);
    return { batch: { ...batch, items }, removed: true };
  }

  /** Lets a failed or interrupted playlist queue again without losing the rest of the batch. */
  function retryItem(batch, url) {
    const index = findIndex(batch, url);
    if (index < 0) throw new Error('队列中没有这份歌单');
    if (!RETRYABLE.includes(batch.items[index].status)) return { batch, retried: false };
    const items = batch.items.slice();
    items[index] = { ...items[index], status: PENDING, note: '', updatedAt: null };
    return { batch: { ...batch, items }, retried: true };
  }

  function nextPending(batch) {
    const items = batch && Array.isArray(batch.items) ? batch.items : [];
    return items.find((item) => item.status === PENDING) || null;
  }

  function running(batch) {
    const items = batch && Array.isArray(batch.items) ? batch.items : [];
    return items.find((item) => item.status === RUNNING || item.status === 'AWAITING_CONFIRMATION') || null;
  }

  function summary(batch) {
    const items = batch && Array.isArray(batch.items) ? batch.items : [];
    const counts = { total: items.length, PENDING: 0, RUNNING: 0, AWAITING_CONFIRMATION: 0,
      COMPLETED: 0, FAILED: 0, INTERRUPTED: 0, SKIPPED: 0, writing: 0 };
    let writtenTracks = 0;
    items.forEach((item) => {
      counts[item.status] = (counts[item.status] || 0) + 1;
      writtenTracks += Number(item.writtenCount) || 0;
    });
    return {
      ...counts,
      writtenTracks,
      finished: items.length > 0 && items.every((item) => TERMINAL.includes(item.status)),
      active: items.some((item) => TERMINAL.indexOf(item.status) < 0)
    };
  }

  function statusLabel(status) {
    return {
      PENDING: '排队中', RUNNING: '匹配中', AWAITING_CONFIRMATION: '等待确认',
      COMPLETED: '已完成', FAILED: '失败', INTERRUPTED: '已中断', SKIPPED: '已跳过'
    }[status] || status || '未知';
  }

  function summaryCsv(batch, formatDate) {
    const items = batch && Array.isArray(batch.items) ? batch.items : [];
    const time = typeof formatDate === 'function' ? formatDate : (value) => value;
    return [row(columns), ...items.map((item, index) => row([
      index + 1,
      item.label || item.url,
      item.url,
      item.trackCount || '',
      statusLabel(item.status),
      TERMINAL.includes(item.status) ? (Number(item.writtenCount) || 0) : '',
      item.targetName,
      item.targetUrl,
      item.note,
      item.updatedAt ? time(item.updatedAt) : ''
    ]))].join('\r\n');
  }

  function row(values) {
    return values.map(cell).join(',');
  }

  // A leading = + - @ or tab/CR turns the cell into a spreadsheet formula.
  function cell(value) {
    let out = value == null ? '' : String(value);
    if (/^[\t\r\n ]*[=+\-@\t\r\n]/.test(out)) out = "'" + out;
    return /[",\r\n]/.test(out) ? '"' + out.replace(/"/g, '""') + '"' : out;
  }

  return {
    MAX_ITEMS, PENDING, RUNNING, SKIPPED, TERMINAL, REMOVABLE, RETRYABLE,
    createBatch, parseLinks, enqueue, markItem, removeItem, retryItem,
    nextPending, running, summary, statusLabel, summaryCsv
  };
}));
