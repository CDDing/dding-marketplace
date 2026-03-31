---
description: daily-log initial setup
allowed-tools: Read, Write, Bash(curl:*), Bash(mkdir:*), AskUserQuestion
---

# Daily Log Setup

Follow this flow step by step.

## Step 1: Mode Selection

Ask the user to choose a mode:

- **local** — Summarize logs locally using Claude CLI. No server needed.
- **server** — Send logs to an external server for processing.

## Step 2 (local mode): Local Settings

Ask the following one at a time:

1. **summary_path** — Where to save summary markdown files.
   Default: `~/.claude/daily-log/summaries`
2. **after_summary** — What to do with raw logs after summarization.
   Options: `archive` (move to archive/) or `delete`
   Default: `archive`
3. **model** — Claude model to use for summarization.
   Default: `haiku`

Save to `~/.claude/daily-log/config.json`:

```json
{
  "mode": "local",
  "summary_path": "<user input or default>",
  "after_summary": "<archive or delete>",
  "model": "<model>"
}
```

## Step 2 (server mode): Server Settings

Ask the following one at a time:

1. **server_url** — The URL to send logs to (e.g., `https://my-server.com/api/submit`)
2. **server_headers** — Custom HTTP headers to include with requests (e.g., authentication).
   Ask: "Do you need to send any custom HTTP headers? (e.g., Authorization: Bearer <token>)"
   If yes, collect key-value pairs. If no, use empty `{}`.

Verify connectivity:

```bash
curl -s -o /dev/null -w "%{http_code}" --max-time 5 "<server_url>"
```

If the server responds, save config. If not, warn and ask to retry or save anyway.

Save to `~/.claude/daily-log/config.json`:

```json
{
  "mode": "server",
  "server_url": "<user input>",
  "server_headers": { "<key>": "<value>", ... }
}
```

## Step 3: Confirmation

Show the saved config and confirm setup is complete.
