#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'warp-cli-agent.js');
const ESC = '\x1b';
const BEL = '\x07';
const PREFIX = `${ESC}]777;notify;warp://cli-agent;`;

function run(hookInput, env) {
  return execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify(hookInput),
    encoding: 'utf8',
    env: Object.assign({}, process.env, { WARP_CLI_AGENT_PROTOCOL_VERSION: '1' }, env),
  });
}

// Returns the payload Warp would parse, after checking the framing Warp requires.
function payloadOf(stdout) {
  const output = JSON.parse(stdout);
  assert.strictEqual(output.suppressOutput, true, 'suppressOutput must be true');

  const seq = output.terminalSequence;
  assert.ok(seq.startsWith(PREFIX), 'sequence must be addressed to warp://cli-agent');
  assert.strictEqual(seq.at(-1), BEL, 'sequence must end with BEL');

  // Probing showed Warp drops the whole field when it carries more than one
  // sequence, so a stray ESC or BEL in user text would silently kill notifications.
  assert.strictEqual(seq.split(ESC).length - 1, 1, 'exactly one ESC');
  assert.strictEqual(seq.split(BEL).length - 1, 1, 'exactly one BEL');

  return JSON.parse(seq.slice(PREFIX.length, -1));
}

function assertEnvelope(payload, event) {
  assert.strictEqual(payload.v, 1);
  assert.strictEqual(payload.agent, 'claude');
  assert.strictEqual(payload.event, event);
  assert.strictEqual(payload.session_id, 'sess-1');
  assert.strictEqual(payload.cwd, 'C:/repos/my-project');
  assert.strictEqual(payload.project, 'my-project');
}

const base = { session_id: 'sess-1', cwd: 'C:/repos/my-project', transcript_path: 'C:/t.jsonl' };
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('SessionStart -> session_start', () => {
  const payload = payloadOf(run(Object.assign({}, base, { hook_event_name: 'SessionStart', source: 'startup' })));
  assertEnvelope(payload, 'session_start');
  assert.strictEqual(typeof payload.plugin_version, 'string');
});

test('UserPromptSubmit -> prompt_submit carries the prompt', () => {
  const payload = payloadOf(run(Object.assign({}, base, { hook_event_name: 'UserPromptSubmit', user_input: 'fix the parser' })));
  assertEnvelope(payload, 'prompt_submit');
  assert.strictEqual(payload.query, 'fix the parser');
});

test('PostToolUse -> tool_complete carries the tool name', () => {
  const payload = payloadOf(run(Object.assign({}, base, { hook_event_name: 'PostToolUse', tool_name: 'Edit' })));
  assertEnvelope(payload, 'tool_complete');
  assert.strictEqual(payload.tool_name, 'Edit');
});

test('PermissionRequest -> summary previews the command, tool_input is slimmed', () => {
  const payload = payloadOf(run(Object.assign({}, base, {
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf build', file_text: 'x'.repeat(50000) },
  })));
  assertEnvelope(payload, 'permission_request');
  assert.strictEqual(payload.summary, 'Wants to run Bash: rm -rf build');
  assert.deepStrictEqual(payload.tool_input, { command: 'rm -rf build' });
});

test('Notification(idle_prompt) -> idle_prompt carries the message', () => {
  const payload = payloadOf(run(Object.assign({}, base, {
    hook_event_name: 'Notification',
    notification_type: 'idle_prompt',
    message: 'Waiting for your input',
  })));
  assertEnvelope(payload, 'idle_prompt');
  assert.strictEqual(payload.summary, 'Waiting for your input');
});

test('Notification(idle_prompt) with no message falls back', () => {
  const payload = payloadOf(run(Object.assign({}, base, { hook_event_name: 'Notification', notification_type: 'idle_prompt' })));
  assert.strictEqual(payload.summary, 'Input needed');
});

test('Stop -> stop carries the first line of the reply', () => {
  const payload = payloadOf(run(Object.assign({}, base, {
    hook_event_name: 'Stop',
    last_assistant_message: '\n\nFirst line here.\nSecond line ignored.',
  })));
  assertEnvelope(payload, 'stop');
  assert.strictEqual(payload.query, 'First line here.');
  assert.strictEqual(payload.transcript_path, 'C:/t.jsonl');
});

test('Stop survives a UTF-8 round trip', () => {
  const payload = payloadOf(run(Object.assign({}, base, {
    hook_event_name: 'Stop',
    last_assistant_message: '한글이 깨지지 않는다.\n둘째 줄은 무시된다.',
  })));
  assert.strictEqual(payload.query, '한글이 깨지지 않는다.');
});

test('Stop escapes control characters in the reply', () => {
  // A raw BEL in the body would terminate the OSC early and swallow the rest.
  const payload = payloadOf(run(Object.assign({}, base, {
    hook_event_name: 'Stop',
    last_assistant_message: `bell${BEL}and${ESC}escape`,
  })));
  assert.strictEqual(payload.query, `bell${BEL}and${ESC}escape`);
});

test('Stop truncates past 200 characters', () => {
  const payload = payloadOf(run(Object.assign({}, base, { hook_event_name: 'Stop', last_assistant_message: 'x'.repeat(500) })));
  assert.strictEqual(payload.query.length, 203);
  assert.ok(payload.query.endsWith('...'));
});

test('emits nothing outside Warp', () => {
  const stdout = run(Object.assign({}, base, { hook_event_name: 'Stop', last_assistant_message: 'hi' }), {
    WARP_CLI_AGENT_PROTOCOL_VERSION: '',
  });
  assert.strictEqual(stdout, '');
});

test('emits nothing when a Stop hook is already active', () => {
  const stdout = run(Object.assign({}, base, { hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: 'hi' }));
  assert.strictEqual(stdout, '');
});

test('emits nothing for an unhandled notification type', () => {
  const stdout = run(Object.assign({}, base, { hook_event_name: 'Notification', notification_type: 'auth_success' }));
  assert.strictEqual(stdout, '');
});

test('emits nothing for an unhandled event', () => {
  const stdout = run(Object.assign({}, base, { hook_event_name: 'PreCompact' }));
  assert.strictEqual(stdout, '');
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
