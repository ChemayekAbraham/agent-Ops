import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';
import { ShieldAlert, Layers, Search, CheckCheck, XCircle } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import type { MerchantCapacity } from '@/lib/merchantFloatCapacity';
import {
  useMerchantCapacityOverrides,
  useBulkSetMerchantCapacityOverrides,
} from '@/hooks/useMerchantCapacityOverrides';

export interface BulkCapacityDesk {
  agentId: string;
  agentName: string;
  capacity?: MerchantCapacity;
}

interface DraftRow {
  amount: string;
  days: string;
  selected: boolean;
}

/**
 * Adjust several merchant desks' qualified daily capacity in ONE action.
 *
 * One reason covers the whole batch (audit requirement, minimum 10 characters);
 * each selected desk carries its own amount and its own duration in days.
 * Recommendation layer only — this changes the planning figure and how an entered
 * distribution pot is split. It moves no money, touches no wallet bucket and
 * posts no ledger entry. Every desk written is stamped with the actor, the time
 * and the shared reason in the audit trail.
 */
export function MerchantCapacityBulkOverrideDialog({
  open,
  onOpenChange,
  desks,
  canEdit,
  readOnlyReason,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  desks: BulkCapacityDesk[];
  canEdit: boolean;
  readOnlyReason?: string;
}) {
  const { data: overrides } = useMerchantCapacityOverrides(200);
  const bulkSet = useBulkSetMerchantCapacityOverrides();

  const [reason, setReason] = useState('');
  const [search, setSearch] = useState('');
  const [defaultDays, setDefaultDays] = useState('1');
  const [drafts, setDrafts] = useState<Record<string, DraftRow>>({});
  const [results, setResults] = useState<
    { agentId: string; agentName: string; ok: boolean; message?: string }[] | null
  >(null);

  const inForceFor = useMemo(() => {
    const m = new Map<string, number>();
    (overrides ?? [])
      .filter((o) => o.isInForce)
      .forEach((o) => {
        if (!m.has(o.agentId)) m.set(o.agentId, o.overrideCapacity);
      });
    return m;
  }, [overrides]);

  // Seed a row per desk when the screen opens: earned figure as the starting
  // amount so the preparer edits from the real record rather than from blank.
  useEffect(() => {
    if (!open) return;
    const seeded: Record<string, DraftRow> = {};
    desks.forEach((d) => {
      const earned = d.capacity?.performanceCapacity ?? 0;
      seeded[d.agentId] = {
        amount: earned > 0 ? String(Math.round(earned)) : '',
        days: '1',
        selected: false,
      };
    });
    setDrafts(seeded);
    setResults(null);
    setReason('');
    setSearch('');
    setDefaultDays('1');
  }, [open, desks]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return desks;
    return desks.filter((d) => d.agentName.toLowerCase().includes(q));
  }, [desks, search]);

  const patch = (agentId: string, next: Partial<DraftRow>) =>
    setDrafts((prev) => ({
      ...prev,
      [agentId]: { amount: '', days: '1', selected: false, ...prev[agentId], ...next },
    }));

  const parseAmount = (v: string) => Number((v || '').replace(/[^\d.]/g, ''));

  const selected = useMemo(
    () =>
      desks
        .map((d) => ({ desk: d, draft: drafts[d.agentId] }))
        .filter((x) => x.draft?.selected)
        .map((x) => ({
          agentId: x.desk.agentId,
          agentName: x.desk.agentName,
          capacity: parseAmount(x.draft!.amount),
          days: Number(x.draft!.days || '0'),
        })),
    [desks, drafts],
  );

  const invalid = selected.filter(
    (s) => !Number.isFinite(s.capacity) || s.capacity < 0 || !(s.days >= 1 && s.days <= 90),
  );
  const reasonOk = reason.trim().length >= 10;
  const canSubmit = canEdit && selected.length > 0 && invalid.length === 0 && reasonOk && !bulkSet.isPending;

  const applyDefaultDays = () => {
    const d = Number(defaultDays || '0');
    if (!(d >= 1 && d <= 90)) {
      toast.error('Duration must be between 1 and 90 days');
      return;
    }
    setDrafts((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((k) => {
        if (next[k].selected) next[k] = { ...next[k], days: String(d) };
      });
      return next;
    });
  };

  const setAllVisible = (on: boolean) =>
    setDrafts((prev) => {
      const next = { ...prev };
      visible.forEach((d) => {
        next[d.agentId] = { amount: '', days: '1', ...next[d.agentId], selected: on };
      });
      return next;
    });

  const submit = async () => {
    try {
      const res = await bulkSet.mutateAsync({ items: selected, reason: reason.trim() });
      setResults(res);
      const okCount = res.filter((r) => r.ok).length;
      const failCount = res.length - okCount;
      if (failCount === 0) {
        toast.success(`Capacity adjusted on ${okCount} desk${okCount === 1 ? '' : 's'}`);
      } else {
        toast.warning(`${okCount} applied, ${failCount} failed — see the result list`);
      }
      setDrafts((prev) => {
        const next = { ...prev };
        res.filter((r) => r.ok).forEach((r) => {
          if (next[r.agentId]) next[r.agentId] = { ...next[r.agentId], selected: false };
        });
        return next;
      });
    } catch (e: any) {
      toast.error(e?.message || 'Could not apply the adjustments');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl w-[calc(100vw-1.5rem)] sm:w-full max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Layers className="h-4 w-4 text-primary" />
            Bulk adjust qualified capacity
          </DialogTitle>
          <DialogDescription className="text-xs">
            Pick the desks, set each one's daily figure and how long it lasts, then give one reason
            for the whole batch. Planning recommendation only — no money moves.
          </DialogDescription>
        </DialogHeader>

        {!canEdit && (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {readOnlyReason || 'You can view capacity but not change it.'}
          </p>
        )}

        <div className="flex flex-wrap items-end gap-2">
          <div className="relative min-w-[180px] flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search desks by name"
              className="h-9 pl-7 text-xs"
            />
          </div>
          <div className="flex items-end gap-1">
            <div className="space-y-1">
              <Label className="text-[10px]">Set duration for selected</Label>
              <Input
                inputMode="numeric"
                value={defaultDays}
                onChange={(e) => setDefaultDays(e.target.value.replace(/[^\d]/g, ''))}
                className="h-9 w-20 font-mono tabular-nums"
              />
            </div>
            <Button type="button" variant="outline" size="sm" className="h-9" onClick={applyDefaultDays}>
              Apply
            </Button>
          </div>
          <Button type="button" variant="ghost" size="sm" className="h-9" onClick={() => setAllVisible(true)}>
            <CheckCheck className="mr-1 h-3.5 w-3.5" /> Select shown
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-9" onClick={() => setAllVisible(false)}>
            <XCircle className="mr-1 h-3.5 w-3.5" /> Clear
          </Button>
        </div>

        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[620px] text-xs">
            <thead className="bg-muted/40">
              <tr className="text-left">
                <th className="w-9 px-2 py-2" />
                <th className="px-2 py-2 font-semibold">Merchant desk</th>
                <th className="px-2 py-2 text-right font-semibold">Earned / day</th>
                <th className="px-2 py-2 text-right font-semibold">In force</th>
                <th className="px-2 py-2 font-semibold">Override (UGX / day)</th>
                <th className="px-2 py-2 font-semibold">Days</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                    No desks match that search.
                  </td>
                </tr>
              )}
              {visible.map((d) => {
                const draft = drafts[d.agentId] ?? { amount: '', days: '1', selected: false };
                const earned = d.capacity?.performanceCapacity ?? 0;
                const force = inForceFor.get(d.agentId);
                const amt = parseAmount(draft.amount);
                const daysN = Number(draft.days || '0');
                const rowInvalid =
                  draft.selected &&
                  (!Number.isFinite(amt) || amt < 0 || !(daysN >= 1 && daysN <= 90));
                return (
                  <tr key={d.agentId} className="border-t border-border">
                    <td className="px-2 py-2 align-middle">
                      <Checkbox
                        checked={draft.selected}
                        disabled={!canEdit}
                        onCheckedChange={(v) => patch(d.agentId, { selected: !!v })}
                        aria-label={`Select ${d.agentName}`}
                      />
                    </td>
                    <td className="px-2 py-2 align-middle font-medium">{d.agentName}</td>
                    <td className="px-2 py-2 text-right align-middle font-mono tabular-nums text-muted-foreground">
                      {formatUGX(Math.round(earned))}
                    </td>
                    <td className="px-2 py-2 text-right align-middle font-mono tabular-nums text-primary">
                      {force != null ? formatUGX(force) : '—'}
                    </td>
                    <td className="px-2 py-2 align-middle">
                      <Input
                        inputMode="numeric"
                        value={draft.amount}
                        disabled={!canEdit || !draft.selected}
                        onChange={(e) => patch(d.agentId, { amount: e.target.value })}
                        placeholder="e.g. 800000"
                        className={`h-8 w-32 font-mono tabular-nums ${rowInvalid ? 'border-destructive' : ''}`}
                      />
                    </td>
                    <td className="px-2 py-2 align-middle">
                      <Input
                        inputMode="numeric"
                        value={draft.days}
                        disabled={!canEdit || !draft.selected}
                        onChange={(e) => patch(d.agentId, { days: e.target.value.replace(/[^\d]/g, '') })}
                        className={`h-8 w-16 font-mono tabular-nums ${rowInvalid ? 'border-destructive' : ''}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="space-y-1">
          <Label htmlFor="bulk-cap-reason" className="text-[11px]">
            Reason for the whole batch (required, at least 10 characters)
          </Label>
          <Textarea
            id="bulk-cap-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            disabled={!canEdit}
            placeholder="Why these desks are being adjusted today"
          />
          <p className="text-[10px] text-muted-foreground">
            {reason.trim().length}/10 characters minimum. Stored against your name on every desk in
            this batch.
          </p>
        </div>

        {invalid.length > 0 && (
          <p className="text-[11px] font-medium text-destructive">
            {invalid.length} selected desk{invalid.length === 1 ? '' : 's'} still need a valid amount
            and a duration between 1 and 90 days.
          </p>
        )}

        <Button onClick={submit} disabled={!canSubmit} className="w-full">
          {bulkSet.isPending
            ? 'Applying…'
            : `Apply to ${selected.length} desk${selected.length === 1 ? '' : 's'}`}
        </Button>

        {results && (
          <div className="space-y-1 rounded-xl border border-border p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Result of the last batch
            </p>
            {results.map((r) => (
              <p
                key={r.agentId}
                className={`text-[11px] ${r.ok ? 'text-muted-foreground' : 'text-destructive'}`}
              >
                {r.ok ? '✓' : '✕'} {r.agentName}
                {r.ok ? ' — adjusted' : ` — ${r.message || 'failed'}`}
              </p>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
