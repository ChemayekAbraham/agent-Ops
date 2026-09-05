import { useState } from 'react';
import { toast } from 'sonner';
import { format, startOfDay, subDays, startOfMonth } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { FileDown, Loader2, Calendar, ChevronDown } from 'lucide-react';
import {
  generateTenantOpsToolReportPdf,
  tenantOpsToolReportTitle,
  tenantOpsToolStatusLabel,
  type TenantOpsTool,
} from '@/lib/generateTenantOpsToolReportPdf';

type Preset = 'today' | '7d' | '30d' | 'month' | 'all' | 'custom';

const PRESETS: { key: Preset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
  { key: 'all', label: 'All time' },
  { key: 'custom', label: 'Custom range…' },
];

interface Props {
  tool: TenantOpsTool;
  /** Status / risk / method filter currently applied in the view. */
  status?: string;
  /** Search term currently applied in the view. */
  search?: string;
  /** Number of records currently visible on screen (shown for context). */
  visibleCount?: number;
  fileSlug: string;
  className?: string;
}

/**
 * Report/export bar for the existing Tenant Ops Tools, mirroring the Landlord Ops
 * house Verification Queue export experience: date range (presets + pickers),
 * status echo, and a landscape PDF that exports exactly what is being filtered.
 */
export function TenantOpsReportToolbar({
  tool, status = 'all', search = '', visibleCount, fileSlug, className,
}: Props) {
  const { user } = useAuth();
  const [preset, setPreset] = useState<Preset>('today');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [exporting, setExporting] = useState(false);
  const [open, setOpen] = useState(false);

  const resolveRange = (): { from: string | null; to: string | null } => {
    if (dateFrom || dateTo) {
      return {
        from: dateFrom ? new Date(`${dateFrom}T00:00:00`).toISOString() : null,
        to: dateTo ? new Date(`${dateTo}T23:59:59.999`).toISOString() : null,
      };
    }
    const now = new Date();
    if (preset === 'all') return { from: null, to: null };
    if (preset === 'today') return { from: startOfDay(now).toISOString(), to: null };
    if (preset === '7d') return { from: startOfDay(subDays(now, 6)).toISOString(), to: null };
    if (preset === 'month') return { from: startOfMonth(now).toISOString(), to: null };
    return { from: startOfDay(subDays(now, 29)).toISOString(), to: null };
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const { from, to } = resolveRange();
      const { data, error } = await (supabase.rpc as any)('ops_tenant_ops_tool_report', {
        p_tool: tool,
        p_status: status || 'all',
        p_search: search?.trim() || null,
        p_date_from: from,
        p_date_to: to,
        p_limit: 10000,
      });
      if (error) throw error;
      const payload = (data || []) as any[];
      const rows = payload.map(r => (r.row_data ?? r));
      const trueTotal = Number(payload[0]?.total_count ?? rows.length);
      if (!rows.length) {
        toast.error('No records match these filters — nothing to export');
        return;
      }
      const blob = generateTenantOpsToolReportPdf(rows, {
        tool,
        status: status || 'all',
        search: search?.trim() || null,
        dateFrom: from,
        dateTo: to,
        totalMatches: trueTotal,
        generatedBy: user?.email ?? null,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `welile-${fileSlug}-${format(new Date(), 'yyyy-MM-dd-HHmm')}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`${tenantOpsToolReportTitle(tool)} report downloaded (${rows.length.toLocaleString()} records)`);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to generate the report');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className={`rounded-lg border border-border bg-muted/30 p-2.5 sm:p-3 transition-all ${className || ''}`}>
      <Collapsible open={open} onOpenChange={setOpen} className="space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <Label className="text-xs font-bold uppercase tracking-wide text-muted-foreground shrink-0 flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5 text-primary" />
              Report period
            </Label>
            <Select
              value={preset}
              onValueChange={(val) => {
                setPreset(val as Preset);
                if (val === 'custom') {
                  setOpen(true);
                } else {
                  setDateFrom('');
                  setDateTo('');
                }
              }}
            >
              <SelectTrigger className="h-8 text-xs w-[130px] sm:w-[140px] bg-background border-border font-medium">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESETS.map((p) => (
                  <SelectItem key={p.key} value={p.key} className="text-xs">
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="h-8 px-2 rounded-md border border-border/70 bg-background hover:bg-muted text-[11px] font-semibold text-muted-foreground inline-flex items-center gap-1 transition-colors"
                title={open ? 'Hide details' : 'Show date picker & export options'}
              >
                <span className="hidden sm:inline">{open ? 'Less' : 'More / PDF'}</span>
                <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
              </button>
            </CollapsibleTrigger>
          </div>
        </div>

        <CollapsibleContent className="space-y-2.5 pt-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge variant="secondary" className="text-[10px] font-bold">
              {tenantOpsToolStatusLabel(tool)}: {status && status !== 'all' ? status.replace(/_/g, ' ') : 'All'}
            </Badge>
            {typeof visibleCount === 'number' && (
              <Badge variant="outline" className="text-[10px]">{visibleCount.toLocaleString()} on screen</Badge>
            )}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">From</Label>
              <Input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPreset('custom'); }} className="h-8 w-[140px] text-xs bg-background" />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">To</Label>
              <Input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPreset('custom'); }} className="h-8 w-[140px] text-xs bg-background" />
            </div>
            {(dateFrom || dateTo) && (
              <Button type="button" size="sm" variant="ghost" className="h-8 text-[11px]" onClick={() => { setDateFrom(''); setDateTo(''); setPreset('today'); }}>
                Clear dates
              </Button>
            )}
            <Button type="button" size="sm" className="h-8 text-xs gap-1.5 ml-auto" onClick={handleExport} disabled={exporting}>
              {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}
              Export PDF
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            The PDF exports exactly what these filters match — {tenantOpsToolReportTitle(tool).toLowerCase()}, with totals calculated from the same records.
          </p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
