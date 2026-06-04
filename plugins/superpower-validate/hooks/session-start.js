#!/usr/bin/env node
// SessionStart hook for the superpower-validate plugin.
// Injects a standing directive (added to Claude's context) telling it that a
// spec/plan validation workflow is installed and should REPLACE the default
// spec-document-reviewer / ad-hoc review loop. stdout from a SessionStart hook
// is added to the model's context.

const path = require("path");

// Resolve regardless of how the hook is launched: prefer the env var, fall back
// to this script's own location (hooks/ -> plugin root).
const root = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..");
// Forward-slash the path: backslashes in a Windows path become invalid string
// escapes (e.g. \v in "\validate.js") once the model embeds it as a scriptPath.
const scriptPath = path.join(root, "workflows", "validate.js").split(path.sep).join("/");

process.stdout.write(
  "<superpower-validate>\n" +
  "A spec/plan validation workflow is installed (superpower-validate plugin).\n\n" +
  "WHEN you reach a point of validating a software SPEC or PLAN — including the superpowers " +
  "brainstorming skill's spec-review step, or right before invoking executing-plans / " +
  "subagent-driven-development — do NOT run the default spec-document-reviewer or ad-hoc review " +
  "loop. INSTEAD invoke the `superpower-validate` skill.\n\n" +
  "It runs an adversarial multi-agent validation (fan-out review across dimensions -> 3-vote " +
  "adversarial verification -> PASS/FAIL verdict) and web-checks external dependencies. It is " +
  "generic and project-agnostic, and it does not author specs/plans — it only validates them.\n\n" +
  "Workflow script (pass as scriptPath): " + scriptPath + "\n" +
  "Invoke via the skill, which calls: Workflow({ scriptPath, args: { spec, plan, rules } }).\n" +
  "</superpower-validate>\n"
);
