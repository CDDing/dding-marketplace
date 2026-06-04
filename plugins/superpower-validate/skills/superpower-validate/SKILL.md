---
name: superpower-validate
description: Use when validating a software SPEC or implementation PLAN before building — e.g. the brainstorming skill's spec-review step, or right before invoking executing-plans / subagent-driven-development. Runs an adversarial multi-agent validation workflow (fan-out review across dimensions → 3-vote adversarial verification → PASS/FAIL verdict, with web-checks of external dependencies). Use this INSTEAD of the default spec-document-reviewer / ad-hoc review loop. Validates only — it never authors specs or plans.
---

# superpower-validate

Adversarial, project-agnostic validation of a spec and/or implementation plan. This skill does **not** write or edit the spec/plan — it only judges it and returns a verdict. Authoring stays with `brainstorming` (spec) and `writing-plans` (plan).

**Announce at start:** "I'm using the superpower-validate skill to validate the spec/plan."

## When to run

- A spec was just written (e.g. brainstorming step "Write design doc") → validate the spec.
- A plan was just written (writing-plans) → validate the spec **and** plan together, *before* implementation begins.
- Anytime a user asks to check/validate/review a spec or plan.

When this skill applies, **replace** the default `spec-document-reviewer` loop — do not run both.

## How to run

1. **Gather inputs** (paths preferred; inline text also works):
   - `spec` — path to the spec/design doc (required).
   - `plan` — path to the implementation plan (include it whenever a plan exists).
   - `rules` — OPTIONAL path to the current project's house rules/conventions (e.g. a repo `CLAUDE.md`, a spec-plan rules file). Pass it to layer project-specific checks on top of the universal ones. Omit for pure generic validation.

2. **Resolve the workflow script path.** The script ships with this plugin at `workflows/validate.js`.
   - The absolute path is printed in the `<superpower-validate>` block injected at session start — use that.
   - Fallback: Glob for `**/plugins/superpower-validate/workflows/validate.js` and use the match.

3. **Run the workflow** (this is the explicit opt-in to call the Workflow tool):
   ```
   Workflow({
     scriptPath: "<absolute path to validate.js>",
     args: { spec: "<spec path-or-text>", plan: "<plan path-or-text>", rules: "<rules path-or-text or omit>" }
   })
   ```

4. **Present the verdict** to your human partner:
   - State the **verdict**: `PASS`, `PASS_WITH_WARNINGS`, or `FAIL`.
   - List confirmed findings grouped by severity (blocker → major → minor): title, location, problem, impact, suggested fix.
   - Surface `blockers` and `openQuestions` explicitly.

## Gate behavior

- **FAIL** (any confirmed blocker/major): STOP. Do not proceed to implementation. Report the blockers and ask the user how to proceed (usually: fix spec/plan, then re-validate).
- **PASS_WITH_WARNINGS**: proceed is allowed, but surface the minors so the user decides.
- **PASS**: proceed.

This is a strong recommendation gate, not a hard mechanical block — always show the verdict and let the user make the call.
