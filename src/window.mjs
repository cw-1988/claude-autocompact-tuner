#!/usr/bin/env node
// Finds the cheapest autocompact window by replaying each session's context growth at windows
// from 100k to 400k. Prices in input-token units: cache read 0.1x, cache write at the measured
// 1h/5m mix (2x / 1.25x), output 5x. Claude Code compacts a margin below the window; the replay
// does the same. Each compaction costs its summary call (the context read from cache, the summary
// as output), the cache write of the first call after it (summary plus re-attached files), and
// the extra context Claude re-reads afterwards.
// node window.mjs [--since YYYY-MM-DD] [--project <part of folder name>]   table by task type
// node window.mjs --auto   hook mode: summarize, then at most weekly set the window if it pays
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { run as summarize } from './summarize.mjs';
import { dataDir, sessionsFile, settingsFile, stateFile } from './paths.mjs';

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : '');
const auto = process.argv.includes('--auto');
const CHECK_EVERY_DAYS = 7;   // how often --auto looks again
const DATA_DAYS = 30;         // --auto judges on the last month, so it follows how the work changes
const MIN_SESSIONS = 40;      // fewer than this and --auto leaves the setting alone
const MIN_COMPACTIONS = 10;   // the compaction costs are measured, so they need some examples
const MIN_GAIN = 0.01;        // a new window must save at least 1% of the bill to replace the current one
const REREAD_CALLS = 10;      // calls after a compaction compared with normal growth to measure re-reads
const DEFAULT_MARGIN = 32_000; // until a window history measures it: a 250k window compacted at ~218k

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const billOf = (r) => r.cost.input + 2 * r.cost.write1h + 1.25 * r.cost.write5m + 0.1 * r.cost.read + 5 * r.cost.output;

