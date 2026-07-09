#!/usr/bin/env node
'use strict';

// Reports Claude Code session state to Warp, which draws a tab status icon and an
// agent notification card. All six hook events funnel through this one dispatcher;
// stdin carries hook_event_name, so no per-event scripts are needed.
//
// The transport is a single OSC 777 sequence addressed to warp://cli-agent, handed
// to Claude Code through the `terminalSequence` hook output field rather than
// written to /dev/tty. That device does not exist on Windows, which is why the
// official bash plugin cannot deliver notifications there.
//
// Two constraints are load-bearing, both established by probing a live Warp:
//   - `terminalSequence` must carry exactly one sequence. An OSC 2 prepended to an
//     OSC 777 silently discards both, despite OSC 2 being documented as allowed.
//   - Warp renders each event's card body from one designated field and ignores
//     every other field: `query` for stop and prompt_submit, `summary` for
//     permission_request and idle_prompt.

const fs = require('fs');
const path = require('path');

const PLUGIN_PROTOCOL_VERSION = 1;
const PLUGIN_VERSION = '0.2.0';
const MAX_TEXT = 200;
const MAX_PREVIEW = 120;
const MAX_TITLE = 80;

// A transcript runs to megabytes and a hook runs on every turn, so read only the end.
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

function truncate(text, max) {
  const value = String(text == null ? '' : text).trim();
  return value.length > max ? value.slice(0, max) + '...' : value;
}

function firstLine(text, max) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const line = lines.find((candidate) => candidate.trim().length > 0);
  return truncate(line || '', max);
}

// Claude Code appends {"type":"ai-title","aiTitle":"..."} to the transcript whenever
// it renames a session, so the last such line is the current name. Returns '' when the
// session is too new to have been named yet.
function readSessionTitle(transcriptPath) {
  if (!transcriptPath) return '';
  try {
    const { size } = fs.statSync(transcriptPath);
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const length = size - start;
    if (length <= 0) return '';

    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }

    const lines = buffer.toString('utf8').split('\n');
    // A mid-file offset lands inside a line, and possibly inside a UTF-8 code point.
    if (start > 0) lines.shift();

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].includes('"type":"ai-title"')) continue;
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.aiTitle) return truncate(entry.aiTitle, MAX_TITLE);
      } catch (error) {
        // A partially written line. Keep scanning backwards.
      }
    }
  } catch (error) {
    // No transcript, or it vanished mid-read. The caller falls back to the project name.
  }
  return '';
}

// Warp gives each card one editable slot and renders newlines inside it, so the session
// name goes on its own line above the message. Which session is calling matters most
// when several are running and one of them is blocked.
function labelled(sessionName, message) {
  return sessionName ? `${sessionName}\n${message}` : message;
}

function permissionSummary(toolName, toolInput) {
  const preview = toolInput && (toolInput.command || toolInput.file_path);
  const name = toolName || 'a tool';
  return preview
    ? `Wants to run ${name}: ${truncate(preview, MAX_PREVIEW)}`
    : `Wants to run ${name}`;
}

// The full tool_input can hold an entire file body. Only the two keys Warp shows a
// preview from are worth pushing through the terminal.
function slimToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return {};
  const slim = {};
  if (toolInput.command) slim.command = truncate(toolInput.command, MAX_PREVIEW);
  if (toolInput.file_path) slim.file_path = String(toolInput.file_path);
  return slim;
}

// `sessionName` is a getter because reading the transcript costs a file read, and the
// events that fire on every tool call render no card that could show the name.
function eventFieldsFor(input, sessionName) {
  switch (input.hook_event_name) {
    case 'SessionStart':
      return { event: 'session_start', plugin_version: PLUGIN_VERSION };

    case 'UserPromptSubmit':
      return { event: 'prompt_submit', query: truncate(input.user_input, MAX_TEXT) };

    case 'PostToolUse':
      return { event: 'tool_complete', tool_name: String(input.tool_name || '') };

    case 'PermissionRequest':
      return {
        event: 'permission_request',
        summary: labelled(sessionName(), permissionSummary(input.tool_name, input.tool_input)),
        tool_name: String(input.tool_name || ''),
        tool_input: slimToolInput(input.tool_input),
      };

    case 'Notification':
      // hooks.json matches only idle_prompt, but a stale matcher must not mislabel.
      if (input.notification_type !== 'idle_prompt') return null;
      return {
        event: 'idle_prompt',
        summary: labelled(sessionName(), truncate(input.message, MAX_TEXT) || 'Input needed'),
      };

    case 'Stop':
      return {
        event: 'stop',
        query: labelled(sessionName(), firstLine(input.last_assistant_message, MAX_TEXT)),
        transcript_path: String(input.transcript_path || ''),
      };

    default:
      return null;
  }
}

function main() {
  // Absent means the terminal is not a Warp that speaks this protocol.
  const advertised = parseInt(process.env.WARP_CLI_AGENT_PROTOCOL_VERSION, 10);
  if (!Number.isInteger(advertised)) return;

  const version = Math.min(PLUGIN_PROTOCOL_VERSION, advertised);
  if (version < 1) return;

  const raw = fs.readFileSync(0, 'utf8');
  if (!raw.trim()) return;

  const input = JSON.parse(raw);
  if (input.stop_hook_active) return;

  const cwd = String(input.cwd || process.cwd());
  const project = path.basename(cwd);

  let cachedName;
  const sessionName = () => {
    if (cachedName === undefined) cachedName = readSessionTitle(input.transcript_path) || project;
    return cachedName;
  };

  const fields = eventFieldsFor(input, sessionName);
  if (!fields) return;

  const payload = Object.assign(
    {
      v: version,
      agent: 'claude',
      event: fields.event,
      session_id: String(input.session_id || ''),
      cwd,
      project,
    },
    fields
  );

  // JSON.stringify escapes control characters, so a prompt or shell command
  // containing an ESC or a BEL cannot terminate the sequence early.
  const body = JSON.stringify(payload);
  const sequence = `\x1b]777;notify;warp://cli-agent;${body}\x07`;

  process.stdout.write(JSON.stringify({ terminalSequence: sequence, suppressOutput: true }));
}

try {
  main();
} catch (error) {
  // A notification is never worth failing a turn over. Staying silent on stderr
  // keeps the failure out of the transcript.
  process.exit(0);
}
