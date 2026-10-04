import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { UserSearchPicker } from '@/components/cfo/UserSearchPicker';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { Loader2, Coins, Wallet, ArrowDownLeft } from 'lucide-react';

interface UserResult {
  id: string;
  full_name: string;
  phone: string;
}

interface LedgerRow {
  id: string;
  amount: number;
  direction: string;
  category: string;
  description: string | null;
  created_at: string;
  transaction_group_id: string | null;
  linked_party: string | null;
}

/** Friendly labels for the most common wallet-credit categories. */
const CATEGORY_LABELS: Record<string, string> = {
  subagent_registration_bonus: 'Sub-Agent Registration Bonus',
  agent_bonus: 'Agent Bonus',
  landlord_registration_bonus: 'Landlord Registration Bonus',
  referral_bonus: 'Referral Signup Bonus',
  referral_signup_bonus: 'Referral Signup Bonus',
  agent_commission_earned: 'Agent Commission',
  agent_commission: 'Agent Commission',
  proxy_investment_commission: 'Proxy Investment Commission',
  partner_commission: 'Partner Commission',
  recruiter_override: 'Recruiter Override Bonus',
  tenant_placement_bonus: 'Tenant Placement Bonus',
  event_bonus: 'Event Bonus',
  wallet_deposit: 'Wallet Deposit',
  rent_disbursement: 'Rent Disbursement (Float)',
  roi_wallet_credit: 'Returns Credit',
  roi_payout: 'Returns Payout',
  payroll: 'Payroll',
  incentive_bonus: 'Incentive Bonus',
  agent_float_funding: 'Operations Float',
  system_balance_correction: 'Balance Correction',
};

function labelFor(category: string): string {
  if (CATEGORY_LABELS[category]) return CATEGORY_LABELS[category];
  return category
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function MoneySourcesBreakdown() {
  const [selectedUser, setSelectedUser] = useState<UserResult | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['money-sources-breakdown', selectedUser?.id],
    enabled: !!selectedUser?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('general_ledger')
        .select('id, amount, direction, category, description, created_at, transaction_group_id, linked_party')
        .eq('user_id', selectedUser!.id)
        .eq('ledger_scope', 'wallet')
        // User-facing filter: hide admin/CFO reconciliation legs.
        .neq('classification', 'admin_correction')
        .neq('category', 'system_balance_correction')
        .order('created_at', { ascending: false })
        .limit(5000);
      if (error) throw error;
      return (data || []) as LedgerRow[];
    },
  });

  // Incoming credits only = "money sources".
  const groups = useMemo(() => {
    const rows = (data || []).filter(
      (r) => r.direction === 'credit' || r.direction === 'cash_in'
    );
    const map = new Map<string, { total: number; count: number; rows: LedgerRow[] }>();
    for (const r of rows) {
      const g = map.get(r.category) || { total: 0, count: 0, rows: [] };
      g.total += r.amount;
      g.count += 1;
      g.rows.push(r);
      map.set(r.category, g);
    }
    return Array.from(map.entries())
      .map(([category, g]) => ({ category, ...g }))
      .sort((a, b) => b.total - a.total);
  }, [data]);

  const grandTotal = groups.reduce((s, g) => s + g.total, 0);
  const grandCount = groups.reduce((s, g) => s + g.count, 0);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border-2 border-primary/30 bg-primary/5 p-4 sm:p-6">
        <h2 className="text-lg font-bold flex items-center gap-2 mb-1">
          <Coins className="h-5 w-5 text-primary" />
          Wallet Money Sources
        </h2>
        <p className="text-sm text-muted-foreground mb-4">
          Search a user by name or phone number to see where every shilling in their wallet
          came from — each commission and bonus category, its total, and the linked transactions.
        </p>
        <UserSearchPicker
          label="User"
          placeholder="Search by name or phone number..."
          selectedUser={selectedUser}
          onSelect={setSelectedUser}
        />
      </div>

      {!selectedUser && (
        <p className="text-sm text-muted-foreground text-center py-8">
          Pick a user above to reveal their wallet money sources.
        </p>
      )}

      {selectedUser && isLoading && (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      )}

      {selectedUser && !isLoading && (
        <>
          {/* Grand total */}
          <Card>
            <CardContent className="p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-primary/10">
                  <Wallet className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Money In</p>
                  <p className="text-[11px] text-muted-foreground">
                    {grandCount} transaction{grandCount === 1 ? '' : 's'} · {groups.length} source{groups.length === 1 ? '' : 's'}
                  </p>
                </div>
              </div>
              <p className="text-2xl font-black tabular-nums">{formatUGX(grandTotal)}</p>
            </CardContent>
          </Card>

          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No incoming wallet transactions found for this user.
            </p>
          ) : (
            <Accordion type="multiple" className="space-y-2">
              {groups.map((g) => {
                const pct = grandTotal > 0 ? Math.round((g.total / grandTotal) * 100) : 0;
                return (
                  <AccordionItem
                    key={g.category}
                    value={g.category}
                    className="border rounded-xl px-3 bg-card"
                  >
                    <AccordionTrigger className="hover:no-underline py-3">
                      <div className="flex items-center justify-between w-full gap-3 pr-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="p-1.5 rounded-lg bg-emerald-500/10 shrink-0">
                            <ArrowDownLeft className="h-4 w-4 text-emerald-600" />
                          </div>
                          <div className="text-left min-w-0">
                            <p className="text-sm font-semibold truncate">{labelFor(g.category)}</p>
                            <p className="text-[10px] text-muted-foreground">
                              {g.count} txn{g.count === 1 ? '' : 's'} · {pct}% of total
                            </p>
                          </div>
                        </div>
                        <p className="text-sm font-bold tabular-nums text-emerald-600 shrink-0">
                          {formatUGX(g.total)}
                        </p>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="divide-y divide-border/60 -mx-1">
                        {g.rows.map((r) => (
                          <div key={r.id} className="flex items-start justify-between gap-3 py-2 px-1">
                            <div className="min-w-0">
                              <p className="text-xs text-muted-foreground truncate">
                                {r.description || labelFor(r.category)}
                              </p>
                              <p className="text-[10px] text-muted-foreground/70">
                                {format(new Date(r.created_at), 'MMM d, yyyy · HH:mm')}
                                {r.transaction_group_id ? ` · ${r.transaction_group_id.slice(0, 8)}` : ''}
                              </p>
                            </div>
                            <p className="text-xs font-semibold tabular-nums shrink-0">
                              {formatUGX(r.amount)}
                            </p>
                          </div>
                        ))}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                );
              })}
            </Accordion>
          )}
        </>
      )}
    </div>
  );
}