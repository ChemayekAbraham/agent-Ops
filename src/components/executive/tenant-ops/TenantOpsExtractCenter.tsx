import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import {
  ClipboardList, CheckCircle2, Wallet, Banknote, CalendarCheck, Users, Printer,
  Loader2, Download, ArrowRight, Activity, Gauge, MapPin, Landmark, HandCoins, FileText,
  History, CalendarX2, Link2, FileCheck,
} from 'lucide-react';
import { generateAndDownloadActiveTenantsPdf } from '@/lib/activeTenantsReportPdf';

/**
 * Reports Hub → Export → Extract.
 *
 * A single, scannable index of the reports that ALREADY exist elsewhere in the
 * Tenant Operations dashboard. Nothing here re-implements a report: entries
 * either call the dashboard's own extract handlers (passed in as props) or open
 * the existing section that owns the report, so there is one source of truth.
 */

export type ExtractKind = 'applied' | 'approved' | 'funded' | 'collected' | 'expected';

/** Views owned by TenantOpsDashboard that already contain a report/export. */
export type ExtractTargetView =
  | 'all-tenants-hub'
  | 'pipeline-hub'
  | 'daily-collections'
  | 'daily-repayments-report'
  | 'daily'
  | 'agent-capacity-hub'
  | 'agent-allocations'
  | 'landlord-float-timeline'
  | 'tenant-location-browser'
  | 'pipeline'
  | 'history'
  | 'missed'
  | 'behavior'
  | 'transfer-audit';

interface Props {
  /** Human label for the currently selected date window, e.g. "01 Aug — 13 Aug". */
  rangeLabel: string;
  /** Which date-ranged extract is running right now (null when idle). */
  extracting: ExtractKind | null;
  onExtract: (kind: ExtractKind) => void;
  printing: boolean;
  onPrintReport: () => void;
  /** Opens the existing dashboard section that owns a report. */
  onOpenView: (view: ExtractTargetView) => void;
}

type Entry =
  | {
      mode: 'download';
      id: string;
      label: string;
      detail: string;
      format: string;
      icon: React.ElementType;
      run: () => void;
      busy: boolean;
    }
  | {
      mode: 'open';
      id: string;
      label: string;
      detail: string;
      format: string;
      icon: React.ElementType;
      view: ExtractTargetView;
    };

