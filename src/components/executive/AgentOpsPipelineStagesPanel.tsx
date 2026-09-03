import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Clock3, Loader2, Search, Workflow } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

type DirectoryAgent = {
  agent_id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  district: string | null;
  region: string | null;
};

type StageEvent = {
  id: string;
  agent_profile_id: string;
  stage: string;
  entered_at: string;
  set_by: string | null;
  note: string | null;
  created_at: string;
};

const STAGES = ['onboarded', 'training', 'qualified'] as const;
type Stage = (typeof STAGES)[number];

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return String(error || 'Something went wrong');
}

function stageLabel(stage: string): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-UG', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function AgentOpsPipelineStagesPanel() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const directoryQuery = useQuery({
    queryKey: ['agent-ops-pipeline-directory', search],
    queryFn: async () => {
      let query = supabase
        .from('vw_agent_ops_directory')
        .select('agent_id, full_name, phone, email, district, region')
        .order('full_name', { ascending: true })
        .limit(50);

      const term = search.trim();
      if (term) {
        const pattern = `%${term}%`;
        query = query.or(`full_name.ilike.${pattern},phone.ilike.${pattern},email.ilike.${pattern}`);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as DirectoryAgent[];
    },
    staleTime: 30_000,
  });

  const historyQuery = useQuery({
    queryKey: ['agent-ops-pipeline-history', selectedAgentId],
    enabled: Boolean(selectedAgentId),
    queryFn: async () => {
      if (!selectedAgentId) return [] as StageEvent[];
      const { data, error } = await supabase
        .from('agent_ops_pipeline_stage_events')
        .select('id, agent_profile_id, stage, entered_at, set_by, note, created_at')
        .eq('agent_profile_id', selectedAgentId)
        .order('entered_at', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as StageEvent[];
    },
  });

  const convertedQuery = useQuery({
    queryKey: ['agent-ops-pipeline-converted', selectedAgentId],
    enabled: Boolean(selectedAgentId),
    queryFn: async () => {
      if (!selectedAgentId) return false;
      const { data, error } = await supabase
        .from('rent_requests')
        .select('id')
        .eq('agent_id', selectedAgentId)
        .limit(1);
      if (error) throw error;
      return (data ?? []).length > 0;
    },
  });

  const selectedAgent = useMemo(
    () => directoryQuery.data?.find((agent) => agent.agent_id === selectedAgentId) ?? null,
    [directoryQuery.data, selectedAgentId],
  );
  const latestEvent = historyQuery.data?.[0] ?? null;

  const setStageMutation = useMutation({
    mutationFn: async (stage: Stage) => {
      if (!selectedAgentId) throw new Error('Select an agent first');
      const { data, error } = await supabase.rpc('agent_ops_set_stage', {
        p_agent_profile_id: selectedAgentId,
        p_stage: stage,
        p_note: note.trim() || null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      setActionError(null);
      setNote('');
      await queryClient.invalidateQueries({ queryKey: ['agent-ops-pipeline-history', selectedAgentId] });
    },
    onError: (error) => setActionError(errorMessage(error)),
  });

  const selectAgent = (agentId: string) => {
    setSelectedAgentId(agentId);
    setActionError(null);
    setNote('');
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Workflow className="h-4 w-4 text-primary" />
            Pipeline stages
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Search an agent to review the latest stage and record the next pipeline milestone.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name, phone, or email"
              className="pl-9"
              aria-label="Search pipeline agents"
            />
          </div>

          {directoryQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Searching agents…
            </div>
          ) : directoryQuery.error ? (
            <p className="py-6 text-sm text-destructive">{errorMessage(directoryQuery.error)}</p>
          ) : directoryQuery.data?.length ? (
            <div className="divide-y rounded-md border">
              {directoryQuery.data.map((agent) => (
                <button
                  key={agent.agent_id}
                  type="button"
                  onClick={() => selectAgent(agent.agent_id)}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50',
                    selectedAgentId === agent.agent_id && 'bg-muted',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{agent.full_name || 'Unnamed agent'}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[agent.phone, agent.email].filter(Boolean).join(' · ') || 'No contact details'}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-muted-foreground">
                    {[agent.district, agent.region].filter(Boolean).join(', ') || 'Location not set'}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="py-8 text-center text-sm text-muted-foreground">No agents match this search.</div>
          )}
        </CardContent>
      </Card>

      {selectedAgent && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base">{selectedAgent.full_name || 'Unnamed agent'}</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  {[selectedAgent.phone, selectedAgent.email].filter(Boolean).join(' · ') || 'No contact details'}
                </p>
              </div>
              {convertedQuery.data && <Badge variant="secondary">Converted</Badge>}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {historyQuery.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading stage history…
              </div>
            ) : historyQuery.error ? (
              <p className="text-sm text-destructive">{errorMessage(historyQuery.error)}</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground">Latest stage</span>
                  <Badge variant={latestEvent ? 'default' : 'outline'}>
                    {latestEvent ? stageLabel(latestEvent.stage) : 'Not set'}
                  </Badge>
                  {latestEvent && (
                    <span className="text-xs text-muted-foreground">{formatDate(latestEvent.entered_at)}</span>
                  )}
                </div>

                <Separator />

                <div className="space-y-3">
                  <div>
                    <p className="text-sm font-medium">Record stage</p>
                    <p className="text-xs text-muted-foreground">Optional note for the stage event.</p>
                  </div>
                  <Textarea
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Add a note (optional)"
                    rows={3}
                    aria-label="Stage note"
                    disabled={convertedQuery.data || setStageMutation.isPending}
                  />
                  <div className="flex flex-wrap gap-2">
                    {STAGES.map((stage) => (
                      <Button
                        key={stage}
                        type="button"
                        variant={latestEvent?.stage === stage ? 'secondary' : 'outline'}
                        disabled={Boolean(convertedQuery.data) || setStageMutation.isPending || !user}
                        onClick={() => setStageMutation.mutate(stage)}
                      >
                        {setStageMutation.isPending && setStageMutation.variables === stage ? (
                          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                        ) : latestEvent?.stage === stage ? (
                          <Check className="mr-1.5 h-4 w-4" />
                        ) : null}
                        {stageLabel(stage)}
                      </Button>
                    ))}
                  </div>
                  {convertedQuery.data && (
                    <p className="text-xs text-muted-foreground">Stage buttons are unavailable because this agent has a rent request.</p>
                  )}
                  {actionError && <p className="text-sm text-destructive">{actionError}</p>}
                </div>

                <Separator />

                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Clock3 className="h-4 w-4 text-muted-foreground" />
                    <p className="text-sm font-medium">Stage history</p>
                  </div>
                  {historyQuery.data?.length ? (
                    <div className="space-y-3">
                      {historyQuery.data.map((event) => (
                        <div key={event.id} className="border-l-2 border-border pl-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline">{stageLabel(event.stage)}</Badge>
                            <span className="text-xs text-muted-foreground">{formatDate(event.entered_at)}</span>
                          </div>
                          {event.note && <p className="mt-1 text-sm text-muted-foreground">{event.note}</p>}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No stage history recorded.</p>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
