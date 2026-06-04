---
description: spec/plan을 적대적 멀티에이전트 워크플로우로 검증 (PASS/FAIL). 외부 의존성은 웹 교차검증. 작성 안 하고 검증만.
argument-hint: <spec-path> [plan-path] [rules-path]
---

Validate a software spec (and optional plan) by running the bundled adversarial validation workflow.

**Arguments** (`$ARGUMENTS`): `<spec-path> [plan-path] [rules-path]`
- `$1` = spec path (required)
- `$2` = plan path (optional)
- `$3` = project rules/conventions path (optional — layers house rules on top of the universal checks)

## Steps

1. Parse the arguments above into `spec`, `plan`, `rules`. If `$1` is empty, ask the user for the spec path and stop.
2. Resolve the workflow script: it ships with this plugin at `${CLAUDE_PLUGIN_ROOT}/workflows/validate.js`. If that variable does not resolve, use the absolute path from the `<superpower-validate>` session block, or Glob `**/plugins/superpower-validate/workflows/validate.js`.
3. Run it:
   ```
   Workflow({
     scriptPath: "<resolved validate.js>",
     args: { spec: "$1", plan: "$2", rules: "$3" }
   })
   ```
4. Present the result: the **verdict** (`PASS` / `PASS_WITH_WARNINGS` / `FAIL`), confirmed findings grouped by severity (title · location · problem · impact · fix), and the `blockers` + `openQuestions` lists. On `FAIL`, do not proceed to implementation — report the blockers and ask how to proceed.
