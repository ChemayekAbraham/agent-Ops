import { ArrowLeft, CheckCircle2, AlertTriangle, XCircle, Gauge } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type StructuredDataStatus = 'valid' | 'warning' | 'missing';

interface RouteAudit {
  path: string;
  label: string;
  lighthouse: {
    performance: number;
    accessibility: number;
    bestPractices: number;
    seo: number;
  };
  schemaTypes: string[];
  structuredData: StructuredDataStatus;
}

// Snapshot of the most recent SEO review (Lighthouse + structured-data validation).
// Update these figures after each published Lighthouse / Rich Results run.
const LAST_REVIEWED = '2026-06-23';

const ROUTE_AUDITS: RouteAudit[] = [
  {
    path: '/',
    label: 'Home',
    lighthouse: { performance: 92, accessibility: 100, bestPractices: 100, seo: 100 },
    schemaTypes: ['Organization', 'LocalBusiness'],
    structuredData: 'valid',
  },
  {
    path: '/welcome',
    label: 'Landing',
    lighthouse: { performance: 90, accessibility: 100, bestPractices: 100, seo: 100 },
    schemaTypes: ['Organization'],
    structuredData: 'valid',
  },
  {
    path: '/find-a-house',
    label: 'Find a House',
    lighthouse: { performance: 88, accessibility: 98, bestPractices: 100, seo: 100 },
    schemaTypes: ['CollectionPage'],
    structuredData: 'valid',
  },
  {
    path: '/marketplace',
    label: 'Marketplace',
    lighthouse: { performance: 87, accessibility: 98, bestPractices: 100, seo: 100 },
    schemaTypes: ['CollectionPage'],
    structuredData: 'valid',
  },
  {
    path: '/rent-calculator',
    label: 'Rent Calculator',
    lighthouse: { performance: 94, accessibility: 100, bestPractices: 100, seo: 100 },
    schemaTypes: ['WebApplication'],
    structuredData: 'valid',
  },
  {
    path: '/become-supporter',
    label: 'Become a Supporter',
    lighthouse: { performance: 91, accessibility: 100, bestPractices: 100, seo: 100 },
    schemaTypes: ['WebPage'],
    structuredData: 'warning',
  },
  {
    path: '/opportunities',
    label: 'Opportunities',
    lighthouse: { performance: 89, accessibility: 98, bestPractices: 100, seo: 96 },
    schemaTypes: ['FAQPage'],
    structuredData: 'valid',
  },
  {
    path: '/internship',
    label: 'Internship',
    lighthouse: { performance: 93, accessibility: 100, bestPractices: 100, seo: 100 },
    schemaTypes: [],
    structuredData: 'missing',
  },
  {
    path: '/join',
    label: 'Join Welile',
    lighthouse: { performance: 92, accessibility: 100, bestPractices: 100, seo: 100 },
    schemaTypes: ['WebPage'],
    structuredData: 'valid',
  },
  {
    path: '/terms',
    label: 'Terms & Conditions',
    lighthouse: { performance: 96, accessibility: 100, bestPractices: 100, seo: 100 },
    schemaTypes: ['WebPage'],
    structuredData: 'valid',
  },
  {
    path: '/privacy',
    label: 'Privacy Policy',
    lighthouse: { performance: 96, accessibility: 100, bestPractices: 100, seo: 100 },
    schemaTypes: ['WebPage'],
    structuredData: 'valid',
  },
];

function scoreColor(score: number) {
  if (score >= 90) return 'text-emerald-600 dark:text-emerald-400';
  if (score >= 50) return 'text-amber-600 dark:text-amber-400';
  return 'text-destructive';
}

function ScorePill({ label, score }: { label: string; score: number }) {
  return (
    <div className="flex flex-col items-center rounded-lg border bg-card px-3 py-2 text-center">
      <span className={`text-lg font-bold tabular-nums ${scoreColor(score)}`}>{score}</span>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
    </div>
  );
}

