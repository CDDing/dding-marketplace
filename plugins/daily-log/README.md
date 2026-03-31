# daily-log

Automatically log your Claude Code prompts and responses, then generate daily summaries organized by workspace.

Every prompt you submit is silently recorded in the background. When the date changes, the accumulated log is either summarized locally using the Claude CLI or forwarded to your own server — your choice.

---

## Features

- **Two modes**: Local (no server, no setup beyond config) or Server (send raw logs to your backend)
- **Automatic daily summarization**: triggered on the first prompt after midnight
- **Manual summarization**: force a summary at any time with `/daily-log summarize`
- **Failed send retry queue**: server-mode failures are saved locally and can be retried with `/daily-log resend`
- **Workspace-aware summaries**: logs are split by working directory (`cwd`) so each project gets its own section
- **Configurable**: summary path, Claude model, post-summary behavior (archive or delete), custom HTTP headers

---

## Installation

```bash
/plugin marketplace add CDDing/dding-marketplace
/plugin install daily-log@dding-marketplace
/daily-log setup
```

---

## Setup Guide

Run `/daily-log setup` and follow the prompts. The wizard will ask a few questions and write `~/.claude/daily-log/config.json`.

### Local Mode

Summaries are generated on your machine using the `claude` CLI. No outbound requests.

| Option | What it does | Default |
|--------|-------------|---------|
| `summary_path` | Directory where summary markdown files are saved | `~/.claude/daily-log/summaries` |
| `after_summary` | What happens to raw logs after summarization: `archive` moves them to `archive/`, `delete` removes them | `archive` |
| `model` | Claude model used for summarization (e.g. `haiku`, `sonnet`) | `haiku` |

### Server Mode

Raw logs are POSTed to your server. Summarization logic lives entirely on your side.

| Option | What it does |
|--------|-------------|
| `server_url` | Full URL to POST logs to (e.g. `https://my-server.com/api/daily-log`) |
| `server_headers` | Key-value pairs sent as HTTP headers on every request (e.g. `Authorization: Bearer <token>`) |

---

## Commands

| Command | Description |
|---------|-------------|
| `/daily-log setup` | Initial configuration wizard |
| `/daily-log status` | Show current mode, pending prompt count, queue files, and last processed date |
| `/daily-log show` | View pending (not yet processed) prompts |
| `/daily-log summarize` | Manually trigger summarization of pending prompts (local mode) |
| `/daily-log resend` | Retry failed sends from the queue (server mode) |

---

## How It Works

### Recording

Two hooks run automatically with every Claude Code interaction:

- **`UserPromptSubmit`**: records your prompt text, timestamp, working directory, and session ID
- **`Stop`**: records the first 200 characters of Claude's response

Both write to `~/.claude/daily-log/prompts.jsonl` using a file-lock to prevent race conditions from concurrent sessions.

### Summarization trigger

On every prompt submission, the plugin compares today's date to the last recorded date in `last_date`. If the date has changed, it processes the accumulated log.

### Local mode processing

1. The log is split by `cwd` (working directory basename)
2. For each workspace, a raw text log is built with timestamps
3. `claude -p` is called with a summarization prompt, producing a markdown section
4. Sections are concatenated and saved as `YYYY/MM/DD.md` under `summary_path`
5. The raw `.jsonl` is archived or deleted depending on `after_summary`

### Server mode processing

1. The log file is atomically renamed to prevent new entries from being lost
2. Entries are batched (up to 500 per request) and POSTed as JSON
3. If any batch fails (non-200 response), the entire file is moved to `queue/` with a timestamp filename
4. Use `/daily-log resend` to retry queued files

### Summary format (local mode)

```markdown
# 2026-03-31 Daily Log

### my-project — 09:15~17:42

**Feature implementation** — added authentication middleware and updated route handlers.

<details><summary>Timeline</summary>

`09:15` how do I add JWT middleware to Express?
  -> response: Here's how to add JWT middleware...
`10:30` refactor the token validation logic
...
</details>
```

---

## Configuration Reference

### Local mode (`~/.claude/daily-log/config.json`)

