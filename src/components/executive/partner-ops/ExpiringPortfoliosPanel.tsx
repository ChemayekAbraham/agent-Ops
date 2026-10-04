import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Hourglass, Search, CalendarX2, Inbox, RefreshCw, TrendingUp, Wallet, Mail, Loader2, CheckCircle2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { fetchAllNearingPayoutPortfolios } from '@/lib/supabaseBatchUtils';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/components/ui/sonner';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const EXPIRY_WINDOW_DAYS = 90; // "approaching maturity" = within 3 months

type ExpiringRow = {
  portfolioId: string;
  portfolioCode: string;
  portfolioName: string;
  name: string;
  phone: string;
  amount: number;
  roiPercentage: number;
  monthlyReturn: number;
  durationMonths: number;
  createdAt: string;
  expiry: Date;
  remainingDays: number;
};

function bucketOf(days: number): '0-30' | '31-60' | '61-90' {
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  return '61-90';
}

const BUCKETS: Array<{ key: '0-30' | '31-60' | '61-90'; label: string; tone: string }> = [
  { key: '0-30', label: 'Within 30 days', tone: 'text-rose-600' },
  { key: '31-60', label: '31 – 60 days', tone: 'text-amber-600' },
  { key: '61-90', label: '61 – 90 days', tone: 'text-primary' },
];

