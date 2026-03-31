#!/bin/bash
# on-prompt.sh — UserPromptSubmit hook
# 프롬프트를 기록하고, 날짜 변경 시 모드에 따라 서버 전송 또는 로컬 요약
set -euo pipefail
export PYTHONIOENCODING=utf-8

DAILY_LOG_DIR="${HOME}/.claude/daily-log"
CONFIG_FILE="${DAILY_LOG_DIR}/config.json"
PROMPTS_FILE="${DAILY_LOG_DIR}/prompts.jsonl"
LAST_DATE_FILE="${DAILY_LOG_DIR}/last_date"
QUEUE_DIR="${DAILY_LOG_DIR}/queue"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$DAILY_LOG_DIR" "$QUEUE_DIR"

emit_error() {
    echo "{\"systemMessage\": \"$1\"}"
}

# stdin에서 hook 데이터 읽기
HOOK_INPUT=$(cat)

# 프롬프트 추출
PROMPT=$(HOOK_DATA="$HOOK_INPUT" python -c "
import sys, json, os
try:
    data = json.loads(os.environ['HOOK_DATA'])
    print(data.get('prompt', data.get('content', '')))
except:
    print('')
" 2>/dev/null || echo "")

[ -z "$PROMPT" ] && exit 0

TODAY=$(date '+%Y-%m-%d')
TIMESTAMP=$(date '+%Y-%m-%dT%H:%M:%S%:z')
CWD=$(HOOK_DATA="$HOOK_INPUT" python -c "
import json, os
data = json.loads(os.environ['HOOK_DATA'])
print(data.get('cwd', ''))
" 2>/dev/null || echo "")
[ -z "$CWD" ] && CWD="${PWD:-unknown}"

SESSION_ID=$(HOOK_DATA="$HOOK_INPUT" python -c "
import json, os
data = json.loads(os.environ['HOOK_DATA'])
print(data.get('session_id', ''))
" 2>/dev/null || echo "")

# === 1단계: mkdir lock으로 잠금 후 프롬프트 기록 ===
LOCK_DIR="${DAILY_LOG_DIR}/.lock.d"
LOCK_RETRIES=10
LOCK_ACQUIRED=false
for i in $(seq 1 $LOCK_RETRIES); do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        LOCK_ACQUIRED=true
        trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
        break
    fi
    if [ -d "$LOCK_DIR" ]; then
        LOCK_AGE=$(( $(date +%s) - $(date -r "$LOCK_DIR" +%s 2>/dev/null || echo 0) ))
        [ "$LOCK_AGE" -gt 5 ] && rm -rf "$LOCK_DIR" 2>/dev/null || true
    fi
    sleep 0.5
done

if $LOCK_ACQUIRED; then
    ENTRY_TS="$TIMESTAMP" ENTRY_TYPE="prompt" ENTRY_CWD="$CWD" ENTRY_SID="$SESSION_ID" ENTRY_CONTENT="$PROMPT" python -c "
import json, os
entry = {
    'ts': os.environ['ENTRY_TS'],
    'type': os.environ['ENTRY_TYPE'],
    'cwd': os.environ['ENTRY_CWD'],
    'session_id': os.environ['ENTRY_SID'],
    'content': os.environ['ENTRY_CONTENT']
}
print(json.dumps(entry, ensure_ascii=False))
" >> "$PROMPTS_FILE"
    rmdir "$LOCK_DIR" 2>/dev/null || true
    trap - EXIT
fi

# === 2단계: 날짜 변경 감지 ===
LAST_DATE=""
if [ -f "$LAST_DATE_FILE" ]; then
    LAST_DATE=$(cat "$LAST_DATE_FILE")
fi

if [ "$LAST_DATE" = "$TODAY" ]; then
    exit 0
fi

if [ -z "$LAST_DATE" ]; then
    echo "$TODAY" > "$LAST_DATE_FILE"
    exit 0
fi

# === 3단계: config 확인 후 모드별 분기 ===
if [ ! -f "$CONFIG_FILE" ]; then
    emit_error "[daily-log] Config not found. Run /daily-log setup first."
    exit 0
fi

echo "$TODAY" > "$LAST_DATE_FILE"

# mode 읽기
MODE=$(CONFIG_PATH="$CONFIG_FILE" python -c "
import json, os
with open(os.environ['CONFIG_PATH'], encoding='utf-8') as f:
    print(json.load(f).get('mode', 'local'))
" 2>/dev/null || echo "local")

if [ "$MODE" = "server" ]; then
    "$SCRIPT_DIR/send-to-server.sh"
else
    "$SCRIPT_DIR/summarize-local.sh"
fi
