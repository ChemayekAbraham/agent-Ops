import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import {
  CalendarCheck,
  HandCoins,
  Home,
  Link2,
  MessageCircle,
  Send,
  ShieldCheck,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatUGX } from '@/lib/currencyFormat';
import { fetchPublicSupportPlan, type PublicSupportPlan } from '@/lib/publicSupportPlan';
import { toast } from 'sonner';

const POINTS = [
  { icon: HandCoins, text: 'You support a tenant — you earn 15% of their rent.' },
  { icon: CalendarCheck, text: 'Support once, earn for 12 months.' },
  { icon: ShieldCheck, text: 'Welile provides an operational guarantee for every tenant you support.' },
];

const HOW_STEPS = [
  { icon: Wallet, text: 'Deposit to your Welile wallet' },
  { icon: TrendingUp, text: 'Tap Fund' },
  { icon: Send, text: 'Welile sends the money straight to the landlord.' },
];

function buildShareMessage(plan: PublicSupportPlan, link: string): string {
  const who = plan.tenantFirstName || 'a tenant';
  return `Help ${who} keep their home. Support their rent on Welile and earn 15% of the rent monthly for 12 months, with Welile's operational guarantee. See the plan: ${link}`;
}

export default function SupportPlanPublic() {
  const { planId } = useParams<{ planId: string }>();
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'unavailable' }
    | { kind: 'ready'; plan: PublicSupportPlan }
  >({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    if (!planId) {
      setState({ kind: 'unavailable' });
      return;
    }
    fetchPublicSupportPlan(planId).then((result) => {
      if (cancelled) return;
      setState(result.status === 'available' ? { kind: 'ready', plan: result.plan } : { kind: 'unavailable' });
    });
    return () => {
      cancelled = true;
    };
  }, [planId]);

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://welileapp.com';
  const link = `${origin}/support/${planId ?? ''}`;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy the link');
    }
  };

  if (state.kind === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Loading this support plan…</p>
      </div>
    );
  }

  if (state.kind === 'unavailable') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <Home className="h-12 w-12 text-muted-foreground" />
        <h1 className="text-xl font-bold">This plan is no longer available</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          It may already be fully supported, or the link may be out of date. There are always more
          tenants who need support.
        </p>
        <Button asChild className="min-h-[48px] rounded-xl px-6">
          <Link to="/dashboard/funder-new">See homes that need support</Link>
        </Button>
      </div>
    );
  }

  const { plan } = state;
  const message = buildShareMessage(plan, link);
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;
  // Signed-out visitors sign up / log in, then land on the funder dashboard
  // with ?plan= so this exact plan opens automatically.
  const fundRedirect = `/dashboard/funder-new?plan=${encodeURIComponent(`ready:${plan.planId}`)}`;
  const authUrl = `/auth?redirect=${encodeURIComponent(fundRedirect)}&role=supporter`;
  const title = `Support ${plan.tenantFirstName ?? 'a tenant'}'s rent — Welile`;
  const description = `Turn rent into an asset. Support this tenant's rent once and earn 15% of their rent every month for 12 months.`;

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>{title}</title>
        <meta name="description" content={description} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={link} />
        {plan.photoUrl ? <meta property="og:image" content={plan.photoUrl} /> : null}
        <meta name="twitter:card" content="summary_large_image" />
      </Helmet>

      <main className="mx-auto w-full max-w-xl space-y-6 px-4 pb-32 pt-6">
        <div className="aspect-video w-full overflow-hidden rounded-2xl bg-primary/10">
          {plan.photoUrl ? (
            <img src={plan.photoUrl} alt="House photo" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-primary">
              <Home className="h-12 w-12" />
              <span className="text-sm text-muted-foreground">Photo coming soon</span>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">Turn rent into an asset</h1>
          <p className="text-base leading-relaxed text-muted-foreground">
            Support {plan.tenantFirstName ?? 'this tenant'}'s rent once. Earn 15% of their rent
            every month for the next 12 months.
          </p>
          {plan.city ? (
            <p className="text-sm text-muted-foreground">
              {plan.houseCategory ? `${plan.houseCategory} · ` : ''}
              {plan.city}
            </p>
          ) : null}
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-2xl bg-muted/40 p-3 text-center">
            <p className="text-xs text-muted-foreground">Support</p>
            <p className="text-sm font-bold sm:text-base">{formatUGX(plan.fundingAmount)}</p>
          </div>
          <div className="rounded-2xl bg-muted/40 p-3 text-center">
            <p className="text-xs text-muted-foreground">Monthly at 15%</p>
            <p className="text-sm font-bold sm:text-base">{formatUGX(plan.monthlyReturn)}</p>
          </div>
          <div className="rounded-2xl bg-muted/40 p-3 text-center">
            <p className="text-xs text-muted-foreground">Over 12 months</p>
            <p className="text-sm font-bold sm:text-base">{formatUGX(plan.twelveMonthTotal)}</p>
          </div>
        </div>

        <ul className="space-y-3">
          {POINTS.map((p) => (
            <li key={p.text} className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
                <p.icon className="h-5 w-5" />
              </span>
              <span className="pt-1.5 text-base">{p.text}</span>
            </li>
          ))}
        </ul>

        <div className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            How it works
          </h2>
          <ol className="space-y-2">
            {HOW_STEPS.map((step, i) => (
              <li key={step.text} className="flex items-center gap-3 rounded-2xl bg-muted/40 p-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
                  {i + 1}
                </span>
                <step.icon className="h-5 w-5 shrink-0 text-primary" />
                <span className="text-sm sm:text-base">{step.text}</span>
              </li>
            ))}
          </ol>
        </div>

        <div className="space-y-2">
          <a
            href={whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-success px-4 text-base font-semibold text-success-foreground shadow-sm hover:opacity-90"
          >
            <MessageCircle className="h-5 w-5" />
            Share on WhatsApp
          </a>
          <Button variant="outline" className="h-11 w-full rounded-xl text-sm" onClick={copyLink}>
            <Link2 className="h-4 w-4" />
            Copy link
          </Button>
        </div>
      </main>

      <div className="fixed inset-x-0 bottom-0 border-t border-border/60 bg-background/95 p-4 backdrop-blur">
        <div className="mx-auto w-full max-w-xl">
          <Button asChild className="min-h-[52px] w-full rounded-xl text-base font-semibold">
            <Link to={authUrl}>Support this tenant</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