function fmtDate(d: Date) {
  return d.toLocaleDateString('en-UG', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Portfolios approaching maturity (contribution date + duration_months within 90 days).
 * Read-only reporting layer — identical maturity logic to the Partner Directory
 * "Portfolios Expiring Soon" dialog.
 */
export function ExpiringPortfoliosPanel() {
  const [search, setSearch] = useState('');

  /* ─── Bulk-send the "Maturity Notice" email to every partner expiring soon. ─── */
  const [sendingNotices, setSendingNotices] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmPortfolioIds, setConfirmPortfolioIds] = useState<string[]>([]);
  type NoticeProgress = {
    queued: number; sent: number; skipped: number;
    suppressed: number; rateLimited: number; failed: number; processed: number;
    done: boolean;
  };
  const [progress, setProgress] = useState<NoticeProgress | null>(null);

  function openMaturityConfirm() {
    const portfolioIds = Array.from(new Set(filtered.map(p => p.portfolioId).filter(Boolean)));
    if (portfolioIds.length === 0) {
      toast.info('No portfolios to notify');
      return;
    }
    setConfirmPortfolioIds(portfolioIds);
    setConfirmOpen(true);
  }

  async function handleConfirmSend() {
    setConfirmOpen(false);
    if (sendingNotices || confirmPortfolioIds.length === 0) return;
    setSendingNotices(true);
    setProgress({ queued: confirmPortfolioIds.length, sent: 0, skipped: 0, suppressed: 0, rateLimited: 0, failed: 0, processed: 0, done: false });
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const apikey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/bulk-send-maturity-notice`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'apikey': apikey,
        },
        body: JSON.stringify({ portfolioIds: confirmPortfolioIds, stream: true }),
      });
      if (!res.ok || !res.body) {
        const txt = await res.text().catch(() => '');
        throw new Error(txt || `Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let last: any = null;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let evt: any;
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt.type === 'error') throw new Error(evt.error || 'Send failed');
          last = evt;
          setProgress({
            queued: evt.queued ?? confirmPortfolioIds.length,
            sent: evt.sent ?? 0,
            skipped: evt.skipped ?? 0,
            suppressed: evt.suppressed ?? 0,
            rateLimited: evt.rateLimited ?? 0,
            failed: evt.failed ?? 0,
            processed: evt.processed ?? 0,
            done: evt.type === 'done',
          });
        }
      }

      const sent = last?.sent ?? 0;
      const skipped = last?.skipped ?? 0;
      const suppressed = last?.suppressed ?? 0;
      const rateLimited = last?.rateLimited ?? 0;
      const failed = last?.failed ?? 0;
      toast.success(`Maturity notices sent: ${sent}`, {
        description: `${skipped} skipped (no email), ${suppressed} suppressed, ${rateLimited} rate-limited, ${failed} failed.`,
      });
    } catch (e: any) {
      console.error('Bulk maturity notice failed', e);
      toast.error(e?.message || 'Failed to send maturity notices');
      setProgress(prev => (prev ? { ...prev, done: true } : prev));
    } finally {
      setSendingNotices(false);
      setConfirmPortfolioIds([]);
    }
  }

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['partner-ops-expiring-portfolios'],
    staleTime: 60_000,
    queryFn: async (): Promise<ExpiringRow[]> => {
      const { portfolios, profileMap, supporterIds } = await fetchAllNearingPayoutPortfolios();
      const rows: ExpiringRow[] = [];
      portfolios.forEach((p: any) => {
        if (p.status !== 'active' && p.status != null) return;
        const ownerId = p.investor_id && supporterIds.has(p.investor_id) ? p.investor_id
          : p.agent_id && supporterIds.has(p.agent_id) ? p.agent_id : null;
        if (!ownerId) return;

        const expiry = new Date(p.created_at);
        expiry.setMonth(expiry.getMonth() + (Number(p.duration_months) || 12));
        const remainingDays = Math.ceil((expiry.getTime() - Date.now()) / 86400000);
        if (remainingDays < 0 || remainingDays > EXPIRY_WINDOW_DAYS) return;

        const profile = profileMap.get(ownerId);
        const amount = Number(p.investment_amount) || 0;
        const roiPercentage = p.roi_percentage ?? 15;
        rows.push({
          portfolioId: p.id,
          portfolioCode: p.portfolio_code,
          portfolioName: p.account_name || p.portfolio_code,
          name: profile?.full_name || 'Unknown partner',
          phone: profile?.phone || '',
          amount,
          roiPercentage,
          monthlyReturn: Math.round(amount * roiPercentage / 100),
          durationMonths: Number(p.duration_months) || 12,
          createdAt: p.created_at,
          expiry,
          remainingDays,
        });
      });
      return rows.sort((a, b) => a.remainingDays - b.remainingDays);
    },
  });

  const rows = data ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      r.name.toLowerCase().includes(q) ||
      r.portfolioName.toLowerCase().includes(q) ||
      r.portfolioCode.toLowerCase().includes(q) ||
      r.phone.toLowerCase().includes(q)
    );
  }, [rows, search]);

  const totals = useMemo(() => {
    const principal = filtered.reduce((s, r) => s + r.amount, 0);
    const monthly = filtered.reduce((s, r) => s + r.monthlyReturn, 0);
    const byBucket = { '0-30': 0, '31-60': 0, '61-90': 0 } as Record<'0-30' | '31-60' | '61-90', number>;
    const amtByBucket = { '0-30': 0, '31-60': 0, '61-90': 0 } as Record<'0-30' | '31-60' | '61-90', number>;
    filtered.forEach(r => {
      const b = bucketOf(r.remainingDays);
      byBucket[b] += 1;
      amtByBucket[b] += r.amount;
    });
    return {
      principal,
      monthly,
      byBucket,
      amtByBucket,
      soonest: filtered.length ? filtered[0].remainingDays : null,
    };
  }, [filtered]);

  return (
    <div className="space-y-4">
      <Card className="border-rose-500/20">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-xl bg-rose-500/10 text-rose-600">
                <Hourglass className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-base">Portfolios Approaching Maturity</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Active portfolios reaching maturity within the next 3 months (contribution date + duration).
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {filtered.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 gap-1.5 text-xs"
                  onClick={openMaturityConfirm}
                  disabled={sendingNotices}
                >
                  {sendingNotices ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}
                  {sendingNotices ? 'Sending…' : `Send Maturity Notice to ${filtered.length} Portfolio${filtered.length === 1 ? '' : 's'}`}
                </Button>
              )}
              <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={() => refetch()} disabled={isFetching}>
                <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} /> Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Financial summary */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <SummaryStat icon={<CalendarX2 className="h-4 w-4" />} label="Maturing Portfolios" value={String(filtered.length)}
              sub={totals.soonest === null ? 'None in window' : `Soonest in ${totals.soonest} day${totals.soonest === 1 ? '' : 's'}`} />
            <SummaryStat icon={<Wallet className="h-4 w-4" />} label="Principal at Maturity" value={formatUGX(totals.principal)}
              sub="Capital requiring renewal or payout" />
            <SummaryStat icon={<TrendingUp className="h-4 w-4" />} label="Monthly Returns Exposure" value={formatUGX(totals.monthly)}
              sub="Current monthly obligation on these portfolios" />
            <SummaryStat icon={<Hourglass className="h-4 w-4" />} label="Critical (≤30 days)" value={String(totals.byBucket['0-30'])}
              sub={formatUGX(totals.amtByBucket['0-30'])} tone="rose" />
          </div>

          {/* Ageing band breakdown */}
          <div className="grid grid-cols-3 gap-3">
            {BUCKETS.map(b => (
              <div key={b.key} className="rounded-xl border p-2.5">
                <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">{b.label}</p>
                <p className={cn('text-sm font-black tabular-nums mt-1', b.tone)}>{totals.byBucket[b.key]}</p>
                <p className="text-[10px] text-muted-foreground tabular-nums">{formatUGX(totals.amtByBucket[b.key])}</p>
              </div>
            ))}
          </div>

          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search partner, portfolio code or phone…"
              className="pl-8 h-9 text-sm"
            />
          </div>

          {isLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Loading maturity schedule…</div>
          ) : filtered.length === 0 ? (
            <div className="py-12 flex flex-col items-center justify-center text-center gap-2">
              <div className="p-3 rounded-2xl bg-muted text-muted-foreground"><Inbox className="h-6 w-6" /></div>
              <p className="text-sm font-semibold">No portfolios approaching maturity</p>
              <p className="text-xs text-muted-foreground max-w-sm">
                No active portfolio matures within the next 90 days{search ? ' for this search' : ''}.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left">
                    <Th>Partner</Th>
                    <Th>Portfolio</Th>
                    <Th className="text-right">Principal</Th>
                    <Th className="text-right">Monthly Return</Th>
                    <Th className="text-right">Rate</Th>
                    <Th className="text-right">Term</Th>
                    <Th>Maturity Date</Th>
                    <Th className="text-right">Days Left</Th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(r => {
                    const b = bucketOf(r.remainingDays);
                    return (
                      <tr key={r.portfolioId} className="border-t hover:bg-muted/30">
                        <Td>
                          <p className="font-semibold leading-tight">{r.name}</p>
                          {r.phone && <p className="text-[11px] text-muted-foreground">{r.phone}</p>}
                        </Td>
                        <Td>
                          <p className="leading-tight">{r.portfolioName}</p>
                          <p className="text-[11px] text-muted-foreground font-mono">{r.portfolioCode}</p>
                        </Td>
                        <Td className="text-right tabular-nums font-semibold">{formatUGX(r.amount)}</Td>
                        <Td className="text-right tabular-nums">{formatUGX(r.monthlyReturn)}</Td>
                        <Td className="text-right tabular-nums">{r.roiPercentage}%</Td>
                        <Td className="text-right tabular-nums">{r.durationMonths} mo</Td>
                        <Td className="whitespace-nowrap">{fmtDate(r.expiry)}</Td>
                        <Td className="text-right">
                          <Badge variant="outline" className={cn(
                            'tabular-nums',
                            b === '0-30' && 'border-rose-500/40 text-rose-600 bg-rose-500/5',
                            b === '31-60' && 'border-amber-500/40 text-amber-600 bg-amber-500/5',
                          )}>
                            {r.remainingDays}d
                          </Badge>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-muted/40 font-semibold">
                  <tr className="border-t">
                    <Td colSpan={2}>Total · {filtered.length} portfolio{filtered.length === 1 ? '' : 's'}</Td>
                    <Td className="text-right tabular-nums">{formatUGX(totals.principal)}</Td>
                    <Td className="text-right tabular-nums">{formatUGX(totals.monthly)}</Td>
                    <Td colSpan={4} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {progress && (
            <div className="rounded-xl border border-border bg-muted/30 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold flex items-center gap-1.5">
                  {progress.done
                    ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                    : <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
                  {progress.done ? 'Maturity notices complete' : 'Sending maturity notices…'}
                </p>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {progress.processed}/{progress.queued}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
                <div
                  className={cn('h-full rounded-full transition-all', progress.done ? 'bg-emerald-500' : 'bg-primary')}
                  style={{ width: `${progress.queued ? Math.round((progress.processed / progress.queued) * 100) : 0}%` }}
                />
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 pt-0.5">
                {([
                  ['Queued', progress.queued, 'text-muted-foreground'],
                  ['Sent', progress.sent, 'text-emerald-600'],
                  ['Skipped', progress.skipped, 'text-amber-600'],
                  ['Suppressed', progress.suppressed, 'text-muted-foreground'],
                  ['Rate-limited', progress.rateLimited, 'text-orange-600'],
                  ['Failed', progress.failed, 'text-rose-600'],
                ] as const).map(([label, value, tone]) => (
                  <div key={label} className="rounded-lg bg-background border border-border px-2 py-1.5 text-center">
                    <p className={cn('text-base font-bold tabular-nums leading-none', tone)}>{value}</p>
                    <p className="text-[9px] uppercase tracking-wide text-muted-foreground mt-1">{label}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send Maturity Notices</AlertDialogTitle>
            <AlertDialogDescription>
              You are about to send the <strong>"Maturity Notice"</strong> email for{' '}
              <strong>{confirmPortfolioIds.length} expiring portfolio{confirmPortfolioIds.length === 1 ? '' : 's'}</strong> listed here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmPortfolioIds([])}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmSend} disabled={sendingNotices}>
              {sendingNotices ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                  Sending…
                </>
              ) : (
                <>Send {confirmPortfolioIds.length} Notice{confirmPortfolioIds.length === 1 ? '' : 's'}</>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SummaryStat({ icon, label, value, sub, tone }: {
  icon: React.ReactNode; label: string; value: string; sub: string; tone?: 'rose';
}) {
  return (
    <div className={cn('rounded-2xl border p-3.5 space-y-1.5', tone === 'rose' ? 'border-rose-500/30 bg-rose-500/5' : 'bg-card')}>
      <div className="flex items-center gap-2">
        <div className={cn('p-1.5 rounded-lg', tone === 'rose' ? 'bg-rose-500/10 text-rose-600' : 'bg-primary/10 text-primary')}>{icon}</div>
        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{label}</span>
      </div>
      <p className="text-lg font-black tracking-tight tabular-nums">{value}</p>
      <p className="text-[11px] text-muted-foreground leading-snug">{sub}</p>
    </div>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th className={cn('px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground', className)}>{children}</th>;
}
function Td({ children, className, colSpan }: { children?: React.ReactNode; className?: string; colSpan?: number }) {
  return <td colSpan={colSpan} className={cn('px-3 py-2.5 align-top', className)}>{children}</td>;
}
