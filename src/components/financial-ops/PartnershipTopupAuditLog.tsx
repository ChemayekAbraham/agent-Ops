import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Loader2, ScrollText, PiggyBank, Building2, ArrowDownRight, ArrowUpRight,
  CheckCircle2, AlertTriangle, User2, ChevronRight, KeyRound,
} from 'lucide-react';
import { format } from 'date-fns';

type FundSource = 'withdrawable' | 'float';

interface LedgerLeg {
  id: string;
  amount: number;
  direction: string;
  category: string;
  ledger_scope: string | null;
  recipient_type: string | null;
  wallet_bucket: string | null;
  user_id: string | null;
  linked_party: string | null;
  description: string | null;
  created_at: string;
  transaction_date: string | null;
  reference_id: string | null;
  source_table: string | null;
  source_id: string | null;
  account: string | null;
  classification: string | null;
  currency: string | null;
  routing_source: string | null;
  idempotency_key: string | null;
  transaction_group_id: string | null;
}

interface TopupRow {
  id: string;
  amount: number;
  status: string;
  created_at: string;
  transaction_group_id: string | null;
  portfolio_id: string | null;
  portfolio_code: string;
  account_name: string | null;
  partner_id: string | null;
  partner_name: string;
  fund_source: FundSource;
  recipient_type: string;
  payment_method: string;
  source_wallet_owner: string;
  reason: string | null;
  legs: LedgerLeg[];
  idempotency_key: string | null;
  metadata: Record<string, any>;
}

/**
 * Read-only audit log of partnership-ops portfolio top-ups.
 * For each top-up it surfaces the selected fund_source (Personal Deposit /
 * Operational Float), the resolved recipient_type that routes the wallet
 * bucket, and BOTH balanced ledger legs (wallet cash_out + platform cash_in)
 * so an operator can verify a top-up at a glance without a SQL query.
 */
