#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'warp-cli-agent.js');
const ESC = '\x1b';
const BEL = '\x07';
const PREFIX = `${ESC}]777;notify;warp://cli-agent;`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warp-cli-agent-'));

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

  // Probing showed Warp drops the whole field when it carries more than one sequence,
  // so a stray ESC or BEL in user text would silently kill notifications.
  assert.strictEqual(seq.split(ESC).length - 1, 1, 'exactly one ESC');
  assert.strictEqual(seq.split(BEL).length - 1, 1, 'exactly one BEL');

  // Warp's docs warn that a raw newline breaks an OSC payload. Newlines we put in a
  // field must survive as the two characters backslash-n, not as a line break.
  assert.ok(!seq.includes('\n'), 'no raw newline may reach the terminal');

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

function writeTranscript(name, lines) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

const aiTitle = (title) => JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: 'sess-1' });
const chatter = (i) => JSON.stringify({ type: 'assistant', message: { content: `filler ${i}` } });

// No transcript on disk, so the session name falls back to the project.
const base = { session_id: 'sess-1', cwd: 'C:/repos/my-project', transcript_path: path.join(tmp, 'absent.jsonl') };
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('SessionStart -> session_start', () => {
  const payload = payloadOf(run(Object.assign({}, base, { hook_event_name: 'SessionStart', source: 'startup' })));
  assertEnvelope(payload, 'session_start');
  assert.strictEqual(typeof payload.plugin_version, 'string');
});

test('UserPromptSubmit -> prompt_submit carries the prompt unlabelled', () => {
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
  assert.strictEqual(payload.summary, 'my-project\nWants to run Bash: rm -rf build');
  assert.deepStrictEqual(payload.tool_input, { command: 'rm -rf build' });
});

test('Notification(idle_prompt) -> idle_prompt carries the message', () => {
  const payload = payloadOf(run(Object.assign({}, base, {
    hook_event_name: 'Notification',
    notification_type: 'idle_prompt',
    message: 'Waiting for your input',
  })));
  assertEnvelope(payload, 'idle_prompt');
  assert.strictEqual(payload.summary, 'my-project\nWaiting for your input');
});

test('Notification(idle_prompt) with no message falls back', () => {
  const payload = payloadOf(run(Object.assign({}, base, { hook_event_name: 'Notification', notification_type: 'idle_prompt' })));
  assert.strictEqual(payload.summary, 'my-project\nInput needed');
});

test('Stop -> stop carries the first line of the reply', () => {
  const payload = payloadOf(run(Object.assign({}, base, {
    hook_event_name: 'Stop',
    last_assistant_message: '\n\nFirst line here.\nSecond line ignored.',
  })));
  assertEnvelope(payload, 'stop');
  assert.strictEqual(payload.query, 'my-project\nFirst line here.');
});

test('Stop labels the card with the session name from the transcript', () => {
  const transcript_path = writeTranscript('named.jsonl', [aiTitle('Old name'), chatter(1), aiTitle('Warp 알림 설정'), chatter(2)]);
  const payload = payloadOf(run(Object.assign({}, base, { hook_event_name: 'Stop', transcript_path, last_assistant_message: 'Done.' })));
  assert.strictEqual(payload.query, 'Warp 알림 설정\nDone.');
});

test('Stop finds the session name near the end of a multi-megabyte transcript', () => {
  const filler = Array.from({ length: 20000 }, (_, i) => chatter(i));
  const transcript_path = writeTranscript('huge.jsonl', [aiTitle('Buried too deep'), ...filler, aiTitle('Recent name'), chatter(0)]);
  assert.ok(fs.statSync(transcript_path).size > 1024 * 1024, 'fixture must exceed the tail window');
  const payload = payloadOf(run(Object.assign({}, base, { hook_event_name: 'Stop', transcript_path, last_assistant_message: 'Done.' })));
  assert.strictEqual(payload.query, 'Recent name\nDone.');
});

test('Stop falls back to the project when the transcript has no name yet', () => {
  const transcript_path = writeTranscript('unnamed.jsonl', [chatter(1), chatter(2)]);
  const payload = payloadOf(run(Object.assign({}, base, { hook_event_name: 'Stop', transcript_path, last_assistant_message: 'Done.' })));
  assert.strictEqual(payload.query, 'my-project\nDone.');
});

test('Stop ignores a half-written transcript line', () => {
  const transcript_path = writeTranscript('torn.jsonl', [aiTitle('Good name'), '{"type":"ai-title","aiTitle":"tru']);
  const payload = payloadOf(run(Object.assign({}, base, { hook_event_name: 'Stop', transcript_path, last_assistant_message: 'Done.' })));
  assert.strictEqual(payload.query, 'Good name\nDone.');
});

test('Stop survives a UTF-8 round trip', () => {
  const payload = payloadOf(run(Object.assign({}, base, {
    hook_event_name: 'Stop',
    last_assistant_message: '한글이 깨지지 않는다.\n둘째 줄은 무시된다.',
  })));
  assert.strictEqual(payload.query, 'my-project\n한글이 깨지지 않는다.');
});

test('Stop escapes control characters in the reply', () => {
  // A raw BEL in the body would terminate the OSC early and swallow the rest.
  const payload = payloadOf(run(Object.assign({}, base, {
    hook_event_name: 'Stop',
    last_assistant_message: `bell${BEL}and${ESC}escape`,
  })));
  assert.strictEqual(payload.query, `my-project\nbell${BEL}and${ESC}escape`);
});

test('Stop truncates the reply past 200 characters', () => {
  const payload = payloadOf(run(Object.assign({}, base, { hook_event_name: 'Stop', last_assistant_message: 'x'.repeat(500) })));
  const [, reply] = payload.query.split('\n');
  assert.strictEqual(reply.length, 203);
  assert.ok(reply.endsWith('...'));
});

test('a long session name is truncated', () => {
  const transcript_path = writeTranscript('longname.jsonl', [aiTitle('n'.repeat(300))]);
  const payload = payloadOf(run(Object.assign({}, base, { hook_event_name: 'Stop', transcript_path, last_assistant_message: 'Done.' })));
  const [name] = payload.query.split('\n');
  assert.strictEqual(name.length, 83);
  assert.ok(name.endsWith('...'));
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

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