export function TenantOpsExtractCenter({
  rangeLabel,
  extracting,
  onExtract,
  printing,
  onPrintReport,
  onOpenView,
}: Props) {
  const [tenantsPdfBusy, setTenantsPdfBusy] = useState(false);

  const downloadAllTenants = async () => {
    setTenantsPdfBusy(true);
    const t = toast.loading('Building the tenants report…');
    try {
      await generateAndDownloadActiveTenantsPdf();
      toast.success('Tenants report downloaded', { id: t });
    } catch (e) {
      toast.error((e as Error).message || 'Failed to generate report', { id: t });
    } finally {
      setTenantsPdfBusy(false);
    }
  };

  const groups: { title: string; hint: string; entries: Entry[] }[] = [
    {
      title: 'Tenants',
      hint: `Date-ranged by the From / To dates above (${rangeLabel})`,
      entries: [
        {
          mode: 'download', id: 'applied', label: 'How many applied', detail: 'Applications received in the selected window',
          format: 'PDF', icon: ClipboardList, busy: extracting === 'applied', run: () => onExtract('applied'),
        },
        {
          mode: 'download', id: 'approved', label: 'How many approved', detail: 'Approvals recorded in the selected window',
          format: 'PDF', icon: CheckCircle2, busy: extracting === 'approved', run: () => onExtract('approved'),
        },
        {
          mode: 'download', id: 'funded', label: 'How many funded', detail: 'Rent plans funded in the selected window',
          format: 'PDF', icon: Wallet, busy: extracting === 'funded', run: () => onExtract('funded'),
        },
        {
          mode: 'download', id: 'all-tenants', label: 'All Tenants report', detail: 'The full tenant register report from the All Tenants workspace',
          format: 'PDF', icon: Users, busy: tenantsPdfBusy, run: () => void downloadAllTenants(),
        },
        {
          mode: 'open', id: 'all-tenants-hub', label: 'All Tenants register', detail: 'Search, filter and profile the full register, then export from there',
          format: 'Open', icon: Users, view: 'all-tenants-hub',
        },
        {
          mode: 'open', id: 'tenant-locations', label: 'Tenants by location', detail: 'Region / district / village breakdown with its own CSV and PDF export',
          format: 'CSV · PDF', icon: MapPin, view: 'tenant-location-browser',
        },
      ],
    },
    {
      title: 'Repayments',
      hint: `Date-ranged by the From / To dates above (${rangeLabel})`,
      entries: [
        {
          mode: 'download', id: 'collected', label: 'How much collected', detail: 'Repayments collected in the selected window',
          format: 'PDF', icon: Banknote, busy: extracting === 'collected', run: () => onExtract('collected'),
        },
        {
          mode: 'download', id: 'expected', label: 'How much expected', detail: 'Repayments expected in the selected window',
          format: 'PDF', icon: CalendarCheck, busy: extracting === 'expected', run: () => onExtract('expected'),
        },
        {
          mode: 'download', id: 'print', label: 'Tenant rent report', detail: 'The printed rent report for the selected window',
          format: 'Print · PDF', icon: Printer, busy: printing, run: onPrintReport,
        },
        {
          mode: 'open', id: 'daily-repayments-report', label: 'Daily repayments report', detail: 'Per-day repayment report with its own CSV and PDF export',
          format: 'CSV · PDF', icon: FileText, view: 'daily-repayments-report',
        },
      ],
    },
    {
      title: 'Payments',
      hint: 'Reports that live in the daily collection tools',
      entries: [
        {
          mode: 'open', id: 'daily-collections', label: 'Daily Collection Monitoring', detail: 'Today’s expected vs collected across the fleet, with PDF and CSV export',
          format: 'PDF · CSV', icon: CalendarCheck, view: 'daily-collections',
        },
        {
          mode: 'open', id: 'daily', label: 'Daily payment tracker', detail: 'Daily performance report download and WhatsApp share',
          format: 'PDF', icon: HandCoins, view: 'daily',
        },
      ],
    },
    {
      title: 'Receivables',
      hint: 'Pipeline and landlord-payable reports',
      entries: [
        {
          mode: 'open', id: 'pipeline-hub', label: 'Pipeline Status report', detail: 'Lifecycle counts, receivables and landlord payables for any date range',
          format: 'PDF · CSV · Excel', icon: Activity, view: 'pipeline-hub',
        },
        {
          mode: 'open', id: 'landlord-float-timeline', label: 'Landlord payout earmarks timeline', detail: 'Earmark and payout events for the current filters',
          format: 'CSV · PDF', icon: Landmark, view: 'landlord-float-timeline',
        },
      ],
    },
    {
      title: 'Agents',
      hint: 'Agent-side reports used by tenant operations',
      entries: [
        {
          mode: 'open', id: 'agent-capacity-hub', label: 'Agent Rent Capacity report', detail: 'Per-agent capacity, eligibility and daily ratings',
          format: 'PDF', icon: Gauge, view: 'agent-capacity-hub',
        },
        {
          mode: 'open', id: 'agent-allocations', label: 'Agent allocation report', detail: 'Allocation blocks per agent for the selected period',
          format: 'PDF', icon: ClipboardList, view: 'agent-allocations',
        },
      ],
    },
    {
      title: 'Tenant Ops Tools',
      hint: 'Each tool keeps its own Export PDF with its own status, search and date filters',
      entries: [
        {
          mode: 'open', id: 'review-requests', label: 'Review Requests report', detail: 'Rent requests in review, as filtered in the queue',
          format: 'PDF', icon: FileCheck, view: 'pipeline',
        },
        {
          mode: 'open', id: 'approval-history', label: 'Approval History report', detail: 'Approval and rejection trail',
          format: 'PDF', icon: History, view: 'history',
        },
        {
          mode: 'open', id: 'missed-days', label: 'Missed Days report', detail: 'Tenants with missed repayment days',
          format: 'PDF', icon: CalendarX2, view: 'missed',
        },
        {
          mode: 'open', id: 'tenant-behavior', label: 'Tenant Behaviour report', detail: 'Behaviour and reliability view per tenant',
          format: 'PDF', icon: Activity, view: 'behavior',
        },
        {
          mode: 'open', id: 'transfer-audit', label: 'Transfer Audit report', detail: 'Tenant transfers between agents',
          format: 'PDF', icon: Link2, view: 'transfer-audit',
        },
      ],
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex flex-wrap items-center gap-2">
          <Download className="h-4 w-4 text-primary shrink-0" />
          Extract
          <Badge variant="secondary" className="text-[10px] font-semibold">
            {groups.reduce((n, g) => n + g.entries.length, 0)} reports
          </Badge>
        </CardTitle>
        <p className="text-[11px] text-muted-foreground leading-snug">
          Every report that already exists in Tenant Operations, in one place. Downloads use the
          From / To dates above; “Open” takes you to the section that owns the report so its own
          filters and export options stay exactly as they are.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {groups.map((group) => (
          <div key={group.title} className="space-y-1.5">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{group.title}</p>
              <p className="text-[10px] text-muted-foreground/80 leading-snug">{group.hint}</p>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
              {group.entries.map((entry) => {
                const Icon = entry.icon;
                const busy = entry.mode === 'download' ? entry.busy : false;
                const disabled = entry.mode === 'download' ? Boolean(extracting) || busy : false;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => (entry.mode === 'download' ? entry.run() : onOpenView(entry.view))}
                    className="w-full text-left rounded-lg border bg-card p-2.5 flex items-start gap-2.5 min-h-[56px] transition-colors hover:bg-accent/40 active:scale-[0.99] disabled:opacity-60 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="p-1.5 rounded-md bg-muted shrink-0">
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4 text-primary" />}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[13px] font-semibold leading-tight break-words">{entry.label}</span>
                      <span className="block text-[10px] text-muted-foreground mt-0.5 leading-snug break-words">{entry.detail}</span>
                    </span>
                    <span className="shrink-0 flex items-center gap-1">
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-semibold whitespace-nowrap">
                        {entry.format}
                      </Badge>
                      {entry.mode === 'open' && <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div className="pt-1">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-muted-foreground" disabled>
            Reports stay available in their original sections — this is an extra way in.
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
