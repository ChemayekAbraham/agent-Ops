// Consultant mode (Prompt 4 item 1, 2, 3, 5):
//   - Triggered when a staff member asks for advice, a plan review, "why",
//     "what should we do", or "way forward".
//   - Uses the deep model (`ZOE_MODEL_DEEP`), NO write tools, NO export/action draft tools.
//   - Can use certified lookups (`assistant_staff_*`), the Analyst lane (`get_data_catalog`,
//     `run_analyst_query`), the Welile glossary (`get_welile_glossary`), `get_staff_manual_help`,
//     `compute`, and `ask_clarification`.
//   - Optional web research (`search_web`, `read_web_page`) is available ONLY in the
//     Consultant path when `staff_assistant_config.web_research_enabled === true`, and
//     every query is deterministically checked (`validateConsultantWebQuery`) so Welile
//     names, phone numbers, emails, and Welile figures are never sent to an external search.

import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";
import { kampalaToday } from "./dates.ts";
import { sanitizeWelileTermsServer } from "./emailDraft.ts";
import type { OpenAiTool } from "./openai.ts";

const BANNED_REGULATORY_TERMS_RE = /\b(loans?|lenders?|roi|interest)\b/i;

/**
 * Tools that MUST NEVER be exposed or executed in the Consultant path.
 * Consultant mode produces structured advice text for a human — never writes,
 * never creates action drafts, and never exports files.
 */
export const CONSULTANT_FORBIDDEN_TOOLS = new Set<string>([
  "draft_report_email",
  "draft_reminder",
  "draft_staff_notification",
  "draft_report_schedule",
  "draft_welile_idea",
]);

export const WEB_RESEARCH_TOOL_NAMES = new Set<string>([
  "search_web",
  "read_web_page",
]);

