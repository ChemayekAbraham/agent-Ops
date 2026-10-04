import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface NoteRow {
  id: string;
  agent_id: string | null;
  partner_name: string | null;
  phone_number: string | null;
  whatsapp_number: string | null;
  amount: number | null;
  status: string | null;
  created_at: string;
  approved_at: string | null;
}

const formatUGX = (n: number | null | undefined) =>
  `UGX ${Number(n || 0).toLocaleString('en-US')}`;

const statusClass = (status: string | null) => {
  const s = (status || '').toLowerCase();
  if (s === 'pending') return 'bg-amber-500/15 text-amber-600 border-amber-500/30';
  if (s === 'activated' || s === 'approved')
    return 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30';
  if (s === 'rejected') return 'bg-destructive/15 text-destructive border-destructive/30';
  return 'bg-muted text-muted-foreground border-border';
};

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
      {message}
    </div>
  );
}

export default function MyProxyNotesFeed() {
  const { user } = useAuth();
  const [showAll, setShowAll] = useState(false);

  const agentsQuery = useQuery({
    queryKey: ['my-proxy-agent-ids', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('partner_lead_assignments')
        .select('agent_id')
        .eq('lead_user_id', user!.id)
        .is('detached_at', null);
      if (error) throw error;
      return Array.from(
        new Set((data || []).map((r: { agent_id: string | null }) => r.agent_id).filter(Boolean)),
      ) as string[];
    },
  });

  const agentIds = agentsQuery.data || [];

  const notesQuery = useQuery({
    queryKey: ['my-proxy-notes-feed', agentIds],
    enabled: agentIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('promissory_notes')
        .select('id, agent_id, partner_name, phone_number, whatsapp_number, amount, status, created_at, approved_at')
        .in('agent_id', agentIds)
        .gte('created_at', '2026-08-05T00:00:00Z')
        .order('created_at', { ascending: false });
      if (error) throw error;
      const rows = (data || []) as NoteRow[];
      const names: Record<string, string> = {};
      const { data: profiles, error: pErr } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', agentIds);
      if (pErr) throw pErr;
      (profiles || []).forEach((p: { id: string; full_name: string | null }) => {
        if (p.full_name) names[p.id] = p.full_name;
      });
      return { rows, names };
    },
  });

  const refetchNotes = notesQuery.refetch;

  useEffect(() => {
    const channel = supabase
      .channel('my-proxy-notes-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'promissory_notes' }, () => {
        refetchNotes();
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [refetchNotes]);

  if (agentsQuery.isError) {
    return (
      <Card>
        <CardHeader><CardTitle>Notes from my proxy agents</CardTitle></CardHeader>
        <CardContent>
          <ErrorBox message={(agentsQuery.error as Error)?.message || String(agentsQuery.error)} />
        </CardContent>
      </Card>
    );
  }

  if (!agentsQuery.data || agentIds.length === 0) return null;

  const rows = notesQuery.data?.rows || [];
  const names = notesQuery.data?.names || {};
  const total = rows.length;
  const pending = rows.filter(r => (r.status || '').toLowerCase() === 'pending').length;
  const approved = rows.filter(r => ['approved', 'activated'].includes((r.status || '').toLowerCase())).length;
  const rejected = rows.filter(r => (r.status || '').toLowerCase() === 'rejected').length;
  const visible = showAll ? rows : rows.slice(0, 20);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notes from my proxy agents</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {notesQuery.isError ? (
          <ErrorBox message={(notesQuery.error as Error)?.message || String(notesQuery.error)} />
        ) : (
          <>
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: 'Total', value: total, cls: 'text-foreground' },
                { label: 'Pending', value: pending, cls: 'text-amber-600' },
                { label: 'Approved', value: approved, cls: 'text-emerald-600' },
                { label: 'Rejected', value: rejected, cls: 'text-destructive' },
              ].map(c => (
                <div key={c.label} className="rounded-md border bg-muted/30 p-2 text-center">
                  <div className={`text-lg font-bold ${c.cls}`}>{c.value}</div>
                  <div className="text-[11px] text-muted-foreground">{c.label}</div>
                </div>
              ))}
            </div>

            <div className="space-y-2">
              {visible.map(note => {
                const isPending = (note.status || '').toLowerCase() === 'pending';
                const days = Math.floor(
                  (Date.now() - new Date(note.created_at).getTime()) / 86400000,
                );
                const waitCls = days > 14 ? 'text-destructive' : days > 7 ? 'text-amber-600' : 'text-muted-foreground';
                return (
                  <div key={note.id} className="rounded-md border p-3 space-y-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{note.partner_name || 'Unnamed partner'}</p>
                        <p className="text-xs text-muted-foreground">
                          {note.phone_number || note.whatsapp_number || 'No phone'}
                        </p>
                      </div>
                      <Badge variant="outline" className={statusClass(note.status)}>
                        {note.status || 'unknown'}
                      </Badge>
                    </div>
                    <p className="text-sm font-semibold">{formatUGX(note.amount)}</p>
                    <p className="text-xs text-muted-foreground">
                      By {(note.agent_id && names[note.agent_id]) || 'Unknown agent'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Submitted {new Date(note.created_at).toLocaleDateString()}
                      {isPending && (
                        <span className={`ml-2 ${waitCls}`}>
                          {days} day{days === 1 ? '' : 's'} waiting
                        </span>
                      )}
                    </p>
                  </div>
                );
              })}
              {rows.length === 0 && !notesQuery.isLoading && (
                <p className="text-sm text-muted-foreground">No notes submitted yet.</p>
              )}
            </div>

            {rows.length > 20 && (
              <Button variant="outline" size="sm" onClick={() => setShowAll(v => !v)}>
                {showAll ? 'Show less' : `Show all (${rows.length})`}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
