import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Building2, Home, ShieldCheck, Landmark, Wallet, Users, Printer,
  Loader2, Download, ArrowRight, MapPin, FileSpreadsheet, Inbox,
} from 'lucide-react';

/**
 * Reports & Exports → Extract (Landlord Operations).
 *
 * Mirror of the Tenant Ops Extract centre: a single, scannable index of the
 * reports that ALREADY exist elsewhere in the Landlord Operations dashboard.
 * Nothing here re-implements a report — entries either call the dashboard's own
 * export handlers (passed in as props) or open the existing section that owns
 * the report, so there is one source of truth and one set of permissions.
 */

/** Scoped downloads owned by LandlordOpsDashboard's existing export handlers. */
export type LandlordExtractKind =
  | 'landlords-verified' | 'landlords-pending' | 'landlords-rejected' | 'landlords-all'
  | 'landlords-funded'
  | 'houses-verified' | 'houses-pending' | 'houses-rejected' | 'houses-all'
  | 'lc1-verified' | 'lc1-pending' | 'lc1-rejected' | 'lc1-all'
  | 'payouts-print';

/** Views owned by LandlordOpsDashboard that already contain a report/export. */
export type LandlordExtractTargetView =
  | 'landlords'
  | 'verify'
  | 'lc1'
  | 'lc1-inbox'
  | 'landlords-paid'
  | 'landlords-tenants'
  | 'locations'
  | 'payout-review'
  | 'agent-capacity';

interface Props {
  /** Human label for the currently selected date window. */
  rangeLabel: string;
  /** Which extract is running right now (null when idle). */
  extracting: LandlordExtractKind | null;
  onExtract: (kind: LandlordExtractKind) => void;
  /** Opens the existing dashboard section that owns a report. */
  onOpenView: (view: LandlordExtractTargetView) => void;
}

type Entry =
  | {
      mode: 'download';
      id: LandlordExtractKind;
      label: string;
      detail: string;
      format: string;
      icon: React.ElementType;
    }
  | {
      mode: 'open';
      id: string;
      label: string;
      detail: string;
      format: string;
      icon: React.ElementType;
      view: LandlordExtractTargetView;
    };