```json
{
  "mode": "local",
  "summary_path": "~/.claude/daily-log/summaries",
  "after_summary": "archive",
  "model": "haiku"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `mode` | string | Must be `"local"` |
| `summary_path` | string | Path for summary files. Supports `~`. Defaults to `~/.claude/daily-log/summaries` if omitted |
| `after_summary` | string | `"archive"` or `"delete"`. What to do with raw logs after summarization |
| `model` | string | Claude model name for summarization. Any model accepted by the `claude` CLI |

### Server mode (`~/.claude/daily-log/config.json`)

```json
{
  "mode": "server",
  "server_url": "https://my-server.com/api/daily-log",
  "server_headers": {
    "Authorization": "Bearer my-token",
    "X-Custom-Header": "value"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `mode` | string | Must be `"server"` |
| `server_url` | string | URL to POST log batches to |
| `server_headers` | object | Headers included in every request. Use this for authentication |

---

## Server API Spec

If you run a compatible server, here is what the plugin sends.

**Request**

```
POST {server_url}
Content-Type: application/json
(+ any headers from server_headers)
```

**Body**

```json
{
  "prompts": [
    {
      "ts": "2026-03-31T10:30:45+09:00",
      "type": "prompt",
      "cwd": "/home/user/my-project",
      "session_id": "sess-abc123",
      "content": "how do I add JWT middleware to Express?"
    },
    {
      "ts": "2026-03-31T10:30:52+09:00",
      "type": "response",
      "cwd": "/home/user/my-project",
      "session_id": "sess-abc123",
      "content": "Here's how to add JWT middleware to Express..."
    }
  ]
}
```

**Fields**

| Field | Type | Description |
|-------|------|-------------|
| `ts` | string | ISO 8601 timestamp with timezone |
| `type` | string | `"prompt"` (user input) or `"response"` (Claude response, truncated to 200 chars) |
| `cwd` | string | Working directory of the Claude Code session at the time of the entry |
| `session_id` | string | Claude Code session identifier |
| `content` | string | The prompt text or response text |

**Expected response**: HTTP `200`. Any other status code is treated as a failure and the batch is queued for retry.

**Batch size**: Up to 500 entries per request. Large logs are split into multiple requests sent sequentially.

---

## File Structure

```
~/.claude/daily-log/
├── config.json           # Plugin configuration
├── prompts.jsonl         # Pending log entries (current day)
├── last_date             # Last processed date (YYYY-MM-DD)
├── archive/              # Raw JSONL backups (if after_summary=archive)
│   └── YYYY-MM-DD.jsonl
├── summaries/            # Generated summaries (local mode)
│   └── YYYY/
│       └── MM/
│           └── DD.md
└── queue/                # Failed sends awaiting retry (server mode)
    └── YYYYMMDD_HHMMSS.jsonl
```

---

## Requirements

- **Claude Code** — the plugin hooks into the Claude Code harness
- **Python 3** — used for JSON parsing in hook scripts
- **Bash** — hook scripts are shell scripts
- **curl** — required for server mode HTTP requests
- **`claude` CLI** — required for local mode summarization (the same CLI you use to run Claude Code)

---

## Troubleshooting

**`[daily-log] Config not found. Run /daily-log setup first.`**
The plugin started logging but has no configuration yet. Run `/daily-log setup` to create `config.json`.

**`[daily-log] Server send failed. Data saved to queue/.`**
The POST request to your server returned a non-200 status or timed out. Check that `server_url` is reachable and responding. Use `/daily-log resend` once the server is healthy.

**`[daily-log] server_url is not configured.`**
You are in server mode but `server_url` is missing from `config.json`. Run `/daily-log setup` again or edit `config.json` directly.

**`[daily-log] Could not acquire lock for summarization.`**
Another process held the file lock for more than 5 seconds. This usually self-resolves — try `/daily-log summarize` again after a moment.

**Summarization silently produces no output**
Check that the `claude` command is on your `PATH` and can run non-interactively (`claude -p "hello"`). Also verify that `prompts.jsonl` is non-empty (`/daily-log status`).

**Summaries appear under the wrong date**
The date is read from the first entry's `ts` field in `prompts.jsonl`, not from the current system time. If your timezone offset is misconfigured, the date in the summary may differ from the filename date.

---

## License

MIT
