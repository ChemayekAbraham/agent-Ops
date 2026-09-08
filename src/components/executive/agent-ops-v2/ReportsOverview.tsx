import { useMemo, useState } from 'react';
import { CalendarRange, Download, FileBarChart, Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

/**
 * Reports → Overview (Phase 1: UI shell only).
 *
 * Flow: pick a date range → the report-type select becomes active → the
 * matching report surface renders below. PDF templates and the actual data
 * fetching land in phase two; every figure here is a placeholder dash.
 */

type ReportType =
  | 'agent'
  | 'rent-collections'
  | 'products-services'
  | 'advances'
  | 'team-collections';

const REPORT_TYPES: { value: ReportType; label: string; blurb: string }[] = [
  { value: 'agent', label: 'Agent', blurb: 'One agent, full rent repayment history, tenant-by-tenant breakdown.' },
  { value: 'rent-collections', label: 'Rent Collections', blurb: 'Daily active repaying tenants only — expected vs collected per agent.' },
  { value: 'products-services', label: 'Agent Products & Services', blurb: 'Smartphones, motorbikes and service uptake across the window.' },
  { value: 'advances', label: 'Advances', blurb: 'Advance issuance, recovery and exposure for the window.' },
  { value: 'team-collections', label: 'Team Collections', blurb: 'Team leader (parent) and sub-agent collections for the window.' },
];

const DASH = '—';

function PlaceholderTable({ columns, note }: { columns: string[]; note?: string }) {
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[720px] text-xs">
          <thead className="bg-muted/60">
            <tr>
              {columns.map((c) => (
                <th key={c} className="whitespace-nowrap px-3 py-2 text-left font-semibold text-muted-foreground">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[0, 1, 2].map((r) => (
              <tr key={r} className="border-t border-border/70">
                {columns.map((c) => (
                  <td key={c} className="whitespace-nowrap px-3 py-2 text-muted-foreground/60">{DASH}</td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-border bg-muted/40">
            <tr>
              {columns.map((c, i) => (
                <td key={c} className="whitespace-nowrap px-3 py-2 text-[11px] font-semibold">
                  {i === 0 ? 'Totals' : DASH}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}

function StatGrid({ items }: { items: string[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {items.map((label) => (
        <div key={label} className="rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
          <p className="mt-1 text-lg font-bold text-muted-foreground/60">{DASH}</p>
        </div>
      ))}
    </div>
  );
}

export function ReportsOverview() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reportType, setReportType] = useState<ReportType | ''>('');
  const [agentSearch, setAgentSearch] = useState('');

  const rangeReady = Boolean(from && to && from <= to);
  const active = REPORT_TYPES.find((r) => r.value === reportType);

  const rangeLabel = useMemo(() => (rangeReady ? `${from} → ${to}` : 'No range selected'), [from, to, rangeReady]);

  const body = () => {
    switch (reportType) {
      case 'agent':
        return (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Agent</Label>
              <Input
                value={agentSearch}
                onChange={(e) => setAgentSearch(e.target.value)}
                placeholder="Search agent by name or phone…"
                className="w-full sm:max-w-sm"
              />
            </div>
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Agent</p>
              <p className="text-base font-bold text-muted-foreground/60">{DASH}</p>
              <p className="text-xs text-muted-foreground/60">{DASH}</p>
            </div>
            <StatGrid items={['Tenants', 'Rent Amount', 'Outstanding', 'Collected', 'Percentage']} />
            <PlaceholderTable
              columns={['Tenant Name & Contact', 'Rent Amount', 'Outstanding', 'Repayment', 'Collected', 'Percentage', 'Date']}
              note="Full rent repayment history for the selected window, one row per collection."
            />
          </div>
        );
      case 'rent-collections':
        return (
          <div className="space-y-4">
            <StatGrid items={['Total Agents', 'Active Agents', 'Expected', 'Collected', 'Collection Rate']} />
            <PlaceholderTable
              columns={['#', 'Agent Name', 'Agent Phone', 'Total Repaying Tenants', 'Expected', 'Collected', 'Rate', 'Paid', 'Status']}
              note="Daily active repaying tenants only. Expected and collected are aggregated across the selected range; totals appear in the last row."
            />
          </div>
        );
      case 'products-services':
        return (
          <div className="space-y-4">
            <StatGrid items={['Applications', 'Approved', 'Delivered', 'Value Issued', 'Recovered']} />
            <PlaceholderTable
              columns={['#', 'Agent Name', 'Agent Phone', 'Product', 'Status', 'Value', 'Recovered', 'Outstanding', 'Date']}
            />
          </div>
        );
      case 'advances':
        return (
          <div className="space-y-4">
            <StatGrid items={['Advances Issued', 'Amount Issued', 'Recovered', 'Outstanding', 'Recovery Rate']} />
            <PlaceholderTable
              columns={['#', 'Agent Name', 'Agent Phone', 'Principal', 'Fee', 'Recovered', 'Outstanding', 'Status', 'Date']}
              note="Structure follows the Agent Operations Comprehensive Report — final columns confirmed in phase two."
            />
          </div>
        );
      case 'team-collections':
        return (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Team</Label>
              <Input placeholder="Search team leader by name or phone…" className="w-full sm:max-w-sm" />
            </div>
            <StatGrid items={['Team Leader', 'Total Sub-Agents', 'Collected', 'Expected', 'Rate / Rank']} />
            <PlaceholderTable
              columns={['Agent Name & Phone', 'Tenants Count', 'Amount Collected', '% of Group Expected', 'Collections in Window']}
              note="Overall collected and expected amounts for the team appear in the totals row."
            />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FileBarChart className="h-4 w-4 text-primary" />
            Reports Overview
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Step 1 — date range */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <CalendarRange className="h-3.5 w-3.5" /> Step 1 · Date range
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ro-from" className="text-xs">From</Label>
                <Input id="ro-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ro-to" className="text-xs">To</Label>
                <Input id="ro-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
              </div>
            </div>
          </div>

          {/* Step 2 — report type */}
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Step 2 · Report type
            </div>
            <Select
              value={reportType || undefined}
              onValueChange={(v) => setReportType(v as ReportType)}
              disabled={!rangeReady}
            >
              <SelectTrigger className="w-full" aria-label="Report type">
                <SelectValue placeholder={rangeReady ? 'Select report type' : 'Select a date range first'} />
              </SelectTrigger>
              <SelectContent>
                {REPORT_TYPES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <Badge variant="outline" className="font-normal">{rangeLabel}</Badge>
              {active && <span>{active.blurb}</span>}
            </div>
          </div>
        </CardContent>
      </Card>

      {!reportType ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <Info className="h-5 w-5 text-muted-foreground" />
            <p className="text-sm font-semibold">Pick a date range, then a report type</p>
            <p className="max-w-md text-xs text-muted-foreground">
              The report renders here and can be downloaded as a PDF.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
            <div>
              <CardTitle className="text-sm">{active?.label} report</CardTitle>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{rangeLabel}</p>
            </div>
            <Button size="sm" variant="outline" disabled className={cn('shrink-0 gap-1.5')}>
              <Download className="h-3.5 w-3.5" /> PDF
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {body()}
            <p className="rounded-md border border-dashed border-border p-2 text-[11px] text-muted-foreground">
              Layout preview only — live figures and the PDF template arrive in phase two.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default ReportsOverview;