// state.json: when --auto last looked, and which window was in force since when, so the margin
// below the window can be measured from the compactions of each period.
const state = (() => { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return {}; } })();
state.windows ??= [];
const saveState = () => { mkdirSync(dataDir, { recursive: true }); writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n'); };
const noteWindow = (w) => {
  if (state.windows.at(-1)?.w !== w) { state.windows.push({ w, since: new Date().toISOString() }); saveState(); }
};

if (auto) {
  try {
    summarize();
    if (state.lastCheck && Date.now() - Date.parse(state.lastCheck) < CHECK_EVERY_DAYS * 864e5) process.exit(0);
    state.lastCheck = new Date().toISOString();
    saveState();
  } catch { process.exit(0); } // a failing stats run must never block a session
}

if (!existsSync(sessionsFile)) { console.log(`No ${sessionsFile} yet; run summarize.mjs first.`); process.exit(0); }
const since = auto ? new Date(Date.now() - DATA_DAYS * 864e5).toISOString() : arg('--since');
const project = arg('--project').toLowerCase();
const all = readFileSync(sessionsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.ctx.length > 1);
const rows = all.filter((r) => String(r.start) >= since && r.project.toLowerCase().includes(project));

function readSettings() {
  try { return JSON.parse(readFileSync(settingsFile, 'utf8')); } catch { return null; }
}

// The window set now: the env var wins, then a per-model setting, then the top-level key.
function setWindow() {
  const env = Number(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  if (env) return { w: env, source: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW' };
  const s = readSettings() ?? {};
  const ms = Object.values(s.modelSettings ?? {}).find((m) => typeof m.autoCompactWindow === 'number');
  if (ms) return { w: ms.autoCompactWindow, source: 'settings.json (modelSettings)' };
  if (typeof s.autoCompactWindow === 'number') return { w: s.autoCompactWindow, source: 'settings.json' };
  return null;
}
const set = setWindow();
if (set) noteWindow(set.w);

// Measured from the sessions: summary size, context and cache write right after a compaction,
// how much faster context grows in the calls after one (files read again), and how far below
// the window it fires.
const compactions = rows.flatMap((r) => r.compactions.filter((c) => c.at < r.ctx.length).map((c) => ({ ...c, r })));
const POST = avg(compactions.map((c) => c.post));
const AFTER = avg(compactions.map((c) => c.r.ctx[c.at]));
const written = compactions.filter((c) => typeof c.write === 'number');
const FIRST_WRITE = written.length ? avg(written.map((c) => c.write)) : POST;
const window10 = (r, i) => r.ctx[i + REREAD_CALLS] - r.ctx[i];
const afterGrowth = avg(compactions.filter((c) => c.at + REREAD_CALLS < c.r.ctx.length).map((c) => window10(c.r, c.at)));
const normalGrowth = avg(rows.flatMap((r) => {
  const cut = r.compactions.map((c) => c.at);
  const out = [];
  for (let i = 1; i + REREAD_CALLS < r.ctx.length; i += REREAD_CALLS) {
    if (!cut.some((a) => a >= i && a <= i + REREAD_CALLS)) out.push(window10(r, i));
  }
  return out;
}));
const REREAD = Math.max(0, afterGrowth - normalGrowth);
const writes = rows.reduce((a, r) => ({ h: a.h + r.cost.write1h, m: a.m + r.cost.write5m }), { h: 0, m: 0 });
const WRITE = writes.h + writes.m ? (2 * writes.h + 1.25 * writes.m) / (writes.h + writes.m) : 2;

// The margin: the window in force when a session started minus where its auto compactions fired.
// All sessions count here, not only the filtered ones, since the margin doesn't depend on the task.
const windowAt = (t) => state.windows.findLast((x) => x.since <= String(t))?.w;
const gaps = all.flatMap((r) => {
  const w = windowAt(r.start);
  return w ? r.compactions.filter((c) => c.trigger === 'auto' && c.pre).map((c) => w - c.pre) : [];
});
const MARGIN = gaps.length >= MIN_COMPACTIONS ? median(gaps) : DEFAULT_MARGIN;

// With no window set ("auto"), the real compactions show where it fires; the margin turns that
// back into a window.
function currentWindow() {
  if (set) return set;
  const pre = compactions.filter((c) => c.trigger === 'auto').map((c) => c.pre);
  const w = pre.length ? Math.round((median(pre) + MARGIN) / 10_000) * 10_000 : 200_000;
  return { w, source: 'auto (median of past compactions plus margin)' };
}

// Context growth per call with the jumps at real compactions removed, and the measured re-read
// taken out of the calls after them, so the replay adds re-reads only where it compacts.
for (const r of rows) {
  const cut = new Set(r.compactions.map((c) => c.at));
  r.steps = [];
  for (let i = 1; i < r.ctx.length; i++) {
    if (cut.has(i)) continue;
    const reread = r.compactions.some((c) => i > c.at && i <= c.at + REREAD_CALLS) ? REREAD / REREAD_CALLS : 0;
    r.steps.push(Math.max(0, r.ctx[i] - r.ctx[i - 1] - reread));
  }
}

function replay(sessions, W) {
  const trigger = W - MARGIN;
  let units = 0;
  for (const r of sessions) {
    let ctx = r.ctx[0], left = 0;
    units += 0.1 * ctx;
    for (const g of r.steps) {
      ctx += g;
      if (ctx > trigger) {
        // The summary call reads the context; the summary is output; the next call writes the
        // new context and later the re-read files. That call's context is the measured AFTER.
        units += 0.1 * ctx + 5 * POST + WRITE * (FIRST_WRITE + REREAD);
        ctx = AFTER;
        left = REREAD_CALLS;
      } else if (left) {
        ctx += REREAD / REREAD_CALLS;
        left--;
      }
      units += 0.1 * ctx;
    }
  }
  return units;
}

// Writes the window wherever the user settings keep it: each model entry that has one, else the
// top-level key.
function applyWindow(w) {
  const s = readSettings() ?? {};
  const entries = Object.values(s.modelSettings ?? {}).filter((m) => 'autoCompactWindow' in m);
  if (entries.length) for (const m of entries) m.autoCompactWindow = w;
  else s.autoCompactWindow = w;
  writeFileSync(settingsFile, JSON.stringify(s, null, 2) + '\n');
  noteWindow(w);
}

const current = currentWindow();
// Windows whose trigger sits barely above the context after a compaction would compact on every call.
const WINDOWS = [];
for (let w = 100_000; w <= 400_000; w += 10_000) if (w - MARGIN > AFTER + 20_000) WINDOWS.push(w);
const best = (list) => WINDOWS.map((w) => ({ w, units: replay(list, w) })).reduce((a, b) => (b.units < a.units ? b : a));

if (auto) {
  if (rows.length < MIN_SESSIONS || compactions.length < MIN_COMPACTIONS) process.exit(0);
  if (current.source.startsWith('CLAUDE_CODE')) process.exit(0); // the env var would override a settings change
  const bill = rows.reduce((a, r) => a + billOf(r), 0);
  const b = best(rows);
  const gain = (replay(rows, current.w) - b.units) / bill;
  if (b.w === current.w || gain < MIN_GAIN) process.exit(0);
  applyWindow(b.w);
  // SessionStart output reaches the session, so Claude can mention the change.
  console.log(`autocompact-tuner: autocompact window set from ${Math.round(current.w / 1000)}k to ${b.w / 1000}k for new sessions (about ${(100 * gain).toFixed(1)}% cheaper over the last ${DATA_DAYS} days).`);
  process.exit(0);
}

const k = (n) => `${Math.round(n / 1000)}k`;
console.log(`${rows.length} sessions${since ? ` since ${since}` : ''}${project ? ` in projects matching "${project}"` : ''}; ${compactions.length} compactions`);
console.log(`per compaction: summary ~${k(POST)}, written after ~${k(FIRST_WRITE)}, context after ~${k(AFTER)}, re-read afterwards ~${k(REREAD)}`);
console.log(`compacts ~${k(MARGIN)} below the window (${gaps.length >= MIN_COMPACTIONS ? `measured from ${gaps.length} compactions` : 'default, too little window history'})`);
console.log(`current window ${k(current.w)} from ${current.source}\n`);
const groups = Object.entries(Object.groupBy(rows, (r) => r.task)).sort((a, b) => b[1].length - a[1].length);
if (groups.length > 1) groups.push(['ALL', rows]);
console.log('task        sessions  calls/session  growth/call   best  saves   140k   160k   200k   (share of that group\'s bill)');
for (const [task, list] of groups) {
  const bill = list.reduce((a, r) => a + billOf(r), 0);
  const base = replay(list, current.w);
  const b = best(list);
  const pct = (units) => ((100 * (base - units)) / bill).toFixed(1).padStart(5) + '%';
  console.log(`${task.padEnd(11)} ${String(list.length).padStart(8)} ${avg(list.map((r) => r.ctx.length)).toFixed(0).padStart(14)} ${k(avg(list.flatMap((r) => r.steps))).padStart(11)} ${k(b.w).padStart(6)} ${pct(b.units)} ${pct(replay(list, 140_000))} ${pct(replay(list, 160_000))} ${pct(replay(list, 200_000))}`);
}
