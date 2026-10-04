import { Helmet } from 'react-helmet-async';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, MapPin, Wallet, Scale } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { getComparison, NEIGHBORHOOD_COMPARISONS } from '@/data/neighborhoodComparisons';
import { formatUGX } from '@/lib/rentCalculations';

const SITE_URL = 'https://welileapp.com';

function range(a: number, b: number) {
  return `${formatUGX(a)} – ${formatUGX(b)}`;
}

export default function NeighborhoodComparisonGuide() {
  const { comparisonSlug } = useParams<{ comparisonSlug: string }>();
  const navigate = useNavigate();
  const c = comparisonSlug ? getComparison(comparisonSlug) : undefined;

  if (!c) {
    return (
      <div className="min-h-screen bg-background">
        <Helmet>
          <title>Neighbourhood Comparisons in Uganda | Welile</title>
          <meta name="description" content="Side-by-side rent, vibe and commute comparisons of popular Ugandan neighbourhoods." />
          <link rel="canonical" href={`${SITE_URL}/guides/compare`} />
        </Helmet>
        <div className="max-w-2xl mx-auto px-4 py-8">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="mb-6 gap-2">
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          <h1 className="text-3xl font-bold mb-4">Neighbourhood comparisons</h1>
          <p className="text-muted-foreground mb-6">Pick a matchup to see rent, vibe, commute and verdict side-by-side.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {NEIGHBORHOOD_COMPARISONS.map((n) => (
              <Link key={n.slug} to={`/guides/compare/${n.slug}`}>
                <Card className="hover:border-primary transition-colors">
                  <CardContent className="p-4">
                    <div className="text-xs text-muted-foreground mb-1">{n.city}</div>
                    <div className="font-semibold text-lg">{n.aName} vs {n.bName}</div>
                    <div className="text-sm text-muted-foreground line-clamp-2 mt-1">{n.summary}</div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const canonical = `${SITE_URL}/guides/compare/${c.slug}`;
  const title = `${c.aName} vs ${c.bName} — Which Is Better to Rent In? (${c.city}, 2026) | Welile`;
  const description = `${c.aName} vs ${c.bName} in ${c.city}: side-by-side rent ranges for single rooms, self-contained and 1–3 bedroom apartments, plus vibe, commute and verdict for 2026.`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        headline: `${c.aName} vs ${c.bName} — ${c.city} rent comparison`,
        description,
        author: { '@type': 'Organization', name: 'Welile' },
        publisher: { '@type': 'Organization', name: 'Welile' },
        dateModified: c.updatedOn,
        mainEntityOfPage: canonical,
      },
      {
        '@type': 'FAQPage',
        mainEntity: c.faqs.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
          { '@type': 'ListItem', position: 2, name: 'Comparisons', item: `${SITE_URL}/guides/compare` },
          { '@type': 'ListItem', position: 3, name: `${c.aName} vs ${c.bName}`, item: canonical },
        ],
      },
    ],
  };

  const otherComps = NEIGHBORHOOD_COMPARISONS.filter((x) => x.slug !== c.slug).slice(0, 4);

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>{title}</title>
        <meta name="description" content={description} />
        <link rel="canonical" href={canonical} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:type" content="article" />
        <meta property="og:url" content={canonical} />
        <meta property="og:site_name" content="Welile" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={title} />
        <meta name="twitter:description" content={description} />
        <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>
      </Helmet>

      <article className="max-w-2xl mx-auto px-4 py-8">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="mb-6 gap-2">
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>

        <header className="mb-8">
          <p className="text-sm font-medium text-primary mb-2 flex items-center gap-1.5">
            <MapPin className="h-4 w-4" /> {c.city} · Updated 2026
          </p>
          <h1 className="text-3xl font-bold leading-tight mb-3 flex items-center gap-2">
            {c.aName} <span className="text-muted-foreground text-lg">vs</span> {c.bName}
          </h1>
          <p className="leading-relaxed text-muted-foreground">{c.summary}</p>
        </header>

        <section className="mb-8">
          <h2 className="text-xl font-bold mb-3 flex items-center gap-2">
            <Wallet className="h-5 w-5 text-primary" /> Rent side-by-side
          </h2>
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left p-3 font-semibold">Type</th>
                    <th className="text-right p-3 font-semibold">{c.aName}</th>
                    <th className="text-right p-3 font-semibold">{c.bName}</th>
                  </tr>
                </thead>
                <tbody>
                  {c.rentTable.map((row) => (
                    <tr key={row.tier} className="border-t">
                      <td className="p-3 font-medium">{row.tier}</td>
                      <td className="p-3 text-right tabular-nums whitespace-nowrap">{range(row.aRangeUgx[0], row.aRangeUgx[1])}</td>
                      <td className="p-3 text-right tabular-nums whitespace-nowrap">{range(row.bRangeUgx[0], row.bRangeUgx[1])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-bold mb-3 flex items-center gap-2">
            <Scale className="h-5 w-5 text-primary" /> Compare on what matters
          </h2>
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left p-3 font-semibold"></th>
                    <th className="text-left p-3 font-semibold">{c.aName}</th>
                    <th className="text-left p-3 font-semibold">{c.bName}</th>
                  </tr>
                </thead>
                <tbody>
                  {c.rows.map((r) => (
                    <tr key={r.label} className="border-t align-top">
                      <td className="p-3 font-medium text-muted-foreground whitespace-nowrap">{r.label}</td>
                      <td className="p-3">{r.a}</td>
                      <td className="p-3">{r.b}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </section>

        <section className="mb-8 grid gap-3 sm:grid-cols-2">
          <Card className="border-primary/30">
            <CardContent className="p-4">
              <div className="text-xs font-semibold text-primary uppercase mb-1">Choose {c.aName} if</div>
              <p className="text-sm">{c.bestFor.a}</p>
            </CardContent>
          </Card>
          <Card className="border-primary/30">
            <CardContent className="p-4">
              <div className="text-xs font-semibold text-primary uppercase mb-1">Choose {c.bName} if</div>
              <p className="text-sm">{c.bestFor.b}</p>
            </CardContent>
          </Card>
        </section>

        <section className="mb-8">
          <Card className="bg-muted/40">
            <CardContent className="p-5">
              <div className="font-semibold mb-1">The verdict</div>
              <p className="text-sm leading-relaxed">{c.verdict}</p>
            </CardContent>
          </Card>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-bold mb-3">Frequently asked</h2>
          <div className="space-y-3">
            {c.faqs.map((f) => (
              <Card key={f.q}>
                <CardContent className="p-4">
                  <div className="font-semibold mb-1">{f.q}</div>
                  <p className="text-sm text-muted-foreground leading-relaxed">{f.a}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section className="mb-8">
          <Card className="bg-gradient-to-br from-primary to-primary/80 text-primary-foreground">
            <CardContent className="p-6">
              <div className="font-bold text-lg mb-1 flex items-center gap-2"><Wallet className="h-5 w-5" /> Whichever you pick, pay in instalments</div>
              <p className="text-sm opacity-90 mb-4">Welile pays your {c.city} landlord in full; you repay weekly. Move in with just your first instalment.</p>
              <Button variant="secondary" onClick={() => navigate(`/find-a-house/${c.regionSlug}`)} className="gap-1">
                Browse {c.city} houses <ArrowRight className="h-4 w-4" />
              </Button>
            </CardContent>
          </Card>
        </section>

        {otherComps.length > 0 && (
          <section className="mb-4">
            <h2 className="text-lg font-bold mb-3">Other comparisons</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {otherComps.map((n) => (
                <Link key={n.slug} to={`/guides/compare/${n.slug}`} className="text-sm text-primary hover:underline">
                  {n.aName} vs {n.bName} →
                </Link>
              ))}
            </div>
          </section>
        )}
      </article>
    </div>
  );
}
