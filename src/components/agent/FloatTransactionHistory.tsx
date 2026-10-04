import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/rentCalculations';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { format } from 'date-fns';
import { ArrowDownLeft, ArrowUpRight, History, Users, Wallet, FileText, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ReverseAllocationDialog } from './ReverseAllocationDialog';
import { applyCustomerWalletLedgerFilters, isCustomerWalletLedgerEntryVisible } from '@/lib/customerWalletHistory';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type TxKind = 'funding' | 'allocation' | 'payout' | 'ledger';

interface TxEntry {
  id: string;
  kind: TxKind;
  type: 'credit' | 'debit';
  amount: number;
  description: string;
  counterparty?: string;
  date: string;
  status?: string;
  category?: string;
  collectionId?: string;
  reversed?: boolean;
}

export function FloatTransactionHistory({ open, onOpenChange }: Props) {
  const { user } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ['agent-wallet-statement', user?.id],
    queryFn: async () => {
      if (!user) return { entries: [] as TxEntry[], totals: { funded: 0, allocated: 0, paidOut: 0 } };

      const [
        { data: funding },
        { data: withdrawals },
        { data: allocations },
        { data: ledger },
      ] = await Promise.all([
        supabase
          .from('agent_float_funding')
          .select('id, amount, created_at, notes, status')
          .eq('agent_id', user.id)
          .order('created_at', { ascending: false })
          .limit(200),
        supabase
          .from('agent_float_withdrawals')
          .select('id, amount, landlord_name, status, created_at')
          .eq('agent_id', user.id)
          .order('created_at', { ascending: false })
          .limit(200),
        supabase
          .from('agent_collections')
          .select('id, amount, created_at, notes, tenant_id, payment_method, float_before, float_after').is('reversed_at', null)
          .eq('agent_id', user.id)
          .order('created_at', { ascending: false })
          .limit(300),
        applyCustomerWalletLedgerFilters(supabase
          .from('general_ledger')
          .select('id, amount, description, direction, created_at, category, linked_party, classification, source_table, reference_id')
          .eq('user_id', user.id)
          .eq('ledger_scope', 'wallet'))
          .order('created_at', { ascending: false })
          .limit(300),
      ]);

      // Resolve tenant names for allocations
      const tenantIds = Array.from(new Set([
        ...(allocations || []).map(a => a.tenant_id).filter(Boolean),
        ...(ledger || []).filter(isCustomerWalletLedgerEntryVisible).map(l => l.linked_party).filter(Boolean),
      ])) as string[];
      const tenantMap: Record<string, string> = {};
      if (tenantIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', tenantIds);
        for (const p of profiles || []) tenantMap[p.id] = p.full_name || 'Tenant';
      }

      const entries: TxEntry[] = [];
      let funded = 0, allocated = 0, paidOut = 0;

      (funding || []).forEach(f => {
        funded += Number(f.amount);
        entries.push({
          id: `f-${f.id}`,
          kind: 'funding',
          type: 'credit',
          amount: Number(f.amount),
          description: f.notes || 'Operations float credited',
          date: f.created_at,
          status: f.status,
        });
      });

      (allocations || []).forEach(a => {
        const notesLower = (a.notes || '').toLowerCase();
        const isAllocation = notesLower.includes('float allocation');
        const isReversed = notesLower.includes('[reversed');
        if (isAllocation) {
          if (!isReversed) allocated += Number(a.amount);
          entries.push({
            id: `a-${a.id}`,
            kind: 'allocation',
            type: 'debit',
            amount: Number(a.amount),
            description: a.notes || 'Float allocation to tenant',
            counterparty: a.tenant_id ? tenantMap[a.tenant_id] || 'Tenant' : 'Tenant',
            date: a.created_at,
            collectionId: a.id,
            reversed: isReversed,
          });
        }
      });

      (withdrawals || []).forEach(w => {
        paidOut += Number(w.amount);
        entries.push({
          id: `w-${w.id}`,
          kind: 'payout',
          type: 'debit',
          amount: Number(w.amount),
          description: `Paid to landlord`,
          counterparty: w.landlord_name,
          date: w.created_at,
          status: w.status,
        });
      });

      // Add ledger entries that aren't already represented (commissions, fees, transfers)
      const seenCats = new Set(['rent_float_funding', 'agent_float_used_for_rent']);
      (ledger || []).filter(isCustomerWalletLedgerEntryVisible).forEach(l => {
        const isCovered = seenCats.has(l.category) || l.category === 'rent_disbursement';
        if (!isCovered) {
          const isCredit = l.direction === 'credit' || l.direction === 'cash_in';
          entries.push({
            id: `l-${l.id}`,
            kind: 'ledger',
            type: isCredit ? 'credit' : 'debit',
            amount: Number(l.amount),
            description: l.description || l.category.replace(/_/g, ' '),
            counterparty: l.linked_party ? tenantMap[l.linked_party] : undefined,
            date: l.created_at,
            category: l.category,
          });
        }
      });

      entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      return { entries, totals: { funded, allocated, paidOut } };
    },
    enabled: !!user && open,
  });

  const queryClient = useQueryClient();
  const [reverseTarget, setReverseTarget] = useState<TxEntry | null>(null);

  const entries = data?.entries || [];
  const totals = data?.totals || { funded: 0, allocated: 0, paidOut: 0 };

  const filtered = useMemo(() => ({
    all: entries,
    allocations: entries.filter(e => e.kind === 'allocation'),
    funding: entries.filter(e => e.kind === 'funding'),
    payouts: entries.filter(e => e.kind === 'payout'),
    ledger: entries,
  }), [entries]);

  const handleReversed = () => {
    queryClient.invalidateQueries({ queryKey: ['agent-wallet-statement', user?.id] });
    queryClient.invalidateQueries({ queryKey: ['agent-balances'] });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[90vh] rounded-t-2xl p-0 flex flex-col">
        <SheetHeader className="px-4 pt-4 pb-2 shrink-0">
          <SheetTitle className="text-base flex items-center gap-2">
            <History className="h-4 w-4 text-chart-4" />
            Operations Wallet Statement
          </SheetTitle>
          <p className="text-[11px] text-muted-foreground text-left">
            Every movement in your operations float — funded, allocated to tenants, and paid out.
          </p>
        </SheetHeader>

        {/* Summary strip */}
        <div className="px-4 pb-2 grid grid-cols-3 gap-2 shrink-0">
          <SummaryPill label="Funded" amount={totals.funded} tone="success" />
          <SummaryPill label="Allocated" amount={totals.allocated} tone="info" />
          <SummaryPill label="Paid Out" amount={totals.paidOut} tone="warning" />
        </div>

        <Tabs defaultValue="all" className="flex-1 flex flex-col min-h-0">
          <TabsList className="mx-4 grid grid-cols-4 h-9 shrink-0">
            <TabsTrigger value="all" className="text-[11px]">All</TabsTrigger>
            <TabsTrigger value="allocations" className="text-[11px]">Allocations</TabsTrigger>
            <TabsTrigger value="funding" className="text-[11px]">Funding</TabsTrigger>
            <TabsTrigger value="payouts" className="text-[11px]">Payouts</TabsTrigger>
          </TabsList>

          <ScrollArea className="flex-1 px-4 mt-2">
            {isLoading ? (
              <div className="flex justify-center py-12 text-muted-foreground text-sm">Loading statement…</div>
            ) : (
              <>
                <TabsContent value="all" className="m-0"><EntryList items={filtered.all} onReverse={setReverseTarget} /></TabsContent>
                <TabsContent value="allocations" className="m-0"><EntryList items={filtered.allocations} emptyText="No tenant allocations yet." onReverse={setReverseTarget} /></TabsContent>
                <TabsContent value="funding" className="m-0"><EntryList items={filtered.funding} emptyText="No funding events yet." onReverse={setReverseTarget} /></TabsContent>
                <TabsContent value="payouts" className="m-0"><EntryList items={filtered.payouts} emptyText="No landlord payouts yet." onReverse={setReverseTarget} /></TabsContent>
              </>
            )}
          </ScrollArea>
        </Tabs>
      </SheetContent>

      <ReverseAllocationDialog
        open={!!reverseTarget}
        onOpenChange={(o) => { if (!o) setReverseTarget(null); }}
        collectionId={reverseTarget?.collectionId || null}
        amount={reverseTarget?.amount || 0}
        tenantName={reverseTarget?.counterparty}
        onReversed={handleReversed}
      />
    </Sheet>
  );
}

