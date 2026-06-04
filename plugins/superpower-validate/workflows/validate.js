export const meta = {
  name: 'superpower-validate',
  description: 'Adversarial spec/plan validation — fan-out review across dimensions, 3-vote adversarial verification per finding, web-check external dependencies, synthesize a PASS/FAIL verdict. Validates only; never authors.',
  whenToUse: 'When a software spec and/or implementation plan needs validation before building. Pass args: { spec: "<path-or-text>", plan?: "<path-or-text>", rules?: "<path-or-text>" }. Generic and project-agnostic — pass a project rules file via `rules` to layer house conventions on top of the universal checks.',
  phases: [
    { title: 'Scope', detail: 'Read spec/plan, extract requirements / ACs / dependencies / plan steps' },
    { title: 'Review', detail: 'One reviewer per validation dimension (fan-out)' },
    { title: 'Verify', detail: '3-vote adversarial verification per finding (need 2/3 to drop)' },
    { title: 'Synthesize', detail: 'Merge dupes, severity-rank, PASS/FAIL verdict' },
  ],
}

// superpower-validate: Scope → Review(fan-out by dimension) → 3-vote Verify → Synthesize(verdict)
// Ported from the deep-research harness. The "claim" there is here a candidate DEFECT in the
// spec/plan; adversarial voters try to REFUTE that it is a real defect (kill false positives).
// External-dependency findings are cross-checked with WebSearch/WebFetch.
// Workflow scripts have NO filesystem access — agents Read the doc paths themselves.

const VOTES_PER_FINDING = 3
const REFUTATIONS_REQUIRED = 2
const MAX_VERIFY_FINDINGS = 30

// ─── Inputs (path OR inline text; agents load paths via Read) ───
const A = (args && typeof args === "object") ? args : {}
const SPEC = (A.spec || A.specPath || (typeof args === "string" ? args : "") || "").toString().trim()
const PLAN = (A.plan || A.planPath || "").toString().trim()
const RULES = (A.rules || A.rulesPath || "").toString().trim()

if (!SPEC) {
  return { error: "No spec provided. Pass args: { spec: '<path-or-text>', plan?: '<path-or-text>', rules?: '<path-or-text>' }." }
}

// ─── Validation dimensions (universal; project rules added only if supplied) ───
const DIMENSIONS = [
  { key: "requirements-clarity", label: "Requirements clarity", web: false, guide:
    "Find requirements that are vague, ambiguous, or could be implemented two different ways. Flag hedge words ('appropriate', 'as needed', 'etc.', 'handle properly', 'where applicable') with no concrete definition, undefined terms, and missing units / thresholds / limits." },
  { key: "acceptance-testability", label: "Acceptance criteria testability", web: false, guide:
    "Every acceptance criterion must be a concrete, checkable 'given X input, expect Y output/behavior' with a clear pass/fail. Flag ACs that are subjective or unobservable, and flag any requirement that has NO corresponding acceptance criterion." },
  { key: "spec-plan-consistency", label: "Spec <-> Plan consistency", web: false, guide:
    "Cross-check the plan against the spec. Flag: (a) spec requirements with NO covering plan step (coverage gap); (b) plan steps that contradict the spec; (c) interface/contract mismatches between what the spec promises and what the plan builds. If no plan was provided, return findings: [] for this dimension." },
  { key: "scope-discipline", label: "Scope discipline", web: false, guide:
    "Flag plan steps or requirements that fall OUTSIDE the spec's stated scope, or violate an explicit 'Out of Scope' / 'Must NOT' list (scope creep). Also flag a spec requirement that silently expands a neighboring system's public contract without declaring that integration." },
  { key: "dependency-existence", label: "External dependency existence", web: true, guide:
    "Identify every external capability the spec/plan ASSUMES exists — third-party libraries, APIs, SDK methods, framework features, CLI flags, services. For each, use WebSearch/WebFetch to verify it really exists and behaves as assumed (correct name, signature, version availability, not deprecated/removed). Flag any assumed capability you cannot confirm or that works differently than assumed. This is the highest-value web check." },
  { key: "internal-consistency", label: "Internal consistency & feasibility", web: false, guide:
    "Flag internal contradictions (two requirements that cannot both hold), technically infeasible requirements, and stated flows missing error / edge-case handling that the spec itself implies is needed." },
]
if (RULES) {
  DIMENSIONS.push({ key: "house-rules", label: "Project conventions", web: false, guide:
    "Read the provided project rules/conventions document and validate the spec/plan against it. Flag concrete violations only — cite the specific rule. Do not invent rules that are not in the document." })
}

