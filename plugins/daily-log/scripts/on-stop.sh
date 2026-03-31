#!/bin/bash
# on-stop.sh — Stop hook
# Claude 응답을 200자로 truncate하여 기록
set -euo pipefail
export PYTHONIOENCODING=utf-8

DAILY_LOG_DIR="${HOME}/.claude/daily-log"
PROMPTS_FILE="${DAILY_LOG_DIR}/prompts.jsonl"
mkdir -p "$DAILY_LOG_DIR"

# stdin에서 hook 데이터 읽기
HOOK_INPUT=$(cat)

# last_assistant_message 추출 + 200자 truncate
RESPONSE=$(HOOK_DATA="$HOOK_INPUT" python -c "
import json, os
data = json.loads(os.environ['HOOK_DATA'])
msg = data.get('last_assistant_message', '')
print(msg[:200])
" 2>/dev/null || echo "")

# 응답이 비어있으면 종료
[ -z "$RESPONSE" ] && exit 0

TIMESTAMP=$(date '+%Y-%m-%dT%H:%M:%S%:z')

# cwd, session_id 추출
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

# mkdir lock으로 잠금 후 기록
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
    ENTRY_TS="$TIMESTAMP" ENTRY_CWD="$CWD" ENTRY_SID="$SESSION_ID" ENTRY_CONTENT="$RESPONSE" python -c "
import json, os
entry = {
    'ts': os.environ['ENTRY_TS'],
    'type': 'response',
    'cwd': os.environ['ENTRY_CWD'],
    'session_id': os.environ['ENTRY_SID'],
    'content': os.environ['ENTRY_CONTENT']
}
print(json.dumps(entry, ensure_ascii=False))
" >> "$PROMPTS_FILE"
fi
