import { useCallback, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { AskReason, ReasonAnswer } from '@/lib/cooDecide';

export type CooReasonCode = { code: string; meaning: string; requires_text: boolean };

/** Reason codes for going against the system, from `coo_reason_codes`. Loaded only when the picker opens. */
export function useCooReasonCodes(enabled: boolean) {
  return useQuery({
    queryKey: ['coo-reason-codes'],
    enabled,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<CooReasonCode[]> => {
      const { data, error } = await supabase.rpc('coo_reason_codes');
      if (error) throw new Error(error.message);
      return (Array.isArray(data) ? data : []) as unknown as CooReasonCode[];
    },
  });
}

/**
 * "Why are you going against the system?" — opened only when the server answers
 * REASON_REQUIRED, so following the system costs no extra click.
 * Returns `askReason` for `cooDecide`, the dialog to render, and `meaningOf` for summaries.
 */
export function useCooReasonPicker() {
  const [open, setOpen] = useState(false);
  const [needsText, setNeedsText] = useState(false);
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const resolver = useRef<((a: ReasonAnswer) => void) | null>(null);
  const codes = useCooReasonCodes(open);

  const finish = (answer: ReasonAnswer) => {
    resolver.current?.(answer);
    resolver.current = null;
    setOpen(false);
  };

  const askReason: AskReason = useCallback((opts) => {
    setNeedsText(opts.needsText);
    setCode(opts.code ?? '');
    setText('');
    setOpen(true);
    return new Promise<ReasonAnswer>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const list = codes.data ?? [];
  const chosen = list.find((c) => c.code === code);
  const showText = needsText || !!chosen?.requires_text;
  const canSubmit = !!code && (!showText || text.trim().length >= 10);

  const meaningOf = useCallback(
    (c: string | null | undefined) => (c ? list.find((r) => r.code === c)?.meaning ?? c : null),
    [list],
  );

  const picker = (
    <Dialog open={open} onOpenChange={(o) => { if (!o) finish(null); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Why are you going against the system?</DialogTitle>
          <DialogDescription>Pick the reason. Nothing has been changed yet.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 max-h-[50vh] overflow-y-auto">
          {codes.isLoading && <p className="text-sm text-muted-foreground">Loading reasons…</p>}
          {codes.error && <p className="text-sm text-destructive">Could not load reasons: {(codes.error as Error).message}</p>}
          {list.map((r) => (
            <button
              key={r.code}
              type="button"
              onClick={() => setCode(r.code)}
              className={cn(
                'rounded-md border px-3 py-2 text-left text-sm transition-colors',
                code === r.code ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted',
              )}
            >
              {r.meaning}
            </button>
          ))}
        </div>
        {showText && (
          <div className="space-y-1">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="A short explanation (at least 10 characters)"
              rows={3}
            />
            <p className="text-xs text-muted-foreground">{text.trim().length}/10 characters minimum</p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => finish(null)}>Cancel</Button>
          <Button disabled={!canSubmit} onClick={() => finish({ code, text: showText ? text.trim() : undefined })}>
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { askReason, picker, meaningOf };
}
