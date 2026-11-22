(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TuneBridgeHistoryReport = factory();
  }
}(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const summaryColumns = ['报告ID', '时间', '状态', '来源', '来源歌单', '目标', '目标授权',
    '来源曲目数', '匹配', '确认写入', '未匹配', '已跳过', '匹配率', '目标歌单', '目标歌单链接', '说明'];
  const matchColumns = ['序号', '已勾选', '来源歌名', '来源歌手', '来源专辑', '时长秒',
    '匹配', '置信', '相似度', '目标歌名', '目标歌手', '目标专辑', '说明'];

  function asReport(value, location) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(location + '必须是迁移报告对象');
    }
    if (typeof value.id !== 'string' || !value.id.trim()) {
      throw new Error(location + '缺少报告 ID');
    }
    return value;
  }

  function part(report, key) {
    const value = report[key];
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function text(value) {
    if (value == null) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (typeof value === 'boolean') return value ? '是' : '否';
    return typeof value === 'string' ? value : '';
  }

  function yesNo(value) {
    return value === true ? '是' : value === false ? '否' : '';
  }

  function row(values) {
    return values.map(cell).join(',');
  }

  // A leading = + - @ or tab/CR turns the cell into a spreadsheet formula.
  function cell(value) {
    let out = text(value);
    if (/^[\t\r\n ]*[=+\-@\t\r\n]/.test(out)) out = "'" + out;
    return /[",\r\n]/.test(out) ? '"' + out.replace(/"/g, '""') + '"' : out;
  }

  function csv(columns, rows) {
    return [row(columns), ...rows.map(row)].join('\r\n');
  }

  function summaryRow(report) {
    const source = part(report, 'source');
    const target = part(report, 'target');
    const result = part(report, 'result');
    return [
      report.id, report.createdAt, report.status,
      source.providerLabel || source.provider, source.name,
      target.providerLabel || target.provider, target.mode,
      source.trackCount,
      result.matchedCount, result.addedCount, result.unmatchedCount, result.skippedCount,
      result.matchRate === undefined ? '' : result.matchRate + '%',
      result.playlistName, result.playlistUrl,
      text(report.error) || text(report.recoveryNotice)
    ];
  }

  function summaryCsv(reports, formatDate) {
    if (!Array.isArray(reports)) throw new Error('导出的历史必须是报告数组');
    const time = typeof formatDate === 'function' ? formatDate : text;
    return csv(summaryColumns, reports.map((report, index) => {
      const safe = asReport(report, '第 ' + (index + 1) + ' 份报告');
      const values = summaryRow(safe);
      values[1] = time(safe.createdAt);
      return values;
    }));
  }

  function matchesCsv(report) {
    const safe = asReport(report, '导出的报告');
    if (!Array.isArray(safe.matches)) throw new Error('报告缺少逐首匹配明细');
    return csv(matchColumns, safe.matches.map((match) => {
      const item = match && typeof match === 'object' && !Array.isArray(match) ? match : {};
      return [
        item.index === undefined ? '' : item.index + 1, yesNo(item.selected),
        item.title, item.artist, item.album, item.durationSec,
        yesNo(item.matched), item.lowConfidence ? '低置信' : '正常',
        item.score === undefined ? '' : item.score + '%',
        item.targetTitle, item.targetArtist, item.targetAlbum, item.note
      ];
    }));
  }

  function reportJson(report) {
    const safe = asReport(report, '导出的报告');
    const source = part(safe, 'source');
    const target = part(safe, 'target');
    return JSON.stringify({
      format: 'tunebridge-migration-report',
      id: safe.id,
      status: safe.status,
      createdAt: safe.createdAt,
      error: safe.error || null,
      recoveryNotice: safe.recoveryNotice || null,
      source: {
        provider: source.provider || '', providerLabel: source.providerLabel || '',
        name: source.name || '', owner: source.owner || '',
        trackCount: Number(source.trackCount) || 0
      },
      target: {
        provider: target.provider || '', providerLabel: target.providerLabel || '', mode: target.mode || ''
      },
      result: safe.result && typeof safe.result === 'object' ? safe.result : null,
      createdTarget: safe.createdTarget && typeof safe.createdTarget === 'object' ? safe.createdTarget : null,
      matches: Array.isArray(safe.matches) ? safe.matches : [],
      logs: Array.isArray(safe.logs) ? safe.logs : []
    }, null, 2);
  }

  return { summaryCsv, matchesCsv, reportJson };
}));
