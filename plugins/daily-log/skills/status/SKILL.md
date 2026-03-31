---
description: daily-log status check
allowed-tools: Read, Bash(cat:*), Bash(wc:*), Bash(ls:*)
---

# Daily Log Status

Show current status:
- Mode (from ~/.claude/daily-log/config.json → `mode` field)
- Number of pending prompts (~/.claude/daily-log/prompts.jsonl line count)
- Queue files (~/.claude/daily-log/queue/ listing, server mode only)
- Last processed date (~/.claude/daily-log/last_date)
- Summary path (local mode only)