export const SEARCH_WEB_OPENAI_TOOL: OpenAiTool = {
  type: "function",
  function: {
    name: "search_web",
    description:
      "[Consultant mode only — Outside source] Search public web sources for generic external context (e.g. Uganda inflation, mobile money fees, housing or school calendar context). NEVER include Welile client names, staff names, phone numbers, emails, or Welile UGX figures in the query. Cite every outside fact with its link and date, label it 'Outside source', and never mix it with Welile figures in totals.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Generic public search query (no Welile names, no phone numbers, no emails, no internal Welile figures).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

export const SearchWebArgsSchema = z
  .object({
    query: z.string().trim().min(3).max(200),
  })
  .strict();

export const READ_WEB_PAGE_OPENAI_TOOL: OpenAiTool = {
  type: "function",
  function: {
    name: "read_web_page",
    description:
      "[Consultant mode only — Outside source] Read a public HTTPS web page returned by search_web to verify an outside fact, its date, and its source link. Cite every outside fact with its link and date, label it 'Outside source', and never mix it with Welile figures in totals.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Public https:// URL to read.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
};

export const ReadWebPageArgsSchema = z
  .object({
    url: z.string().trim().min(10).max(500),
  })
  .strict();

/**
 * Determines whether a staff message should route through the Consultant mode path:
 *   - Advice, options, recommendations, or trade-offs
 *   - Plan review ("review this plan", "review our plan", "critique our plan")
 *   - Diagnostic "why" questions ("why did...", "why is...", "why are...")
 *   - Action planning ("what should we do", "way forward", "how should we tackle/improve")
 *
 * Excludes explicit draft/action commands ("send an email", "set a reminder", "notify",
 * "schedule this report") and pure UI navigation "how do I click/find" lookups.
 */
export function isConsultantQuestion(userMessage: string): boolean {
  const s = (userMessage ?? "").trim();
  if (!s || s.length < 8) return false;

  // Never route explicit draft/action or file export commands to Consultant mode
  if (
    /\b(send\s+(?:an?\s+)?email|email\s+this\s+to|set\s+a\s+reminder|remind\s+me\s+to|send\s+(?:a\s+)?notification|notify\s+[a-z]+|schedule\s+(?:this|a)\s+report|save\s+this\s+as\s+an?\s+idea)\b/i.test(
      s,
    )
  ) {
    return false;
  }

  // Pure "how do I click / where is the button" UI manual lookups stay in normal mode
  if (
    /\b(where\s+(?:do\s+i\s+find|is\s+the\s+button|is\s+the\s+tab)|how\s+do\s+i\s+(?:log\s+in|reset|open|click|navigate|submit\s+a\s+requisition))\b/i.test(
      s,
    ) &&
    !/\b(advice|way\s+forward|what\s+should\s+we\s+do|options|trade-?offs|recommend)\b/i.test(s)
  ) {
    return false;
  }

  return (
    /\b(what\s+should\s+we\s+do|way\s+forward|give\s+(?:me\s+|us\s+)?advice|advise(?:\s+(?:me|us|on))?|as\s+a\s+consultant|consultant\s+view)\b/i.test(
      s,
    ) ||
    /\b(review\s+(?:this|my|our)\s+(?:plan|proposal|target|strategy|rollout|budget|payroll|queue|position|distribution)|plan\s+review|critique\s+(?:this|our)\s+plan)\b/i.test(
      s,
    ) ||
    /\b(what\s+are\s+(?:our|the)\s+options|options\s+and\s+trade-?offs|recommend(?:ation|ations)?\s+(?:for|on|to)|how\s+(?:should|can|could)\s+we\s+(?:improve|reduce|increase|fix|tackle|address|prioriti[sz]e|prepare|handle|manage))\b/i.test(
      s,
    ) ||
    /\bwhy\s+(?:is|are|did|has|have|do|does)\b[\s\S]{6,}/i.test(s)
  );
}

/**
 * Filters the role-authorized OpenAI tool list for the Consultant path:
 *   - Strips all write/action/draft tools (`CONSULTANT_FORBIDDEN_TOOLS`)
 *   - Adds `search_web` and `read_web_page` ONLY when `webResearchEnabled === true`
 */
export function filterToolsForConsultantMode(
  tools: readonly OpenAiTool[],
  webResearchEnabled: boolean,
): OpenAiTool[] {
  const filtered = tools.filter(
    (t) =>
      !CONSULTANT_FORBIDDEN_TOOLS.has(t.function.name) &&
      !WEB_RESEARCH_TOOL_NAMES.has(t.function.name),
  );
  if (webResearchEnabled) {
    return [...filtered, SEARCH_WEB_OPENAI_TOOL, READ_WEB_PAGE_OPENAI_TOOL];
  }
  return filtered;
}

const PHONE_RE = /(?:\+?256|0)\s*[732]\d[\d\s-]{6,11}|\b\d{9,14}\b/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const NIN_RE = /\bC[MF][A-Z0-9]{12}\b/i;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const UGX_AMOUNT_RE = /\bUGX\s*[\d,]+(?:\.\d+)?\b/i;
const INTERNAL_NAME_KEYS = new Set([
  "full_name",
  "name",
  "staff_name",
  "tenant_name",
  "landlord_name",
  "agent_name",
  "supporter_name",
  "partner_name",
  "caller_name",
  "created_by_name",
  "recipient_name",
  "phone",
  "phone_number",
  "tenant_phone",
  "landlord_phone",
  "agent_phone",
  "email",
]);

function extractProtectedValuesFromToolOutputs(rawToolOutputs: readonly string[]): {
  names: Set<string>;
  numbers: Set<string>;
} {
  const names = new Set<string>();
  const numbers = new Set<string>();

  const walkValue = (val: unknown, keyHint = ""): void => {
    if (val === null || val === undefined) return;
    if (typeof val === "number" && Number.isFinite(val)) {
      const abs = Math.abs(val);
      // Protect non-trivial Welile figures (>= 100, excluding years 2020..2035)
      if (abs >= 100 && !(Number.isInteger(abs) && abs >= 2020 && abs <= 2035)) {
        numbers.add(String(Math.round(abs)));
        numbers.add(Math.round(abs).toLocaleString("en-US"));
      }
      return;
    }
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (!trimmed) return;
      if (INTERNAL_NAME_KEYS.has(keyHint.toLowerCase())) {
        // Add full string and multi-character person name parts (>= 4 chars)
        if (trimmed.length >= 3) {
          names.add(trimmed.toLowerCase());
        }
        for (const part of trimmed.split(/\s+/)) {
          const cleanPart = part.replace(/[^a-zA-Z'-]/g, "").toLowerCase();
          if (cleanPart.length >= 4 && !/^(welile|staff|agent|tenant|landlord|admin|user)$/.test(cleanPart)) {
            names.add(cleanPart);
          }
        }
      }
      return;
    }
    if (Array.isArray(val)) {
      for (const item of val) walkValue(item, keyHint);
      return;
    }
    if (typeof val === "object") {
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        walkValue(v, k);
      }
    }
  };

  for (const raw of rawToolOutputs) {
    try {
      const parsed = JSON.parse(raw);
      walkValue(parsed);
    } catch {
      // Also scan raw text for UGX numbers
      for (const m of raw.matchAll(/\b\d[\d,]{2,}\b/g)) {
        const cleanDigits = m[0].replace(/,/g, "");
        const n = Number(cleanDigits);
        if (Number.isFinite(n) && n >= 100 && !(n >= 2020 && n <= 2035)) {
          numbers.add(cleanDigits);
          numbers.add(m[0]);
        }
      }
    }
  }

  return { names, numbers };
}

/**
 * Deterministic safety gate for Prompt 4 item (3):
 *   "Queries must be generic: never include Welile client names, staff names,
 *    phone numbers or Welile figures; enforce this with a check that rejects
 *    any query containing values from the tool results."
 */
export function validateConsultantWebQuery(
  query: string,
  rawToolOutputs: readonly string[] = [],
):
  | { ok: true; cleanedQuery: string }
  | { ok: false; reason: string; detail: string } {
  const cleaned = (query ?? "").replace(/\s+/g, " ").trim();
  if (cleaned.length < 3 || cleaned.length > 200) {
    return {
      ok: false,
      reason: "invalid_length",
      detail: "Web research query must be between 3 and 200 characters.",
    };
  }

  if (PHONE_RE.test(cleaned)) {
    return {
      ok: false,
      reason: "contains_phone",
      detail: "Web research query must never include a phone number.",
    };
  }

  if (EMAIL_RE.test(cleaned)) {
    return {
      ok: false,
      reason: "contains_email",
      detail: "Web research query must never include an email address.",
    };
  }

  if (NIN_RE.test(cleaned) || UUID_RE.test(cleaned)) {
    return {
      ok: false,
      reason: "contains_identifier",
      detail: "Web research query must never include a national ID or record UUID.",
    };
  }

  if (UGX_AMOUNT_RE.test(cleaned)) {
    return {
      ok: false,
      reason: "contains_ugx_figure",
      detail: "Web research query must never include Welile UGX figures.",
    };
  }

  if (/\bwelile/i.test(cleaned)) {
    return {
      ok: false,
      reason: "contains_internal_brand",
      detail: "Web research queries must be generic external queries and must not include internal Welile identifiers.",
    };
  }

  // Known staff first/full names that must never leak to web search
  if (
    /\b(janehephzibar|gimono|hanishah|kawuki|winfred|asiimwe|bwayo|namubiru|mugisha|nakato|wasswa|kato|babirye|okello|opio|mukasa|ssemakula|tumusiime|byaruhanga)\b/i.test(
      cleaned,
    )
  ) {
    return {
      ok: false,
      reason: "contains_person_name",
      detail: "Web research query must never include Welile staff or client names.",
    };
  }

  const { names, numbers } = extractProtectedValuesFromToolOutputs(rawToolOutputs);
  const lowerQuery = cleaned.toLowerCase();

  for (const name of names) {
    if (!name || name.length < 3) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    if (re.test(lowerQuery)) {
      return {
        ok: false,
        reason: "contains_tool_result_name",
        detail: `Web research query rejected because it contains a name ("${name}") from Welile tool results.`,
      };
    }
  }

  const queryNumbers = [...cleaned.matchAll(/\b\d[\d,]*(?:\.\d+)?\b/g)].map((m) =>
    m[0].replace(/,/g, ""),
  );
  for (const qNum of queryNumbers) {
    const n = Number(qNum);
    if (Number.isFinite(n) && n >= 2020 && n <= 2035) continue;
    if (numbers.has(qNum) || (Number.isFinite(n) && n >= 10_000)) {
      return {
        ok: false,
        reason: "contains_tool_result_figure",
        detail: `Web research query rejected because it contains a numeric figure ("${qNum}") from Welile tool results.`,
      };
    }
  }

  return { ok: true, cleanedQuery: cleaned };
}

/**
 * Validates that a URL passed to `read_web_page` is a public `https://` URL
 * and does not point to private/loopback networks or leak internal parameters.
 */
export function validateConsultantWebUrl(
  rawUrl: string,
  rawToolOutputs: readonly string[] = [],
):
  | { ok: true; url: string; hostname: string }
  | { ok: false; reason: string; detail: string } {
  let parsed: URL;
  try {
    parsed = new URL((rawUrl ?? "").trim());
  } catch {
    return {
      ok: false,
      reason: "invalid_url",
      detail: "URL must be a valid https:// address.",
    };
  }

  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: "non_https",
      detail: "Only public https:// URLs are allowed in read_web_page.",
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.includes("supabase.co") ||
    host.includes("welilereceipts") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  ) {
    return {
      ok: false,
      reason: "private_or_internal_host",
      detail: "read_web_page may only access public external domains.",
    };
  }

  // Also ensure the URL query string does not leak tool values or PII
  if (parsed.search && parsed.search.length > 1) {
    const queryCheck = validateConsultantWebQuery(
      decodeURIComponent(parsed.search.slice(1)),
      rawToolOutputs,
    );
    if (!queryCheck.ok) {
      return {
        ok: false,
        reason: queryCheck.reason,
        detail: `URL query parameters rejected: ${queryCheck.detail}`,
      };
    }
  }

  return { ok: true, url: parsed.toString(), hostname: host };
}

export interface OutsideWebFact {
  label: "Outside source";
  title: string;
  snippet: string;
  url: string;
  accessed_date: string;
}

export interface WebSearchResultPayload {
  source: string;
  period: string;
  outside_source: true;
  label: "Outside source";
  query: string;
  accessed_date: string;
  warning: string;
  results: OutsideWebFact[];
}

/**
 * Executes a generic external web search for Consultant mode when `web_research_enabled` is true.
 * Accepts an optional `fetcher` for deterministic testing.
 */
export async function executeConsultantWebSearch(
  query: string,
  rawToolOutputs: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<
  | { ok: true; payload: WebSearchResultPayload }
  | { ok: false; reason: string; error: string }
> {
  const check = validateConsultantWebQuery(query, rawToolOutputs);
  if (!check.ok) {
    return {
      ok: false,
      reason: check.reason,
      error: check.detail,
    };
  }

  const today = kampalaToday();
  const results: OutsideWebFact[] = [];

  try {
    const endpoint = `https://api.duckduckgo.com/?q=${encodeURIComponent(
      check.cleanedQuery,
    )}&format=json&no_redirect=1&no_html=1`;
    const res = await fetcher(endpoint, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      const json = (await res.json()) as Record<string, unknown>;
      const abstractText =
        typeof json.AbstractText === "string" ? json.AbstractText.trim() : "";
      const abstractUrl =
        typeof json.AbstractURL === "string" && json.AbstractURL.startsWith("https://")
          ? json.AbstractURL.trim()
          : "";
      const heading =
        typeof json.Heading === "string" && json.Heading.trim()
          ? json.Heading.trim()
          : check.cleanedQuery;

      if (abstractText && abstractUrl) {
        results.push({
          label: "Outside source",
          title: sanitizeWelileTermsServer(heading),
          snippet: sanitizeWelileTermsServer(abstractText.slice(0, 500)),
          url: abstractUrl,
          accessed_date: today,
        });
      }

      const related = Array.isArray(json.RelatedTopics) ? json.RelatedTopics : [];
      for (const item of related) {
        if (results.length >= 5) break;
        if (!item || typeof item !== "object") continue;
        const r = item as Record<string, unknown>;
        const text = typeof r.Text === "string" ? r.Text.trim() : "";
        const firstUrl =
          typeof r.FirstURL === "string" && r.FirstURL.startsWith("https://")
            ? r.FirstURL.trim()
            : "";
        if (text && firstUrl) {
          results.push({
            label: "Outside source",
            title: sanitizeWelileTermsServer(text.slice(0, 90)),
            snippet: sanitizeWelileTermsServer(text.slice(0, 400)),
            url: firstUrl,
            accessed_date: today,
          });
        }
      }
    }
  } catch {
    // Non-fatal: return empty outside results with clear note
  }

  return {
    ok: true,
    payload: {
      source: `Outside source (search_web · ${today})`,
      period: today,
      outside_source: true,
      label: "Outside source",
      query: check.cleanedQuery,
      accessed_date: today,
      warning:
        "Outside source — cite every external fact with its link and date, label it 'Outside source', and NEVER mix outside numbers with Welile figures in totals.",
      results,
    },
  };
}

/**
 * Reads a public HTTPS web page in Consultant mode when `web_research_enabled` is true.
 */
export async function executeConsultantReadWebPage(
  url: string,
  rawToolOutputs: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<
  | {
      ok: true;
      payload: {
        source: string;
        period: string;
        outside_source: true;
        label: "Outside source";
        url: string;
        accessed_date: string;
        title: string;
        excerpt: string;
        warning: string;
      };
    }
  | { ok: false; reason: string; error: string }
> {
  const check = validateConsultantWebUrl(url, rawToolOutputs);
  if (!check.ok) {
    return {
      ok: false,
      reason: check.reason,
      error: check.detail,
    };
  }

  const today = kampalaToday();
  let title = check.hostname;
  let excerpt = "";

  try {
    const res = await fetcher(check.url, {
      method: "GET",
      headers: { Accept: "text/html, text/plain;q=0.9" },
    });
    if (res.ok) {
      const rawHtml = (await res.text()).slice(0, 40_000);
      const titleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (titleMatch?.[1]) {
        title = titleMatch[1].replace(/\s+/g, " ").trim().slice(0, 140);
      }
      excerpt = rawHtml
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1200);
    }
  } catch {
    excerpt = "";
  }

  return {
    ok: true,
    payload: {
      source: `Outside source (${check.hostname} · ${today})`,
      period: today,
      outside_source: true,
      label: "Outside source",
      url: check.url,
      accessed_date: today,
      title: sanitizeWelileTermsServer(title),
      excerpt: sanitizeWelileTermsServer(excerpt),
      warning:
        "Outside source — cite with link and date, label 'Outside source', and NEVER mix with Welile figures in totals.",
    },
  };
}

export interface ConsultantChecklistScore {
  passed: boolean;
  score: number;
  maxScore: 5;
  checks: {
    hasWhatILookedAt: boolean;
    hasWhatDataShowsWithTags: boolean;
    hasOptionsWithTradeOffs: boolean;
    hasRecommendationAndNextMetric: boolean;
    respectsEpistemicAndTerminologyRules: boolean;
  };
  reasons: string[];
}

/**
 * Deterministic + AI-judge checklist evaluator for Prompt 4 item (1) & (5):
 *   1. "What I looked at" (data, period, caveats)
 *   2. "What the data shows" (each point tagged Evidence / Assumption / Judgement)
 *   3. "Options" (2 or 3, with trade-offs, risks and what would change the answer)
 *   4. "Recommendation and what to measure next"
 *   5. Epistemic & terminology rules: no causal claims from correlation, flags caveats/sample size,
 *      never invents benchmarks, and uses Welile terminology (Rent Plan, Supporter, Returns).
 */
export function scoreConsultantAnswer(reply: string): ConsultantChecklistScore {
  const s = (reply ?? "").trim();
  const reasons: string[] = [];

  const hasWhatILookedAt =
    /\bwhat\s+i\s+looked\s+at\b/i.test(s) &&
    /\b(source|period|caveat|sample|window|data|report|view)\b/i.test(s);
  if (!hasWhatILookedAt) {
    reasons.push("Missing 'What I looked at' section with data source, period, and caveats.");
  }

  const hasWhatDataShowsHeading = /\bwhat\s+the\s+data\s+shows\b/i.test(s);
  const tagMatches = s.match(/\[?(?:Evidence|Assumption|Judgement|Judgment)\]?(?:\s*:|\])/gi) ?? [];
  const hasWhatDataShowsWithTags = hasWhatDataShowsHeading && tagMatches.length >= 2;
  if (!hasWhatDataShowsWithTags) {
    reasons.push(
      "Missing 'What the data shows' section with points tagged [Evidence], [Assumption], or [Judgement].",
    );
  }

  const hasOptionsHeading = /\boptions\b/i.test(s);
  const optionCount =
    (s.match(/(?:^|\n)\s*(?:[-*•]|\d+\.)\s*\**(?:Option\s+[123A-C]|[123]\b)/gi) ?? []).length;
  const hasTradeOffsAndRisks =
    /\b(trade-?offs?|risks?)\b/i.test(s) &&
    /\b(what\s+would\s+change|change\s+the\s+answer|if\s+we\s+see|revisit\s+if)\b/i.test(s);
  const hasOptionsWithTradeOffs =
    hasOptionsHeading && optionCount >= 2 && optionCount <= 3 && hasTradeOffsAndRisks;
  if (!hasOptionsWithTradeOffs) {
    reasons.push(
      "Missing 'Options' section with 2 or 3 options, trade-offs, risks, and what would change the answer.",
    );
  }

  const hasRecommendationAndNextMetric =
    /\brecommendation\b/i.test(s) &&
    /\b(what\s+to\s+measure\s+next|measure\s+next|next\s+metric|track\s+next)\b/i.test(s);
  if (!hasRecommendationAndNextMetric) {
    reasons.push("Missing 'Recommendation and what to measure next' section.");
  }

  const hasCausalClaimFromCorrelation =
    /\b(this\s+proves\s+that|correlation\s+proves|definitely\s+caused\s+by|is\s+proven\s+to\s+cause)\b/i.test(
      s,
    );
  const hasInventedBenchmark =
    /\b(industry\s+standard\s+is\s+\d|global\s+benchmark\s+of\s+\d)\b/i.test(s) &&
    !/\boutside\s+source\b/i.test(s);
  const hasBannedTerms = BANNED_REGULATORY_TERMS_RE.test(s);
  const respectsEpistemicAndTerminologyRules =
    !hasCausalClaimFromCorrelation && !hasInventedBenchmark && !hasBannedTerms;
  if (!respectsEpistemicAndTerminologyRules) {
    reasons.push(
      "Violated epistemic or Welile terminology rules (causal claim from correlation, unlabelled benchmark, or banned regulatory term).",
    );
  }

  const checks = {
    hasWhatILookedAt,
    hasWhatDataShowsWithTags,
    hasOptionsWithTradeOffs,
    hasRecommendationAndNextMetric,
    respectsEpistemicAndTerminologyRules,
  };

  const score = Object.values(checks).filter(Boolean).length;
  return {
    passed: score === 5,
    score,
    maxScore: 5,
    checks,
    reasons,
  };
}
