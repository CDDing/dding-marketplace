---
description: daily-log initial setup
allowed-tools: Read, Write, Bash(curl:*), Bash(mkdir:*), AskUserQuestion
---

# Daily Log Setup

Follow this flow step by step.
All user questions MUST use the AskUserQuestion tool.

## Step 1: Show Defaults

Show the user the default configuration:

> **기본 설정값:**
> - mode: `local` (로컬에서 Claude CLI로 요약)
> - summary_path: `~/.claude/daily-log/summaries`
> - after_summary: `archive` (요약 후 원본을 archive/로 이동)
> - model: `haiku`

Ask: "이대로 설정할까요? (Yes / No — 커스텀)"

- **Yes** → Step 3 (save with all defaults)
- **No** → Step 2

## Step 2: Custom Settings

### 2-1. mode

Ask: "모드를 선택하세요: `local` (로컬 요약) / `server` (외부 서버 전송)"

- **local** → 2-2로
- **server** → 2-5로

### 2-2. summary_path

Ask: "요약 파일 저장 경로를 입력하세요. (기본값: `~/.claude/daily-log/summaries`)"

### 2-3. after_summary

Ask: "요약 후 원본 로그를 어떻게 처리할까요? `archive` (보관) / `delete` (삭제) (기본값: `archive`)"

### 2-4. model

Ask: "요약에 사용할 Claude 모델을 입력하세요. (기본값: `haiku`)"

→ Step 3으로

### 2-5. server_url

Ask: "로그를 전송할 서버 URL을 입력하세요. (예: `https://my-server.com/api/submit`)"

### 2-6. server_headers

Ask: "커스텀 HTTP 헤더가 필요합니까? (예: 인증 토큰 등)"

- **No** → headers = `{}`
- **Yes** → "~/.claude/daily-log/config.json 의 `server_headers` 필드를 직접 편집하세요." 안내

### 2-7. Server connectivity check

```bash
curl -s -o /dev/null -w "%{http_code}" --max-time 5 "<server_url>"
```

- 응답 있음 → Step 3
- 실패 → 경고 후 "그래도 저장할까요?" 확인

## Step 3: Save

Save to `~/.claude/daily-log/config.json`.

Local mode:
```json
{
  "mode": "local",
  "summary_path": "<value>",
  "after_summary": "<value>",
  "model": "<value>"
}
```

Server mode:
```json
{
  "mode": "server",
  "server_url": "<value>",
  "server_headers": {}
}
```

## Step 4: Post-setup guide

Show:
- "설정이 저장되었습니다: `~/.claude/daily-log/config.json`"
- Local mode인 경우: "요약 프롬프트를 커스텀하려면 이 파일을 편집하세요: `~/.claude/daily-log/summary-prompt.md`"
