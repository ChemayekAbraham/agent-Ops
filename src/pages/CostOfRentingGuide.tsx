import { Helmet } from 'react-helmet-async';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, MapPin, Home, Wallet, Bus, Zap, Lightbulb } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getCityGuide, CITY_GUIDES } from '@/data/rentCostGuides';
import { formatUGX } from '@/lib/rentCalculations';

const SITE_URL = 'https://welileapp.com';
const YEAR_LABEL = '2026';

function range(a: number, b: number) {
  return `${formatUGX(a)} – ${formatUGX(b)}`;
}

export default function CostOfRentingGuide() {
  const { citySlug } = useParams<{ citySlug: string }>();
  const navigate = useNavigate();
  const guide = citySlug ? getCityGuide(citySlug) : undefined;

  if (!guide) {
    return (
      <div className="min-h-screen bg-background">
        <Helmet>
          <title>Cost of Renting Guides — Uganda | Welile</title>
          <meta name="description" content="Rent cost guides for every major city in Uganda in 2026. Pick a city to see typical monthly rent by house type and neighbourhood." />
          <link rel="canonical" href={`${SITE_URL}/guides/cost-of-renting`} />
        </Helmet>
        <div className="max-w-2xl mx-auto px-4 py-8">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="mb-6 gap-2">
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          <h1 className="text-3xl font-bold mb-4">Cost of Renting in Uganda — 2026 Guides</h1>
          <p className="text-muted-foreground mb-6">Pick a city to see typical monthly rent, popular neighbourhoods and a 2026 price breakdown.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {CITY_GUIDES.map((g) => (
              <Link key={g.slug} to={`/guides/cost-of-renting-in-${g.slug}`}>
                <Card className="hover:border-primary transition-colors">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 text-sm text-primary font-medium mb-1">
                      <MapPin className="h-4 w-4" /> {g.region}
                    </div>
                    <div className="font-semibold text-lg">Cost of renting in {g.city} {YEAR_LABEL}</div>
                    <div className="text-sm text-muted-foreground line-clamp-2 mt-1">{g.tagline}</div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const canonical = `${SITE_URL}/guides/cost-of-renting-in-${guide.slug}`;
  const title = `Cost of Renting in ${guide.city} ${YEAR_LABEL} — Prices by Area | Welile`;
  const description = `${guide.city} rent guide ${YEAR_LABEL}: typical prices for rooms, 1-2 bed apartments and top areas. Plan your rent with Welile.`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        headline: `Cost of Renting in ${guide.city} ${YEAR_LABEL}`,
        description,
        author: { '@type': 'Organization', name: 'Welile' },
        publisher: { '@type': 'Organization', name: 'Welile' },
        dateModified: guide.updatedOn,
        mainEntityOfPage: canonical,
      },
      {
        '@type': 'FAQPage',
        mainEntity: guide.faqs.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
          { '@type': 'ListItem', position: 2, name: 'Rent guides', item: `${SITE_URL}/guides/cost-of-renting` },
          { '@type': 'ListItem', position: 3, name: `${guide.city} ${YEAR_LABEL}`, item: canonical },
        ],
      },
    ],
  };

  const otherGuides = CITY_GUIDES.filter((g) => g.slug !== guide.slug).slice(0, 4);

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
            <MapPin className="h-4 w-4" /> {guide.region} · Updated {YEAR_LABEL}
          </p>
          <h1 className="text-3xl font-bold leading-tight mb-3">
            Cost of Renting in {guide.city} {YEAR_LABEL}
          </h1>
          <p className="text-lg text-muted-foreground leading-relaxed">{guide.tagline}</p>
          <p className="mt-4 leading-relaxed">{guide.intro}</p>
        </header>

        <section className="mb-8">
          <h2 className="text-xl font-bold mb-3 flex items-center gap-2">
            <Home className="h-5 w-5 text-primary" /> Typical monthly rent in {guide.city}
          </h2>
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left p-3 font-semibold">House type</th>
                    <th className="text-right p-3 font-semibold">Typical monthly rent</th>
                  </tr>
                </thead>
                <tbody>
                  {guide.tiers.map((t) => (
                    <tr key={t.label} className="border-t">
                      <td className="p-3 align-top">
                        <div className="font-medium">{t.label}</div>
                        {t.notes && <div className="text-xs text-muted-foreground mt-0.5">{t.notes}</div>}
                      </td>
                      <td className="p-3 text-right whitespace-nowrap tabular-nums">{range(t.rangeUgx[0], t.rangeUgx[1])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-bold mb-3 flex items-center gap-2">
            <MapPin className="h-5 w-5 text-primary" /> Popular neighbourhoods
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {guide.popularAreas.map((a) => {
              const content = (
                <CardContent className="p-4">
                  <div className="font-semibold">{a.name}</div>
                  <div className="text-xs text-muted-foreground mb-2">{a.vibe}</div>
                  <div className="text-sm font-medium tabular-nums">{range(a.typicalMonthlyUgx[0], a.typicalMonthlyUgx[1])}/mo</div>
                </CardContent>
              );
              return a.regionSlug ? (
                <Link key={a.name} to={`/find-a-house/${a.regionSlug}`}>
                  <Card className="hover:border-primary transition-colors">{content}</Card>
                </Link>
              ) : (
                <Card key={a.name}>{content}</Card>
              );
            })}
          </div>
        </section>

        <section className="mb-8 grid gap-3 sm:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2"><Zap className="h-4 w-4 text-amber-500" /> Utilities</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">{guide.utilityNote}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2"><Bus className="h-4 w-4 text-emerald-500" /> Commute</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">{guide.commuteNote}</CardContent>
          </Card>
        </section>

        <section className="mb-8">
          <Card className="bg-primary/5 border-primary/20">
            <CardContent className="p-4 flex gap-3">
              <Lightbulb className="h-5 w-5 text-primary shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold mb-1">How to save on {guide.city} rent</div>
                <p className="text-sm text-muted-foreground">{guide.savingsTip}</p>
              </div>
            </CardContent>
          </Card>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-bold mb-3">Frequently asked questions</h2>
          <div className="space-y-3">
            {guide.faqs.map((f) => (
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
              <div className="font-bold text-lg mb-1 flex items-center gap-2"><Wallet className="h-5 w-5" /> Pay {guide.city} rent in weekly instalments</div>
              <p className="text-sm opacity-90 mb-4">Welile settles your landlord in full and lets you repay in small weekly or daily amounts. No lump sum. No collateral.</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => navigate(`/find-a-house/${guide.regionSlug}`)} className="gap-1">
                  Browse houses in {guide.city} <ArrowRight className="h-4 w-4" />
                </Button>
                <Button variant="outline" className="bg-transparent border-primary-foreground/40 text-primary-foreground hover:bg-primary-foreground/10" onClick={() => navigate('/rent-calculator')}>
                  Rent calculator
                </Button>
              </div>
            </CardContent>
          </Card>
        </section>

        {otherGuides.length > 0 && (
          <section className="mb-4">
            <h2 className="text-lg font-bold mb-3">Compare other Ugandan cities</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {otherGuides.map((g) => (
                <Link key={g.slug} to={`/guides/cost-of-renting-in-${g.slug}`} className="text-sm text-primary hover:underline">
                  Cost of renting in {g.city} {YEAR_LABEL} →
                </Link>
              ))}
            </div>
          </section>
        )}
      </article>
    </div>
  );
}
