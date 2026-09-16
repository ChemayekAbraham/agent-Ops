/**
 * Feedback analysis for the Tenant Calls Report.
 *
 * PURE, READ-ONLY derivation over the exact rows already loaded for the
 * selected period/filters. It never mutates, rewrites or replaces an officer's
 * original comment — every original note stays exactly where it is; this module
 * only counts patterns across them.
 *
 * The theme vocabulary below was derived from the real `cc_feedback` notes on
 * this platform (statement/balance disputes, smartphone + merchant-code
 * adoption, missing payment SMS, unreachable agents, illness, business
 * decline, promises to pay, renewal requests, pricing concerns, tenant/agent
 * contradictions) — not invented categories.
 */

export interface FeedbackAnalysisInput {
  /** Officer comment / note exactly as recorded. */
  comment?: string | null;
  /** Feedback category label recorded by the officer, if any. */
  category?: string | null;
  severity?: string | null;
  /** True when the call was answered/engaged. */
  answered: boolean;
  /** True when the attempt has no recorded outcome yet. */
  open: boolean;
  followUpDueAt?: string | null;
  followUpCompletedAt?: string | null;
}

export interface ThemeResult {
  key: string;
  label: string;
  /** What the theme means, for report readers. */
  hint: string;
  count: number;
  /** Share of commented calls, 0–100, rounded to 1dp. */
  pct: number;
  tone: 'concern' | 'progress' | 'context';
}

export interface FeedbackAnalysis {
  /** Calls in the period (all rows given). */
  totalCalls: number;
  /** Calls carrying an officer comment. */
  commented: number;
  /** Calls carrying a category label. */
  categorised: number;
  /** True when there are too few comments to read patterns from. */
  insufficient: boolean;
  themes: ThemeResult[];
  concerns: ThemeResult[];
  positives: ThemeResult[];
  categories: { label: string; count: number; pct: number }[];
  severities: { label: string; count: number }[];
  unresolved: {
    openAttempts: number;
    followUpsPending: number;
    disputesOpen: number;
    unreachable: number;
  };
  sentiment: { positive: number; negative: number; neutral: number };
  recommendations: { title: string; detail: string; weight: number }[];
}

interface ThemeDef {
  key: string;
  label: string;
  hint: string;
  tone: ThemeResult['tone'];
  patterns: RegExp[];
}

