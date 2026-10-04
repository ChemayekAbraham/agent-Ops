import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { AlertTriangle, CheckCircle, MessageCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';

const SEVERITY_STYLES: Record<string, string> = {
  low: 'border-border bg-muted/30',
  medium: 'border-amber-500/30 bg-amber-500/5',
  high: 'border-destructive/30 bg-destructive/5',
  critical: 'border-destructive/50 bg-destructive/10',
};

export function AgentEscalationQueue() {
  const [resolveOpen, setResolveOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [resolving, setResolving] = useState(false);
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: escalations, isLoading } = useQuery({
    queryKey: ['agent-escalation-queue'],
    queryFn: async () => {
      const { data } = await supabase.from('agent_escalations')
        .select('id, agent_id, escalation_type, severity, title, description, status, created_at')
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(50);

      const agentIds = [...new Set((data || []).map(e => e.agent_id))];
      const { data: profiles } = await supabase.from('profiles')
        .select('id, full_name').in('id', agentIds);
      const nameMap: Record<string, string> = {};
      (profiles || []).forEach(p => { nameMap[p.id] = p.full_name; });

      return (data || []).map(e => ({
        ...e,
        agent_name: nameMap[e.agent_id] || e.agent_id.substring(0, 8),
      }));
    },
    staleTime: 120000,
  });

  const handleResolve = async () => {
    if (!selectedId || notes.length < 5) {
      toast({ title: 'Error', description: 'Please add resolution notes (min 5 chars)', variant: 'destructive' });
      return;
    }
    setResolving(true);
    try {
      const { error } = await supabase.from('agent_escalations')
        .update({
          status: 'resolved',
          resolved_at: new Date().toISOString(),
          resolved_by: user?.id,
          resolution_notes: notes,
        })
        .eq('id', selectedId);
      if (error) throw error;
      toast({ title: 'Escalation Resolved' });
      setResolveOpen(false);
      setSelectedId(null);
      setNotes('');
      queryClient.invalidateQueries({ queryKey: ['agent-escalation-queue'] });
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setResolving(false);
    }
  };

  const openCount = (escalations || []).length;
  const criticalCount = (escalations || []).filter(e => e.severity === 'critical' || e.severity === 'high').length;

  return (
    <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <MessageCircle className="h-4 w-4" />
          Escalation Queue
          {openCount > 0 && <Badge variant="secondary" className="text-xs">{openCount}</Badge>}
        </h3>
        {criticalCount > 0 && (
          <Badge variant="destructive" className="text-[10px]">{criticalCount} urgent</Badge>
        )}
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground py-4 text-center">Loading...</p>
      ) : openCount === 0 ? (
        <div className="text-center py-6 text-muted-foreground">
          <CheckCircle className="h-6 w-6 mx-auto mb-2 opacity-30" />
          <p className="text-sm">No open escalations</p>
          <p className="text-xs">All agent issues have been resolved</p>
        </div>
      ) : (
        <div className="space-y-1.5 max-h-[250px] overflow-y-auto">
          {(escalations || []).map(esc => {
            const hoursAgo = Math.floor((Date.now() - new Date(esc.created_at).getTime()) / 3600000);
            return (
              <div key={esc.id} className={`flex items-start gap-2 p-2.5 rounded-xl border ${SEVERITY_STYLES[esc.severity]}`}>
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold truncate">{esc.title}</span>
                    <Badge variant="outline" className="text-[9px]">{esc.severity}</Badge>
                  </div>
                  <p className="text-[10px] text-muted-foreground truncate">
                    {esc.agent_name} • {esc.escalation_type} • {hoursAgo < 24 ? `${hoursAgo}h ago` : `${Math.floor(hoursAgo / 24)}d ago`}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 text-[10px] shrink-0"
                  onClick={() => { setSelectedId(esc.id); setResolveOpen(true); }}
                >
                  Resolve
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={resolveOpen} onOpenChange={setResolveOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Resolve Escalation</DialogTitle>
            <DialogDescription>Add resolution notes for audit trail</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <Textarea
              placeholder="How was this resolved? (min 5 chars)"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
            />
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setResolveOpen(false)}>Cancel</Button>
              <Button className="flex-1" onClick={handleResolve} disabled={resolving || notes.length < 5}>
                {resolving ? 'Resolving...' : 'Mark Resolved'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