function SummaryPill({ label, amount, tone }: { label: string; amount: number; tone: 'success' | 'info' | 'warning' }) {
  const toneCls = tone === 'success' ? 'bg-success/10 text-success border-success/20'
    : tone === 'info' ? 'bg-chart-4/10 text-chart-4 border-chart-4/20'
    : 'bg-warning/10 text-warning border-warning/20';
  return (
    <div className={`rounded-lg border p-2 ${toneCls}`}>
      <p className="text-[9px] uppercase tracking-wide opacity-80">{label}</p>
      <p className="text-xs font-bold truncate">{formatUGX(amount)}</p>
    </div>
  );
}

function EntryList({ items, emptyText = 'No transactions yet.', onReverse }: { items: TxEntry[]; emptyText?: string; onReverse?: (tx: TxEntry) => void }) {
  if (items.length === 0) {
    return <div className="text-center py-12 text-muted-foreground text-sm">{emptyText}</div>;
  }
  return (
    <div className="space-y-2 pb-6">
      {items.map((tx) => {
        const Icon = tx.kind === 'allocation' ? Users
          : tx.kind === 'funding' ? Wallet
          : tx.kind === 'ledger' ? FileText
          : tx.type === 'credit' ? ArrowDownLeft : ArrowUpRight;
        const iconBg = tx.kind === 'allocation' ? 'bg-chart-4/10 text-chart-4'
          : tx.kind === 'funding' ? 'bg-success/10 text-success'
          : tx.kind === 'payout' ? 'bg-warning/10 text-warning'
          : tx.type === 'credit' ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground';
        const kindLabel = tx.kind === 'allocation' ? 'Allocation'
          : tx.kind === 'funding' ? 'Funding'
          : tx.kind === 'payout' ? 'Payout'
          : tx.category?.replace(/_/g, ' ') || 'Ledger';
        const canReverse = tx.kind === 'allocation' && !!tx.collectionId && !tx.reversed;

        return (
          <div key={tx.id} className={`flex items-start gap-3 p-3 rounded-xl border hover:bg-muted/30 transition-colors ${tx.reversed ? 'opacity-60' : ''}`}>
            <div className={`p-2 rounded-lg shrink-0 ${iconBg}`}>
              <Icon className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <Badge variant="outline" className="text-[8px] px-1.5 py-0 capitalize">{kindLabel}</Badge>
                {tx.reversed && <Badge variant="destructive" className="text-[8px] px-1.5 py-0">Reversed</Badge>}
                {tx.counterparty && (
                  <span className="text-[11px] font-medium truncate">→ {tx.counterparty}</span>
                )}
              </div>
              <p className={`text-[11px] text-muted-foreground truncate mt-0.5 ${tx.reversed ? 'line-through' : ''}`}>{tx.description}</p>
              <p className="text-[10px] text-muted-foreground/80 mt-0.5">
                {format(new Date(tx.date), 'dd MMM yy, HH:mm')}
              </p>
              {canReverse && onReverse && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 mt-1 text-[10px] text-warning hover:text-warning hover:bg-warning/10"
                  onClick={() => onReverse(tx)}
                >
                  <Undo2 className="h-3 w-3 mr-1" />
                  Reverse
                </Button>
              )}
            </div>
            <div className="text-right shrink-0">
              <p className={`font-bold text-sm ${tx.reversed ? 'line-through text-muted-foreground' : tx.type === 'credit' ? 'text-success' : 'text-foreground'}`}>
                {tx.type === 'credit' ? '+' : '-'}{formatUGX(tx.amount)}
              </p>
              {tx.status && (
                <Badge
                  variant={tx.status === 'completed' ? 'default' : tx.status === 'rejected' ? 'destructive' : 'secondary'}
                  className="text-[8px] mt-0.5"
                >
                  {tx.status.replace(/_/g, ' ')}
                </Badge>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