export function PartnershipTopupAuditLog() {
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['partnership-topup-audit-log'],
    queryFn: async (): Promise<TopupRow[]> => {
      const { data: ops, error } = await supabase
        .from('pending_wallet_operations')
        .select('id, amount, status, created_at, transaction_group_id, source_id, user_id, description, metadata')
        .eq('source_table', 'investor_portfolios')
        .eq('operation_type', 'portfolio_topup')
        .order('created_at', { ascending: false })
        .limit(100);

      if (error || !ops || ops.length === 0) return [];

      const groupIds = [...new Set(ops.map((o) => o.transaction_group_id).filter(Boolean))] as string[];
      const portfolioIds = [...new Set(ops.map((o) => o.source_id).filter(Boolean))] as string[];
      const partnerIds = [...new Set(ops.map((o) => o.user_id).filter(Boolean))] as string[];

      const [legRes, portfolioRes, profileRes] = await Promise.all([
        groupIds.length
          ? supabase
              .from('general_ledger')
              .select('id, amount, direction, category, ledger_scope, recipient_type, wallet_bucket, user_id, linked_party, description, created_at, transaction_date, reference_id, source_table, source_id, account, classification, currency, routing_source, idempotency_key, transaction_group_id')
              .in('transaction_group_id', groupIds)
          : Promise.resolve({ data: [] as any[] }),
        portfolioIds.length
          ? supabase
              .from('investor_portfolios')
              .select('id, portfolio_code, account_name')
              .in('id', portfolioIds)
          : Promise.resolve({ data: [] as any[] }),
        partnerIds.length
          ? supabase
              .from('profiles')
              .select('id, full_name')
              .in('id', partnerIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);

      const legsByGroup = new Map<string, LedgerLeg[]>();
      for (const leg of (legRes.data || []) as any[]) {
        const gid = leg.transaction_group_id as string;
        if (!gid) continue;
        if (!legsByGroup.has(gid)) legsByGroup.set(gid, []);
        legsByGroup.get(gid)!.push(leg);
      }
      const portfolioMap = new Map((portfolioRes.data || []).map((p: any) => [p.id, p]));
      const profileMap = new Map((profileRes.data || []).map((p: any) => [p.id, p]));

      return ops.map((o: any) => {
        const meta = (o.metadata || {}) as Record<string, any>;
        const fundSource: FundSource = meta.fund_source === 'float' ? 'float' : 'withdrawable';
        const portfolio = o.source_id ? portfolioMap.get(o.source_id) : undefined;
        const partner = o.user_id ? profileMap.get(o.user_id) : undefined;
        const legs = (o.transaction_group_id ? legsByGroup.get(o.transaction_group_id) : undefined) || [];

        // recipient_type drives the wallet bucket. Prefer the value stamped on
        // the wallet leg; fall back to the deterministic derivation from
        // fund_source (float → operational_wallet, withdrawable → user).
        const walletLeg = legs.find((l) => l.ledger_scope === 'wallet');
        const recipientType =
          walletLeg?.recipient_type ||
          (fundSource === 'float' ? 'operational_wallet' : 'user');

        // Idempotency key is stamped on the ledger legs at creation time;
        // both balanced legs share it. Fall back to any leg that carries one.
        const idempotencyKey =
          legs.find((l) => l.idempotency_key)?.idempotency_key ?? null;

        return {
          id: o.id,
          amount: Number(o.amount),
          status: o.status,
          created_at: o.created_at,
          transaction_group_id: o.transaction_group_id,
          portfolio_id: o.source_id,
          portfolio_code: portfolio?.portfolio_code || '—',
          account_name: portfolio?.account_name ?? null,
          partner_id: o.user_id,
          partner_name: partner?.full_name || 'Unknown partner',
          fund_source: fundSource,
          recipient_type: recipientType,
          payment_method: meta.payment_method || '—',
          source_wallet_owner: meta.source_wallet_owner || meta.source || '—',
          reason: meta.reason ?? meta.notes ?? null,
          legs: legs.sort((a, b) => (a.ledger_scope === 'wallet' ? -1 : 1)),
          idempotency_key: idempotencyKey,
          metadata: meta,
        };
      });
    },
    refetchInterval: 60_000,
  });

  const [selected, setSelected] = useState<TopupRow | null>(null);

  const statusBadge = (status: string) => {
    const map: Record<string, string> = {
      completed: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
      approved: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
      cancelled: 'bg-destructive/10 text-destructive border-destructive/30',
      awaiting_verification: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
    };
    return map[status] || 'bg-muted text-muted-foreground border-border';
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl sm:text-2xl font-bold flex items-center gap-2.5">
          <ScrollText className="h-6 w-6 text-primary" />
          Partnership Top-Up Audit Log
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Every partnership top-up with its fund source, wallet routing
          (recipient type) and both balanced ledger legs — for instant
          verification.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading top-ups…
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground text-sm">
            No partnership top-ups recorded yet.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const balanced =
              r.legs.length === 2 &&
              r.legs.every((l) => Number(l.amount) === r.amount);
            return (
              <Card
                key={r.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelected(r)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelected(r);
                  }
                }}
                className="overflow-hidden cursor-pointer transition-colors hover:border-primary/50 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <CardTitle className="text-base font-bold flex items-center gap-2">
                        {r.account_name || r.portfolio_code}
                        <span className="text-xs font-mono font-normal text-muted-foreground">
                          {r.portfolio_code}
                        </span>
                      </CardTitle>
                      <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
                        <User2 className="h-3.5 w-3.5" />
                        {r.partner_name}
                        <span className="text-muted-foreground/60">·</span>
                        {format(new Date(r.created_at), 'dd MMM yyyy, HH:mm')}
                      </p>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-bold">{formatUGX(r.amount)}</div>
                      <Badge variant="outline" className={`mt-1 text-[10px] ${statusBadge(r.status)}`}>
                        {r.status.replace(/_/g, ' ')}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* Routing summary */}
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline" className="gap-1.5">
                      {r.fund_source === 'float' ? (
                        <Building2 className="h-3.5 w-3.5" />
                      ) : (
                        <PiggyBank className="h-3.5 w-3.5" />
                      )}
                      {r.fund_source === 'float' ? 'Operational Float' : 'Personal Deposit'}
                    </Badge>
                    <Badge variant="secondary" className="gap-1.5 font-mono text-[11px]">
                      recipient: {r.recipient_type}
                    </Badge>
                    <Badge variant="outline" className="text-[11px]">
                      via {r.payment_method.replace(/_/g, ' ')}
                    </Badge>
                    <Badge variant="outline" className="text-[11px]">
                      {r.source_wallet_owner}
                    </Badge>
                  </div>

                  {/* Compact footer: balance status + click affordance */}
                  <div className="flex items-center justify-between gap-2">
                    {r.legs.length > 0 ? (
                      <div className={`text-xs flex items-center gap-1.5 ${balanced ? 'text-emerald-600' : 'text-amber-600'}`}>
                        {balanced ? (
                          <>
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Balanced · {r.legs.length} ledger legs
                          </>
                        ) : (
                          <>
                            <AlertTriangle className="h-3.5 w-3.5" />
                            Review · {r.legs.length} ledger legs
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="text-xs flex items-center gap-1.5 text-amber-600">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        No ledger legs found
                      </div>
                    )}
                    <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                      View full breakdown <ChevronRight className="h-3.5 w-3.5" />
                    </span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <TopupDetailModal row={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

/* ── Detail modal: full ledger leg breakdown + metadata + idempotency key ── */

function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border/60 last:border-0">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className={`text-xs text-right break-all ${mono ? 'font-mono' : 'font-medium'}`}>
        {value ?? '—'}
      </span>
    </div>
  );
}

function TopupDetailModal({ row, onClose }: { row: TopupRow | null; onClose: () => void }) {
  const balanced =
    !!row &&
    row.legs.length === 2 &&
    row.legs.every((l) => Number(l.amount) === row.amount);

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] p-0 overflow-hidden">
        {row && (
          <>
            <DialogHeader className="px-5 pt-5 pb-3 border-b border-border">
              <DialogTitle className="flex items-center gap-2 text-base">
                <ScrollText className="h-5 w-5 text-primary" />
                {row.account_name || row.portfolio_code}
                <span className="text-xs font-mono font-normal text-muted-foreground">
                  {row.portfolio_code}
                </span>
              </DialogTitle>
              <DialogDescription className="text-xs">
                {formatUGX(row.amount)} · {row.partner_name} ·{' '}
                {format(new Date(row.created_at), 'dd MMM yyyy, HH:mm')}
              </DialogDescription>
            </DialogHeader>

            <ScrollArea className="max-h-[calc(90vh-5rem)]">
              <div className="px-5 py-4 space-y-5">
                {/* Summary */}
                <section>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">
                    Top-Up
                  </h3>
                  <div className="rounded-lg border border-border px-3">
                    <Row label="Status" value={row.status.replace(/_/g, ' ')} />
                    <Row
                      label="Fund source"
                      value={row.fund_source === 'float' ? 'Operational Float' : 'Personal Deposit (Withdrawable)'}
                    />
                    <Row label="Recipient type" value={row.recipient_type} mono />
                    <Row label="Payment method" value={row.payment_method.replace(/_/g, ' ')} />
                    <Row label="Source wallet" value={row.source_wallet_owner} />
                    <Row label="Reason" value={row.reason} />
                    <Row label="Operation ID" value={row.id} mono />
                    <Row label="Transaction group" value={row.transaction_group_id} mono />
                  </div>
                </section>

                {/* Idempotency key */}
                <section>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                    <KeyRound className="h-3.5 w-3.5" /> Idempotency Key
                  </h3>
                  <div className="rounded-lg border border-border bg-muted/40 p-3">
                    <code className="text-[11px] font-mono break-all">
                      {row.idempotency_key || 'Not recorded on the ledger legs.'}
                    </code>
                  </div>
                </section>

                {/* Ledger legs */}
                <section>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                      Ledger Legs ({row.legs.length})
                    </h3>
                    {row.legs.length > 0 && (
                      <span className={`text-xs flex items-center gap-1 ${balanced ? 'text-emerald-600' : 'text-amber-600'}`}>
                        {balanced ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                        {balanced ? `Balanced @ ${formatUGX(row.amount)}` : 'Unbalanced'}
                      </span>
                    )}
                  </div>

                  {row.legs.length === 0 ? (
                    <div className="rounded-lg border border-border p-3 text-xs text-muted-foreground flex items-center gap-2">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                      No ledger legs found for this top-up.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {row.legs.map((l) => {
                        const isOut = l.direction === 'cash_out';
                        return (
                          <div key={l.id} className="rounded-lg border border-border overflow-hidden">
                            <div className="flex items-center justify-between gap-2 px-3 py-2 bg-muted/40 border-b border-border">
                              <span className="flex items-center gap-1.5 text-xs font-semibold font-mono">
                                <span className={isOut ? 'text-destructive' : 'text-emerald-600'}>
                                  {isOut ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
                                </span>
                                {l.category}
                              </span>
                              <span className={`text-sm font-bold ${isOut ? 'text-destructive' : 'text-emerald-600'}`}>
                                {isOut ? '−' : '+'}{formatUGX(Number(l.amount))}
                              </span>
                            </div>
                            <div className="px-3">
                              <Row label="Direction" value={l.direction} mono />
                              <Row label="Scope" value={l.ledger_scope} mono />
                              <Row label="Recipient type" value={l.recipient_type} mono />
                              <Row label="Wallet bucket" value={l.wallet_bucket} mono />
                              <Row label="Routing source" value={l.routing_source} mono />
                              <Row label="Account" value={l.account} />
                              <Row label="Classification" value={l.classification} mono />
                              <Row label="Currency" value={l.currency} mono />
                              <Row label="User ID" value={l.user_id} mono />
                              <Row label="Linked party" value={l.linked_party} mono />
                              <Row label="Reference ID" value={l.reference_id} mono />
                              <Row label="Source" value={l.source_table ? `${l.source_table} · ${l.source_id ?? ''}` : null} mono />
                              <Row
                                label="Posted"
                                value={format(new Date(l.transaction_date || l.created_at), 'dd MMM yyyy, HH:mm:ss')}
                              />
                              <Row label="Leg ID" value={l.id} mono />
                              <Row label="Description" value={l.description} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                {/* Raw metadata */}
                <section>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">
                    Raw Metadata
                  </h3>
                  <pre className="rounded-lg border border-border bg-muted/40 p-3 text-[11px] font-mono whitespace-pre-wrap break-all">
                    {JSON.stringify(row.metadata, null, 2)}
                  </pre>
                </section>
              </div>
            </ScrollArea>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}