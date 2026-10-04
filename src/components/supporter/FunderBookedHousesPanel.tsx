import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CalendarClock, CheckCircle2, Clock, Home, Loader2, RotateCcw, Wallet } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';

interface Booking {
  intent_id: string;
  note_id: string;
  house_id: string;
  title: string;
  district: string;
  verified: boolean;
  monthly_rent: number;
  status: string;
  promised_funding_date: string | null;
  reserved_until: string | null;
  released_at: string | null;
  release_reason: string | null;
  funded_at: string | null;
  days_left: number | null;
  created_at: string;
}

const dateLabel = (iso: string | null) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return '—';
  }
};

/**
 * A Supporter's own empty-house bookings: houses held for 7 days, houses already
 * funded, and houses that went back to the open list. Funding and releasing both
 * run through server-side RPCs — nothing moves money in the client.
 */
export function FunderBookedHousesPanel() {
  const [rows, setRows] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyHouse, setBusyHouse] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('funder_booked_houses');
    if (error) {
      console.error('[FunderBookedHousesPanel]', error.message);
      setRows([]);
    } else {
      const payload = (data ?? {}) as { bookings?: Booking[] };
      setRows(Array.isArray(payload.bookings) ? payload.bookings : []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const handler = () => { void load(); };
    window.addEventListener('supporter-contribution-changed', handler);
    return () => window.removeEventListener('supporter-contribution-changed', handler);
  }, [load]);

  const fundOne = async (b: Booking) => {
    setBusyHouse(b.house_id);
    try {
      const { error } = await supabase.rpc('funder_fund_booked_houses', {
        p_house_ids: [b.house_id],
        p_term_months: 1,
        p_idempotency_key: `fund-${b.intent_id}`,
      });
      if (error) throw error;
      void supabase.functions.invoke('notify-house-booking', { body: { note_id: b.note_id } }).catch(() => {});
      toast.success('Funding submitted for operational review');
      window.dispatchEvent(new Event('supporter-contribution-changed'));
      await load();
    } catch (err: unknown) {
      const raw = String((err as { message?: string })?.message || 'Could not fund this house');
      toast.error(
        raw.includes('AGREEMENT_REQUIRED')
          ? 'Please sign your partnership agreement first.'
          : raw.includes('BOOKING_NOT_FOUND')
            ? 'This hold is no longer active. Refresh and book again.'
            : raw,
      );
    } finally {
      setBusyHouse(null);
    }
  };

  const releaseOne = async (b: Booking) => {
    setBusyHouse(b.house_id);
    try {
      const { error } = await supabase.rpc('funder_release_booked_houses', {
        p_house_ids: [b.house_id],
        p_reason: 'given_up_by_funder',
      });
      if (error) throw error;
      void supabase.functions.invoke('notify-house-booking', { body: { note_id: b.note_id } }).catch(() => {});
      toast.success('House returned to the open empty-house list');
      await load();
    } catch (err: unknown) {
      toast.error(String((err as { message?: string })?.message || 'Could not release this house'));
    } finally {
      setBusyHouse(null);
    }
  };

  if (loading) {
    return (
      <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    );
  }

  if (rows.length === 0) return null;

  const held = rows.filter((r) => r.status === 'reserved');
  const heldRent = held.reduce((s, r) => s + Number(r.monthly_rent || 0), 0);

  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">My booked houses</p>
          <p className="text-sm font-black text-foreground">
            {held.length} held · {formatUGX(heldRent)} to fund
          </p>
        </div>
        <Home className="h-4 w-4 text-primary shrink-0" />
      </div>

      <div className="space-y-2">
        {rows.map((b) => {
          const isHeld = b.status === 'reserved';
          const isFunded = b.status === 'funded';
          return (
            <div key={b.intent_id} className="rounded-xl border border-border/60 bg-muted/25 p-3 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-bold text-foreground truncate">{b.title}</p>
                  <p className="text-[11px] text-muted-foreground truncate">{b.district || '—'}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs font-black text-foreground">{formatUGX(b.monthly_rent)}</p>
                  <p className="text-[10px] font-semibold text-success">
                    +{formatUGX(Math.round(Number(b.monthly_rent || 0) * 0.15))}/mo
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {isHeld && (
                  <Badge variant="secondary" className="gap-1 text-[10px] font-semibold">
                    <Clock className="h-3 w-3" />
                    Held · {b.days_left ?? 0} day{(b.days_left ?? 0) === 1 ? '' : 's'} left
                  </Badge>
                )}
                {isFunded && (
                  <Badge className="gap-1 text-[10px] font-semibold">
                    <CheckCircle2 className="h-3 w-3" /> Funding submitted
                  </Badge>
                )}
                {b.status === 'released' && (
                  <Badge variant="outline" className="gap-1 text-[10px] font-semibold">
                    <RotateCcw className="h-3 w-3" />
                    {b.release_reason === 'hold_expired_7_days' ? 'Hold lapsed' : 'Released'} ·{' '}
                    {dateLabel(b.released_at)}
                  </Badge>
                )}
                {b.promised_funding_date && isHeld && (
                  <Badge variant="outline" className="gap-1 text-[10px] font-semibold">
                    <CalendarClock className="h-3 w-3" /> Promised {dateLabel(b.promised_funding_date)}
                  </Badge>
                )}
              </div>

              {isHeld && (
                <div className="grid grid-cols-2 gap-2 pt-0.5">
                  <Button
                    variant="outline"
                    className="h-9 gap-1.5 rounded-xl text-[11px] font-bold"
                    disabled={busyHouse === b.house_id}
                    onClick={() => releaseOne(b)}
                  >
                    {busyHouse === b.house_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    Give up
                  </Button>
                  <Button
                    className="h-9 gap-1.5 rounded-xl text-[11px] font-bold"
                    disabled={busyHouse === b.house_id}
                    onClick={() => fundOne(b)}
                  >
                    {busyHouse === b.house_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wallet className="h-3.5 w-3.5" />}
                    Fund now
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-[10px] leading-relaxed text-muted-foreground">
        Houses are held for 7 days. If a hold lapses, the house goes back to the open empty-house list for
        other Supporters and we notify you by SMS and email.
      </p>
    </div>
  );
}