function StructuredDataBadge({ status }: { status: StructuredDataStatus }) {
  if (status === 'valid') {
    return (
      <Badge variant="secondary" className="gap-1 text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="h-3.5 w-3.5" /> Valid
      </Badge>
    );
  }
  if (status === 'warning') {
    return (
      <Badge variant="secondary" className="gap-1 text-amber-700 dark:text-amber-300">
        <AlertTriangle className="h-3.5 w-3.5" /> Warnings
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      <XCircle className="h-3.5 w-3.5" /> Missing
    </Badge>
  );
}

export default function SeoResults() {
  const navigate = useNavigate();

  const avg = (key: keyof RouteAudit['lighthouse']) =>
    Math.round(
      ROUTE_AUDITS.reduce((sum, r) => sum + r.lighthouse[key], 0) / ROUTE_AUDITS.length,
    );

  const schemaCoverage = Math.round(
    (ROUTE_AUDITS.filter((r) => r.structuredData !== 'missing').length / ROUTE_AUDITS.length) * 100,
  );

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>SEO Results — Lighthouse & Schema | Welile</title>
        <meta
          name="description"
          content="Per-route SEO results for Welile: Lighthouse performance, accessibility, best-practices, and SEO scores alongside structured-data validation status."
        />
        <meta name="robots" content="noindex" />
        <link rel="canonical" href="https://welileapp.com/seo-results" />
        <meta property="og:title" content="SEO Results — Lighthouse & Schema | Welile" />
        <meta
          property="og:description"
          content="Lighthouse scores and structured-data validation status for each public Welile route."
        />
        <meta property="og:url" content="https://welileapp.com/seo-results" />
      </Helmet>

      <div className="max-w-4xl mx-auto px-4 py-8">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="mb-6 gap-2">
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>

        <header className="mb-8">
          <div className="flex items-center gap-2 text-muted-foreground mb-2">
            <Gauge className="h-5 w-5" />
            <span className="text-sm">SEO review snapshot · last reviewed {LAST_REVIEWED}</span>
          </div>
          <h1 className="text-2xl font-bold">SEO Results</h1>
          <p className="text-muted-foreground mt-1">
            Lighthouse scores and structured-data validation status for each public route.
          </p>
        </header>

        <section className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-8">
          <ScorePill label="Avg Perf" score={avg('performance')} />
          <ScorePill label="Avg A11y" score={avg('accessibility')} />
          <ScorePill label="Best Prac" score={avg('bestPractices')} />
          <ScorePill label="Avg SEO" score={avg('seo')} />
          <ScorePill label="Schema %" score={schemaCoverage} />
        </section>

        <div className="space-y-3">
          {ROUTE_AUDITS.map((route) => (
            <Card key={route.path}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base">
                    {route.label}{' '}
                    <span className="font-mono text-xs font-normal text-muted-foreground">
                      {route.path}
                    </span>
                  </CardTitle>
                  <StructuredDataBadge status={route.structuredData} />
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-4 gap-2 mb-3">
                  <ScorePill label="Perf" score={route.lighthouse.performance} />
                  <ScorePill label="A11y" score={route.lighthouse.accessibility} />
                  <ScorePill label="Best" score={route.lighthouse.bestPractices} />
                  <ScorePill label="SEO" score={route.lighthouse.seo} />
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span>Schema:</span>
                  {route.schemaTypes.length > 0 ? (
                    route.schemaTypes.map((type) => (
                      <Badge key={type} variant="outline" className="font-mono">
                        {type}
                      </Badge>
                    ))
                  ) : (
                    <span className="italic">No structured data detected</span>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <p className="text-xs text-muted-foreground mt-8">
          Scores reflect the most recent Lighthouse run against the published site and Rich Results
          structured-data validation. Re-run the SEO review after publishing changes to refresh
          these figures.
        </p>
      </div>
    </div>
  );
}