// ─── Schemas ───
const SCOPE_SCHEMA = {
  type: "object", required: ["summary"],
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    readError: { type: "string" },
    hasPlan: { type: "boolean" },
    requirements: { type: "array", items: { type: "string" } },
    acceptanceCriteria: { type: "array", items: { type: "string" } },
    externalDependencies: { type: "array", items: { type: "string" } },
    planSteps: { type: "array", items: { type: "string" } },
    outOfScope: { type: "array", items: { type: "string" } },
  },
}
const FINDINGS_SCHEMA = {
  type: "object", required: ["findings"],
  properties: {
    findings: { type: "array", maxItems: 8, items: {
      type: "object", required: ["title", "severity", "location", "problem", "impact"],
      properties: {
        title: { type: "string" },
        severity: { enum: ["blocker", "major", "minor"] },
        location: { type: "string" },
        problem: { type: "string" },
        impact: { type: "string" },
        suggestion: { type: "string" },
        needsWebCheck: { type: "boolean" },
      },
    }},
  },
}
const VERDICT_SCHEMA = {
  type: "object", required: ["refuted", "evidence", "confidence"],
  properties: {
    refuted: { type: "boolean" },
    evidence: { type: "string" },
    confidence: { enum: ["high", "medium", "low"] },
  },
}
const REPORT_SCHEMA = {
  type: "object", required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { enum: ["PASS", "PASS_WITH_WARNINGS", "FAIL"] },
    summary: { type: "string" },
    findings: { type: "array", items: {
      type: "object", required: ["title", "severity", "location", "problem", "impact"],
      properties: {
        title: { type: "string" },
        severity: { enum: ["blocker", "major", "minor"] },
        dimension: { type: "string" },
        location: { type: "string" },
        problem: { type: "string" },
        impact: { type: "string" },
        suggestion: { type: "string" },
        confidence: { enum: ["high", "medium", "low"] },
      },
    }},
    blockers: { type: "array", items: { type: "string" } },
    openQuestions: { type: "array", items: { type: "string" } },
  },
}

// ─── Shared doc-input block (every agent that touches the docs gets this) ───
const DOCS_BLOCK =
  "### Document inputs (if a value is a file path, load it with the Read tool; otherwise treat it as literal text)\n" +
  "Spec: " + SPEC + "\n" +
  (PLAN ? "Plan: " + PLAN + "\n" : "Plan: (none provided)\n") +
  (RULES ? "Project rules: " + RULES + "\n" : "")

// ─── Phase 0: Scope ───
phase("Scope")
const scope = await agent(
  "## Spec/Plan Validation — Scope\n\n" +
  "You are validating a software spec" + (PLAN ? " and its implementation plan" : "") + ".\n\n" +
  DOCS_BLOCK + "\n" +
  "## Task\n" +
  "1. Load every input above (Read the paths). If a REQUIRED input cannot be loaded, set `readError` describing exactly which input and the error, and return.\n" +
  "2. Extract the structured content: title, requirements, acceptance criteria, the external dependencies the doc assumes, the plan steps (if a plan was given), and any out-of-scope / Must-NOT items.\n" +
  "3. Set `hasPlan` to whether a usable plan was found.\n" +
  "4. Give a 1-2 sentence overall read of how complete and coherent the spec+plan look.\n\nStructured output only.",
  { label: "scope", schema: SCOPE_SCHEMA }
)
if (!scope) {
  return { error: "Scope agent returned no result — could not read or decompose the spec/plan." }
}
if (scope.readError) {
  return { verdict: "ERROR", error: "Could not read inputs: " + scope.readError, spec: SPEC, plan: PLAN || null }
}
log("Validating: " + (scope.title || SPEC).toString().slice(0, 70))
log("Extracted " + (scope.requirements?.length || 0) + " reqs, " + (scope.acceptanceCriteria?.length || 0) + " ACs, " +
    (scope.externalDependencies?.length || 0) + " deps" + (scope.hasPlan ? ", plan present" : ", NO plan"))

