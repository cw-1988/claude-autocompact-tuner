#!/usr/bin/env node
// Condenses every Claude Code transcript under ~/.claude/projects into one small line per
// session in sessions.jsonl, so the stats outlive Claude Code's transcript cleanup. Only
// transcripts whose size changed since their last summary are read again.
// Usage: node summarize.mjs [--verbose]
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectsDir, dataDir, sessionsFile, tasksFile } from './paths.mjs';

// Optional task rules: [{ "type": "art", "match": "Art[\\\\/]" }, ...]. A session gets the type
// most of its tool calls match (paths and commands); without rules or matches it is "other".
function loadTasks() {
  if (!existsSync(tasksFile)) return [];
  return JSON.parse(readFileSync(tasksFile, 'utf8').replace(/^﻿/, '')).map((t) => [t.type, new RegExp(t.match, 'i')]);
}

function summarize(file, id, project, tasks) {
  const seen = new Set();
  const ctx = [], compactions = [], counts = {};
  const cost = { input: 0, write1h: 0, write5m: 0, read: 0, output: 0 };
  let start = null, end = null, model = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain) continue;
    if (e.timestamp) { start ??= e.timestamp; end = e.timestamp; }
    if (e.type === 'system' && e.subtype === 'compact_boundary' && e.compactMetadata) {
      const m = e.compactMetadata;
      compactions.push({ at: ctx.length, pre: m.preTokens ?? 0, post: m.postTokens ?? 0, trigger: m.trigger ?? '' });
      continue;
    }
    const m = e.message;
    if (e.type !== 'assistant' || !m) continue;
    if (tasks.length) {
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type !== 'tool_use' || !b.input) continue;
        const text = [b.input.file_path, b.input.path, b.input.notebook_path, b.input.command, b.input.url]
          .filter((x) => typeof x === 'string').join(' ');
        const hit = tasks.find(([, re]) => re.test(text));
        if (hit) counts[hit[0]] = (counts[hit[0]] ?? 0) + 1;
      }
    }
    if (!m.usage || !m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    const u = m.usage, cc = u.cache_creation;
    // Synthetic messages (interrupts, errors) carry an all-zero usage and no API call.
    if (!(u.input_tokens || u.cache_creation_input_tokens || u.cache_read_input_tokens)) continue;
    if (m.model) model = m.model;
    cost.input += u.input_tokens || 0;
    cost.read += u.cache_read_input_tokens || 0;
    cost.output += u.output_tokens || 0;
    if (cc) { cost.write1h += cc.ephemeral_1h_input_tokens || 0; cost.write5m += cc.ephemeral_5m_input_tokens || 0; }
    else cost.write5m += u.cache_creation_input_tokens || 0;
    ctx.push((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0));
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return { id, project, model, start, end, task: best ? best[0] : 'other', counts, ctx, compactions, cost };
}

export function run({ verbose = false } = {}) {
  const old = new Map();
  if (existsSync(sessionsFile)) {
    for (const line of readFileSync(sessionsFile, 'utf8').split('\n')) {
      if (!line) continue;
      try { const r = JSON.parse(line); old.set(r.id, r); } catch {}
    }
  }
  const tasks = loadTasks();
  let changed = 0;
  if (existsSync(projectsDir)) {
    for (const project of readdirSync(projectsDir)) {
      const dir = join(projectsDir, project);
      if (!statSync(dir).isDirectory()) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue;
        const file = join(dir, name);
        const size = statSync(file).size;
        const id = name.slice(0, -6);
        if (old.get(id)?.size === size) continue;
        const r = summarize(file, id, project, tasks);
        if (!r.ctx.length) continue;
        old.set(id, { ...r, size });
        changed++;
      }
    }
  }
  if (changed) {
    mkdirSync(dataDir, { recursive: true });
    const rows = [...old.values()].sort((a, b) => String(a.start).localeCompare(String(b.start)));
    writeFileSync(sessionsFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  if (verbose) console.log(`${changed} sessions summarized, ${old.size} total in ${sessionsFile}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) run({ verbose: process.argv.includes('--verbose') });
