#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

run_test() {
    local name="$1"
    echo "=== Test: $name ==="
}

fail() {
    echo "FAIL: $1"
    FAIL=$((FAIL + 1))
}

pass() {
    echo "PASS: $1"
    PASS=$((PASS + 1))
}

# --- on-stop.sh tests ---

run_test "on-stop.sh records response"
TEST_DIR=$(mktemp -d)
export HOME="$TEST_DIR"
DAILY_LOG_DIR="${TEST_DIR}/.claude/daily-log"
mkdir -p "$DAILY_LOG_DIR"

echo '{"last_assistant_message": "Hello world response", "cwd": "/tmp/test", "session_id": "test-sess"}' \
  | "$SCRIPT_DIR/on-stop.sh"

if [ -f "$DAILY_LOG_DIR/prompts.jsonl" ]; then
    python -c "
import json
with open('$DAILY_LOG_DIR/prompts.jsonl') as f:
    entry = json.loads(f.readline())
    assert entry['type'] == 'response', f'Expected response, got {entry[\"type\"]}'
    assert entry['content'] == 'Hello world response', f'Wrong content: {entry[\"content\"]}'
    assert entry['cwd'] == '/tmp/test'
    assert entry['session_id'] == 'test-sess'
    assert 'env' not in entry, 'env field should not exist'
" && pass "on-stop.sh records response correctly" || fail "response content mismatch"
else
    fail "prompts.jsonl not created"
fi
rm -rf "$TEST_DIR"

run_test "on-stop.sh truncates at 200 chars"
TEST_DIR=$(mktemp -d)
export HOME="$TEST_DIR"
DAILY_LOG_DIR="${TEST_DIR}/.claude/daily-log"
mkdir -p "$DAILY_LOG_DIR"

LONG_MSG=$(python -c "print('x' * 300)")
echo "{\"last_assistant_message\": \"$LONG_MSG\", \"cwd\": \"/tmp\", \"session_id\": \"s1\"}" \
  | "$SCRIPT_DIR/on-stop.sh"

python -c "
import json
with open('$DAILY_LOG_DIR/prompts.jsonl') as f:
    entry = json.loads(f.readline())
    assert len(entry['content']) == 200, f'Expected 200 chars, got {len(entry[\"content\"])}'
" && pass "truncates at 200 chars" || fail "truncation failed"
rm -rf "$TEST_DIR"

run_test "on-stop.sh skips empty response"
TEST_DIR=$(mktemp -d)
export HOME="$TEST_DIR"
DAILY_LOG_DIR="${TEST_DIR}/.claude/daily-log"
mkdir -p "$DAILY_LOG_DIR"

echo '{"last_assistant_message": "", "cwd": "/tmp", "session_id": "s1"}' \
  | "$SCRIPT_DIR/on-stop.sh"

if [ ! -f "$DAILY_LOG_DIR/prompts.jsonl" ]; then
    pass "skips empty response"
else
    fail "should not create file for empty response"
fi
rm -rf "$TEST_DIR"

# --- send-to-server.sh tests ---

run_test "send-to-server.sh fails gracefully when server unreachable"
TEST_DIR=$(mktemp -d)
export HOME="$TEST_DIR"
DAILY_LOG_DIR="${TEST_DIR}/.claude/daily-log"
QUEUE_DIR="${DAILY_LOG_DIR}/queue"
mkdir -p "$DAILY_LOG_DIR" "$QUEUE_DIR"

cat > "$DAILY_LOG_DIR/config.json" << 'CONF'
{
  "mode": "server",
  "server_url": "http://localhost:19999/api/submit",
  "server_headers": {
    "Authorization": "Bearer test-token",
    "X-Custom": "hello"
  }
}
CONF

echo '{"ts":"2026-03-31T10:00:00+09:00","type":"prompt","cwd":"/tmp","session_id":"s1","content":"test"}' \
  > "$DAILY_LOG_DIR/prompts.jsonl"

"$SCRIPT_DIR/send-to-server.sh" 2>/dev/null || true