const SCOPE_BLOCK =
  "### Extracted scope (from a prior pass — the source docs above are authoritative)\n" +
  "Title: " + (scope.title || "-") + "\n" +
  "Summary: " + scope.summary + "\n" +
  "Requirements: " + JSON.stringify((scope.requirements || []).slice(0, 30)) + "\n" +
  "Acceptance criteria: " + JSON.stringify((scope.acceptanceCriteria || []).slice(0, 30)) + "\n" +
  "Assumed external dependencies: " + JSON.stringify((scope.externalDependencies || []).slice(0, 30)) + "\n" +
  "Plan steps: " + JSON.stringify((scope.planSteps || []).slice(0, 40)) + "\n" +
  "Out of scope / Must-NOT: " + JSON.stringify((scope.outOfScope || []).slice(0, 20)) + "\n"

// ─── Phase 1: Review — one reviewer per dimension (barrier; pool must be assembled before ranking) ───
phase("Review")
const reviewed = (await parallel(
  DIMENSIONS.map(dim => () =>
    agent(
      "## Spec/Plan Reviewer — " + dim.label + "\n\n" +
      (dim.web ? "You MAY use WebSearch / WebFetch.\n\n" : "") +
      DOCS_BLOCK + "\n" + SCOPE_BLOCK + "\n" +
      "## Your dimension: " + dim.label + "\n" + dim.guide + "\n\n" +
      "## Output rules\n" +
      "Return ONLY real, specific findings for THIS dimension. For each finding give: a one-line title; severity " +
      "(blocker = ships broken / contract violation / data loss / unbuildable; major = likely defect or significant gap; " +
      "minor = clarity/polish); the exact location (which requirement / AC / plan step / section); the problem; the impact " +
      "(a concrete failure scenario, not 'this is bad'); and a concrete fix suggestion. " +
      (dim.web ? "Set needsWebCheck=true on findings that rest on an external-dependency claim. " : "") +
      "If the dimension is clean, return findings: []. Do NOT invent issues to fill space.\n\nStructured output only.",
      { label: "review:" + dim.key, phase: "Review", schema: FINDINGS_SCHEMA }
    ).then(r => (r && r.findings ? r.findings.map(f => ({ ...f, dimension: dim.key })) : []))
  )
)).filter(Boolean).flat()

// dedup near-identical findings (same dimension + location + title prefix)
const sevRank = { blocker: 0, major: 1, minor: 2 }
const fkey = f => (f.dimension + "|" + (f.location || "").toLowerCase().trim() + "|" + (f.title || "").toLowerCase().slice(0, 50))
const seen = new Set()
const deduped = []
let dupes = 0
for (const f of reviewed) {
  const k = fkey(f)
  if (seen.has(k)) { dupes++; continue }
  seen.add(k); deduped.push(f)
}

const ranked = [...deduped].sort((a, b) => sevRank[a.severity] - sevRank[b.severity])
const toVerify = ranked.slice(0, MAX_VERIFY_FINDINGS)
const overflow = ranked.slice(MAX_VERIFY_FINDINGS)
if (overflow.length) log("NOTE: " + overflow.length + " lower-severity finding(s) exceed the verify cap and were NOT verified (cap=" + MAX_VERIFY_FINDINGS + ")")
log("Review: " + reviewed.length + " raw → " + deduped.length + " unique (" + dupes + " dupes) → verifying " + toVerify.length)

