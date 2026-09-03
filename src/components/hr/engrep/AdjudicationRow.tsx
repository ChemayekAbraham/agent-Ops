/**
 * ENGREP P12 — per-row adjudication cells (Band + Written basis).
 *
 * Writes go through the engrep_adjudicate RPC only; engrep_rows is never written from
 * the client. No point, K, score, percentage or payout is displayed or computed here —
 * those live in the scoring workbook.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { adjudicate, isAdjudicator } from '@/hr/engrep/api';
import type { EngrepBand } from '@/hr/engrep/types';

export const BAND_OPTIONS: Array<{ value: EngrepBand; label: string }> = [
  { value: 'w1', label: 'W1' },
  { value: 'w2', label: 'W2' },
  { value: 'w3', label: 'W3' },
  { value: 'w4', label: 'W4' },
  { value: 'w5', label: 'W5' },
];

const MIN_BASIS_LENGTH = 25;
const RESTRICTED = 'Adjudication is restricted to the Lead Engineer.';
const ZERO_NOTE = 'A zero cannot be overridden, only annotated.';
const DUPLICATE_BASIS = 'This basis is identical to another row in this period';

// The engrep tables are newer than the generated Supabase types.
const db = supabase as unknown as { from: (table: string) => any };

export interface AdjudicationRowInput {
  id: string;
  window_id?: string | null;
  band: EngrepBand | null;
  basis: string | null;
  zeroed: boolean;
  zero_reason: string | null;
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/duplicate|unique|identical|already exists/i.test(message)) return DUPLICATE_BASIS;
  return message || 'Could not save the adjudication';
}

function AddendumDialog({
  open,
  onOpenChange,
  rowId,
  windowId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rowId: string;
  windowId: string | null;
}) {
  const [text, setText] = useState('');
  const remaining = Math.max(0, MIN_BASIS_LENGTH - text.trim().length);

  const save = useMutation({
    mutationFn: async () => {
      const { data: auth } = await supabase.auth.getUser();
      const { error } = await db.from('engrep_addenda').insert({
        window_id: windowId,
        row_id: rowId,
        addendum_text: text.trim(),
        created_by: auth?.user?.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Addendum recorded');
      setText('');
      onOpenChange(false);
    },
    onError: (error: unknown) => toast.error(friendlyError(error)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add addendum</DialogTitle>
        </DialogHeader>
        <Textarea
          rows={5}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Dated annotation for this zeroed row"
        />
        <p className="text-xs text-muted-foreground">
          {remaining > 0
            ? `${remaining} more character${remaining === 1 ? '' : 's'} required`
            : 'Ready to save'}
        </p>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={remaining > 0 || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save addendum'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Renders the Band cell and the Written basis cell for one row. */
export function AdjudicationCells({
  row,
  windowId,
}: {
  row: AdjudicationRowInput;
  windowId: string | null;
}) {
  const queryClient = useQueryClient();
  const effectiveWindowId = windowId ?? row.window_id ?? null;

  // The lock state is read from the database, never inferred in the client.
  const windowQuery = useQuery({
    queryKey: ['engrep', 'window-status', effectiveWindowId],
    enabled: Boolean(effectiveWindowId),
    queryFn: async () => {
      const { data, error } = await db
        .from('engrep_windows')
        .select('status, locked_at')
        .eq('id', effectiveWindowId)
        .maybeSingle();
      if (error) throw error;
      return data as { status: string; locked_at: string | null } | null;
    },
  });
  const locked = windowQuery.data?.status === 'locked' || Boolean(windowQuery.data?.locked_at);
  // No default selection and no suggested value: the harvest must never propose a band.
  const [band, setBand] = useState<EngrepBand | ''>(row.band ?? '');
  const [basis, setBasis] = useState(row.basis ?? '');
  const [addendumOpen, setAddendumOpen] = useState(false);

  const adjudicatorQuery = useQuery({
    queryKey: ['engrep', 'is-adjudicator'],
    queryFn: () => isAdjudicator().catch(() => false),
  });
  const canAdjudicate = adjudicatorQuery.data === true;

  const save = useMutation({
    mutationFn: () => adjudicate(row.id, band as EngrepBand, basis.trim()),
    onSuccess: () => {
      toast.success('Adjudication saved');
      queryClient.invalidateQueries({ queryKey: ['engrep'] });
    },
    onError: (error: unknown) => toast.error(friendlyError(error)),
  });

  if (row.zeroed) {
    return (
      <>
        <td className="px-3 py-2 text-muted-foreground">
          <p className="text-xs">{row.zero_reason ?? 'Zeroed'}</p>
          <p className="text-xs italic">{ZERO_NOTE}</p>
        </td>
        <td className="px-3 py-2 text-muted-foreground">
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={locked || !canAdjudicate}
            title={canAdjudicate ? undefined : RESTRICTED}
            onClick={() => setAddendumOpen(true)}
          >
            Add addendum
          </Button>
          <AddendumDialog
            open={addendumOpen}
            onOpenChange={setAddendumOpen}
            rowId={row.id}
            windowId={effectiveWindowId}
          />
        </td>
      </>
    );
  }

  const remaining = Math.max(0, MIN_BASIS_LENGTH - basis.trim().length);
  const readOnly = locked || !canAdjudicate;
  const disabledReason = locked
    ? 'Locked. Corrections by dated addendum.'
    : !canAdjudicate
      ? RESTRICTED
      : undefined;

  return (
    <>
      <td className="px-3 py-2">
        {readOnly ? (
          row.band ? (
            <span className="font-medium uppercase">{row.band}</span>
          ) : (
            <span className="font-medium text-destructive">Not set</span>
          )
        ) : (
          <div className="space-y-1">
            <Select value={band} onValueChange={(value) => setBand(value as EngrepBand)}>
              <SelectTrigger className="h-8 w-[92px]">
                <SelectValue placeholder="Not set" />
              </SelectTrigger>
              <SelectContent>
                {BAND_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!band && <p className="text-xs font-medium text-destructive">Not set</p>}
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        {readOnly ? (
          <div className="space-y-1">
            <p className="text-xs">{row.basis ?? <span className="text-destructive">Not set</span>}</p>
            {disabledReason && <p className="text-xs text-muted-foreground">{disabledReason}</p>}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 min-w-[200px] flex-1"
              value={basis}
              onChange={(event) => setBasis(event.target.value)}
              placeholder="Written basis"
            />
            <span className="text-xs text-muted-foreground">
              {remaining > 0 ? `${remaining} more` : 'ready'}
            </span>
            <Button
              size="sm"
              type="button"
              disabled={!band || remaining > 0 || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
      </td>
    </>
  );
}

export default AdjudicationCells;
