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
import { FileDown, Loader2, Calendar } from 'lucide-react';
import {
  generateTenantOpsToolReportPdf,
  tenantOpsToolReportTitle,
  tenantOpsToolStatusLabel,
  type TenantOpsTool,
} from '@/lib/generateTenantOpsToolReportPdf';

type Preset = 'today' | '7d' | '30d' | 'month' | 'all';

const PRESETS: { key: Preset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
  { key: 'all', label: 'All time' },
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
    <div className={`rounded-lg border border-border bg-muted/30 p-3 space-y-2.5 ${className || ''}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Label className="text-xs font-bold uppercase tracking-wide text-muted-foreground shrink-0 flex items-center gap-1">
            <Calendar className="h-3.5 w-3.5 text-primary" />
            Report period
          </Label>
          <Select
            value={preset}
            onValueChange={(val) => {
              setPreset(val as Preset);
              setDateFrom('');
              setDateTo('');
            }}
          >
            <SelectTrigger className="h-8 text-xs w-[140px] bg-background border-border font-medium">
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

        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge variant="secondary" className="text-[10px] font-bold">
            {tenantOpsToolStatusLabel(tool)}: {status && status !== 'all' ? status.replace(/_/g, ' ') : 'All'}
          </Badge>
          {typeof visibleCount === 'number' && (
            <Badge variant="outline" className="text-[10px]">{visibleCount.toLocaleString()} on screen</Badge>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">From</Label>
          <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-8 w-[140px] text-xs bg-background" />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">To</Label>
          <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-8 w-[140px] text-xs bg-background" />
        </div>
        {(dateFrom || dateTo) && (
          <Button type="button" size="sm" variant="ghost" className="h-8 text-[11px]" onClick={() => { setDateFrom(''); setDateTo(''); }}>
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
    </div>
  );
}
