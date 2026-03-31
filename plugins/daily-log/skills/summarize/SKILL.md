---
description: manually trigger local summarization
allowed-tools: Bash('${CLAUDE_PLUGIN_ROOT}/scripts/summarize-local.sh':*)
---

# Daily Log Manual Summarize

Manually trigger summarization of pending prompts (local mode only):
- Run: ${CLAUDE_PLUGIN_ROOT}/scripts/summarize-local.sh
- This will summarize all pending prompts and save the result to the configured summary path.
