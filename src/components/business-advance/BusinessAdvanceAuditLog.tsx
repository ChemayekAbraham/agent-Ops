import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronUp, History, Loader2, User, Bot } from 'lucide-react';
import { format } from 'date-fns';
import { useBusinessAdvanceRealtime } from '@/hooks/useBusinessAdvanceRealtime';

type AuditEntry = {
  stage: string;
  label: string;
  occurred_at: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  notes: string | null;
};

const ROLE_LABEL: Record<string, string> = {
  agent: 'Agent',
  agent_ops: 'Agent Ops',
  tenant_ops: 'Tenant Ops',
  landlord_ops: 'Landlord Ops',
  coo: 'COO',
  cfo: 'CFO',
  system: 'System',
};

/**
 * Expandable audit log shown beneath the live Business Advance tracker.
 * Lists every stage transition with timestamp, actor name and role so the
 * applicant has a complete approval paper trail. Auto-refreshes in lockstep
 * with the tracker via the shared `useBusinessAdvanceRealtime` hook.
 *
 * Pass `phone` for the public (anonymous) tracker — the SECURITY DEFINER RPC
 * verifies it matches the tenant before returning rows. Authenticated tenants,
 * the requesting agent, and staff roles bypass the phone check server-side.
 */
export function BusinessAdvanceAuditLog({
  advanceId,
  phone,
  defaultOpen = false,
}: {
  advanceId: string;
  phone?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  const fetchLog = async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('get_business_advance_audit_log', {
      p_advance_id: advanceId,
      p_phone: phone ?? null,
    });
    if (!error && Array.isArray(data)) setEntries(data as AuditEntry[]);
    setLoading(false);
    setLoaded(true);
  };

  useEffect(() => {
    if (open && !loaded) fetchLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep entries fresh while the log is open
  useBusinessAdvanceRealtime(open ? `audit-${advanceId}` : null, () => {
    if (open) fetchLog();
  });

  return (
    <div className="border-t border-border/60 pt-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        className="w-full justify-between h-8 px-2 text-xs font-semibold"
      >
        <span className="flex items-center gap-1.5">
          <History className="h-3.5 w-3.5" />
          Activity log
          {loaded && entries.length > 0 && (
            <span className="text-[10px] text-muted-foreground font-normal">({entries.length})</span>
          )}
        </span>
        {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </Button>

      {open && (
        <div className="mt-2 rounded-md border border-border/60 bg-muted/30 p-2.5">
          {loading && entries.length === 0 ? (
            <div className="flex justify-center py-3">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : entries.length === 0 ? (
            <p className="text-[11px] text-muted-foreground py-2 text-center">No activity yet.</p>
          ) : (
            <ol className="space-y-2">
              {entries.map((e, i) => {
                const isSystem = e.actor_role === 'system' || !e.actor_id;
                const Icon = isSystem ? Bot : User;
                return (
                  <li key={`${e.stage}-${i}`} className="flex gap-2 text-[11px]">
                    <div className="mt-0.5">
                      <Icon className="h-3 w-3 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-1.5">
                        <span className="font-semibold text-foreground">{e.label}</span>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-muted-foreground">
                          {e.actor_name || 'System'}
                          {e.actor_role && ROLE_LABEL[e.actor_role] && (
                            <span className="text-muted-foreground/80"> ({ROLE_LABEL[e.actor_role]})</span>
                          )}
                        </span>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {format(new Date(e.occurred_at), 'MMM d, yyyy • HH:mm')}
                      </p>
                      {e.notes && (
                        <p className="text-[10px] italic text-muted-foreground/90 mt-0.5">"{e.notes}"</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

export default BusinessAdvanceAuditLog;