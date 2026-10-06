/**
 * Follow-up controls for one short Rent Plan in the Collection Shortfall side panel:
 * tap-to-call / WhatsApp for the tenant and the agent (the app's existing ContactActions,
 * unchanged), the latest follow-up line, and a "Mark followed up" action. Recording goes
 * through tops_record_shortfall_followup; nothing here touches money or the collection path.
 */
import { useState } from 'react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { ClipboardCheck, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { ContactActions } from '@/components/ops/ContactActions';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import type { ShortfallDetailRow } from '@/hooks/tenantOpsWorkspace/useShortfallDetail';
import {
  useRecordShortfallFollowup, type ShortfallFollowupLatest, type ShortfallFollowupOutcome,
} from '@/hooks/tenantOpsWorkspace/useShortfallFollowups';
import {
  FOLLOWUP_OUTCOMES, MIN_FOLLOWUP_NOTE, describeFollowup,
} from '@/hooks/tenantOpsWorkspace/shortfallFollowupLabels';

// ─── Latest follow-up line ───────────────────────────────────────────────────

export function LatestFollowupLine({ latest }: { latest: ShortfallFollowupLatest | undefined }) {
  if (!latest) {
    return <p className="text-xs text-muted-foreground">Not followed up yet</p>;
  }
  const s = describeFollowup(latest);
  return (
    <div className="space-y-0.5" data-testid="latest-followup">
      <p className="text-xs font-medium">
        {s.line}
        {s.promisePassed && <span className="text-destructive"> · promise date passed</span>}
      </p>
      <p className="line-clamp-2 break-words text-[11px] text-muted-foreground">{s.note}</p>
      <p className="text-[10px] text-muted-foreground">
        {[s.by, s.count > 1 ? `${s.count} follow-ups` : null].filter(Boolean).join(' · ')}
      </p>
    </div>
  );
}

// ─── Mark followed up dialog ─────────────────────────────────────────────────

export function MarkFollowedUpDialog({
  row, open, onOpenChange,
}: {
  row: ShortfallDetailRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [outcome, setOutcome] = useState<ShortfallFollowupOutcome | ''>('');
  const [note, setNote] = useState('');
  const [promised, setPromised] = useState('');
  const [touched, setTouched] = useState(false);
  const record = useRecordShortfallFollowup();

  const reset = () => {
    setOutcome('');
    setNote('');
    setPromised('');
    setTouched(false);
    record.reset();
  };

  const noteLen = note.trim().length;
  const noteOk = noteLen >= MIN_FOLLOWUP_NOTE;
  const today = format(new Date(), 'yyyy-MM-dd');
  const dateOk = !promised || promised >= today;
  const canSave = !!row && !!outcome && noteOk && dateOk && !record.isPending;

  const save = () => {
    setTouched(true);
    if (!row || !outcome || !noteOk || !dateOk) return;
    record.mutate(
      {
        rentRequestId: row.rent_request_id,
        outcome,
        note: note.trim(),
        promisedDate: outcome === 'reached_will_pay' && promised ? promised : null,
      },
      {
        onSuccess: () => {
          toast.success('Follow-up saved');
          onOpenChange(false);
          reset();
        },
      },
    );
  };

  const serverError = record.error
    ? ((record.error as { message?: string }).message || 'Could not save the follow-up')
    : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (record.isPending) return;
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent stable className="max-w-[calc(100vw-1.5rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark followed up</DialogTitle>
          <DialogDescription>
            {row
              ? `${row.tenant_name ?? 'Unnamed tenant'} · Rent Plan ${row.plan_code} · ${formatUGX(row.short_ugx)} short`
              : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold">What happened?</legend>
            <RadioGroup
              value={outcome}
              onValueChange={(v) => {
                setOutcome(v as ShortfallFollowupOutcome);
                if (v !== 'reached_will_pay') setPromised('');
              }}
              className="gap-2"
            >
              {FOLLOWUP_OUTCOMES.map((o) => (
                <Label
                  key={o.value}
                  htmlFor={`followup-${o.value}`}
                  className={cn(
                    'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-sm font-normal',
                    outcome === o.value && 'border-primary bg-primary/5',
                  )}
                >
                  <RadioGroupItem id={`followup-${o.value}`} value={o.value} />
                  <span className="min-w-0">
                    <span className="block font-medium">{o.label}</span>
                    <span className="block text-[11px] text-muted-foreground">{o.hint}</span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
            {touched && !outcome && <p className="text-xs text-destructive">Choose what happened.</p>}
          </fieldset>

          {outcome === 'reached_will_pay' && (
            <div className="space-y-1.5">
              <Label htmlFor="followup-promised" className="text-xs font-semibold">
                Promised payment date (optional)
              </Label>
              <Input
                id="followup-promised"
                type="date"
                min={today}
                value={promised}
                onChange={(e) => setPromised(e.target.value)}
                className="h-11"
              />
              {!dateOk && <p className="text-xs text-destructive">The promised date cannot be in the past.</p>}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="followup-note" className="text-xs font-semibold">Note</Label>
            <Textarea
              id="followup-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => setTouched(true)}
              rows={3}
              maxLength={500}
              placeholder="What was said, and what happens next"
            />
            <div className="flex items-center justify-between gap-2">
              <p className={cn('text-xs', touched && !noteOk ? 'text-destructive' : 'text-muted-foreground')}>
                At least {MIN_FOLLOWUP_NOTE} characters.
              </p>
              <p className="text-[11px] tabular-nums text-muted-foreground">{noteLen}/500</p>
            </div>
          </div>

          {serverError && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {serverError}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" className="h-11" disabled={record.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" className="h-11 gap-2" disabled={!canSave} onClick={save}>
            {record.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardCheck className="h-4 w-4" />}
            Save follow-up
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Per-row actions (call, latest follow-up, mark) ──────────────────────────

export function ShortfallRowActions({
  row, latest, onMark,
}: {
  row: ShortfallDetailRow;
  latest: ShortfallFollowupLatest | undefined;
  onMark: (row: ShortfallDetailRow) => void;
}) {
  const tenant = row.tenant_name ?? 'there';
  const agent = row.agent_name ?? 'there';
  return (
    <div className="space-y-2.5 border-t border-border/60 pt-2.5">
      <LatestFollowupLine latest={latest} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Tenant</span>
          <ContactActions
            phone={row.tenant_phone}
            showLabels
            message={`Hello ${tenant}, this is Welile Ops about your Rent Plan ${row.plan_code}.`}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Agent</span>
          <ContactActions
            phone={row.agent_phone}
            showLabels
            message={`Hello ${agent}, this is Welile Ops about Rent Plan ${row.plan_code} (${row.tenant_name ?? 'tenant'}).`}
          />
        </div>
      </div>

      <Button
        type="button"
        variant="outline"
        className="h-10 w-full gap-2 text-xs font-semibold"
        onClick={() => onMark(row)}
      >
        <ClipboardCheck className="h-4 w-4" />
        Mark followed up
      </Button>
    </div>
  );
}
