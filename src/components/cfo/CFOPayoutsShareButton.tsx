import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Share2, Loader2, CalendarIcon } from 'lucide-react';
import {
  format,
  startOfMonth,
  endOfDay,
  startOfDay,
  startOfWeek,
  subDays,
  startOfQuarter,
  startOfYear,
} from 'date-fns';
import { generateCfoPayoutsPdf, shareCfoPayoutsPdf, type CfoPayoutRow } from '@/lib/cfoPayoutsReportPdf';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import { CFO_PAYOUT_LABELS } from '@/lib/cfoPayoutLabels';

// Audit-log action types that represent money actually paid OUT to a person/wallet.
const PAYOUT_ACTIONS = [
  'cfo_direct_credit',
  'cfo_roi_payout_approved',
  'roi_payout',
  'rent_payout_approved',
  'cfo_batch_payout_processed',
  'commission_payout',
  'landlord_payout_cfo_approve',
  'agent_float_funded',
  'cfo_payroll_processed',
  'cfo_service_centre_payout',
];

const ACTION_LABEL: Record<string, string> = {
  cfo_direct_credit: CFO_PAYOUT_LABELS.credit,
  cfo_roi_payout_approved: 'ROI Payout',
  roi_payout: 'ROI Payout',
  rent_payout_approved: 'Rent Payout',
  cfo_batch_payout_processed: 'Batch Payout',
  commission_payout: 'Commission',
  landlord_payout_cfo_approve: 'Landlord Payout',
  agent_float_funded: 'Agent Float',
  cfo_payroll_processed: 'Payroll',
  cfo_service_centre_payout: 'Service Centre',
};

function DatePicker({
  label,
  date,
  onSelect,
}: {
  label: string;
  date?: Date;
  onSelect: (d?: Date) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('w-[145px] justify-start text-left font-normal gap-1.5', !date && 'text-muted-foreground')}
        >
          <CalendarIcon className="h-3.5 w-3.5" />
          {date ? format(date, 'dd MMM yyyy') : label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0 pointer-events-auto" align="start">
        <Calendar
          mode="single"
          selected={date}
          onSelect={onSelect}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  );
}

type PresetKey = 'week' | '30days' | 'quarter' | 'ytd' | 'custom';

const PRESETS: { key: PresetKey; label: string; getRange: () => { start: Date; end: Date } }[] = [
  {
    key: 'week',
    label: 'This week',
    getRange: () => ({ start: startOfWeek(new Date(), { weekStartsOn: 1 }), end: new Date() }),
  },
  {
    key: '30days',
    label: 'Last 30 days',
    getRange: () => ({ start: subDays(new Date(), 29), end: new Date() }),
  },
  {
    key: 'quarter',
    label: 'This quarter',
    getRange: () => ({ start: startOfQuarter(new Date()), end: new Date() }),
  },
  {
    key: 'ytd',
    label: 'Year to date',
    getRange: () => ({ start: startOfYear(new Date()), end: new Date() }),
  },
];

export function CFOPayoutsShareButton() {
  const [busy, setBusy] = useState(false);
  const [startDate, setStartDate] = useState<Date | undefined>(startOfMonth(new Date()));
  const [endDate, setEndDate] = useState<Date | undefined>(new Date());
  const [activePreset, setActivePreset] = useState<PresetKey>('custom');

  const handleShare = async () => {
    if (!startDate || !endDate) {
      toast.error('Please select both start and end dates.');
      return;
    }
    if (startDate > endDate) {
      toast.error('Start date cannot be after end date.');
      return;
    }

    setBusy(true);
    try {
      const from = startOfDay(startDate).toISOString();
      const to = endOfDay(endDate).toISOString();

      const { data, error } = await supabase
        .from('audit_logs')
        .select('action_type, created_at, metadata')
        .in('action_type', PAYOUT_ACTIONS)
        .gte('created_at', from)
        .lte('created_at', to)
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;

      const rows: CfoPayoutRow[] = (data || [])
        .map((a: any) => {
          const meta = a.metadata || {};
          const amount = Number(meta.amount ?? meta.total_amount ?? 0);
          const recipient =
            meta.target_name || meta.target_user_name || meta.user_name ||
            meta.partner_name || meta.agent_name || meta.recipient_name || '—';
          // Reason: prefer the explicit reason field; otherwise parse the
          // "Reason: …" suffix some payouts embed in their description.
          let reason: string =
            meta.reason || meta.payout_reason || meta.note || meta.notes || meta.purpose || '';
          if (!reason && typeof meta.description === 'string') {
            const m = meta.description.match(/Reason:\s*(.+?)\s*$/i);
            if (m) reason = m[1];
          }
          reason = (reason || '').toString().trim();
          return {
            date: new Date(a.created_at),
            recipient,
            amount,
            type: ACTION_LABEL[a.action_type] || a.action_type,
            reference: meta.reference_id || meta.reference || meta.tid || meta.transaction_id || meta.batch_reference || '',
            reason,
          } as CfoPayoutRow;
        })
        .filter(r => r.amount > 0);

      if (rows.length === 0) {
        toast.error('No payouts found for the selected period.');
        return;
      }

      // Recipient breakdown: group by recipient and sum amounts
      const breakdownMap = new Map<string, { recipient: string; count: number; total: number }>();
      for (const r of rows) {
        const key = r.recipient || '—';
        const existing = breakdownMap.get(key);
        if (existing) {
          existing.count += 1;
          existing.total += r.amount;
        } else {
          breakdownMap.set(key, { recipient: key, count: 1, total: r.amount });
        }
      }
      const breakdown = Array.from(breakdownMap.values()).sort((a, b) => b.total - a.total);

      const blob = await generateCfoPayoutsPdf(rows, new Date(), { startDate, endDate }, breakdown);
      const filename = `welile-payouts-${format(startDate, 'yyyy-MM-dd')}-to-${format(endDate, 'yyyy-MM-dd')}.pdf`;
      const total = rows.reduce((s, r) => s + r.amount, 0);
      const caption = `Welile Wallet Payouts — ${rows.length} payouts totalling UGX ${total.toLocaleString()} (${format(startDate, 'dd MMM yyyy')} – ${format(endDate, 'dd MMM yyyy')}).`;
      await shareCfoPayoutsPdf(blob, filename, caption);
    } catch (err: any) {
      toast.error('Could not generate payouts PDF', { description: err?.message });
    } finally {
      setBusy(false);
    }
  };

  const applyPreset = (key: PresetKey) => {
    if (key === 'custom') return;
    const preset = PRESETS.find(p => p.key === key);
    if (!preset) return;
    const { start, end } = preset.getRange();
    setStartDate(start);
    setEndDate(end);
    setActivePreset(key);
  };

  const handleStartChange = (d?: Date) => {
    setStartDate(d);
    setActivePreset('custom');
  };

  const handleEndChange = (d?: Date) => {
    setEndDate(d);
    setActivePreset('custom');
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        {PRESETS.map(p => (
          <Button
            key={p.key}
            size="sm"
            variant={activePreset === p.key ? 'default' : 'outline'}
            onClick={() => applyPreset(p.key)}
            className="text-xs h-7 px-2.5"
          >
            {p.label}
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <DatePicker label="Start date" date={startDate} onSelect={handleStartChange} />
        <span className="text-muted-foreground text-sm">to</span>
        <DatePicker label="End date" date={endDate} onSelect={handleEndChange} />
        <Button variant="outline" size="sm" onClick={handleShare} disabled={busy} className="gap-1.5">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
          Share Payouts PDF
        </Button>
      </div>
    </div>
  );
}