export function LandlordOpsExtractCenter({ rangeLabel, extracting, onExtract, onOpenView }: Props) {
  const groups: { title: string; hint: string; entries: Entry[] }[] = [
    {
      title: 'Landlords',
      hint: `Landlord verification report, date-ranged by the From / To dates above (${rangeLabel})`,
      entries: [
        {
          mode: 'download', id: 'landlords-verified', label: 'Verified landlords', detail: 'The All Landlords verification report, verified scope',
          format: 'PDF', icon: ShieldCheck,
        },
        {
          mode: 'download', id: 'landlords-pending', label: 'Pending landlords', detail: 'The All Landlords verification report, pending scope',
          format: 'PDF', icon: Building2,
        },
        {
          mode: 'download', id: 'landlords-rejected', label: 'Rejected landlords', detail: 'The All Landlords verification report, rejected scope',
          format: 'PDF', icon: Building2,
        },
        {
          mode: 'download', id: 'landlords-all', label: 'All landlords', detail: 'The All Landlords verification report, every scope',
          format: 'PDF', icon: Users,
        },
        {
          mode: 'open', id: 'landlords', label: 'All Landlords workspace', detail: 'Search, filter and export with its own quick filters and date range',
          format: 'Open', icon: Building2, view: 'landlords',
        },
      ],
    },
    {
      title: 'Houses',
      hint: `House verification report, date-ranged by the From / To dates above (${rangeLabel})`,
      entries: [
        {
          mode: 'download', id: 'houses-verified', label: 'Verified houses', detail: 'The Verify Houses report, verified scope',
          format: 'PDF', icon: Home,
        },
        {
          mode: 'download', id: 'houses-pending', label: 'Pending houses', detail: 'The Verify Houses report, pending scope',
          format: 'PDF', icon: Home,
        },
        {
          mode: 'download', id: 'houses-rejected', label: 'Rejected houses', detail: 'The Verify Houses report, rejected scope',
          format: 'PDF', icon: Home,
        },
        {
          mode: 'download', id: 'houses-all', label: 'All houses', detail: 'The Verify Houses report, every scope',
          format: 'PDF', icon: Home,
        },
        {
          mode: 'open', id: 'verify', label: 'Verify Houses queue', detail: 'Quick filters, search and its own export live here',
          format: 'Open', icon: Home, view: 'verify',
        },
        {
          mode: 'open', id: 'locations', label: 'Houses by location', detail: 'Region / district / village browser for landlord properties',
          format: 'Open', icon: MapPin, view: 'locations',
        },
      ],
    },
    {
      title: 'LC1 Chairpersons',
      hint: 'The LC1 verification report — same export the LC1 register uses',
      entries: [
        {
          mode: 'download', id: 'lc1-verified', label: 'Verified LC1 chairpersons', detail: 'LC1 verification report, verified scope',
          format: 'PDF', icon: ShieldCheck,
        },
        {
          mode: 'download', id: 'lc1-pending', label: 'Pending LC1 chairpersons', detail: 'LC1 verification report, pending scope',
          format: 'PDF', icon: ShieldCheck,
        },
        {
          mode: 'download', id: 'lc1-rejected', label: 'Rejected LC1 chairpersons', detail: 'LC1 verification report, rejected scope',
          format: 'PDF', icon: ShieldCheck,
        },
        {
          mode: 'download', id: 'lc1-all', label: 'All LC1 chairpersons', detail: 'LC1 verification report, every scope',
          format: 'PDF', icon: Users,
        },
        {
          mode: 'open', id: 'lc1', label: 'LC1 Chairpersons register', detail: 'Approved and rejected chairpersons, with its own export',
          format: 'Open', icon: ShieldCheck, view: 'lc1',
        },
        {
          mode: 'open', id: 'lc1-inbox', label: 'LC1 verification inbox', detail: 'Per-status inbox with its own export per tab',
          format: 'PDF', icon: Inbox, view: 'lc1-inbox',
        },
      ],
    },
    {
      title: 'Payouts',
      hint: `Landlord payout reporting for the selected window (${rangeLabel})`,
      entries: [
        {
          mode: 'download', id: 'payouts-print', label: 'Landlord payouts report', detail: 'The printed landlord payouts PDF for the selected window',
          format: 'Print · PDF', icon: Printer,
        },
        {
          mode: 'download', id: 'landlords-funded', label: 'Landlords funded pack', detail: 'The Landlords Paid management pack: KPIs, trend, districts and register',
          format: 'PDF', icon: Wallet,
        },
        {
          mode: 'open', id: 'landlords-paid', label: 'Landlords Paid workspace', detail: 'Funded landlords with their own filters and funded export',
          format: 'Open', icon: Landmark, view: 'landlords-paid',
        },
        {
          mode: 'open', id: 'payout-review', label: 'Payout review', detail: 'Landlord payout review queue',
          format: 'Open', icon: Landmark, view: 'payout-review',
        },
      ],
    },
    {
      title: 'Occupancy',
      hint: 'Landlord-to-tenant linkage reporting',
      entries: [
        {
          mode: 'open', id: 'landlords-tenants', label: 'Landlords with tenants', detail: 'Occupancy register with its own Excel export',
          format: 'Excel', icon: FileSpreadsheet, view: 'landlords-tenants',
        },
        {
          mode: 'open', id: 'agent-capacity', label: 'Agent capacity', detail: 'Agent-side capacity view used by landlord operations',
          format: 'Open', icon: Users, view: 'agent-capacity',
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
          Every report that already exists in Landlord Operations, in one place. Downloads use the
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
                const busy = entry.mode === 'download' && extracting === entry.id;
                const disabled = entry.mode === 'download' ? Boolean(extracting) : false;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => (entry.mode === 'download' ? onExtract(entry.id) : onOpenView(entry.view))}
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
