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
const PLUGIN_VERSION = '0.1.0';
const MAX_TEXT = 200;
const MAX_PREVIEW = 120;

function truncate(text, max) {
  const value = String(text == null ? '' : text).trim();
  return value.length > max ? value.slice(0, max) + '...' : value;
}

function firstLine(text, max) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const line = lines.find((candidate) => candidate.trim().length > 0);
  return truncate(line || '', max);
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

function eventFieldsFor(input) {
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
        summary: permissionSummary(input.tool_name, input.tool_input),
        tool_name: String(input.tool_name || ''),
        tool_input: slimToolInput(input.tool_input),
      };

    case 'Notification':
      // hooks.json matches only idle_prompt, but a stale matcher must not mislabel.
      if (input.notification_type !== 'idle_prompt') return null;
      return { event: 'idle_prompt', summary: truncate(input.message, MAX_TEXT) || 'Input needed' };

    case 'Stop':
      return {
        event: 'stop',
        query: firstLine(input.last_assistant_message, MAX_TEXT),
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

  const fields = eventFieldsFor(input);
  if (!fields) return;

  const cwd = String(input.cwd || process.cwd());
  const payload = Object.assign(
    {
      v: version,
      agent: 'claude',
      event: fields.event,
      session_id: String(input.session_id || ''),
      cwd,
      project: path.basename(cwd),
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
