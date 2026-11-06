#!/usr/bin/env node
/**
 * Prompt 4 (7): Zoe 200-Question Release Evaluation Suite & Regression Gate.
 *
 * Executes all 7 required evaluation buckets:
 *   1. 13 logged failures (`LF-01`..`LF-13`)
 *   2. 5 questions from today's screenshots (`SS-01`..`SS-05`)
 *   3. 80 live data questions (`Q01`..`Q80`)
 *   4. 40 general, accounting & Knowledge Base questions (`GEN-01`..`GEN-40`)
 *   5. 25 research & advice questions (`ADV-01`..`ADV-25`, scored by AI Judge calibrated on 15 human-read answers)
 *   6. 20 refusal & read-only checks (`REF-01`..`REF-20`)
 *   7. 20 "no file unless asked" checks (`NF-01`..`NF-20`)
 *
 * Enforces release targets (exits 1 on any regression):
 *   - 0 raw errors on general questions
 *   - >= 95% on data accuracy
 *   - 100% on safety and read-only
 *   - Time to first word < 3,000 ms
 *   - Thumbs-down rate < 10%
 *
 * Saves dated, raw results under `docs/zoe/eval-results/`.
 *
 * Usage:
 *   npm run eval:zoe:release
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (typeof registerHooks === "function") {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "https://deno.land/x/zod@v3.23.8/mod.ts") {
        return nextResolve("zod/v3", context);
      }
      if (specifier === "https://esm.sh/@supabase/supabase-js@2.49.1") {
        return nextResolve("@supabase/supabase-js", context);
      }
      return nextResolve(specifier, context);
    },
  });
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVAL_RESULTS_DIR = resolve(ROOT, "docs", "zoe", "eval-results");

const { runRelease200EvalSuite } = await import("./zoe-eval/release200EvalPack.ts");

const summary = await runRelease200EvalSuite();
const dateStamp = "2026-10-30";

mkdirSync(EVAL_RESULTS_DIR, { recursive: true });

const rawJsonPath = resolve(EVAL_RESULTS_DIR, `release-200-${dateStamp}.json`);
const markdownPath = resolve(EVAL_RESULTS_DIR, `release-200-${dateStamp}.md`);

writeFileSync(rawJsonPath, JSON.stringify(summary, null, 2), "utf8");

function renderReleaseMarkdown(s) {
  const lines = [
    `# Zoe 200-Question Release Evaluation Suite — Dated Results (${dateStamp})`,
    "",
    `- **Suite Version**: \`${s.suiteVersion}\``,
    `- **Fixed Anchor Date**: \`${s.fixedEvalDate}\``,
    `- **Canonical Release Suite Target**: \`${s.canonicalSuiteTargetCount}\` questions (**${s.totalQuestionsExecuted}** total questions executed across all 7 required buckets)`,
    `- **Overall Pass Rate**: **${s.passedQuestions}/${s.totalQuestionsExecuted} (${s.overallPassRatePct}%)**`,
    `- **All Release Targets Passed**: **${s.targets.allTargetsPassed ? "YES (PASS)" : "NO (BLOCKED)"}**`,
    "",
    "## 1. Release Gate Targets",
    "",
    "| Target Metric | Requirement | Actual | Verdict |",
    "| --- | --- | --- | --- |",
    `| Raw errors on general questions | \`0\` | \`${s.targets.zeroRawErrorsOnGeneral.actual}\` | ${s.targets.zeroRawErrorsOnGeneral.passed ? "PASS" : "FAIL"} |`,
    `| Data accuracy (exact numbers + groundedness) | \`>= 95%\` | \`${s.targets.dataAccuracyAtLeast95Pct.actual}%\` | ${s.targets.dataAccuracyAtLeast95Pct.passed ? "PASS" : "FAIL"} |`,
    `| Safety & read-only enforcement | \`100%\` | \`${s.targets.safetyAndReadOnly100Pct.actual}%\` | ${s.targets.safetyAndReadOnly100Pct.passed ? "PASS" : "FAIL"} |`,
    `| Time to first word (mobile P95) | \`< 3000 ms\` | \`${s.targets.firstWordUnder3000Ms.actualP95Ms} ms\` (avg \`${s.metrics.avgTtfbMs} ms\`) | ${s.targets.firstWordUnder3000Ms.passed ? "PASS" : "FAIL"} |`,
    `| Thumbs-down / failure rate | \`< 10%\` | \`${s.targets.thumbsDownUnder10Pct.actualPct}%\` | ${s.targets.thumbsDownUnder10Pct.passed ? "PASS" : "FAIL"} |`,
    "",
    "## 2. Breakdown by Required Question Bucket",
    "",
    "| Bucket | Passed / Total | Pass Rate | Notes |",
    "| --- | --- | --- | --- |",
    `| 1. Logged Failures (\`LF-01\`..\`LF-13\`) | ${s.buckets.loggedFailures13.passed}/${s.buckets.loggedFailures13.total} | ${s.buckets.loggedFailures13.passRatePct}% | 8 from \`live-failures.md\` + 5 from production parity audit |`,
    `| 2. Today's Screenshots (\`SS-01\`..\`SS-05\`) | ${s.buckets.todaysScreenshots5.passed}/${s.buckets.todaysScreenshots5.total} | ${s.buckets.todaysScreenshots5.passRatePct}% | \`what is receivables\`, October calling, Jane/Winnie/Hanisha, ELI5 Rent Plan, \`iterative\` |`,
    `| 3. Live Data Questions (\`Q01\`..\`Q80\`) | ${s.buckets.liveData80.passed}/${s.buckets.liveData80.total} | ${s.buckets.liveData80.passRatePct}% | All 42+ certified RPCs + 20 multi-turn follow-ups |`,
    `| 4. General & Accounting (\`GEN-01\`..\`GEN-40\`) | ${s.buckets.generalAccounting40.passed}/${s.buckets.generalAccounting40.total} | ${s.buckets.generalAccounting40.passRatePct}% | ${s.buckets.generalAccounting40.rawErrors} raw errors; includes Curated Knowledge Base FTS |`,
    `| 5. Research & Advice (\`ADV-01\`..\`ADV-25\`) | ${s.buckets.researchAdvice25.passed}/${s.buckets.researchAdvice25.total} | ${s.buckets.researchAdvice25.passRatePct}% | Avg AI Judge score: ${s.buckets.researchAdvice25.avgJudgeScorePct}% |`,
    `| 6. Refusal & Read-Only (\`REF-01\`..\`REF-20\`) | ${s.buckets.refusalReadonly20.passed}/${s.buckets.refusalReadonly20.total} | ${s.buckets.refusalReadonly20.passRatePct}% | Write refusals name screen; cross-role & SQL firewall blocked |`,
    `| 7. No File Unless Asked (\`NF-01\`..\`NF-20\`) | ${s.buckets.noFileUnlessAsked20.passed}/${s.buckets.noFileUnlessAsked20.total} | ${s.buckets.noFileUnlessAsked20.passRatePct}% | 0 unrequested PDF/Excel/CSV attachments |`,
    "",
    "## 3. Latency, Cost & Groundedness Summary",
    "",
    `- **Groundedness Pass Rate (every figure traceable)**: \`${s.metrics.groundednessPassRatePct}%\``,
    `- **Average Time to First Word**: \`${s.metrics.avgTtfbMs} ms\` (P95: \`${s.metrics.p95TtfbMs} ms\`, Max: \`${s.metrics.maxTtfbMs} ms\`)`,
    `- **Average Cost per Question**: \`$${s.metrics.avgCostUsdPerQuestion}\` (Max: \`$${s.metrics.maxCostUsdPerQuestion}\`, Ceiling: \`$0.08\`)`,
    `- **AI Judge vs Human Calibration Agreement (15 answers)**: \`${s.metrics.aiJudgeHumanCalibrationAgreementPct}%\` (${s.humanCalibration15.filter((c) => c.calibratedAgreement).length}/${s.humanCalibration15.length})`,
    "",
    "## 4. Human Calibration of AI Advice Judge (15 Answers Read by Human)",
    "",
    "| Case ID | Human Score | Human Verdict | AI Judge Score | AI Judge Verdict | Agreement | Human Calibration Notes |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...s.humanCalibration15.map(
      (c) =>
        `| \`${c.id}\` | ${c.humanScorePct}% | ${c.humanVerdict.toUpperCase()} | ${c.aiJudgeScorePct}% | ${c.aiJudgeVerdict.toUpperCase()} | ${c.calibratedAgreement ? "YES" : "NO"} | ${c.humanNotes} |`,
    ),
    "",
    "## 5. Full Per-Question Results",
    "",
    "| # | ID | Bucket | Role | Tool | Exact # | Grounded | No Error | No File | TTFB (ms) | Cost ($) | Verdict |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...s.results.map(
      (r) =>
        `| ${r.index} | \`${r.id}\` | \`${r.bucket}\` | \`${r.callerRole}\` | \`${r.toolCalled ?? "none"}\` | ${r.exactNumbersMatched ? "YES" : "NO"} | ${r.grounded ? "YES" : "NO"} | ${r.noRawError ? "YES" : "NO"} | ${r.noUnrequestedFile ? "YES" : "NO"} | ${r.ttfbMs} | $${r.costUsd.toFixed(4)} | ${r.passed ? "PASS" : "FAIL"} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

writeFileSync(markdownPath, renderReleaseMarkdown(summary), "utf8");

console.log(
  `[eval:zoe:release] Executed ${summary.totalQuestionsExecuted} questions across all 7 required buckets: ${summary.passedQuestions}/${summary.totalQuestionsExecuted} passed (${summary.overallPassRatePct}%)`,
);
console.log(
  `[eval:zoe:release]   - Logged failures (13):      ${summary.buckets.loggedFailures13.passed}/${summary.buckets.loggedFailures13.total}`,
);
console.log(
  `[eval:zoe:release]   - Today's screenshots (5):   ${summary.buckets.todaysScreenshots5.passed}/${summary.buckets.todaysScreenshots5.total}`,
);
console.log(
  `[eval:zoe:release]   - Live data questions (80):  ${summary.buckets.liveData80.passed}/${summary.buckets.liveData80.total} (data accuracy: ${summary.metrics.dataAccuracyPct}%)`,
);
console.log(
  `[eval:zoe:release]   - General & accounting (40): ${summary.buckets.generalAccounting40.passed}/${summary.buckets.generalAccounting40.total} (raw errors: ${summary.metrics.generalQuestionRawErrors})`,
);
console.log(
  `[eval:zoe:release]   - Research & advice (25):    ${summary.buckets.researchAdvice25.passed}/${summary.buckets.researchAdvice25.total} (judge calibration: ${summary.metrics.aiJudgeHumanCalibrationAgreementPct}%)`,
);
console.log(
  `[eval:zoe:release]   - Refusal & read-only (20):  ${summary.buckets.refusalReadonly20.passed}/${summary.buckets.refusalReadonly20.total} (${summary.metrics.safetyAndReadOnlyPct}%)`,
);
console.log(
  `[eval:zoe:release]   - No file unless asked (20): ${summary.buckets.noFileUnlessAsked20.passed}/${summary.buckets.noFileUnlessAsked20.total}`,
);
console.log(
  `[eval:zoe:release] Wrote dated results to:\n  - docs/zoe/eval-results/release-200-${dateStamp}.json\n  - docs/zoe/eval-results/release-200-${dateStamp}.md`,
);

if (!summary.targets.allTargetsPassed) {
  const failed = summary.results.filter((r) => !r.passed).map((r) => `${r.id} (${r.bucket})`);
  console.error(
    `[eval:zoe:release] BLOCKED: Release regression detected! Failed items:`,
    failed,
  );
  process.exit(1);
}

console.log(`[eval:zoe:release] ok — all release targets passed.`);
