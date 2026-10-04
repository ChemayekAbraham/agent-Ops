import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { RotateCcw } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';

/**
 * Fin Ops in-session notifier for operational-float deposit requests
 * that have been moved back to the pending queue (reopened).
 *
 * Polls `audit_logs` every 30s for `deposit_request_reopened` rows whose
 * `new_values.deposit_purpose = 'operational_float'`, and toasts each new
 * one observed during the session. The first poll seeds the "seen" set
 * silently so the operator only sees alerts for reopens happening WHILE
 * they are on the verification screen — no historical replay.
 */
export function OpFloatReopenNotifier() {
  const seenRef = useRef<Set<string>>(new Set());
  const seededRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      const sinceIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from('audit_logs')
        .select('id, record_id, metadata, created_at')
        .eq('table_name', 'deposit_requests')
        .eq('action_type', 'deposit_request_reopened')
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(50);
      if (cancelled || error || !data) return;

      const opFloatRows = data.filter((row) => {
        const meta = row.metadata as Record<string, unknown> | null;
        return meta && (meta as any).deposit_purpose === 'operational_float';
      });

      if (!seededRef.current) {
        opFloatRows.forEach((r) => seenRef.current.add(r.id));
        seededRef.current = true;
        return;
      }

      // Toast newest-first so multiple reopens stack in chronological order
      const fresh = opFloatRows.filter((r) => !seenRef.current.has(r.id)).reverse();
      for (const row of fresh) {
        seenRef.current.add(row.id);
        const meta = (row.metadata ?? {}) as Record<string, unknown>;
        const amount = Number((meta as any).amount ?? 0);
        const tid = (meta as any).tid as string | null | undefined;
        const reason = (meta as any).reason as string | undefined;
        toast.message('Operational-float request reopened', {
          icon: <RotateCcw className="h-4 w-4 text-primary" />,
          description: [
            `Back in the pending queue for Fin Ops verification.`,
            amount > 0 ? `Amount: ${formatUGX(amount)}` : null,
            tid ? `TID: ${tid}` : null,
            reason ? `Reason: ${reason}` : null,
          ]
            .filter(Boolean)
            .join(' • '),
          duration: 8000,
        });
      }
    };

    void poll();
    const id = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return null;
}

export default OpFloatReopenNotifier;