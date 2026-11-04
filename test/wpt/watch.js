#!/usr/bin/env bun
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log('Usage: bun test/wpt/watch.js [result-directory] [--once] [--interval=2]\n'
    + 'Default: ../wpt-run/native-all. Refresh interval is in seconds. Ctrl-C exits.');
  process.exit(0);
}
const directory = resolve(args.find(arg => !arg.startsWith('--'))
  ?? fileURLToPath(new URL('../../../wpt-run/native-all/', import.meta.url)));
const interval = Number(args.find(arg => arg.startsWith('--interval='))?.split('=')[1] ?? 2);
if (!Number.isFinite(interval) || interval < 0.1) throw Error('--interval must be at least 0.1 seconds');
const path = resolve(directory, 'progress.json');
const once = args.includes('--once');
const percent = (n, d, digits = 2) => d > 0 ? (100 * n / d).toFixed(digits) + '%' : '—';
const number = value => Number(value ?? 0).toLocaleString('en-US');
let last = null;
let previousOutput = '';

for (;;) {
  let warning = '';
  try {
    // The runner can be rewriting this small file; retain the previous
    // complete snapshot if we happen to read it between writes.
    last = await Bun.file(path).json();
  } catch (error) {
    warning = `暫時讀不到完整進度，${last ? '保留上次數據' : '等待測試寫入'}（${error.code ?? error.name}）`;
  }
  let output = `WPT 即時通過率 · 每 ${interval} 秒更新 · Ctrl-C 離開\n${path}\n\n`;
  if (last) {
    const p = last, c = p.classification ?? {};
    const age = Math.max(0, Math.floor((Date.now() - Date.parse(p.updated)) / 1000));
    output += [
      `進度：${number(p.completed)} / ${number(p.total)}（${percent(p.completed, p.total)}）`,
      `已測部分通過率：${number(p.passed)} / ${number(p.eligible)} = ${percent(p.passed, p.eligible)}`,
      `整份 WPT 已驗證通過率：${number(p.passed)} / ${number(p.wholeManifestCases)} = ${percent(p.passed, p.wholeManifestCases, 5)}`,
      '',
      `整例通過 ${number(c.pass)} · 斷言失敗 ${number(c.fail)}`,
      `Harness 錯誤 ${number(c['harness-error'])} · 未完成 ${number(c.incomplete)} · 基礎設施限制 ${number(c['unsupported-infrastructure'])}`,
      `已回報子測試：${number(p.passedSubtests)} / ${number(p.reportedSubtests)} = ${percent(p.passedSubtests, p.reportedSubtests)}`,
      '',
      `最後更新：${p.updated}（${Number.isFinite(age) ? age : '?'} 秒前）`,
      `預估剩餘：${Number.isFinite(p.estimatedRemainingHours) ? p.estimatedRemainingHours.toFixed(1) + ' 小時' : '尚無足夠數據'}`,
      '',
      '已測分母排除基礎設施限制，但保留未完成與 Harness 錯誤。',
      '整份比例是已驗證下限；尚未測試不代表失敗。子測試比例僅涵蓋已回報結果。',
      '目前按目錄順序執行，中途比例不代表整體相容率。',
    ].join('\n');
  }
  if (warning) output += '\n' + warning;
  if (process.stdout.isTTY && !once) process.stdout.write('\x1b[H\x1b[2J' + output + '\n');
  else if (output !== previousOutput) console.log(output);
  previousOutput = output;
  if (once) break;
  await Bun.sleep(interval * 1000);
}
