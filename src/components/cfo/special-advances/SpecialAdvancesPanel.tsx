import { useState } from 'react';
import { Plus, ShieldCheck, ShieldAlert, Scale, Clock, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import {
  STATUS_LABEL,
  describeSpecialAdvanceError,
  type SpecialAdvanceStatus,
} from '@/lib/specialAdvances';
import {
  useSpecialAdvanceList,
  useSpecialAdvanceReconciliation,
  useSpecialAdvanceCorrections,
  useSpecialAdvanceProvisionReviews,
  useSpecialAdvanceWriteOffs,
} from '@/hooks/useSpecialAdvances';
import { SpecialAdvanceModal } from '@/components/cfo/SpecialAdvanceModal';
import { SpecialAdvanceDetailSheet } from './SpecialAdvanceDetailSheet';
import { SpecialAdvanceMakerCheckerQueue } from './SpecialAdvanceMakerCheckerQueue';
import { SpecialAdvanceProvisionsTab } from './SpecialAdvanceProvisionsTab';
import { SpecialAdvanceReconciliationCard } from './SpecialAdvanceReconciliationCard';

const ALL = '__all__';

/**
 * CFO Special Advances: issuance switch state, A24/A25 reconciliation,
 * the register of agreements, second-CFO approval queue, impairment provisions, and detailed reporting.
 */
export function SpecialAdvancesPanel() {
  const [activeTab, setActiveTab] = useState<'agreements' | 'approvals' | 'provisions' | 'reconciliation'>('agreements');
  const [status, setStatus] = useState<SpecialAdvanceStatus | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);

  const list = useSpecialAdvanceList(status);
  const recon = useSpecialAdvanceReconciliation();

  // Pending counts for second-CFO queue badge
  const pendingCorrections = useSpecialAdvanceCorrections('pending');
  const pendingProvisions = useSpecialAdvanceProvisionReviews('pending');
  const pendingWriteOffs = useSpecialAdvanceWriteOffs('pending');

  const pendingCount =
    (pendingCorrections.data?.length ?? 0) +
    (pendingProvisions.data?.length ?? 0) +
    (pendingWriteOffs.data?.length ?? 0);

  const issuanceEnabled = list.data?.issuance_enabled ?? false;
  const items = list.data?.items ?? [];

  return (
    <div className="space-y-4">
      {/* Top Banner: Issuance state, Reconciliation summary, New Advance button */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-3 text-xs">
        <span
          id="special-advance-issuance-state"
          className={`inline-flex items-center gap-1.5 font-medium ${
            issuanceEnabled ? 'text-emerald-600' : 'text-amber-700 dark:text-amber-400'
          }`}
        >
          {issuanceEnabled ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
          {list.data
            ? issuanceEnabled
              ? 'Issuance is switched on'
              : 'Issuance is switched off — recording, approval and payout are disabled'
            : 'Checking the server...'}
        </span>

        {recon.data && (
          <span
            id="special-advance-reconciliation"
            className={recon.data.balanced ? 'text-muted-foreground' : 'font-semibold text-destructive'}
          >
            A24 ledger {formatUGX(recon.data.a24_ledger_balance)} · records {formatUGX(recon.data.subledger_outstanding)}
            {recon.data.a25_ledger_balance !== undefined && (
              <> · A25 allowance {formatUGX(recon.data.a25_ledger_balance)}</>
            )}
            {recon.data.net_receivable !== undefined && (
              <> · net {formatUGX(recon.data.net_receivable)}</>
            )}
            {recon.data.balanced ? ' · reconciled' : ` · difference ${formatUGX(recon.data.difference)}`}
          </span>
        )}

        <Button id="special-advance-new" size="sm" onClick={() => setRecording(true)}>
          <Plus className="mr-1 h-4 w-4" /> New Special Advance
        </Button>
      </div>

      {/* Tabs navigation */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)} className="space-y-3">
        <TabsList className="h-9 p-1 bg-muted/60 text-xs">
          <TabsTrigger value="agreements" className="text-xs">
            Agreements ({items.length})
          </TabsTrigger>
          <TabsTrigger value="approvals" className="text-xs flex items-center gap-1.5">
            Awaiting second CFO
            {pendingCount > 0 && (
              <Badge variant="destructive" className="h-4 px-1 text-[10px] leading-none">
                {pendingCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="provisions" className="text-xs">
            Provisions & Allowances
          </TabsTrigger>
          <TabsTrigger value="reconciliation" className="text-xs">
            Reconciliation & Balances
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: Agreements */}
        <TabsContent value="agreements" className="space-y-3">
          <section className="rounded-xl border border-border bg-card" aria-label="Special Advances">
            <div className="flex items-center justify-between gap-2 border-b border-border/60 p-3">
              <h3 className="text-sm font-semibold">Agreements</h3>
              <Select
                value={status ?? ALL}
                onValueChange={(v) => setStatus(v === ALL ? null : (v as SpecialAdvanceStatus))}
              >
                <SelectTrigger
                  id="special-advance-status-filter"
                  aria-label="Filter by status"
                  className="h-8 w-48 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All statuses</SelectItem>
                  {(Object.keys(STATUS_LABEL) as SpecialAdvanceStatus[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-[11px] text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Reference</th>
                    <th className="px-3 py-2 text-left font-medium">Borrower</th>
                    <th className="px-3 py-2 text-right font-medium">Principal</th>
                    <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Total repayable</th>
                    <th className="px-3 py-2 text-left font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {list.isLoading && (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-muted-foreground">
                        Loading...
                      </td>
                    </tr>
                  )}
                  {list.isError && (
                    <tr>
                      <td colSpan={5} role="alert" className="py-8 text-center text-destructive">
                        {describeSpecialAdvanceError(list.error)}
                      </td>
                    </tr>
                  )}
                  {!list.isLoading && !list.isError && items.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-muted-foreground">
                        No Special Advances recorded{status ? ' with this status' : ''}.
                      </td>
                    </tr>
                  )}
                  {items.map((a) => (
                    <tr
                      key={a.id}
                      tabIndex={0}
                      className="cursor-pointer hover:bg-muted/30"
                      onClick={() => setOpenId(a.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') setOpenId(a.id);
                      }}
                    >
                      <td className="px-3 py-2 font-mono text-primary">{a.reference}</td>
                      <td className="px-3 py-2">
                        {a.borrower_name ?? '—'}
                        <span className="block text-[10px] text-muted-foreground">
                          {a.borrower_kind === 'external' ? 'External' : 'Welile account'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatUGX(a.principal)}</td>
                      <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">
                        {formatUGX(a.total_repayable)}
                      </td>
                      <td className="px-3 py-2">
                        <Badge
                          variant={
                            a.status === 'disbursed'
                              ? 'default'
                              : a.status === 'settled'
                              ? 'secondary'
                              : a.status === 'written_off' || a.status === 'reversed' || a.status === 'rejected'
                              ? 'destructive'
                              : 'outline'
                          }
                          className="text-[10px] font-medium"
                        >
                          {STATUS_LABEL[a.status]}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </TabsContent>

        {/* Tab 2: Awaiting second CFO */}
        <TabsContent value="approvals">
          <SpecialAdvanceMakerCheckerQueue onOpenAdvance={(id) => setOpenId(id)} />
        </TabsContent>

        {/* Tab 3: Provisions & Allowances */}
        <TabsContent value="provisions">
          <SpecialAdvanceProvisionsTab />
        </TabsContent>

        {/* Tab 4: Reconciliation & Balances */}
        <TabsContent value="reconciliation">
          <SpecialAdvanceReconciliationCard onOpenAdvance={(ref) => {
            const found = items.find((i) => i.reference === ref);
            if (found) setOpenId(found.id);
          }} />
        </TabsContent>
      </Tabs>

      <SpecialAdvanceDetailSheet
        advanceId={openId}
        issuanceEnabled={issuanceEnabled}
        onOpenChange={(o) => {
          if (!o) setOpenId(null);
        }}
      />
      <SpecialAdvanceModal open={recording} onOpenChange={setRecording} />
    </div>
  );
}

export default SpecialAdvancesPanel;