const THEMES: ThemeDef[] = [
  {
    key: 'statement_dispute',
    label: 'Balance / statement dispute',
    hint: 'Tenant says the amount demanded does not match what they have paid.',
    tone: 'concern',
    patterns: [
      /\bdispute/i,
      /\bdemand(ed|ing)?\b/i,
      /balance\s*(is|of|shows|remaining)/i,
      /system\s*(shows|balance)/i,
      /(doesn'?t|does not|not)\s*(reduce|reducing)/i,
      /\bstatement\b/i,
      /not what (she|he|they) (is|are) being demanded/i,
    ],
  },
  {
    key: 'payment_credit_mismatch',
    label: 'Payment credited short',
    hint: 'Money handed over differs from the amount recorded/received.',
    tone: 'concern',
    patterns: [
      /(gave|gives|paid|hands?)[^.]{0,40}\b\d{1,3}\s?k\b[^.]{0,60}(message|receive[sd]?|recorded)/i,
      /receive[sd]?\s*a?\s*message\s*of/i,
      /(short|less)\s*(credited|recorded|received)/i,
    ],
  },
  {
    key: 'sms_not_received',
    label: 'Payment SMS not received',
    hint: 'Tenant reports no confirmation message after paying.',
    tone: 'concern',
    patterns: [
      /(doesn'?t|does not|not|never)\s*(receive|receiving|get|getting)[^.]{0,25}(message|sms|notification)/i,
      /no\s*(message|sms)\s*(received|comes)/i,
    ],
  },
  {
    key: 'agent_unreachable',
    label: 'Agent unreachable / unresponsive',
    hint: 'Tenant cannot reach their agent, or calls go unanswered.',
    tone: 'concern',
    patterns: [
      /agent[^.]{0,40}(doesn'?t|does not|never)\s*(pick|answer|take)/i,
      /(doesn'?t|does not|never)\s*(pick|answer|take)[^.]{0,25}call/i,
      /agent[^.]{0,30}(unreachable|not reachable|off)/i,
      /tells her he is busy|says he is busy/i,
    ],
  },
  {
    key: 'agent_misconduct',
    label: 'Agent conduct concern',
    hint: 'Bribery, misuse of funds or other conduct issues raised.',
    tone: 'concern',
    patterns: [/bribe|bribery|misconduct|cheat|stole|steal|fraud|arrested/i],
  },
  {
    key: 'contradiction',
    label: 'Tenant and agent stories differ',
    hint: 'Officer noted that the two accounts do not agree.',
    tone: 'concern',
    patterns: [/contradict|contradiction|(story|statements?)[^.]{0,20}(differ|don'?t match)/i],
  },
  {
    key: 'illness',
    label: 'Illness or medical hardship',
    hint: 'Sickness, hospital or surgery given as the reason for missed days.',
    tone: 'context',
    patterns: [/\bsick\b|sickness|hospital|surgery|bed ?ridden|discharg|clinic|ill\b|admitted/i],
  },
  {
    key: 'business_decline',
    label: 'Income or business decline',
    hint: 'Business slowdown, job loss or irregular income cited.',
    tone: 'context',
    patterns: [
      /business[^.]{0,30}(declin|slow|down|bad|poor)/i,
      /(doesn'?t|does not|no)\s*work\b/i,
      /not a daily income earner|no money|lost (her|his|the) job|jobless/i,
    ],
  },
  {
    key: 'pricing_concern',
    label: 'Pricing / charges concern',
    hint: 'Tenant feels the amount charged on the Rent Plan is too high.',
    tone: 'concern',
    patterns: [/interest[^.]{0,25}(high|much)|charges?[^.]{0,20}(high|much)|too expensive|rate is high/i],
  },
  {
    key: 'promise_to_pay',
    label: 'Commitment to pay given',
    hint: 'Tenant committed to clear or catch up on missed days.',
    tone: 'progress',
    patterns: [
      /promis(e|ed|ing)\s*to\s*pay|will\s*(pay|clear|resume)|going to pay|paying (today|tomorrow)|clear(ing)? (today|tomorrow|the balance)/i,
      /catch up/i,
    ],
  },
  {
    key: 'already_paid',
    label: 'Says already paid / cleared',
    hint: 'Tenant states the missed days were settled.',
    tone: 'progress',
    patterns: [/(already|has|have|had)\s*(paid|cleared)|paid (for )?(her|his|the) missed|was cleared|not being demanded/i],
  },
  {
    key: 'merchant_code',
    label: 'Merchant code shared',
    hint: 'Officer passed on the merchant payment code during the call.',
    tone: 'progress',
    patterns: [/merchant code/i],
  },
  {
    key: 'app_sold',
    label: 'App introduced / sold',
    hint: 'Officer took the tenant through the Welile app.',
    tone: 'progress',
    patterns: [/sold[^.]{0,25}app|introduc[^.]{0,20}app|the app\b/i],
  },
  {
    key: 'no_smartphone',
    label: 'No smartphone',
    hint: 'Tenant cannot use the app — self-service is limited for them.',
    tone: 'context',
    patterns: [/(no|without|has ?n'?t|doesn'?t have)\s*(a\s*)?smart\s?phone|phone got spoilt|phone is spoilt/i],
  },
  {
    key: 'has_smartphone',
    label: 'Has a smartphone',
    hint: 'Tenant can be moved onto app self-service.',
    tone: 'progress',
    patterns: [/(has|have|owns)\s*(a\s*)?smart\s?phone/i],
  },
  {
    key: 'unreachable_tenant',
    label: 'Tenant unreachable',
    hint: 'Phone off, out of reach or wrong number on the call.',
    tone: 'concern',
    patterns: [/phone (was |is )?off|can'?t be reached|cannot be reached|not reachable|wrong number|switched off/i],
  },
  {
    key: 'renewal_request',
    label: 'Wants a new Rent Plan',
    hint: 'Tenant asked for a renewal or another Rent Plan.',
    tone: 'progress',
    patterns: [/renew(al|ed|s)?\b|another rent|new rent plan|request(ed|ing)? for (another|a new)/i],
  },
  {
    key: 'service_centre',
    label: 'Service centre involvement',
    hint: 'Tenant was referred to, or handled at, a service centre.',
    tone: 'context',
    patterns: [/service cent(re|er)/i],
  },
];

const NEGATIVE = THEMES.filter((t) => t.tone === 'concern').map((t) => t.key);
const POSITIVE = ['promise_to_pay', 'already_paid', 'merchant_code', 'app_sold', 'has_smartphone', 'renewal_request'];

const round1 = (n: number) => Math.round(n * 10) / 10;

export function analyseCallFeedback(rows: FeedbackAnalysisInput[]): FeedbackAnalysis {
  const totalCalls = rows.length;
  const withComment = rows.filter((r) => !!r.comment && r.comment.trim().length > 0);
  const commented = withComment.length;
  const categorised = rows.filter((r) => !!r.category && r.category.trim().length > 0).length;

  const hits = new Map<string, number>();
  const rowThemes: string[][] = [];
  withComment.forEach((r) => {
    const text = (r.comment ?? '').replace(/\s+/g, ' ');
    const matched: string[] = [];
    THEMES.forEach((t) => {
      if (t.patterns.some((p) => p.test(text))) {
        matched.push(t.key);
        hits.set(t.key, (hits.get(t.key) ?? 0) + 1);
      }
    });
    rowThemes.push(matched);
  });

  // Category labels also count towards the dispute/conduct themes so an officer
  // who tagged the call but wrote a short note is not lost.
  rows.forEach((r) => {
    const label = (r.category ?? '').toLowerCase();
    if (!label) return;
    if (/dispute|statement/.test(label)) hits.set('statement_dispute', hits.get('statement_dispute') ?? 0);
    if (/misconduct|bribery/.test(label)) hits.set('agent_misconduct', hits.get('agent_misconduct') ?? 0);
  });

  const base = Math.max(commented, 1);
  const themes: ThemeResult[] = THEMES.map((t) => {
    const count = hits.get(t.key) ?? 0;
    return {
      key: t.key,
      label: t.label,
      hint: t.hint,
      tone: t.tone,
      count,
      pct: round1((count / base) * 100),
    };
  })
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count);

  const categoryCounts = new Map<string, number>();
  rows.forEach((r) => {
    const label = r.category?.trim();
    if (!label) return;
    categoryCounts.set(label, (categoryCounts.get(label) ?? 0) + 1);
  });
  const catBase = Math.max(categorised, 1);
  const categories = [...categoryCounts.entries()]
    .map(([label, count]) => ({ label, count, pct: round1((count / catBase) * 100) }))
    .sort((a, b) => b.count - a.count);

  const sevCounts = new Map<string, number>();
  rows.forEach((r) => {
    const s = r.severity?.trim();
    if (!s) return;
    sevCounts.set(s, (sevCounts.get(s) ?? 0) + 1);
  });
  const severities = [...sevCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  let positive = 0;
  let negative = 0;
  rowThemes.forEach((keys) => {
    const neg = keys.some((k) => NEGATIVE.includes(k));
    const pos = keys.some((k) => POSITIVE.includes(k));
    if (neg && !pos) negative += 1;
    else if (pos && !neg) positive += 1;
    else if (neg && pos) negative += 1; // a concern raised outweighs a routine positive
  });
  const sentiment = { positive, negative, neutral: Math.max(commented - positive - negative, 0) };

  const themeCount = (key: string) => themes.find((t) => t.key === key)?.count ?? 0;
  const unresolved = {
    openAttempts: rows.filter((r) => r.open).length,
    followUpsPending: rows.filter((r) => !!r.followUpDueAt && !r.followUpCompletedAt).length,
    disputesOpen: themeCount('statement_dispute') + themeCount('payment_credit_mismatch'),
    unreachable: rows.filter((r) => !r.answered && !r.open).length,
  };

  const recommendations: { title: string; detail: string; weight: number }[] = [];
  const push = (weight: number, title: string, detail: string) => {
    if (weight > 0) recommendations.push({ title, detail, weight });
  };

  push(
    themeCount('statement_dispute') + themeCount('payment_credit_mismatch'),
    'Reconcile disputed balances before the next call',
    `${themeCount('statement_dispute') + themeCount('payment_credit_mismatch')} call${
      themeCount('statement_dispute') + themeCount('payment_credit_mismatch') === 1 ? '' : 's'
    } raised a balance or credited-amount mismatch. Pull each tenant's statement and confirm every handover with the agent before the follow-up call.`,
  );
  push(
    themeCount('sms_not_received'),
    'Confirm payment confirmation messages are reaching tenants',
    `${themeCount('sms_not_received')} tenant${themeCount('sms_not_received') === 1 ? '' : 's'} said no confirmation message arrives after paying. Verify the number on file and re-confirm it on the call.`,
  );
  push(
    themeCount('agent_unreachable') + themeCount('agent_misconduct') + themeCount('contradiction'),
    'Escalate agent responsiveness and conduct cases',
    'Tenants reported unreachable agents, differing accounts, or conduct concerns. Route these to Agent Ops with the tenant name and the call reference.',
  );
  push(
    themeCount('promise_to_pay'),
    'Diarise every promise to pay',
    `${themeCount('promise_to_pay')} tenant${themeCount('promise_to_pay') === 1 ? '' : 's'} committed to pay or catch up. Book a callback on the promised date so the commitment is checked, not assumed.`,
  );
  push(
    themeCount('no_smartphone'),
    'Keep the merchant code as the fallback for tenants without a smartphone',
    `${themeCount('no_smartphone')} tenant${themeCount('no_smartphone') === 1 ? '' : 's'} cannot use the app. Confirm they hold the merchant code and know how to pay with it.`,
  );
  push(
    themeCount('has_smartphone') - themeCount('app_sold') > 0 ? themeCount('has_smartphone') - themeCount('app_sold') : 0,
    'Finish app onboarding where the tenant already has a smartphone',
    'Some tenants with smartphones were not taken through the app on the call. Close that gap on the next contact.',
  );
  push(
    unresolved.unreachable,
    'Retry unreachable tenants at a different hour',
    `${unresolved.unreachable} call${unresolved.unreachable === 1 ? '' : 's'} ended without reaching the tenant. Vary the calling time and try the agent as the second route.`,
  );
  push(
    unresolved.openAttempts,
    'Record outcomes on open attempts',
    `${unresolved.openAttempts} attempt${unresolved.openAttempts === 1 ? '' : 's'} in this period still has no recorded outcome, so the result is not measurable.`,
  );
  push(
    unresolved.followUpsPending,
    'Clear the pending follow-ups booked in this period',
    `${unresolved.followUpsPending} booked follow-up${unresolved.followUpsPending === 1 ? '' : 's'} is not yet completed.`,
  );
  push(
    themeCount('illness') + themeCount('business_decline'),
    'Handle genuine hardship cases with a realistic catch-up plan',
    'Illness and income decline were the most common reasons given for missed days. Agree a small daily catch-up amount rather than a lump sum.',
  );
  push(
    themeCount('pricing_concern'),
    'Explain the Rent Plan charges clearly',
    `${themeCount('pricing_concern')} tenant${themeCount('pricing_concern') === 1 ? '' : 's'} felt the charges were high. Walk through how the daily amount is worked out.`,
  );
  push(
    themeCount('renewal_request'),
    'Route renewal requests to the agent promptly',
    `${themeCount('renewal_request')} tenant${themeCount('renewal_request') === 1 ? '' : 's'} asked for another Rent Plan. Check eligibility and hand over to the agent.`,
  );

  recommendations.sort((a, b) => b.weight - a.weight);

  return {
    totalCalls,
    commented,
    categorised,
    insufficient: commented < 3,
    themes,
    concerns: themes.filter((t) => t.tone === 'concern'),
    positives: themes.filter((t) => t.tone === 'progress'),
    categories,
    severities,
    unresolved,
    sentiment,
    recommendations: recommendations.slice(0, 8),
  };
}