if ls "$QUEUE_DIR"/*.jsonl 1>/dev/null 2>&1; then
    pass "failed send moves to queue"
else
    fail "queue file not created on send failure"
fi
rm -rf "$TEST_DIR"

run_test "send-to-server.sh exits when no config"
TEST_DIR=$(mktemp -d)
export HOME="$TEST_DIR"
mkdir -p "${TEST_DIR}/.claude/daily-log"

OUTPUT=$("$SCRIPT_DIR/send-to-server.sh" 2>/dev/null || true)
if echo "$OUTPUT" | grep -q "config.json not found"; then
    pass "reports missing config"
else
    fail "should report missing config"
fi
rm -rf "$TEST_DIR"

run_test "send-to-server.sh skips empty prompts file"
TEST_DIR=$(mktemp -d)
export HOME="$TEST_DIR"
DAILY_LOG_DIR="${TEST_DIR}/.claude/daily-log"
mkdir -p "$DAILY_LOG_DIR"

cat > "$DAILY_LOG_DIR/config.json" << 'CONF'
{
  "mode": "server",
  "server_url": "http://localhost:19999/api/submit",
  "server_headers": {}
}
CONF

touch "$DAILY_LOG_DIR/prompts.jsonl"

"$SCRIPT_DIR/send-to-server.sh" 2>/dev/null
if [ $? -eq 0 ]; then
    pass "skips empty prompts file"
else
    fail "should succeed with empty prompts"
fi
rm -rf "$TEST_DIR"

# --- summarize-local.sh tests ---

run_test "summarize-local.sh dry-run creates summary file"
TEST_DIR=$(mktemp -d)
export HOME="$TEST_DIR"
DAILY_LOG_DIR="${TEST_DIR}/.claude/daily-log"
mkdir -p "$DAILY_LOG_DIR"

cat > "$DAILY_LOG_DIR/config.json" << 'CONF'
{
  "mode": "local",
  "summary_path": "",
  "after_summary": "delete",
  "model": "haiku"
}
CONF

cat > "$DAILY_LOG_DIR/prompts.jsonl" << 'JSONL'
{"ts":"2026-03-30T10:00:00+09:00","type":"prompt","cwd":"/home/user/project-a","session_id":"s1","content":"working on feature A"}
{"ts":"2026-03-30T10:05:00+09:00","type":"response","cwd":"/home/user/project-a","session_id":"s1","content":"done with feature A"}
{"ts":"2026-03-30T11:00:00+09:00","type":"prompt","cwd":"/home/user/project-b","session_id":"s2","content":"fixing bug in project B"}
JSONL

"$SCRIPT_DIR/summarize-local.sh" --dry-run 2>/dev/null

SUMMARY_FILE="${DAILY_LOG_DIR}/summaries/2026/03/2026-03-30.md"
if [ -f "$SUMMARY_FILE" ]; then
    # Check it has the header and both workspaces
    if grep -q "# 2026-03-30 Daily Log" "$SUMMARY_FILE" && \
       grep -q "project-a" "$SUMMARY_FILE" && \
       grep -q "project-b" "$SUMMARY_FILE"; then
        pass "dry-run creates summary with both workspaces"
    else
        fail "summary file missing expected content"
        cat "$SUMMARY_FILE"
    fi
else
    fail "summary file not created"
fi
rm -rf "$TEST_DIR"

run_test "summarize-local.sh dry-run with delete removes original"
TEST_DIR=$(mktemp -d)
export HOME="$TEST_DIR"
DAILY_LOG_DIR="${TEST_DIR}/.claude/daily-log"
mkdir -p "$DAILY_LOG_DIR"

cat > "$DAILY_LOG_DIR/config.json" << 'CONF'
{
  "mode": "local",
  "summary_path": "",
  "after_summary": "delete",
  "model": "haiku"
}
CONF

echo '{"ts":"2026-03-30T10:00:00+09:00","type":"prompt","cwd":"/tmp/proj","session_id":"s1","content":"test"}' \
  > "$DAILY_LOG_DIR/prompts.jsonl"

"$SCRIPT_DIR/summarize-local.sh" --dry-run 2>/dev/null

if [ ! -f "$DAILY_LOG_DIR/.summarizing.jsonl" ] && [ ! -f "$DAILY_LOG_DIR/prompts.jsonl" ]; then
    pass "delete mode removes original after summarization"
else
    fail "original file still exists after delete mode"
fi
rm -rf "$TEST_DIR"

run_test "summarize-local.sh dry-run with archive moves original"
TEST_DIR=$(mktemp -d)
export HOME="$TEST_DIR"
DAILY_LOG_DIR="${TEST_DIR}/.claude/daily-log"
mkdir -p "$DAILY_LOG_DIR"

cat > "$DAILY_LOG_DIR/config.json" << 'CONF'
{
  "mode": "local",
  "summary_path": "",
  "after_summary": "archive",
  "model": "haiku"
}
CONF

echo '{"ts":"2026-03-30T10:00:00+09:00","type":"prompt","cwd":"/tmp/proj","session_id":"s1","content":"test"}' \
  > "$DAILY_LOG_DIR/prompts.jsonl"

"$SCRIPT_DIR/summarize-local.sh" --dry-run 2>/dev/null

if [ -f "$DAILY_LOG_DIR/archive/2026-03-30.jsonl" ]; then
    pass "archive mode moves original to archive/"
else
    fail "archive file not found"
fi
rm -rf "$TEST_DIR"

run_test "summarize-local.sh custom summary_path"
TEST_DIR=$(mktemp -d)
export HOME="$TEST_DIR"
DAILY_LOG_DIR="${TEST_DIR}/.claude/daily-log"
CUSTOM_PATH="${TEST_DIR}/my-notes"
mkdir -p "$DAILY_LOG_DIR"

cat > "$DAILY_LOG_DIR/config.json" << CONF
{
  "mode": "local",
  "summary_path": "${CUSTOM_PATH}",
  "after_summary": "delete",
  "model": "haiku"
}
CONF

echo '{"ts":"2026-03-30T10:00:00+09:00","type":"prompt","cwd":"/tmp/proj","session_id":"s1","content":"test"}' \
  > "$DAILY_LOG_DIR/prompts.jsonl"

"$SCRIPT_DIR/summarize-local.sh" --dry-run 2>/dev/null

if [ -f "${CUSTOM_PATH}/2026/03/2026-03-30.md" ]; then
    pass "custom summary_path works"
else
    fail "summary not found at custom path"
fi
rm -rf "$TEST_DIR"

run_test "summarize-local.sh skips empty prompts"
TEST_DIR=$(mktemp -d)
export HOME="$TEST_DIR"
DAILY_LOG_DIR="${TEST_DIR}/.claude/daily-log"
mkdir -p "$DAILY_LOG_DIR"

cat > "$DAILY_LOG_DIR/config.json" << 'CONF'
{
  "mode": "local",
  "summary_path": "",
  "after_summary": "delete",
  "model": "haiku"
}
CONF

touch "$DAILY_LOG_DIR/prompts.jsonl"

"$SCRIPT_DIR/summarize-local.sh" --dry-run 2>/dev/null
if [ $? -eq 0 ]; then
    pass "skips empty prompts file"
else
    fail "should succeed with empty prompts"
fi
rm -rf "$TEST_DIR"

# --- on-prompt.sh tests ---

run_test "on-prompt.sh records prompt"
TEST_DIR=$(mktemp -d)
export HOME="$TEST_DIR"
DAILY_LOG_DIR="${TEST_DIR}/.claude/daily-log"
mkdir -p "$DAILY_LOG_DIR"

echo '{"prompt": "hello world", "cwd": "/tmp/test", "session_id": "test-sess"}' \
  | "$SCRIPT_DIR/on-prompt.sh"

if [ -f "$DAILY_LOG_DIR/prompts.jsonl" ]; then
    python -c "
import json
with open('$DAILY_LOG_DIR/prompts.jsonl') as f:
    entry = json.loads(f.readline())
    assert entry['type'] == 'prompt'
    assert entry['content'] == 'hello world'
    assert entry['cwd'] == '/tmp/test'
    assert 'env' not in entry, 'env field should not exist'
" && pass "records prompt correctly" || fail "prompt content mismatch"
else
    fail "prompts.jsonl not created"
fi
rm -rf "$TEST_DIR"

run_test "on-prompt.sh first run sets last_date"
TEST_DIR=$(mktemp -d)
export HOME="$TEST_DIR"
DAILY_LOG_DIR="${TEST_DIR}/.claude/daily-log"
mkdir -p "$DAILY_LOG_DIR"

echo '{"prompt": "first prompt", "cwd": "/tmp", "session_id": "s1"}' \
  | "$SCRIPT_DIR/on-prompt.sh"

if [ -f "$DAILY_LOG_DIR/last_date" ]; then
    TODAY=$(date '+%Y-%m-%d')
    SAVED=$(cat "$DAILY_LOG_DIR/last_date")
    if [ "$SAVED" = "$TODAY" ]; then
        pass "first run sets last_date to today"
    else
        fail "last_date is '$SAVED', expected '$TODAY'"
    fi
else
    fail "last_date not created"
fi
rm -rf "$TEST_DIR"

run_test "on-prompt.sh skips empty prompt"
TEST_DIR=$(mktemp -d)
export HOME="$TEST_DIR"
DAILY_LOG_DIR="${TEST_DIR}/.claude/daily-log"
mkdir -p "$DAILY_LOG_DIR"

echo '{"prompt": "", "cwd": "/tmp", "session_id": "s1"}' \
  | "$SCRIPT_DIR/on-prompt.sh"

if [ ! -f "$DAILY_LOG_DIR/prompts.jsonl" ]; then
    pass "skips empty prompt"
else
    fail "should not record empty prompt"
fi
rm -rf "$TEST_DIR"

run_test "on-prompt.sh no config emits error on date change"
TEST_DIR=$(mktemp -d)
export HOME="$TEST_DIR"
DAILY_LOG_DIR="${TEST_DIR}/.claude/daily-log"
mkdir -p "$DAILY_LOG_DIR"

# Set last_date to yesterday
echo "2020-01-01" > "$DAILY_LOG_DIR/last_date"

OUTPUT=$(echo '{"prompt": "test", "cwd": "/tmp", "session_id": "s1"}' \
  | "$SCRIPT_DIR/on-prompt.sh" 2>/dev/null)

if echo "$OUTPUT" | grep -q "Config not found"; then
    pass "emits error when config missing on date change"
else
    fail "should emit config not found error"
fi
rm -rf "$TEST_DIR"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
