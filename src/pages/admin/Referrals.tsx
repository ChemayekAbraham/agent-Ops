import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  ArrowLeft, RefreshCw, Search, Copy, CheckCircle2, Clock, AlertTriangle,
  Gift, ExternalLink,
} from 'lucide-react';
import { format } from 'date-fns';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import ScreenLoader from '@/components/common/ScreenLoader';

type ReferralRow = {
  id: string;
  referrer_id: string;
  referred_id: string;
  bonus_amount: number;
  credited: boolean;
  credited_at: string | null;
  created_at: string;
  first_transaction_bonus_credited: boolean | null;
  first_transaction_bonus_credited_at: string | null;
  first_transaction_bonus_amount: number | null;
};

type ProfileLite = { id: string; full_name: string | null; phone: string | null };

type LedgerLite = {
  id: string;
  transaction_group_id: string | null;
  source_id: string | null;
  amount: number;
  category: string;
  direction: string;
  description: string | null;
  user_id: string | null;
  created_at: string;
};

type EnrichedReferral = ReferralRow & {
  referrer?: ProfileLite;
  referred?: ProfileLite;
  ledgerEntries: LedgerLite[];
  status: 'credited' | 'pending' | 'error';
  reason: string;
};

const STATUS_META = {
  credited: { label: 'Credited', icon: CheckCircle2, cls: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30' },
  pending:  { label: 'Pending',  icon: Clock,         cls: 'bg-amber-500/10 text-amber-700 border-amber-500/30' },
  error:    { label: 'Error',    icon: AlertTriangle, cls: 'bg-destructive/10 text-destructive border-destructive/30' },
} as const;

export default function AdminReferralsPage() {
  const navigate = useNavigate();
  const { roles, loading: authLoading, role } = useAuth();
  const { toast } = useToast();

  const canAccess = roles.some(r => ['super_admin', 'manager', 'cfo', 'coo', 'cto'].includes(r));

  const [rows, setRows] = useState<EnrichedReferral[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'credited' | 'pending' | 'error'>('all');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!authLoading && !canAccess) navigate(roleToSlug(role), { replace: true });
  }, [authLoading, canAccess, navigate]);

  const load = async () => {
    setLoading(true);
    try {
      const { data: refs, error } = await supabase
        .from('referrals')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;

      const refRows = (refs || []) as ReferralRow[];
      const userIds = Array.from(new Set(refRows.flatMap(r => [r.referrer_id, r.referred_id])));
      const refIds = refRows.map(r => r.id);

      const [{ data: profiles }, { data: ledger }] = await Promise.all([
        userIds.length
          ? supabase.from('profiles').select('id, full_name, phone').in('id', userIds)
          : Promise.resolve({ data: [] as ProfileLite[] } as any),
        refIds.length
          ? supabase
              .from('general_ledger')
              .select('id, transaction_group_id, source_id, amount, category, direction, description, user_id, created_at')
              .eq('source_table', 'referrals')
              .in('source_id', refIds)
          : Promise.resolve({ data: [] as LedgerLite[] } as any),
      ]);

      const profileMap = new Map<string, ProfileLite>();
      (profiles || []).forEach((p: any) => profileMap.set(p.id, p));

      const ledgerMap = new Map<string, LedgerLite[]>();
      (ledger || []).forEach((l: any) => {
        if (!l.source_id) return;
        const arr = ledgerMap.get(l.source_id) || [];
        arr.push(l);
        ledgerMap.set(l.source_id, arr);
      });

      const enriched: EnrichedReferral[] = refRows.map(r => {
        const entries = (ledgerMap.get(r.id) || []).sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
        const ageHours = (Date.now() - new Date(r.created_at).getTime()) / 36e5;
        const hasBonusEntry = entries.some(e => e.category === 'referral_bonus' && e.direction === 'cash_in');

        let status: EnrichedReferral['status'];
        let reason: string;

        if (r.credited && hasBonusEntry) {
          status = 'credited';
          reason = `Trigger credit_signup_referral_bonus posted double-entry ledger at ${
            r.credited_at ? format(new Date(r.credited_at), 'PPp') : 'unknown time'
          }.`;
        } else if (r.credited && !hasBonusEntry) {
          status = 'error';
          reason = 'Marked credited but no matching ledger entry found — possible idempotency skip or ledger desync. Check Postgres logs for "credit_signup_referral_bonus failed".';
        } else if (!r.credited && hasBonusEntry) {
          status = 'error';
          reason = 'Ledger entry exists but referral row not marked credited — UPDATE step inside trigger failed.';
        } else if (r.bonus_amount <= 0) {
          status = 'pending';
          reason = 'Bonus amount is 0 — trigger short-circuits when bonus_amount <= 0. No payout expected.';
        } else if (ageHours < 0.05) {
          status = 'pending';
          reason = 'Just created — trigger may still be running.';
        } else {
          status = 'error';
          reason = 'Trigger trg_credit_signup_referral_bonus did not post a ledger entry. Likely raised a WARNING (e.g. ledger guard, balanced-entry, or wallet error). Check Postgres logs filtered by "credit_signup_referral_bonus failed for referral '+r.id+'".';
        }

        return {
          ...r,
          referrer: profileMap.get(r.referrer_id),
          referred: profileMap.get(r.referred_id),
          ledgerEntries: entries,
          status,
          reason,
        };
      });

      setRows(enriched);
    } catch (e: any) {
      toast({ title: 'Failed to load referrals', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (canAccess) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAccess]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (!q) return true;
      return (
        r.id.toLowerCase().includes(q) ||
        r.referrer_id.toLowerCase().includes(q) ||
        r.referred_id.toLowerCase().includes(q) ||
        r.referrer?.full_name?.toLowerCase().includes(q) ||
        r.referred?.full_name?.toLowerCase().includes(q) ||
        r.referrer?.phone?.toLowerCase().includes(q) ||
        r.referred?.phone?.toLowerCase().includes(q) ||
        r.ledgerEntries.some(e => e.id.toLowerCase().includes(q) || e.transaction_group_id?.toLowerCase().includes(q))
      );
    });
  }, [rows, search, statusFilter]);

  const counts = useMemo(() => {
    const c = { total: rows.length, credited: 0, pending: 0, error: 0, totalUgx: 0 };
    rows.forEach(r => { c[r.status] += 1; if (r.status === 'credited') c.totalUgx += Number(r.bonus_amount || 0); });
    return c;
  }, [rows]);

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => toast({ title: `${label} copied` }));
  };

  if (authLoading) {
    return (
      <ScreenLoader />
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/admin/dashboard'))}
            className="gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <Button size="sm" variant="outline" onClick={load} disabled={loading} className="gap-2">
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        <div>
          <h1 className="text-2xl font-black text-foreground flex items-center gap-2">
            <Gift className="h-6 w-6 text-primary" />
            Referral Bonus Audit
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Per-referral bonus status, linked ledger entries, and the exact trigger reason.
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="p-4">
            <p className="text-xs text-muted-foreground">Total referrals</p>
            <p className="text-2xl font-bold mt-1">{counts.total.toLocaleString()}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-muted-foreground">Credited</p>
            <p className="text-2xl font-bold text-emerald-700 mt-1">{counts.credited.toLocaleString()}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-muted-foreground">Pending</p>
            <p className="text-2xl font-bold text-amber-700 mt-1">{counts.pending.toLocaleString()}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-muted-foreground">Error / Stuck</p>
            <p className="text-2xl font-bold text-destructive mt-1">{counts.error.toLocaleString()}</p>
          </Card>
        </div>

        <Card className="p-4">
          <p className="text-xs text-muted-foreground">Total UGX paid out (credited)</p>
          <p className="text-xl font-bold mt-1">UGX {counts.totalUgx.toLocaleString()}</p>
        </Card>

        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, phone, ID, or ledger ID…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={(v: any) => setStatusFilter(v)}>
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="credited">Credited</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="error">Error</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Card className="overflow-hidden">
          {loading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-12 text-center text-sm text-muted-foreground">No referrals match your filters.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Referrer → Referred</TableHead>
                  <TableHead>Bonus</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Ledger</TableHead>
                  <TableHead className="text-right">Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(r => {
                  const meta = STATUS_META[r.status];
                  const Icon = meta.icon;
                  const isOpen = !!expanded[r.id];
                  const primaryEntry = r.ledgerEntries.find(e => e.category === 'referral_bonus') || r.ledgerEntries[0];
                  return (
                    <Fragment key={r.id}>
                      <TableRow className="align-top">
                        <TableCell>
                          <Badge variant="outline" className={cn('gap-1', meta.cls)}>
                            <Icon className="h-3 w-3" />
                            {meta.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">
                            <p className="font-medium">{r.referrer?.full_name || 'Unknown'}</p>
                            <p className="text-xs text-muted-foreground">{r.referrer?.phone || r.referrer_id.slice(0, 8)}</p>
                            <p className="text-xs text-muted-foreground mt-1">→ {r.referred?.full_name || r.referred_id.slice(0, 8)}</p>
                          </div>
                        </TableCell>
                        <TableCell className="text-sm font-medium">
                          UGX {Number(r.bonus_amount).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {format(new Date(r.created_at), 'PP p')}
                        </TableCell>
                        <TableCell>
                          {primaryEntry ? (
                            <button
                              onClick={() => copy(primaryEntry.id, 'Ledger ID')}
                              className="flex items-center gap-1 text-xs font-mono hover:text-primary"
                              title="Copy ledger entry ID"
                            >
                              {primaryEntry.id.slice(0, 8)}…
                              <Copy className="h-3 w-3" />
                            </button>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="ghost" onClick={() => setExpanded(s => ({ ...s, [r.id]: !s[r.id] }))}>
                            {isOpen ? 'Hide' : 'Inspect'}
                          </Button>
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow className="bg-muted/30">
                          <TableCell colSpan={6} className="p-4">
                            <div className="space-y-3 text-sm">
                              <div>
                                <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-1">
                                  Trigger reason
                                </p>
                                <p className="text-sm">{r.reason}</p>
                              </div>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                                <div className="space-y-1">
                                  <p className="text-muted-foreground">Referral ID</p>
                                  <button onClick={() => copy(r.id, 'Referral ID')} className="font-mono flex items-center gap-1 hover:text-primary">
                                    {r.id} <Copy className="h-3 w-3" />
                                  </button>
                                </div>
                                <div className="space-y-1">
                                  <p className="text-muted-foreground">Credited at</p>
                                  <p>{r.credited_at ? format(new Date(r.credited_at), 'PPp') : '—'}</p>
                                </div>
                              </div>

                              <div>
                                <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">
                                  Ledger entries ({r.ledgerEntries.length})
                                </p>
                                {r.ledgerEntries.length === 0 ? (
                                  <p className="text-xs text-muted-foreground italic">
                                    No ledger entries linked to this referral.
                                  </p>
                                ) : (
                                  <div className="space-y-2">
                                    {r.ledgerEntries.map(e => (
                                      <div key={e.id} className="rounded-lg border bg-background p-3 text-xs">
                                        <div className="flex items-start justify-between gap-2">
                                          <div className="space-y-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                              <Badge variant="outline" className="text-[10px]">{e.category}</Badge>
                                              <Badge variant="outline" className={cn(
                                                'text-[10px]',
                                                e.direction === 'cash_in' ? 'text-emerald-700' : 'text-destructive'
                                              )}>
                                                {e.direction}
                                              </Badge>
                                              <span className="font-medium">UGX {Number(e.amount).toLocaleString()}</span>
                                            </div>
                                            <p className="text-muted-foreground">{e.description || '—'}</p>
                                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground font-mono">
                                              <button onClick={() => copy(e.id, 'Entry ID')} className="hover:text-primary flex items-center gap-1">
                                                entry: {e.id.slice(0, 12)}… <Copy className="h-2.5 w-2.5" />
                                              </button>
                                              {e.transaction_group_id && (
                                                <button onClick={() => copy(e.transaction_group_id!, 'Transaction group')} className="hover:text-primary flex items-center gap-1">
                                                  group: {e.transaction_group_id.slice(0, 12)}… <Copy className="h-2.5 w-2.5" />
                                                </button>
                                              )}
                                              <span>{format(new Date(e.created_at), 'PP p')}</span>
                                            </div>
                                          </div>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Card>

        <p className="text-xs text-muted-foreground">
          Note: trigger errors raise Postgres WARNINGs (not exceptions) so signup never fails. To see exact SQL errors,
          inspect Postgres logs filtered by <span className="font-mono">credit_signup_referral_bonus failed</span> or
          <span className="font-mono"> credit_referral_bonus failed</span>.
          <a href="https://supabase.com/dashboard/project/wirntoujqoyjobfhyelc/logs/postgres-logs"
             target="_blank" rel="noreferrer"
             className="ml-2 inline-flex items-center gap-1 text-primary hover:underline">
            Open logs <ExternalLink className="h-3 w-3" />
          </a>
        </p>
      </div>
    </div>
  );
}
