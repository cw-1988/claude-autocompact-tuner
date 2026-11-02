# claude-autocompact-tuner

Finds the cheapest auto-compact window for **your** Claude Code sessions and keeps it set.

A long Claude Code session re-reads its whole context from the prompt cache on every call. That's cheap per token
(0.1× input price), but it happens on every call, and in long sessions it ends up being most of the bill. A smaller
auto-compact window keeps the context shorter, but every compaction costs a summary call, a fresh cache write, and the
files Claude reads again afterwards. Where the balance lies depends on how you work. This tool measures it from your
own transcripts.

Zero dependencies, Node 22 or later, reads only local files.

## What it does

1. **`summarize.mjs`** condenses every transcript under `~/.claude/projects/` into one line per session (about 1 KB)
   in `~/.claude/autocompact-tuner/sessions.jsonl`. The line holds the context size of every API call, the compactions
   (size before and after), the billed tokens, and the task type. Claude Code deletes transcripts after 30 days
   (`cleanupPeriodDays`), but this history stays.
2. **`window.mjs`** replays each session at windows from 100k to 400k and prices it:
   - every call reads its context from cache (0.1×)
   - every compaction reads the context once for the summary call, writes the summary as output (5×), writes the new
     context to cache (2×), and adds the extra context Claude re-reads afterwards (2× write, then read on every call)
   - summary size, the context right after a compaction, and the re-read amount are all measured from your sessions

   It prints the best window and what it would save, overall and by task type.
3. **`--auto`** (as a SessionStart hook) summarizes new transcripts on each session start. Once a week it checks the
   last 30 days. If another window would save at least 1% of the bill, it writes that window to
   `~/.claude/settings.json` and tells the session.

Output tokens and the cache writes of new content are the same at every window, so they cancel out. They are still
in the bill the savings are a share of.

## Example output

```
332 sessions; 284 compactions
per compaction: summary ~18k, context after ~87k, re-read afterwards ~5k
current window 250k from settings.json (modelSettings)

task        sessions  calls/session  growth/call   best  saves   140k   160k   200k
code             135             42          3k   180k   3.2%   0.3%   2.5%   2.1%
art               56            233          2k   160k   9.0%   8.0%   9.0%   6.4%
story             24             32          1k   150k   0.1%  -0.2%  -0.7%   0.0%
ALL              332             82          2k   170k   6.1%   4.6%   5.9%   4.2%
```

Long sessions gain the most; short ones barely compact at all.

## Install

```bash
git clone https://github.com/cw-1988/claude-autocompact-tuner ~/claude-autocompact-tuner
node ~/claude-autocompact-tuner/src/summarize.mjs --verbose
node ~/claude-autocompact-tuner/src/window.mjs
```

To keep it running, add the hook to `~/.claude/settings.json`, using your own path:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "node \"/home/you/claude-autocompact-tuner/src/window.mjs\" --auto", "timeout": 120 }
        ]
      }
    ]
  }
}
```

The first run reads every transcript, which takes a few seconds. After that it reads only changed ones.

## Options

```
node src/window.mjs --since 2026-10-01      only sessions from that date on
node src/window.mjs --project my-app        only projects whose folder name contains this
```

**Task types**: by default every session is `other`. To split the table, put rules in
`~/.claude/autocompact-tuner/tasks.json`. A session gets the type most of its tool calls match (file paths, commands,
URLs). Delete `sessions.jsonl` after changing the rules so every session is typed again. See
[examples/tasks.json](examples/tasks.json).

**Paths**: `CLAUDE_CONFIG_DIR` is respected. `AUTOCOMPACT_TUNER_DIR` moves the data folder.

**Limits** for `--auto` are constants at the top of `src/window.mjs`: check every 7 days, judge on 30 days of data,
need 40 sessions and 10 compactions, and change only for at least a 1% gain. It never touches the window when
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` is set, because that variable overrides the settings file.

## What it doesn't model

- **Lost context**: each compaction drops detail, and a wrong turn afterwards costs more than the compaction did. The
  1% threshold keeps it from shrinking the window for small gains, but it doesn't price quality.
- **Cold caches**: compacting after the cache expired costs more. That hits every window about the same.
- **Subagents** have their own context and are left out.
- **Per-task windows**: Claude Code reads the window only at session start, so it can't follow the task inside a
  session. In our data every task type's best window was within 30k of the overall one.

## License

MIT
