import { Helmet } from 'react-helmet-async';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CheckCircle2, Calendar, Wallet, ShieldCheck, Home } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

const CANONICAL = 'https://welileapp.com/guides/pay-rent-in-installments-uganda';

const faqs = [
  {
    q: 'Can I really pay my rent in instalments in Uganda?',
    a: 'Yes. With Welile you can split your monthly or quarterly rent into smaller weekly or daily payments instead of paying a large lump sum upfront. Welile pays your landlord in full and you repay in manageable instalments.',
  },
  {
    q: 'How is paying rent in instalments different from a rent loan?',
    a: 'A traditional rent advance is a lump-sum loan you must repay all at once, often with heavy interest. Welile instead spreads your rent into small scheduled instalments that match how you actually earn, so you never have to find the full amount in one go.',
  },
  {
    q: 'Do I need a guarantor or collateral?',
    a: 'No collateral is required. Welile builds a trust score from your payment behaviour and verified identity, then guarantees your rent to the landlord on your behalf.',
  },
  {
    q: 'How much does it cost to split my rent?',
    a: 'You pay a small, transparent access fee on top of your rent. There are no hidden charges — the full repayment schedule is shown to you before you commit.',
  },
  {
    q: 'What happens if I miss an instalment?',
    a: 'Welile sends reminders before each due date. If you fall behind, your trust score is affected, which can reduce how much rent we cover next time. Paying on time steadily increases your limit.',
  },
];

const steps = [
  {
    icon: Home,
    title: '1. Tell us your rent',
    body: 'Enter your monthly or quarterly rent amount and choose how long you want to take to repay — from a week up to several months.',
  },
  {
    icon: ShieldCheck,
    title: '2. We guarantee your landlord',
    body: 'Welile pays your landlord the full rent immediately so your house is secured. No awkward conversations, no eviction risk.',
  },
  {
    icon: Calendar,
    title: '3. Repay in small instalments',
    body: 'You repay in scheduled weekly or daily amounts that fit your income, all tracked transparently in the app.',
  },
  {
    icon: Wallet,
    title: '4. Build your limit',
    body: 'Every on-time payment raises your trust score, unlocking larger rent coverage and longer repayment periods over time.',
  },
];

export default function PayRentInstallmentsGuide() {
  const navigate = useNavigate();

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        headline: 'How to Pay Rent in Instalments in Uganda (2026 Guide)',
        description:
          'A complete guide to splitting your rent into manageable weekly or daily instalments in Uganda with Welile — without a lump-sum rent advance.',
        author: { '@type': 'Organization', name: 'Welile' },
        publisher: { '@type': 'Organization', name: 'Welile' },
        mainEntityOfPage: CANONICAL,
      },
      {
        '@type': 'FAQPage',
        mainEntity: faqs.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://welileapp.com/' },
          { '@type': 'ListItem', position: 2, name: 'Pay Rent in Instalments Guide', item: CANONICAL },
        ],
      },
    ],
  };

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>Pay Rent in Instalments in Uganda — A Practical Guide | Welile</title>
        <meta
          name="description"
          content="Need money to pay rent? Learn how to split your rent into small weekly or daily instalments in Uganda with Welile — no lump-sum advance, no collateral."
        />
        <link rel="canonical" href={CANONICAL} />
        <meta property="og:title" content="Pay Rent in Instalments in Uganda — A Practical Guide | Welile" />
        <meta
          property="og:description"
          content="Split your rent into manageable instalments with Welile. We pay your landlord in full; you repay in small amounts that match your income."
        />
        <meta property="og:type" content="article" />
        <meta property="og:url" content={CANONICAL} />
        <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>
      </Helmet>

      <article className="max-w-2xl mx-auto px-4 py-8">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="mb-6 gap-2">
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>

        <header className="mb-8">
          <p className="text-sm font-medium text-primary mb-2">Rent funding guide · Uganda</p>
          <h1 className="text-3xl font-bold leading-tight mb-3">
            How to Pay Rent in Instalments in Uganda
          </h1>
          <p className="text-muted-foreground leading-relaxed">
            If you need money to pay rent but can't raise the full amount at once, you don't have to
            take a costly lump-sum rent advance. This guide explains how to split your rent into
            small, manageable instalments with Welile — so your house stays secure and your cash flow
            stays healthy.
          </p>
        </header>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-3">Why instalments beat a lump-sum rent advance</h2>
          <p className="text-muted-foreground leading-relaxed mb-4">
            In most of Uganda, landlords expect rent monthly, quarterly, or even a year in advance.
            For many tenants — boda riders, market vendors, salaried workers paid mid-month — finding
            that lump sum on time is the hardest part. A traditional rent loan replaces one big
            problem with another: high interest and a single large repayment.
          </p>
          <p className="text-muted-foreground leading-relaxed">
            Paying in instalments works with how you actually earn. Instead of one painful payment,
            you make several small ones spread over days or weeks. Welile covers the landlord upfront,
            so you keep your home while you repay at a comfortable pace.
          </p>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4">How it works in 4 steps</h2>
          <div className="grid gap-4">
            {steps.map((s) => (
              <Card key={s.title}>
                <CardContent className="flex gap-4 p-4">
                  <div className="shrink-0 h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <s.icon className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold mb-1">{s.title}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">{s.body}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-3">Who is rent instalment funding for?</h2>
          <ul className="space-y-2">
            {[
              'Tenants whose income arrives weekly or daily rather than monthly',
              'People relocating who need to secure a house before their next pay',
              'Anyone facing a quarterly or annual lump-sum rent demand',
              'Tenants who want to avoid high-interest informal rent loans',
            ].map((item) => (
              <li key={item} className="flex gap-2 text-muted-foreground">
                <CheckCircle2 className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4">Frequently asked questions</h2>
          <div className="space-y-5">
            {faqs.map((f) => (
              <div key={f.q}>
                <h3 className="font-semibold mb-1">{f.q}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-xl bg-primary/5 border border-primary/10 p-6 text-center">
          <h2 className="text-xl font-semibold mb-2">Ready to split your rent?</h2>
          <p className="text-muted-foreground mb-4">
            Try the free calculator to see your exact instalment schedule, then apply in minutes.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button onClick={() => navigate('/rent-calculator')} className="gap-2">
              Calculate my instalments
              <ArrowRight className="h-4 w-4" />
            </Button>
            <Button variant="outline" onClick={() => navigate('/rent-money')}>
              Get rent funding
            </Button>
          </div>
        </section>
      </article>
    </div>
  );
}