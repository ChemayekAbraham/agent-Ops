import { useState, useEffect } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Loader2, ArrowDownLeft, ArrowUpRight, Copy, FileText, Calendar, User, Link } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { applyCustomerWalletLedgerFilters, isCustomerWalletLedgerEntryVisible } from '@/lib/customerWalletHistory';

interface LedgerEntryDetailDrawerProps {
  entryId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface FullLedgerEntry {
  id: string;
  transaction_date: string;
  amount: number;
  direction: string;
  category: string;
  description: string | null;
  reference_id: string | null;
  linked_party: string | null;
  source_table: string;
  source_id: string | null;
  account: string | null;
  transaction_group_id: string | null;
  user_id: string | null;
  created_at: string;
  classification?: string | null;
}

interface RelatedEntry {
  id: string;
  amount: number;
  direction: string;
  category: string;
  description: string | null;
  transaction_date: string;
  user_id: string | null;
  classification?: string | null;
  source_table?: string | null;
  reference_id?: string | null;
}

interface ProfileInfo {
  full_name: string;
  phone: string;
}

const SOURCE_TABLE_LABELS: Record<string, string> = {
  rent_requests: 'Rent Request',
  repayments: 'Repayment',
  deposit_requests: 'Deposit',
  withdrawal_requests: 'Withdrawal',
  referrals: 'Referral Bonus',
  agent_earnings: 'Agent Earning',
  agent_commission_payouts: 'Commission Payout',
  supporter_roi_payments: 'Supporter ROI',
  tenant_merchant_payments: 'Field Payment',
  manual: 'Manual Entry',
  system: 'System',
  subscription_charges: 'Auto-Charge',
  opening_balance: 'Opening Balance',
};

const CATEGORY_LABELS: Record<string, string> = {
  tenant_access_fee: 'Access Fee',
  tenant_request_fee: 'Request Fee',
  rent_repayment: 'Rent Repayment',
  supporter_facilitation_capital: 'Supporter Capital',
  agent_remittance: 'Agent Remittance',
  platform_service_income: 'Service Income',
  deposit: 'Deposit',
  referral_bonus: 'Referral Bonus',
  agent_commission: 'Agent Commission',
  first_transaction_bonus: 'First Transaction Bonus',
  opening_balance: 'Opening Balance',
  rent_facilitation_payout: 'Rent Facilitation',
  supporter_platform_rewards: 'Platform Rewards',
  agent_commission_payout: 'Commission Payout',
  transaction_platform_expenses: 'Platform Expenses',
  operational_expenses: 'Operating Expenses',
  withdrawal: 'Withdrawal',
  transfer_out: 'Transfer Out',
  transfer_in: 'Transfer In',
  rent_payment_for_tenant: 'Rent Payment (Tenant)',
};

export function LedgerEntryDetailDrawer({ entryId, open, onOpenChange }: LedgerEntryDetailDrawerProps) {
  const [loading, setLoading] = useState(true);
  const [entry, setEntry] = useState<FullLedgerEntry | null>(null);
  const [ownerProfile, setOwnerProfile] = useState<ProfileInfo | null>(null);
  const [linkedPartyProfile, setLinkedPartyProfile] = useState<ProfileInfo | null>(null);
  const [relatedEntries, setRelatedEntries] = useState<RelatedEntry[]>([]);

  useEffect(() => {
    if (!entryId || !open) return;
    setLoading(true);

    const fetchAll = async () => {
      const { data: e } = await applyCustomerWalletLedgerFilters(supabase
        .from('general_ledger')
        .select('*')
        .eq('id', entryId))
        .single();

      if (!e) { setLoading(false); return; }
      setEntry(e as FullLedgerEntry);

      // Fetch owner profile, and related group entries in parallel
      // Fetch related data in parallel
      const [ownerRes, relatedRes, linkedRes] = await Promise.all([
        e.user_id
          ? supabase.from('profiles').select('full_name, phone').eq('id', e.user_id).single()
          : Promise.resolve({ data: null }),
        e.transaction_group_id
          ? applyCustomerWalletLedgerFilters(supabase.from('general_ledger')
              .select('id, amount, direction, category, description, transaction_date, user_id, classification, source_table, reference_id')
              .eq('transaction_group_id', e.transaction_group_id)
              .neq('id', entryId))
              .order('transaction_date', { ascending: false })
          : Promise.resolve({ data: [] }),
        e.linked_party && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e.linked_party)
          ? supabase.from('profiles').select('full_name, phone').eq('id', e.linked_party).single()
          : Promise.resolve({ data: null }),
      ]);

      setOwnerProfile(ownerRes.data as any);
      setRelatedEntries(((relatedRes.data || []) as RelatedEntry[]).filter(isCustomerWalletLedgerEntryVisible));
      setLinkedPartyProfile(linkedRes.data as any);
      setLoading(false);
    };

    fetchAll();
  }, [entryId, open]);

  const handleCopyId = async () => {
    if (!entryId) return;
    await navigator.clipboard.writeText(entryId);
    toast.success('Entry ID copied');
  };

  const handleCopyRef = async () => {
    if (!entry?.reference_id) return;
    await navigator.clipboard.writeText(entry.reference_id);
    toast.success('Reference copied');
  };

