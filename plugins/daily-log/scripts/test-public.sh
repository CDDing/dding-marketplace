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

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
