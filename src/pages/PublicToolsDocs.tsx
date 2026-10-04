import { useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { ArrowLeft, Check, Copy, Globe } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const PROJECT_REF = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? '';
const PUBLIC_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/mcp-public`;

type Param = {
  name: string;
  type: string;
  required: boolean;
  description: string;
};

type ToolDoc = {
  name: string;
  title: string;
  description: string;
  params: Param[];
  prompts: string[];
  returns: string;
};

const REFERRAL_PARAM: Param = {
  name: 'referral_code',
  type: 'string',
  required: false,
  description: "The referrer's Welile user id. Adds a referral signup link to the answer.",
};

// The shared envelope every public tool returns (schema version 1.0). Keep in
// sync with src/lib/mcp-public/response.ts.
const RESPONSE_FIELDS: { name: string; type: string; description: string }[] = [
  { name: 'schema_version', type: 'string', description: 'Envelope version, currently "1.0".' },
  { name: 'tool', type: 'string', description: 'Name of the tool that produced the answer.' },
  { name: 'ok', type: 'boolean', description: 'True on success, false when error is set.' },
  {
    name: 'kind',
    type: '"info" | "estimate" | "listings" | "error"',
    description: 'What sort of answer this is, so a client can render it appropriately.',
  },
  { name: 'summary', type: 'string', description: 'One sentence answering the question, safe to quote directly.' },
  {
    name: 'assumptions',
    type: 'string[]',
    description: 'What the answer assumes — rates used, defaults chosen, and any filters applied.',
  },
  {
    name: 'estimates',
    type: 'object | null',
    description:
      'Normalised figures: basis (the formula or source), confidence ("indicative", "illustrative", or "actual"), currency, and ranges. Null for tools that return no figures.',
  },
  {
    name: 'data',
    type: 'object',
    description: 'The tool-specific payload — faqs, plans, projections, listings, filters.',
  },
  {
    name: 'disclaimers',
    type: 'string[]',
    description: 'Caveats that must be passed on, e.g. that a figure is not an approval or guarantee.',
  },
  { name: 'next_steps', type: 'string[]', description: 'What the user should do next.' },
  {
    name: 'links',
    type: 'object',
    description: 'landing_url, signup_url, referral_url (or null), and the target role (or null).',
  },
  { name: 'currency', type: 'string', description: 'Always "UGX" — Welile deals strictly in Ugandan Shillings.' },
  {
    name: 'error',
    type: 'object | null',
    description:
      'Null on success. Otherwise code, message, retry_after_seconds (set when rate limited), and details.',
  },
];

const TOOLS: ToolDoc[] = [
  {
    name: 'how_welile_works',
    title: 'How Welile works',
    description:
      'Explains how Welile Receipts works for tenants, agents, landlords, and Supporters, and returns the free signup link. Answers come from a fixed set of FAQs, so nothing is invented.',
    params: [
      {
        name: 'topic',
        type: 'string',
        required: false,
        description:
          "Keyword to focus the answer, e.g. 'tenant', 'agent', 'supporter', 'landlord', 'trust score'. Omit to get all FAQs.",
      },
      REFERRAL_PARAM,
    ],
    prompts: [
      'How does Welile Receipts work?',
      'Explain Welile for landlords.',
      'What is the Welile Trust Score?',
    ],
    returns: 'Matching FAQs plus a free signup link (and a referral link when a referral code is given).',
  },
  {
    name: 'explore_welile',
    title: 'Explore Welile (guided prompts)',
    description:
      'Answers "what can I do here" questions and turns them into a next step, returning a role-targeted signup link. With no intent it lists every guided prompt an assistant can suggest.',
    params: [
      {
        name: 'intent',
        type: 'string',
        required: false,
        description:
          "One of rent_access, agent_commissions, supporter_returns, landlord_payouts, trust_score — or free text like 'check my rent access'. Omit to list all guided prompts.",
      },
      REFERRAL_PARAM,
    ],
    prompts: [
      'What can I do with Welile?',
      'I want to earn as a field agent — how does that work?',
      'How do landlords get guaranteed rent?',
    ],
    returns: 'A headline, plain-language explanation, next step, and a signup link for the matching role.',
  },
  {
    name: 'check_eligibility',
    title: 'Check eligibility for a Welile role',
    description:
      "Answers 'can I join?' / 'do I qualify?' for the tenant, agent, landlord, and Supporter roles by returning that role's requirement checklist plus the free role-targeted signup link. If the user has already shared facts about themselves, each requirement comes back marked met, not_met, or to_confirm. A general checklist only — never an approval.",
    params: [
      {
        name: 'role',
        type: 'string',
        required: false,
        description:
          "tenant, agent, landlord, or supporter — or free text like 'I want to collect rent'. Omit to compare all four roles.",
      },
      { name: 'age', type: 'number', required: false, description: 'Age in years. Welile requires 18+.' },
      {
        name: 'has_national_id',
        type: 'boolean',
        required: false,
        description: 'Whether they hold a Ugandan national ID.',
      },
      {
        name: 'has_phone',
        type: 'boolean',
        required: false,
        description: 'Whether they have a phone number they control (confirmed by SMS).',
      },
      {
        name: 'has_mobile_money',
        type: 'boolean',
        required: false,
        description: 'Whether they have mobile money registered in their own names.',
      },
      { name: 'district', type: 'string', required: false, description: 'District or area they live or work in.' },
      {
        name: 'monthly_rent',
        type: 'number',
        required: false,
        description: 'Tenant only: monthly rent in UGX. Plans cover 10,000 – 5,000,000.',
      },
      {
        name: 'support_amount',
        type: 'number',
        required: false,
        description: 'Supporter only: amount in UGX they can commit. Minimum 20,000.',
      },
      {
        name: 'houses_to_list',
        type: 'number',
        required: false,
        description: 'Landlord only: how many rental houses they own or manage.',
      },
      REFERRAL_PARAM,
    ],
    prompts: [
      'Can I become a Welile agent? I am 24, I have a national ID and mobile money.',
      'Do I qualify for a Welile Rent Plan if my rent is UGX 180,000?',
      'What do I need to become a Welile Supporter with UGX 100,000?',
      'I own 3 rental houses in Mukono — can I list them on Welile?',
    ],
    returns:
      'The role headline, who it is for, and a full requirement checklist with per-requirement status (met / not_met / to_confirm), counts, the relevant UGX thresholds, and the role signup link.',
  },
  {
    name: 'get_onboarding_steps',
    title: 'Step-by-step Welile onboarding',
    description:
      "Returns the numbered onboarding walkthrough for a role — what the user does at each step, what to bring (national ID, house photos, mobile money, transaction ID…), and how long each step typically takes — plus the free role-targeted signup link. Pass a step number to expand a single step.",
    params: [
      {
        name: 'role',
        type: 'string',
        required: false,
        description:
          "tenant, agent, landlord, or supporter — or free text like 'I want to earn commission'. Omit to outline all four paths.",
      },
      {
        name: 'step',
        type: 'number',
        required: false,
        description: "1-based step number to expand one step of that role's onboarding.",
      },
      REFERRAL_PARAM,
    ],
    prompts: [
      'What are the steps to become a Welile agent?',
      'How do I get a Rent Plan on Welile, step by step?',
      'Walk me through listing my house on Welile.',
      'Step 4 of becoming a Welile Supporter — what do I need?',
    ],
    returns:
      'Numbered steps with what you do, a bring-checklist, and typical durations, plus a combined checklist of everything to have ready and the role signup link.',
  },
  {
    name: 'estimate_rent_access',
    title: 'Estimate rent access (indicative)',
    description:
      'Gives a prospective tenant an indicative rent-access ballpark in UGX — total repayment and daily payment for a given monthly rent — plus the free tenant signup link. Illustrative only: it is not an approval, and the real Rent Plan is set after signup and verification.',
    params: [
      {
        name: 'rent',
        type: 'number',
        required: true,
        description: 'Monthly rent in UGX, e.g. 200000. Accepted range: 10,000 – 5,000,000.',
      },
      {
        name: 'duration_days',
        type: 'number',
        required: false,
        description: 'Rent Plan length in days (7–120). Omit to compare 30 / 60 / 90-day options.',
      },
      REFERRAL_PARAM,
    ],
    prompts: [
      'My rent is UGX 250,000 a month — what would a Welile Rent Plan cost me?',
      'Estimate rent access for UGX 400,000 over 60 days.',
      'How much would I pay daily on UGX 150,000 rent?',
    ],
    returns:
      'Per-duration breakdown (rent, access fee, service fee, agent commission, total repayment, daily payment) in UGX, plus the tenant signup link.',
  },
  {
    name: 'estimate_supporter_returns',
    title: 'Estimate Supporter Returns (illustrative)',
    description:
      'Gives a prospective Supporter an illustrative Returns range in UGX for a support amount over time, from simple (Returns paid out) to compounding (Returns reinvested), plus the free Supporter signup link. An illustration only, not a guarantee — actual rates and terms are shown in the app.',
    params: [
      {
        name: 'amount',
        type: 'number',
        required: true,
        description: 'Amount to support in UGX, e.g. 500000. Accepted range: 20,000 – 500,000,000.',
      },
      {
        name: 'duration_months',
        type: 'number',
        required: false,
        description: 'Horizon in months (1–36). Omit to compare 3 / 6 / 12-month options.',
      },
      REFERRAL_PARAM,
    ],
    prompts: [
      'If I support Welile with UGX 1,000,000, what Returns could I expect?',
      'Show Supporter Returns on UGX 2,000,000 over 12 months.',
      'Compare paying out Returns versus reinvesting them.',
    ],
    returns:
      'Per-horizon monthly Returns, simple and compounding earnings, and totals in UGX, plus the Supporter signup link.',
  },
  {
    name: 'find_available_houses',
    title: 'Find available houses',
    description:
      'Returns a small read-only sample of available Welile house listings by district and/or area, plus the free tenant signup link to view details and apply. Only public, non-sensitive fields are exposed — never the exact address, GPS, landlord, or contact details.',
    params: [
      {
        name: 'district',
        type: 'string',
        required: false,
        description: "District to search, e.g. 'Wakiso', 'Kampala'.",
      },
      {
        name: 'area',
        type: 'string',
        required: false,
        description: 'Area or neighbourhood — matches village, sub-county, district, or region.',
      },
      {
        name: 'max_rent',
        type: 'number',
        required: false,
        description: 'Maximum monthly rent in UGX.',
      },
      {
        name: 'limit',
        type: 'number',
        required: false,
        description: 'Number of listings to return (1–10, default 5).',
      },
      REFERRAL_PARAM,
    ],
    prompts: [
      'Show me available houses in Wakiso under UGX 300,000.',
      'Any rentals in Kira right now?',
      'Find 3 available houses in Kampala.',
    ],
    returns:
      'A sample of available listings (title, area, rooms, monthly rent in UGX) plus the tenant signup link.',
  },
];

function UrlBox({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success('Link copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy — select the text and copy manually');
    }
  };

  return (
    <div className="rounded-lg border bg-muted/40 p-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all font-mono text-xs sm:text-sm">{url}</code>
        <Button size="sm" variant="secondary" onClick={copy} className="shrink-0">
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          <span className="ml-1.5 hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span>
        </Button>
      </div>
    </div>
  );
}

export default function PublicToolsDocs() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>Public AI Tools Reference | Welile Receipts</title>
        <meta
          name="description"
          content="Reference for every public Welile Receipts AI tool: parameters, what each returns, and example prompts you can use in ChatGPT or Claude. No account needed."
        />
        <link rel="canonical" href="https://welileapp.com/public-tools" />
        <meta property="og:title" content="Public AI Tools Reference | Welile Receipts" />
        <meta
          property="og:description"
          content="Every public Welile AI tool, its parameters, and example prompts for ChatGPT and Claude."
        />
        <meta property="og:type" content="website" />
        <meta name="twitter:card" content="summary" />
      </Helmet>

      <div className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
        <Button variant="ghost" size="sm" className="mb-6 -ml-2" onClick={() => navigate('/connect-ai')}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Connect AI
        </Button>

        <header className="mb-8">
          <Badge variant="secondary" className="mb-3">
            <Globe className="mr-1.5 h-3.5 w-3.5" />
            Public — no sign-in
          </Badge>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Public AI tools reference</h1>
          <p className="mt-3 text-muted-foreground">
            These {TOOLS.length} tools are available to anyone who connects the public Welile server to
            ChatGPT or Claude — no Welile account required. They are read-only and return general
            information, ballpark figures in UGX, and signup links. Personal figures such as your wallet
            balance live on the signed-in server instead.
          </p>
        </header>

        <section className="mb-10 space-y-3">
          <UrlBox url={PUBLIC_URL} label="Public server URL" />
          <p className="text-sm text-muted-foreground">
            Add this URL as a connector in ChatGPT or Claude, then use any example prompt below. See{' '}
            <button
              type="button"
              onClick={() => navigate('/connect-ai')}
              className="font-medium text-primary underline underline-offset-4"
            >
              step-by-step setup
            </button>
            .
          </p>
        </section>

        <nav aria-label="Tools" className="mb-10 rounded-lg border p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            On this page
          </h2>
          <ul className="space-y-1.5">
            {TOOLS.map((t) => (
              <li key={t.name}>
                <a
                  href={`#${t.name}`}
                  className="font-mono text-sm text-primary underline-offset-4 hover:underline"
                >
                  {t.name}
                </a>
                <span className="ml-2 text-sm text-muted-foreground">{t.title}</span>
              </li>
            ))}
          </ul>
        </nav>

        <Card className="mb-10" id="response-shape">
          <CardHeader>
            <CardTitle className="text-base sm:text-lg">One response shape for every tool</CardTitle>
            <p className="text-sm text-muted-foreground">
              All {TOOLS.length} tools return the same top-level JSON fields, on success and on failure, so
              an assistant never has to guess where the answer lives. Only <code className="font-mono">ok</code>{' '}
              tells you whether it worked.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-2 text-sm">
              {RESPONSE_FIELDS.map((f) => (
                <li key={f.name}>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-sm">{f.name}</code>
                    <span className="text-xs text-muted-foreground">{f.type}</span>
                  </div>
                  <p className="mt-0.5 text-muted-foreground">{f.description}</p>
                </li>
              ))}
            </ul>
            <div>
              <h3 className="mb-2 text-sm font-semibold">Every entry in estimates.ranges</h3>
              <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
{`{
  "label": "Returns over 6 months",
  "metric": "returns",
  "unit": "UGX",              // UGX | UGX_per_day | UGX_per_month | count
  "low": 450000,              // low and high are always both present;
  "high": 656530,             // they are equal for a single figure
  "period": { "unit": "months", "value": 6 },
  "breakdown": { "paid_out": 450000, "reinvested": 656530 }
}`}
              </pre>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          {TOOLS.map((tool) => (
            <Card key={tool.name} id={tool.name} className="scroll-mt-6">
              <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="font-mono text-base sm:text-lg">{tool.name}</CardTitle>
                  <Badge variant="outline">Read-only</Badge>
                </div>
                <p className="text-sm font-medium">{tool.title}</p>
                <p className="text-sm text-muted-foreground">{tool.description}</p>
              </CardHeader>
              <CardContent className="space-y-5">
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Parameters</h3>
                  <ul className="space-y-2.5">
                    {tool.params.map((p) => (
                      <li key={p.name} className="text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <code className="font-mono text-sm">{p.name}</code>
                          <span className="text-xs text-muted-foreground">{p.type}</span>
                          <Badge variant={p.required ? 'default' : 'secondary'} className="text-[10px]">
                            {p.required ? 'required' : 'optional'}
                          </Badge>
                        </div>
                        <p className="mt-0.5 text-muted-foreground">{p.description}</p>
                      </li>
                    ))}
                  </ul>
                </div>

                <div>
                  <h3 className="mb-2 text-sm font-semibold">Returns</h3>
                  <p className="text-sm text-muted-foreground">{tool.returns}</p>
                </div>

                <div>
                  <h3 className="mb-2 text-sm font-semibold">Example prompts</h3>
                  <ul className="space-y-2">
                    {tool.prompts.map((p) => (
                      <li
                        key={p}
                        className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-foreground"
                      >
                        “{p}”
                      </li>
                    ))}
                  </ul>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <p className="mt-10 text-xs text-muted-foreground">
          All amounts are in UGX. Rent-access and Supporter Returns figures are illustrative only — they
          are not an approval or a guarantee. Actual plans, rates, and terms are confirmed in the app after
          signup and verification.
        </p>
      </div>
    </div>
  );
}