// One stats shape for every return branch (early or final) so consumers get a
// consistent object regardless of which path fired.
const overflowList = overflow.map(f => ({ title: f.title, severity: f.severity }))
const buildStats = (o = {}) => {
  const verified = o.verified ?? 0
  return {
    dimensions: DIMENSIONS.length,
    rawFindings: reviewed.length,
    uniqueFindings: deduped.length,
    dupes,
    overflow: overflow.length,
    verified,
    confirmed: o.confirmed ?? 0,
    dropped: o.dropped ?? 0,
    agentCalls: 1 + DIMENSIONS.length + verified * VOTES_PER_FINDING + (o.synth ?? 0),
  }
}

if (toVerify.length === 0) {
  return {
    verdict: "PASS",
    summary: "No findings raised across " + DIMENSIONS.length + " validation dimensions. Spec" + (scope.hasPlan ? "/plan" : "") + " looks clean to this pass.",
    findings: [], droppedFindings: [], overflowNotVerified: overflowList,
    stats: buildStats(),
  }
}

// ─── Phase 2: Verify — 3-vote adversarial (try to REFUTE that each finding is a real defect) ───
phase("Verify")
const voted = (await parallel(
  toVerify.map(f => () =>
    parallel(
      Array.from({ length: VOTES_PER_FINDING }, (_, v) => () =>
        agent(
          "## Adversarial Finding Verifier (voter " + (v + 1) + "/" + VOTES_PER_FINDING + ")\n\n" +
          "A reviewer claims the spec/plan has the DEFECT below. Be skeptical and try to REFUTE it — show it is NOT a real defect " +
          "(misread, quoted out of context, already addressed elsewhere, out of scope, or a pedantic non-issue). " +
          "At least " + REFUTATIONS_REQUIRED + "/" + VOTES_PER_FINDING + " refutations drop it from the report.\n\n" +
          DOCS_BLOCK + "\n" +
          "### Finding under review\n" +
          "Dimension: " + f.dimension + "\nTitle: " + f.title + "\nSeverity: " + f.severity + "\n" +
          "Location: " + f.location + "\nProblem: " + f.problem + "\nImpact: " + f.impact + "\n\n" +
          "## Checklist\n" +
          "1. Re-read the cited location in the ACTUAL document (Read it). Is the problem really there, or did the reviewer misread?\n" +
          "2. Is it addressed elsewhere — another section, an AC, a stated assumption?\n" +
          "3. Is it genuinely in scope, or is the reviewer demanding something the spec explicitly excluded?\n" +
          (f.needsWebCheck
            ? "4. WebSearch/WebFetch to check the external-dependency claim. If the capability DOES exist and behaves as the doc assumed, the finding is refuted.\n"
            : "4. Is the severity inflated (a minor nit dressed as a blocker)? Note it but do not refute solely for that.\n") +
          "5. Is the finding specific and actionable, or vague hand-waving?\n\n" +
          "**refuted=true** if: not actually present / addressed elsewhere / out of scope / dependency actually fine / vague non-issue.\n" +
          "**refuted=false** if the defect is real, correctly located, in scope, and material.\n" +
          "When uncertain: for a `minor` finding default refuted=true (drop nits); for a `blocker`/`major` finding default refuted=false " +
          "and mark confidence=low (we would rather surface a possible blocker than hide it).\n\n" +
          "Structured output only. Evidence MUST cite the document (or the web source for dependency checks).",
          { label: "v" + v + ":" + (f.title || "").slice(0, 32), phase: "Verify", schema: VERDICT_SCHEMA }
        )
      )
    ).then(verdicts => {
      const valid = verdicts.filter(Boolean)
      const refuted = valid.filter(v => v.refuted).length
      const abstained = VOTES_PER_FINDING - valid.length
      // Survive (= real defect, keep in report) only if adjudicated by a quorum
      // AND refutations stayed below threshold. All-abstain must NOT auto-survive.
      const survives = valid.length >= REFUTATIONS_REQUIRED && refuted < REFUTATIONS_REQUIRED
      log("\"" + (f.title || "").slice(0, 46) + "\": kept " + (valid.length - refuted) + " / refuted " + refuted +
          (abstained ? " (" + abstained + " abstain)" : "") + " " + (survives ? "✓ defect" : "✗ dropped"))
      return { ...f, verdicts: valid, refutedVotes: refuted, survives }
    })
  )
)).filter(Boolean)

