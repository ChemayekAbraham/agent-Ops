import { useEffect, useMemo, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Store,
  Ticket,
  CheckCircle2,
  WifiOff,
  XCircle,
  Gift,
  ReceiptText,
  ArrowLeft,
} from 'lucide-react';
import {
  PARTNER_SELLERS,
  getActiveStore,
  setActiveStore,
  findClaimByCode,
  fulfillClaim,
  listRedemptions,
  type PartnerSeller,
  type RedemptionRecord,
  type BreadClaim,
} from '@/lib/welileBreadClaims';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';

/**
 * /seller-portal
 *
 * Standalone, public, ultra-minimal portal for partner sellers (mall
 * cashiers, supermarket clerks, bakery counters) to redeem Welile Bread
 * Claim Codes issued by tenants. Works offline — codes are validated
 * against the same device's localStorage queue and a redemption log is
 * appended on success.
 */
export default function SellerPortal() {
  const [store, setStore] = useState<PartnerSeller | null>(() => getActiveStore());
  const [code, setCode] = useState('');
  const [lookup, setLookup] = useState<BreadClaim | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<RedemptionRecord[]>([]);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);

  useEffect(() => {
    setHistory(listRedemptions());
  }, []);

  useEffect(() => {
    const onChange = () => setOnline(navigator.onLine);
    window.addEventListener('online', onChange);
    window.addEventListener('offline', onChange);
    return () => {
      window.removeEventListener('online', onChange);
      window.removeEventListener('offline', onChange);
    };
  }, []);

  const handleStorePick = (id: string) => {
    setActiveStore(id);
    setStore(PARTNER_SELLERS.find((s) => s.id === id) ?? null);
  };

  const verify = () => {
    setError(null);
    setLookup(null);
    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      setError('Enter the 6-digit code from the customer');
      return;
    }
    const claim = findClaimByCode(trimmed);
    if (!claim) {
      setError('Code not found. Ask the customer to re-open Welile and tap the bread.');
      return;
    }
    if (claim.status === 'fulfilled') {
      setError('This code was already redeemed.');
      return;
    }
    if (claim.status === 'expired' || claim.expiresAt < Date.now()) {
      setError('This code has expired. Ask the customer to generate a new one.');
      return;
    }
    setLookup(claim);
  };

  const release = () => {
    if (!lookup || !store) return;
    const result = fulfillClaim(lookup.code, { id: store.id, name: `${store.name} — ${store.city}` });
    if (result.ok === false) {
      setError(result.reason);
      return;
    }
    const rec = result.record;
    toast.success('Bread released', {
      description:
        rec.freeBreads > 0
          ? `${rec.freeBreads}× free bread · charged UGX 0`
          : `Charged ${formatUGX(rec.payableCharged)}`,
    });
    setHistory(listRedemptions());
    setLookup(null);
    setCode('');
  };

  const reset = () => {
    setLookup(null);
    setCode('');
    setError(null);
  };

  const totalsToday = useMemo(() => {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const today = history.filter((r) => r.fulfilledAt >= dayStart.getTime());
    const free = today.reduce((n, r) => n + (r.freeBreads > 0 ? 1 : 0), 0);
    const discounted = today.length - free;
    return { count: today.length, free, discounted };
  }, [history]);

  // ---------- Store selection screen ----------
  if (!store) {
    return (
      <div className="min-h-screen bg-muted/30">
        <Helmet>
          <title>Welile Seller Portal — Choose your store</title>
          <meta name="description" content="Welile bread claim portal for partner malls, supermarkets and bakeries in Uganda." />
        </Helmet>
        <div className="max-w-md mx-auto px-5 py-8 space-y-6">
          <header className="text-center space-y-1">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-600 text-white shadow-md mx-auto">
              <Store className="h-6 w-6" />
            </div>
            <h1 className="text-2xl font-extrabold tracking-tight">Welile Seller Portal</h1>
            <p className="text-sm text-muted-foreground">
              Pick your store to start releasing bread to customers.
            </p>
          </header>

          <div className="space-y-2">
            {PARTNER_SELLERS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => handleStorePick(s.id)}
                className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-2xl border border-border bg-card hover:border-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 active:scale-[0.99] transition-all text-left"
              >
                <div className="min-w-0">
                  <p className="font-semibold truncate">{s.name}</p>
                  <p className="text-xs text-muted-foreground capitalize">
                    {s.type} · {s.city}
                  </p>
                </div>
                <ArrowLeft className="h-4 w-4 rotate-180 text-muted-foreground" />
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ---------- Redemption screen ----------
  return (
    <div className="min-h-screen bg-muted/30">
      <Helmet>
        <title>Welile Seller Portal — {store.name}</title>
        <meta name="description" content="Redeem Welile bread claim codes." />
      </Helmet>
      <div className="max-w-md mx-auto px-5 py-6 space-y-5">
        {/* Header */}
        <header className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-10 w-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center shadow-sm shrink-0">
              <Store className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Signed in as</p>
              <p className="font-semibold truncate">{store.name}</p>
              <p className="text-[11px] text-muted-foreground capitalize">{store.type} · {store.city}</p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            {!online && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 text-[10px] font-semibold px-2 py-0.5">
                <WifiOff className="h-3 w-3" /> Offline
              </span>
            )}
            <button
              type="button"
              onClick={() => setStore(null)}
              className="text-[11px] text-muted-foreground underline"
            >
              Change store
            </button>
          </div>
        </header>

        {/* Today's summary */}
        <div className="grid grid-cols-3 gap-2">
          <SummaryStat label="Today" value={totalsToday.count} />
          <SummaryStat label="Free" value={totalsToday.free} accent="emerald" />
          <SummaryStat label="Discounted" value={totalsToday.discounted} />
        </div>

        {/* Lookup card */}
        {!lookup ? (
          <section className="rounded-2xl border border-border bg-card p-5 space-y-3">
            <Label htmlFor="claim-code" className="text-xs font-semibold inline-flex items-center gap-1.5">
              <Ticket className="h-3.5 w-3.5" />
              Enter the customer's 6-digit code
            </Label>
            <Input
              id="claim-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="••• •••"
              inputMode="numeric"
              autoFocus
              className="h-14 text-3xl font-extrabold tracking-[0.4em] text-center tabular-nums"
            />
            {error && (
              <p className="text-xs font-medium text-destructive" role="alert">
                {error}
              </p>
            )}
            <Button
              type="button"
              onClick={verify}
              disabled={code.length !== 6}
              className="w-full bg-emerald-600 hover:bg-emerald-700 text-white"
              size="lg"
            >
              Verify code
            </Button>
          </section>
        ) : (
          <section className="rounded-2xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 p-5 space-y-4">
            <div className="flex items-start gap-3">
              {lookup.freeBreads > 0 ? (
                <Gift className="h-6 w-6 text-emerald-600 shrink-0 mt-0.5" />
              ) : (
                <CheckCircle2 className="h-6 w-6 text-emerald-600 shrink-0 mt-0.5" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-emerald-900 dark:text-emerald-100 uppercase tracking-wider">
                  Code valid
                </p>
                <p className="font-mono text-lg font-extrabold text-emerald-950 dark:text-emerald-50 tabular-nums">
                  {lookup.code}
                </p>
              </div>
            </div>

            <dl className="space-y-1.5 text-sm">
              <Row label="Receipt #" value={<span className="font-mono">{lookup.receiptNumber}</span>} />
              <Row label="Receipt amount" value={formatUGX(lookup.receiptAmount)} />
              <Row label="Welile credit (5%)" value={formatUGX(lookup.credit)} />
              {lookup.freeBreads > 0 && (
                <Row label="Free breads" value={`${lookup.freeBreads}×`} accent />
              )}
              <div className="pt-2 mt-1 border-t border-emerald-200 dark:border-emerald-800 flex items-baseline justify-between gap-3">
                <dt className="font-semibold">Charge customer</dt>
                <dd className="text-2xl font-extrabold text-emerald-700 dark:text-emerald-300 tabular-nums">
                  {lookup.freeBreads > 0 ? 'FREE' : formatUGX(lookup.payableForNext)}
                </dd>
              </div>
            </dl>

            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant="outline" size="lg" onClick={reset}>
                <XCircle className="h-4 w-4" />
                Cancel
              </Button>
              <Button
                type="button"
                size="lg"
                onClick={release}
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                <CheckCircle2 className="h-4 w-4" />
                Release bread
              </Button>
            </div>
          </section>
        )}

        {/* Recent redemptions */}
        {history.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <ReceiptText className="h-3.5 w-3.5" />
              Recent redemptions
            </div>
            <ul className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
              {history.slice(0, 8).map((r) => (
                <li key={r.code + r.fulfilledAt} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-bold tabular-nums">{r.code}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {new Date(r.fulfilledAt).toLocaleTimeString()} · {r.storeName}
                    </p>
                  </div>
                  <span
                    className={
                      r.freeBreads > 0
                        ? 'text-xs font-bold text-emerald-700 dark:text-emerald-300'
                        : 'text-xs font-semibold tabular-nums'
                    }
                  >
                    {r.freeBreads > 0 ? 'FREE' : formatUGX(r.payableCharged)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="text-center text-[11px] text-muted-foreground pt-2">
          Welile Seller Portal · works offline · v1
        </p>
      </div>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: 'emerald';
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5 text-center">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </p>
      <p
        className={
          accent === 'emerald'
            ? 'text-xl font-extrabold text-emerald-700 dark:text-emerald-300 tabular-nums'
            : 'text-xl font-extrabold tabular-nums'
        }
      >
        {value}
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={
          accent
            ? 'font-semibold text-emerald-700 dark:text-emerald-300 tabular-nums'
            : 'font-semibold tabular-nums'
        }
      >
        {value}
      </dd>
    </div>
  );
}
