// Partner Returns RELEASE SCAN (design v2 §10.1 T1.11b, §8.5 #2 and #3). Expected RED until the parked
// agreement work and Gemini's screen work have landed; the release checklist runs it (with
// src/test/partnerRateRelease.test.ts) before the release migration sets release_ready:
//
//   deno test --allow-read supabase/functions/_shared/releaseScan_test.ts
//
// Reads files only. Each check lists every offending file:line so the failure says what is left to do.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, ROOT));

// ---- §8.5 #2: agreements (parked work) state no fixed 15% and never fall back to it -----------------------
const AGREEMENT_FILES = [
  "src/components/supporter/agreement/AgreementContent.ts",
  "src/components/partner/agreementTemplate.ts",
  "src/components/partner/partnerAgreementTemplate.html",
  "supabase/functions/generate-partner-agreement/index.ts",
  "supabase/functions/resend-partner-agreement-email/index.ts",
  "supabase/functions/send-partner-agreement-with-pdf/index.ts",
  "supabase/functions/_shared/transactional-email-templates/tenant-partnership-agreement.tsx",
  "supabase/functions/_shared/partnerContractPdf.ts",
];

/** A fixed 15% Returns rate: "15%", "fifteen per cent", 0.15, 15/100, or a 15 fallback. */
const FIXED_15 = /\b15\s*%|fifteen\s+per\s*cent|\b0?\.15\b|\b15\s*\/\s*100\b|(?:\?\?|\|\|)\s*['"]?15\b/i;

/** Lines that state nothing to a reader: comments and console logging. Template preview samples
 *  (`X.PreviewProps = { … }`, `previewData: { … }`) are fixtures for the email preview tool, not
 *  text sent to anyone. */
const braceDelta = (s: string) => (s.match(/{/g)?.length ?? 0) - (s.match(/}/g)?.length ?? 0);
function offendingLines(rel: string, text: string): string[] {
  const out: string[] = [];
  let previewDepth = 0;
  let inBlockComment = false;
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (previewDepth > 0) {
      previewDepth += braceDelta(t);
      return;
    }
    if (/\.PreviewProps\s*=|\bpreviewData\s*:/.test(t)) {
      previewDepth = Math.max(0, braceDelta(t));
      return;
    }
    if (inBlockComment) {
      if (t.includes("*/") || t.includes("-->")) inBlockComment = false;
      return;
    }
    if (t.startsWith("/*") || t.startsWith("<!--")) {
      if (!t.includes("*/") && !t.includes("-->")) inBlockComment = true;
      return;
    }
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("console.")) return;
    if (FIXED_15.test(line)) out.push(`${rel}:${i + 1}: ${t.slice(0, 140)}`);
  });
  return out;
}

Deno.test("T1.11b agreements state no fixed 15% and have no 15% fallback (§8.5 #2)", () => {
  const offenders = AGREEMENT_FILES.flatMap((rel) => offendingLines(rel, read(rel)));
  assertEquals(offenders, []);
});

// ---- §8.5 #3: the deprecated hard-coded-15% src/lib exports have no importer -----------------------------
const DEPRECATED: Record<string, string[]> = {
  funderEarnings: ["FUNDER_MONTHLY_RATE", "calcFunderEarnings", "sumFunderEarnings"],
  planShareLink: ["SHARE_ROI_RATE", "planShareDescription"],
  houseSupportShare: ["HOUSE_SHARE_ROI_RATE", "houseMonthlyReturn", "houseShareMessage"],
  supportPlanExample: [
    "EXAMPLE_MONTHLY_RATE",
    "EXAMPLE_MONTHLY_RETURN",
    "EXAMPLE_TWELVE_MONTH_TOTAL",
    "SUPPORT_EXAMPLE_STEPS",
    "exampleMonthlyReturn",
    "buildSupportPlanExampleLine",
  ],
  // The rent-facilitation reward (PayLandlordDialog, RentCategoryFeed, MyWatchlist): use
  // calculateSupporterRewardAt / sumSupporterRewardsAt with the person's own rate.
  rentCalculations: ["calculateSupporterReward"],
};

function walk(dirRel: string, out: string[] = []): string[] {
  for (const e of Deno.readDirSync(new URL(dirRel, ROOT))) {
    const rel = `${dirRel}${e.name}`;
    if (e.isDirectory) {
      if (["node_modules", "__tests__", "__snapshots__", "tests"].includes(e.name)) continue;
      walk(`${rel}/`, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/[._-](test|spec)\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) {
      out.push(rel);
    }
  }
  return out;
}

Deno.test("T1.11b the deprecated hard-coded-15% src/lib exports have no importer (§8.5 #3)", () => {
  const offenders: string[] = [];
  for (const rel of [...walk("src/"), ...walk("supabase/functions/")]) {
    const text = read(rel);
    for (const [mod, names] of Object.entries(DEPRECATED)) {
      if (rel === `src/lib/${mod}.ts`) continue;
      if (!text.includes(mod)) continue; // fast path (the generated types file is ~100k lines)
      // Named imports and re-exports (with or without a default import before the braces).
      const named = new RegExp(
        `(?:import|export)\\s+(?:type\\s+)?(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*['"][^'"]*\\b${mod}['"]`,
        "g",
      );
      let m: RegExpExecArray | null;
      while ((m = named.exec(text))) {
        for (const n of m[1].split(",").map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0])) {
          if (names.includes(n)) offenders.push(`${rel}: ${n}`);
        }
      }
      // A namespace import reaches every deprecated export.
      const ns = new RegExp(`import\\s+\\*\\s+as\\s+\\w+\\s+from\\s*['"][^'"]*\\b${mod}['"]`);
      if (ns.test(text)) offenders.push(`${rel}: * as (namespace import of ${mod})`);
    }
  }
  assertEquals(offenders, []);
});
