import { useEffect, useMemo, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  BadgePercent,
  Gift,
  Store,
  Ticket,
  Copy,
  Share2,
  ArrowRight,
  Clock,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { decodeSharedClaim, type SharedClaimPayload } from '@/lib/welileBreadClaims';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';

/**
 * /bread/:code
 *
 * Public, no-login landing page that the recipient of a shared bread
 * claim opens. The claim payload is encoded in the URL hash so the page
 * works fully offline and needs zero backend lookups.
 */
export default function SharedBreadClaim() {
  const { code } = useParams<{ code: string }>();
  const [now, setNow] = useState(Date.now());

  // Decode the payload from the URL hash (#<base64url>).
  const payload: SharedClaimPayload | null = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const raw = window.location.hash.replace(/^#/, '');
    if (!raw) return null;
    return decodeSharedClaim(raw);
  }, []);

  // Live countdown for the 30-min expiry window.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const expired = payload ? payload.expiresAt < now : false;
  const minutesLeft = payload ? Math.max(0, Math.floor((payload.expiresAt - now) / 60000)) : 0;
  const secondsLeft = payload
    ? Math.max(0, Math.floor(((payload.expiresAt - now) % 60000) / 1000))
    : 0;

  const copyCode = async () => {
    if (!payload) return;
    try {
      await navigator.clipboard.writeText(payload.code);
      toast.success('Code copied');
    } catch {
      /* noop */
    }
  };

  const reshare = async () => {
    if (!payload) return;
    const url = window.location.href;
    const text =
      `🎁 Free bread on Welile\n` +
      `Pick up at ${payload.sellerName}\n` +
      `Code: ${payload.code}\n${url}`;
    try {
      if ((navigator as any).share) {
        await (navigator as any).share({ title: 'Free bread from Welile', text, url });
        return;
      }
      await navigator.clipboard.writeText(text);
      toast.success('Link copied');
    } catch {
      /* dismissed */
    }
  };

  // Empty / invalid link
  if (!payload || !code) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-5">
        <Helmet>
          <title>Bread claim · Welile</title>
          <meta name="description" content="Open your shared Welile bread claim." />
        </Helmet>
        <div className="max-w-sm w-full text-center space-y-4">
          <div className="mx-auto h-14 w-14 rounded-2xl bg-muted flex items-center justify-center">
            <XCircle className="h-7 w-7 text-muted-foreground" />
          </div>
          <h1 className="text-xl font-bold">This bread link is invalid</h1>
          <p className="text-sm text-muted-foreground">
            The link is missing details. Ask the sender to share it again.
          </p>
          <Button asChild variant="outline" className="w-full">
            <Link to="/">Go to Welile</Link>
          </Button>
        </div>
      </div>
    );
  }

  const isFree = payload.freeBreads > 0;

  return (
    <div className="min-h-screen bg-gradient-to-b from-emerald-50 to-background dark:from-emerald-950/30 dark:to-background">
      <Helmet>
        <title>{isFree ? 'Free bread for you' : 'Discounted bread for you'} · Welile</title>
        <meta
          name="description"
          content={`Pick up your bread at ${payload.sellerName}. Show code ${payload.code} at the till.`}
        />
      </Helmet>

      <div className="max-w-md mx-auto px-5 pt-8 pb-16 space-y-5">
        {/* Header */}
        <header className="flex items-center gap-2.5">
          <div className="h-10 w-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center shadow-sm">
            <BadgePercent className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
              Welile Bread
            </p>
            <h1 className="text-base font-semibold leading-tight">
              {payload.from ? `${payload.from} sent you bread` : 'Someone sent you bread'}
            </h1>
          </div>
        </header>

        {/* Hero card */}
        <section className="rounded-3xl border border-emerald-200 dark:border-emerald-800 bg-card p-6 shadow-sm space-y-5">
          <div className="text-center space-y-2">
            <div className="mx-auto h-14 w-14 rounded-2xl bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center">
              {isFree ? (
                <Gift className="h-7 w-7 text-emerald-700 dark:text-emerald-300" />
              ) : (
                <BadgePercent className="h-7 w-7 text-emerald-700 dark:text-emerald-300" />
              )}
            </div>
            <p className="text-3xl font-extrabold text-emerald-700 dark:text-emerald-300 tabular-nums">
              {isFree
                ? `${payload.freeBreads}× FREE`
                : `Pay ${formatUGX(payload.payableForNext)}`}
            </p>
            <p className="text-sm text-muted-foreground">
              {isFree ? 'bread waiting for you' : 'for one fresh loaf'}
            </p>
          </div>

          {/* Code */}
          <div className="rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 px-4 py-5 text-center">
            <p className="text-[11px] uppercase tracking-wider text-emerald-800 dark:text-emerald-300 font-semibold inline-flex items-center gap-1.5">
              <Ticket className="h-3.5 w-3.5" />
              Show this code at the till
            </p>
            <div className="mt-2 text-4xl font-extrabold tracking-[0.4em] text-emerald-700 dark:text-emerald-300 tabular-nums select-all">
              {payload.code}
            </div>
            <p
              className={`mt-2 text-[11px] inline-flex items-center gap-1 font-semibold ${
                expired
                  ? 'text-destructive'
                  : 'text-muted-foreground'
              }`}
            >
              <Clock className="h-3 w-3" />
              {expired
                ? 'Code expired — ask sender for a new one'
                : `Expires in ${minutesLeft}m ${secondsLeft.toString().padStart(2, '0')}s`}
            </p>
          </div>

          {/* Pickup location */}
          <div className="rounded-xl border border-border bg-muted/40 p-4 flex items-start gap-3">
            <Store className="h-5 w-5 text-foreground shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                Pick up at
              </p>
              <p className="font-semibold text-foreground truncate">{payload.sellerName}</p>
            </div>
          </div>

          {/* Steps */}
          <ol className="space-y-2 text-sm">
            {[
              'Walk into the store above',
              'Show this 6-digit code at the till',
              isFree ? 'Take your free bread — no payment' : `Pay ${formatUGX(payload.payableForNext)} — that's it`,
            ].map((step, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <span className="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-emerald-600 text-white text-[11px] font-bold flex items-center justify-center">
                  {i + 1}
                </span>
                <span className="text-foreground">{step}</span>
              </li>
            ))}
          </ol>

          {/* Actions */}
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" size="lg" onClick={copyCode} disabled={expired}>
              <Copy className="h-4 w-4" />
              Copy code
            </Button>
            <Button
              type="button"
              size="lg"
              onClick={reshare}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              disabled={expired}
            >
              <Share2 className="h-4 w-4" />
              Share
            </Button>
          </div>
        </section>

        {/* Footer / brand */}
        <div className="rounded-2xl border border-border bg-card p-4 flex items-center gap-3">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <p className="text-xs text-muted-foreground flex-1">
            No app, no signup — just walk in and show the code. Powered by Welile.
          </p>
          <Button asChild variant="ghost" size="sm">
            <Link to="/">
              Welile <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}