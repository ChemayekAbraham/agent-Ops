import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Unlink, UserCog, Loader2 } from 'lucide-react';
import { format } from 'date-fns';

interface AssignmentRow {
  id: string;
  lead_user_id: string;
  agent_id: string;
  reason: string;
  attached_at: string;
}

/**
 * Lead partner growth — proxy agent connections.
 * Read-only list of active attachments with detach capability.
 */
export function PartnerLeadAssignments() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [detaching, setDetaching] = useState<string | null>(null);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['partner-lead-assignments', 'active'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('partner_lead_assignments')
        .select('id, lead_user_id, agent_id, reason, attached_at')
        .is('detached_at', null)
        .order('attached_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as AssignmentRow[];
    },
  });

  const personIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      set.add(r.lead_user_id);
      set.add(r.agent_id);
    }
    return [...set];
  }, [rows]);

  const { data: nameMap = {} } = useQuery({
    queryKey: ['partner-lead-assignments', 'names', personIds],
    enabled: personIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', personIds);
      if (error) throw error;
      const map: Record<string, string> = {};
      for (const p of data ?? []) map[p.id] = p.full_name ?? p.id;
      return map;
    },
  });

  const { data: consentMap = {} } = useQuery({
    queryKey: ['proxy-agreement-consents', 'current-month', personIds],
    enabled: personIds.length > 0,
    queryFn: async () => {
      const start = new Date();
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setMonth(end.getMonth() + 1);

      const { data, error } = await supabase
        .from('proxy_agreement_consents')
        .select('agent_user_id, accepted_at, proxy_agreement_versions(version_code)')
        .in('agent_user_id', personIds)
        .gte('period_month', start.toISOString())
        .lt('period_month', end.toISOString())
        .order('accepted_at', { ascending: false });
      if (error) throw error;

      const map: Record<string, { accepted_at: string; version_code: string }> = {};
      for (const c of data ?? []) {
        const agentId = c.agent_user_id;
        if (!map[agentId]) {
          const version = (c.proxy_agreement_versions as { version_code?: string } | null)?.version_code ?? '';
          map[agentId] = { accepted_at: c.accepted_at, version_code: version };
        }
      }
      return map;
    },
  });

  const attachmentsState = useQuery({
    queryKey: ['partner-lead-assignments', 'active'],
    enabled: false,
    queryFn: async () => [] as AssignmentRow[],
  });
  const namesState = useQuery({
    queryKey: ['partner-lead-assignments', 'names', personIds],
    enabled: false,
    queryFn: async () => ({}) as Record<string, string>,
  });
  const consentsState = useQuery({
    queryKey: ['proxy-agreement-consents', 'current-month', personIds],
    enabled: false,
    queryFn: async () => ({}) as Record<string, { accepted_at: string; version_code: string }>,
  });
  const errText = (e: unknown, fallback: string) =>
    e instanceof Error ? e.message : typeof e === 'string' ? e : fallback;

  const handleDetach = async (id: string) => {
    setDetaching(id);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) throw new Error('Not signed in');

      const { error } = await supabase
        .from('partner_lead_assignments')
        .update({ detached_at: new Date().toISOString(), detached_by: uid })
        .eq('id', id);
      if (error) {
        toast({ title: 'Detach failed', description: error.message, variant: 'destructive' });
        return;
      }
      toast({ title: 'Detached' });
      qc.invalidateQueries({ queryKey: ['partner-lead-assignments'] });
    } catch (e) {
      toast({
        title: 'Detach failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setDetaching(null);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <UserCog className="h-4 w-4 text-primary" />
          Lead partner — proxy agent connections
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold">Active attachments</h4>
          <Badge variant="secondary">{rows.length}</Badge>
        </div>

        {namesState.isError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Could not load names: {errText(namesState.error, 'unknown error')}
          </div>
        )}

        {consentsState.isError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Could not load agreement consents: {errText(consentsState.error, 'unknown error')}
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading attachments...
          </div>
        ) : attachmentsState.isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Could not load attachments: {errText(attachmentsState.error, 'unknown error')}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No active attachments.</p>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => {
              const consent = consentMap[r.agent_id];
              return (
                <div
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3"
                >
                  <div className="min-w-0 space-y-0.5">
                    <p className="truncate text-sm font-medium">
                      {nameMap[r.lead_user_id] ?? r.lead_user_id}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      Agent: {nameMap[r.agent_id] ?? r.agent_id}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Attached {format(new Date(r.attached_at), 'dd MMM yyyy')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {consent ? (
                      <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                        Accepted {format(new Date(consent.accepted_at), 'dd MMM yyyy')} · {consent.version_code}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                        Not accepted
                      </Badge>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      disabled={detaching === r.id}
                      onClick={() => handleDetach(r.id)}
                    >
                      {detaching === r.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Unlink className="h-3.5 w-3.5" />
                      )}
                      Detach
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default PartnerLeadAssignments;