  const isIn = entry?.direction === 'cash_in';
  const categoryLabel = entry ? (CATEGORY_LABELS[entry.category] || entry.category.replace(/_/g, ' ')) : '';
  const sourceLabel = entry ? (SOURCE_TABLE_LABELS[entry.source_table] || entry.source_table.replace(/_/g, ' ')) : '';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[85vh] rounded-t-2xl">
        <SheetHeader className="text-left pb-3">
          <SheetTitle>Ledger Entry Details</SheetTitle>
        </SheetHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !entry ? (
          <p className="text-center text-muted-foreground py-8">Entry not found</p>
        ) : (
          <div className="space-y-5 overflow-y-auto max-h-[calc(85vh-80px)] pb-6">

            {/* Amount header */}
            <div className="text-center py-5 bg-muted/30 rounded-2xl">
              <div className={cn(
                'w-12 h-12 mx-auto mb-3 rounded-full flex items-center justify-center',
                isIn ? 'bg-success/15' : 'bg-destructive/15'
              )}>
                {isIn ? <ArrowDownLeft className="h-6 w-6 text-success" /> : <ArrowUpRight className="h-6 w-6 text-destructive" />}
              </div>
              <p className="text-sm text-muted-foreground capitalize">{categoryLabel}</p>
              <p className={cn('text-3xl font-bold', isIn ? 'text-success' : 'text-destructive')}>
                {isIn ? '+' : '-'}{formatUGX(entry.amount)}
              </p>
              <div className="mt-2 flex justify-center gap-2">
                <Badge variant={isIn ? 'default' : 'destructive'} className="text-xs">
                  {isIn ? 'Cash In' : 'Cash Out'}
                </Badge>
                <Badge variant="outline" className="text-xs">{sourceLabel}</Badge>
              </div>
            </div>

            {/* IDs */}
            <div className="space-y-1">
              <button onClick={handleCopyId} className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground w-full">
                <Copy className="h-3 w-3" />
                <span className="font-mono truncate">ID: {entry.id}</span>
              </button>
              {entry.reference_id && (
                <button onClick={handleCopyRef} className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground w-full">
                  <Copy className="h-3 w-3" />
                  <span className="font-mono truncate">Ref: {entry.reference_id}</span>
                </button>
              )}
            </div>

            <Separator />

            {/* Core details */}
            <DetailSection title="Transaction Info" icon={<FileText className="h-3.5 w-3.5" />}>
              <DetailRow label="Category" value={categoryLabel} />
              <DetailRow label="Direction" value={isIn ? 'Cash In' : 'Cash Out'} />
              <DetailRow label="Amount" value={formatUGX(entry.amount)} bold />
              {entry.account && <DetailRow label="Account" value={entry.account} />}
              {entry.description && <DetailRow label="Description" value={entry.description} />}
            </DetailSection>

            <Separator />

            {/* Source */}
            <DetailSection title="Source" icon={<Link className="h-3.5 w-3.5" />}>
              <DetailRow label="Source Table" value={sourceLabel} />
              {entry.source_id && <DetailRow label="Source ID" value={entry.source_id} />}
              {entry.transaction_group_id && <DetailRow label="Transaction Group" value={entry.transaction_group_id} />}
            </DetailSection>

            <Separator />

            {/* Parties */}
            <DetailSection title="Parties" icon={<User className="h-3.5 w-3.5" />}>
              {ownerProfile && (
                <DetailRow label="Owner" value={`${ownerProfile.full_name} (${ownerProfile.phone})`} />
              )}
              {entry.linked_party &&
                !(entry.source_table === 'withdrawal_requests' || entry.category === 'wallet_withdrawal') && (
                  <DetailRow
                    label="Linked Party"
                    value={linkedPartyProfile ? `${linkedPartyProfile.full_name} (${linkedPartyProfile.phone})` : entry.linked_party}
                  />
                )}
            </DetailSection>

            <Separator />

            {/* Timeline */}
            <DetailSection title="Timestamps" icon={<Calendar className="h-3.5 w-3.5" />}>
              <DetailRow label="Transaction Date" value={format(new Date(entry.transaction_date), 'dd MMM yyyy, HH:mm:ss')} />
              <DetailRow label="Created At" value={format(new Date(entry.created_at), 'dd MMM yyyy, HH:mm:ss')} />
            </DetailSection>

            {/* Related entries */}
            {relatedEntries.length > 0 && (
              <>
                <Separator />
                <DetailSection title={`Related Entries (${relatedEntries.length})`} icon={<Link className="h-3.5 w-3.5" />}>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {relatedEntries.map(r => (
                      <div key={r.id} className="flex items-center justify-between text-xs py-1.5 border-b border-border/30 last:border-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {r.direction === 'cash_in' ? (
                            <ArrowDownLeft className="h-3 w-3 text-success shrink-0" />
                          ) : (
                            <ArrowUpRight className="h-3 w-3 text-destructive shrink-0" />
                          )}
                          <span className="truncate">{CATEGORY_LABELS[r.category] || r.category.replace(/_/g, ' ')}</span>
                        </div>
                        <span className={cn(
                          'font-mono font-semibold ml-2 shrink-0',
                          r.direction === 'cash_in' ? 'text-success' : 'text-destructive'
                        )}>
                          {r.direction === 'cash_in' ? '+' : '-'}{formatUGX(r.amount)}
                        </span>
                      </div>
                    ))}
                  </div>
                </DetailSection>
              </>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DetailSection({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        {icon}
        <h4 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{title}</h4>
      </div>
      <div className="space-y-1.5 pl-1">{children}</div>
    </div>
  );
}

function DetailRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-xs text-right max-w-[220px] break-words', bold ? 'font-bold' : 'font-medium')}>{value}</span>
    </div>
  );
}
