#!/bin/bash
# send-to-server.sh — prompts.jsonl을 서버로 전송 또는 큐 재전송
# Usage:
#   send-to-server.sh          날짜 변경 시 자동 호출 (prompts.jsonl 전송)
#   send-to-server.sh resend   큐 재전송 (/daily-log resend에서 호출)
set -euo pipefail
export PYTHONIOENCODING=utf-8

DAILY_LOG_DIR="${HOME}/.claude/daily-log"
CONFIG_FILE="${DAILY_LOG_DIR}/config.json"
PROMPTS_FILE="${DAILY_LOG_DIR}/prompts.jsonl"
QUEUE_DIR="${DAILY_LOG_DIR}/queue"
LOCK_DIR="${DAILY_LOG_DIR}/.lock.d"

mkdir -p "$QUEUE_DIR"

emit_error() {
    echo "{\"systemMessage\": \"$1\"}"
}

# config 읽기
if [ ! -f "$CONFIG_FILE" ]; then
    emit_error "[daily-log] config.json not found. Run /daily-log setup first."
    exit 1
fi

SERVER_URL=$(CONFIG_PATH="$CONFIG_FILE" python -c "
import json, os
with open(os.environ['CONFIG_PATH'], encoding='utf-8') as f:
    print(json.load(f).get('server_url', ''))
" 2>/dev/null)

if [ -z "$SERVER_URL" ]; then
    emit_error "[daily-log] server_url is not configured."
    exit 1
fi

# server_headers를 curl -H 옵션으로 변환
HEADER_ARGS=$(CONFIG_PATH="$CONFIG_FILE" python -c "
import json, os
with open(os.environ['CONFIG_PATH'], encoding='utf-8') as f:
    headers = json.load(f).get('server_headers', {})
for k, v in headers.items():
    print(f'-H')
    print(f'{k}: {v}')
" 2>/dev/null || echo "")

BATCH_SIZE=500

send_file() {
    local filepath="$1"

    if [ ! -f "$filepath" ] || [ ! -s "$filepath" ]; then
        return 0
    fi

    local tmpdir
    tmpdir=$(mktemp -d) || return 1

    FILE_PATH="$filepath" TMPDIR="$tmpdir" BATCH="$BATCH_SIZE" python -c "
import json, os

batch_size = int(os.environ['BATCH'])
tmpdir = os.environ['TMPDIR']
prompts = []
with open(os.environ['FILE_PATH'], encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            prompts.append(json.loads(line))
        except json.JSONDecodeError:
            continue
if not prompts:
    exit(1)
for i in range(0, len(prompts), batch_size):
    batch = prompts[i:i+batch_size]
    out_path = os.path.join(tmpdir, f'batch_{i:06d}.json')
    with open(out_path, 'w', encoding='utf-8') as out:
        json.dump({'prompts': batch}, out, ensure_ascii=False)
" 2>/dev/null || { rm -rf "$tmpdir"; return 1; }

    local all_ok=true
    for batch_file in "$tmpdir"/batch_*.json; do
        [ -f "$batch_file" ] || continue

        # server_headers를 curl 옵션으로 전달
        local curl_cmd=(curl -s -o /dev/null -w "%{http_code}" --max-time 30 -X POST "${SERVER_URL}" -H "Content-Type: application/json")
        if [ -n "$HEADER_ARGS" ]; then
            while IFS= read -r arg; do
                [ -n "$arg" ] && curl_cmd+=("$arg")
            done <<< "$HEADER_ARGS"
        fi
        curl_cmd+=(-d @"$batch_file")

        HTTP_CODE=$("${curl_cmd[@]}" 2>/dev/null || echo "000")
        if [ "$HTTP_CODE" != "200" ]; then
            all_ok=false
            break
        fi
    done

    rm -rf "$tmpdir"
    $all_ok
}

MODE="${1:-send}"

if [ "$MODE" = "resend" ]; then
    SENT=0
    FAILED=0
    for queue_file in "${QUEUE_DIR}"/*.jsonl; do
        [ -f "$queue_file" ] || continue
        if send_file "$queue_file"; then
            rm -f "$queue_file"
            SENT=$((SENT + 1))
        else
            FAILED=$((FAILED + 1))
        fi
    done
    echo "Queue resend: ${SENT} sent, ${FAILED} failed"
else
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
        if [ ! -f "$PROMPTS_FILE" ] || [ ! -s "$PROMPTS_FILE" ]; then
            exit 0
        fi

        SEND_FILE="${DAILY_LOG_DIR}/.sending.jsonl"
        mv "$PROMPTS_FILE" "$SEND_FILE"

        if send_file "$SEND_FILE"; then
            rm -f "$SEND_FILE"
        else
            QUEUE_FILE="${QUEUE_DIR}/$(date '+%Y%m%d_%H%M%S').jsonl"
            mv "$SEND_FILE" "$QUEUE_FILE"
            emit_error "[daily-log] Server send failed. Data saved to queue/. Use /daily-log resend to retry."
        fi
    fi
fi
