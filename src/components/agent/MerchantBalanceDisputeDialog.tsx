import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import {
  DISPUTED_FIELD_LABELS,
  DisputedField,
  useMyBalanceDisputes,
  useRaiseBalanceDispute,
} from '@/hooks/useMerchantBalanceDisputes';

/**
 * A merchant agent tells Finance that a figure on their dashboard is wrong.
 * Nothing here touches money — it only opens a written request that Financial
 * Ops sees on their board and corrects there.
 */
export function MerchantBalanceDisputeDialog({
  open,
  onOpenChange,
  deskId,
  amounts,
  initialField = 'owed_to_agent',
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  deskId?: string | null;
  amounts: Partial<Record<DisputedField, number>>;
  initialField?: DisputedField;
}) {
  const [field, setField] = useState<DisputedField>(initialField);
  const [claimed, setClaimed] = useState('');
  const [reason, setReason] = useState('');
  const raise = useRaiseBalanceDispute();
  const { data: mine } = useMyBalanceDisputes(open);

  const systemAmount = amounts[field] ?? 0;
  const claimedNum = claimed.trim() ? Number(claimed.replace(/[^\d.-]/g, '')) : null;
  const valid = reason.trim().length >= 15 && (claimedNum === null || Number.isFinite(claimedNum));

  const submit = async () => {
    try {
      await raise.mutateAsync({
        deskId,
        disputedField: field,
        systemAmount,
        claimedAmount: claimedNum,
        reason,
      });
      toast.success('Sent to Finance. They will check and correct it.');
      setClaimed('');
      setReason('');
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e?.message || 'Could not send your request');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">This figure is not right</DialogTitle>
          <DialogDescription className="text-xs">
            Tell Finance which number is wrong and what you actually have. They will check it and fix
            it on their side. Nothing changes until they do.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-xs">Which figure is wrong</Label>
            <Select value={field} onValueChange={(v) => setField(v as DisputedField)}>
              <SelectTrigger className="mt-1 h-9 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[200]">
                {(Object.keys(DISPUTED_FIELD_LABELS) as DisputedField[]).map((k) => (
                  <SelectItem key={k} value={k} className="text-xs">
                    {DISPUTED_FIELD_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-xl border border-border bg-muted/30 p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              What the system shows now
            </p>
            <p className="mt-0.5 font-mono text-base font-bold tabular-nums text-foreground break-all">
              {formatUGX(systemAmount)}
            </p>
          </div>

          <div>
            <Label className="text-xs">What it should be (UGX, optional)</Label>
            <Input
              value={claimed}
              onChange={(e) => setClaimed(e.target.value)}
              inputMode="numeric"
              placeholder="e.g. 250000"
              className="mt-1 h-9 text-sm"
            />
          </div>

          <div>
            <Label className="text-xs">Explain what happened (at least 15 letters)</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              placeholder="Tell Finance why this figure is wrong — what you sent, what you received, and any transaction IDs"
              className="mt-1 text-sm"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">{reason.trim().length}/15</p>
          </div>

          <Button onClick={submit} disabled={!valid || raise.isPending} className="w-full">
            {raise.isPending ? 'Sending…' : 'Send to Finance'}
          </Button>
        </div>

        {!!mine?.length && (
          <div className="border-t border-border pt-3 space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Your past requests
            </p>
            {mine.slice(0, 5).map((d) => (
              <div key={d.id} className="rounded-xl border border-border bg-muted/20 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-medium text-foreground truncate">
                    {DISPUTED_FIELD_LABELS[d.disputedField]}
                  </p>
                  <span
                    className={`text-[10px] font-semibold shrink-0 ${
                      d.status === 'resolved'
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : d.status === 'rejected'
                          ? 'text-destructive'
                          : 'text-warning'
                    }`}
                  >
                    {d.status === 'open'
                      ? 'Waiting for Finance'
                      : d.status === 'reviewing'
                        ? 'Finance is checking'
                        : d.status === 'resolved'
                          ? 'Fixed'
                          : 'Not accepted'}
                  </span>
                </div>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {new Date(d.createdAt).toLocaleString()} · showed {formatUGX(d.systemAmount)}
                  {d.claimedAmount !== null && ` · you said ${formatUGX(d.claimedAmount)}`}
                </p>
                {d.resolutionNote && (
                  <p className="mt-1 text-[10px] text-foreground">Finance: {d.resolutionNote}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