const confirmed = voted.filter(f => f.survives)
const dropped = voted.filter(f => !f.survives)
log("Verify done: " + voted.length + " findings → " + confirmed.length + " confirmed defects, " + dropped.length + " dropped")

const hasBlockerMajor = confirmed.some(f => f.severity === "blocker" || f.severity === "major")
const fallbackVerdict = confirmed.length === 0 ? "PASS" : (hasBlockerMajor ? "FAIL" : "PASS_WITH_WARNINGS")

if (confirmed.length === 0) {
  return {
    verdict: "PASS",
    summary: "All " + voted.length + " candidate findings were refuted by 3-vote adversarial verification. Spec" + (scope.hasPlan ? "/plan" : "") + " passes.",
    findings: [],
    droppedFindings: dropped.map(f => ({ title: f.title, severity: f.severity, vote: (f.verdicts.length - f.refutedVotes) + "-" + f.refutedVotes })),
    overflowNotVerified: overflowList,
    stats: buildStats({ verified: voted.length, dropped: dropped.length }),
  }
}

// ─── Phase 3: Synthesize — merge dupes, severity-rank, verdict ───
phase("Synthesize")
const block = confirmed.map((f, i) =>
  "### [" + i + "] (" + f.severity + " · " + f.dimension + ") " + f.title + "\n" +
  "Vote: " + (f.verdicts.length - f.refutedVotes) + "-" + f.refutedVotes + " · Location: " + f.location + "\n" +
  "Problem: " + f.problem + "\nImpact: " + f.impact + (f.suggestion ? "\nSuggested fix: " + f.suggestion : "") + "\n"
).join("\n")

const report = await agent(
  "## Synthesis: spec/plan validation verdict\n\n" +
  "**Validating:** " + (scope.title || SPEC).toString().slice(0, 100) + "\n\n" +
  confirmed.length + " findings survived " + VOTES_PER_FINDING + "-vote adversarial verification. Produce the final verdict.\n\n" +
  "## Confirmed findings\n" + block + "\n\n" +
  "## Instructions\n" +
  "1. Merge findings that describe the same underlying defect; combine their locations.\n" +
  "2. For each final finding keep: title, severity, dimension, location, problem, impact, suggestion, and a confidence (high/medium/low based on vote margin and evidence strength).\n" +
  "3. Assign the overall verdict: FAIL if any confirmed blocker or major remains; PASS_WITH_WARNINGS if only minors remain; PASS if none.\n" +
  "4. Write a 2-4 sentence executive summary: is this spec/plan safe to build from, and the top reason if not.\n" +
  "5. List the blocker/major titles in `blockers`.\n" +
  "6. List 1-4 open questions the author should resolve.\n\nStructured output only.",
  { label: "synthesize", schema: REPORT_SCHEMA }
)

if (!report) {
  // Synthesis skipped/errored — salvage confirmed findings raw rather than discarding the run.
  return {
    verdict: fallbackVerdict,
    summary: "Synthesis step was skipped or failed — returning " + confirmed.length + " verified findings unmerged.",
    findings: confirmed.map(f => ({ title: f.title, severity: f.severity, dimension: f.dimension, location: f.location, problem: f.problem, impact: f.impact, suggestion: f.suggestion, vote: (f.verdicts.length - f.refutedVotes) + "-" + f.refutedVotes })),
    droppedFindings: dropped.map(f => ({ title: f.title, severity: f.severity })),
    overflowNotVerified: overflowList,
    stats: buildStats({ verified: voted.length, confirmed: confirmed.length, dropped: dropped.length, synth: 1 }),
  }
}

return {
  verdict: report.verdict || fallbackVerdict,
  ...report,
  droppedFindings: dropped.map(f => ({ title: f.title, severity: f.severity, vote: (f.verdicts.length - f.refutedVotes) + "-" + f.refutedVotes })),
  overflowNotVerified: overflowList,
  stats: buildStats({ verified: voted.length, confirmed: confirmed.length, dropped: dropped.length, synth: 1 }),
}
