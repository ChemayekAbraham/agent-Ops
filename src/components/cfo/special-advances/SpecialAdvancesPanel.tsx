import { useState } from 'react';
import { Plus, Scale, Clock, Sparkles, MoreHorizontal, Wallet, PlusCircle, RotateCcw, Pencil } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { SpecialAdvanceSheetAction } from './SpecialAdvanceDetailSheet';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { kampalaLabel } from '@/lib/kampalaDays';
import {
  STATUS_LABEL,
  describeSpecialAdvanceError,
  type SpecialAdvanceStatus,
  RECORDED_ADVANCE_MARKER,
  repaymentStatusLabel,
} from '@/lib/specialAdvances';
import { useSpecialAdvanceList } from '@/hooks/useSpecialAdvances';
import { SpecialAdvanceModal } from '@/components/cfo/SpecialAdvanceModal';
import { SpecialAdvanceDetailSheet } from './SpecialAdvanceDetailSheet';
import { SpecialAdvanceProvisionsTab } from './SpecialAdvanceProvisionsTab';
import { SpecialAdvanceReconciliationCard } from './SpecialAdvanceReconciliationCard';

const ALL = '__all__';

/**
 * CFO Special Advances: A24/A25 reconciliation,
 * the register of agreements, impairment provisions, and detailed reporting. Corrections, provision reviews and
 * write-offs are posted by the CFO in one authorised step (decision 2026-11-03): there is no approval queue.
 */
export function SpecialAdvancesPanel() {
  const [activeTab, setActiveTab] = useState<'agreements' | 'provisions' | 'reconciliation'>('agreements');
  const [status, setStatus] = useState<SpecialAdvanceStatus | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openAction, setOpenAction] = useState<SpecialAdvanceSheetAction>(null);
  const [recording, setRecording] = useState(false);
  const [historical, setHistorical] = useState(false);

  const list = useSpecialAdvanceList(status);

  const issuanceEnabled = list.data?.issuance_enabled ?? false;
  const items = list.data?.items ?? [];

  return (
    <div className="space-y-4">
      {/* Top Banner: New Advance button */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-3 text-xs">

        <Button variant="outline" size="sm" className="ml-auto text-primary" onClick={() => { setHistorical(true); setRecording(true); }}>
          <Clock className="mr-1 h-4 w-4" /> Record Special Advance
        </Button>
        <Button id="special-advance-new" size="sm" onClick={() => { setHistorical(false); setRecording(true); }}>
          <Plus className="mr-1 h-4 w-4" /> New Special Advance
        </Button>
      </div>

      {/* Tabs navigation */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)} className="space-y-3">
        <TabsList className="h-9 p-1 bg-muted/60 text-xs">
          <TabsTrigger value="agreements" className="text-xs">
            Agreements ({items.length})
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
                    <th className="px-3 py-2 text-left font-medium">Recipient</th>
                    <th className="px-3 py-2 text-right font-medium">Principal</th>
                    <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Total repayable</th>
                    <th className="px-3 py-2 text-right font-medium">Outstanding</th>
                    <th className="px-3 py-2 text-left font-medium">Repayment status</th>
                    <th className="px-3 py-2 text-left font-medium">Date Issued</th>
                    <th className="px-3 py-2 text-left font-medium">Period</th>
                    <th className="px-3 py-2 text-left font-medium">Status</th>
                    <th className="px-3 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {list.isLoading && (
                    <tr>
                      <td colSpan={9} className="py-8 text-center text-muted-foreground">
                        Loading...
                      </td>
                    </tr>
                  )}
                  {list.isError && (
                    <tr>
                      <td colSpan={9} role="alert" className="py-8 text-center text-destructive">
                        {describeSpecialAdvanceError(list.error)}
                      </td>
                    </tr>
                  )}
                  {!list.isLoading && !list.isError && items.length === 0 && (
                    <tr>
                      <td colSpan={9} className="py-8 text-center text-muted-foreground">
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
                      <td className="px-3 py-2 text-right tabular-nums">
                        {a.paid_out ? formatUGX(a.outstanding ?? 0) : '—'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{repaymentStatusLabel(a)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {a.payout_date ? kampalaLabel(a.payout_date) : '—'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {a.term_days} days
                        <span className="block text-[10px] text-muted-foreground">
                          {a.instalments} {a.frequency} instalments
                        </span>
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
                      <td className="px-3 py-2 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              aria-label={`Actions for ${a.reference}`}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                            <DropdownMenuItem disabled={a.decision_reason !== RECORDED_ADVANCE_MARKER} onSelect={() => { setOpenAction('edit'); setOpenId(a.id); }}>
                              <Pencil className="mr-2 h-4 w-4" /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => { setOpenAction('repay'); setOpenId(a.id); }}>
                              <Wallet className="mr-2 h-4 w-4" /> Record Repayment
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={a.status !== 'disbursed'} onSelect={() => { setOpenAction('topup'); setOpenId(a.id); }}>
                              <PlusCircle className="mr-2 h-4 w-4" /> Top up
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={a.status !== 'disbursed'} onSelect={() => { setOpenAction('reverse'); setOpenId(a.id); }}>
                              <RotateCcw className="mr-2 h-4 w-4" /> Reverse
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </TabsContent>

        {/* Tab 2: Provisions & Allowances */}
        <TabsContent value="provisions">
          <SpecialAdvanceProvisionsTab />
        </TabsContent>

        {/* Tab 3: Reconciliation & Balances */}
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
        initialAction={openAction}
        onOpenChange={(o) => {
          if (!o) { setOpenId(null); setOpenAction(null); }
        }}
      />
      <SpecialAdvanceModal key={historical ? 'historical' : 'new'} open={recording} onOpenChange={setRecording} historical={historical} />
    </div>
  );
}

export default SpecialAdvancesPanel;
