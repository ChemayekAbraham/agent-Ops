import { useEffect, useState } from 'react';
import { formatDistanceToNow, format } from 'date-fns';
import { Bot, ExternalLink, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/hooks/useAuth';
import {
  ASSISTANT_FAILURE_OUTCOMES, ESCALATION_REASON_LABEL,
  useAssistantConversations, useAssistantEscalations, useAssistantThread, useUpdateAssistantEscalation,
  type AssistantConversation, type AssistantEscalation, type AssistantOutcome,
  type EscalationReason, type EscalationStatus,
} from '@/hooks/useAssistantCrm';
import { cn } from '@/lib/utils';

const STATUS_LABEL: Record<EscalationStatus, string> = {
  open: 'Open', in_progress: 'In progress', resolved: 'Resolved', dismissed: 'Dismissed',
};
const FILTERS: (EscalationStatus | 'all')[] = ['open', 'in_progress', 'resolved', 'dismissed', 'all'];
const FAILURE_LABEL: Partial<Record<AssistantOutcome, string>> = {
  unmatched: 'Could not answer', out_of_scope: 'Out of scope', blocked: 'Blocked', error: 'Error',
};

const ago = (iso?: string | null) => (iso ? formatDistanceToNow(new Date(iso), { addSuffix: true }) : '-');
const agentName = (p?: { full_name: string | null } | null) => p?.full_name || 'Unknown agent';

type Selected = { kind: 'escalation'; item: AssistantEscalation } | { kind: 'conversation'; item: AssistantConversation };

export function AssistantConversationsPanel() {
  const [selected, setSelected] = useState<Selected | null>(null);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><Bot className="h-5 w-5" /></span>
        <div>
          <h2 className="text-lg font-semibold">Agent Assistant</h2>
          <p className="text-sm text-muted-foreground">Escalations and conversations from the read-only agent assistant.</p>
        </div>
      </div>
      <Tabs defaultValue="escalations">
        <TabsList>
          <TabsTrigger value="escalations">Escalations</TabsTrigger>
          <TabsTrigger value="conversations">All conversations</TabsTrigger>
        </TabsList>
        <TabsContent value="escalations"><EscalationsList onOpen={(item) => setSelected({ kind: 'escalation', item })} /></TabsContent>
        <TabsContent value="conversations"><ConversationsList onOpen={(item) => setSelected({ kind: 'conversation', item })} /></TabsContent>
      </Tabs>
      <DetailSheet selected={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function ListSkeleton() {
  return <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-2xl" />)}</div>;
}
function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-2xl bg-card border border-border/60 p-6 text-center space-y-3">
      <p className="text-sm text-muted-foreground">Could not load this list.</p>
      <Button variant="outline" onClick={onRetry}><RefreshCw className="mr-2 h-4 w-4" /> Retry</Button>
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return <div className="rounded-2xl bg-card border border-border/60 p-8 text-center text-sm text-muted-foreground">{text}</div>;
}
function StatusBadge({ status }: { status: string }) {
  const s = status as EscalationStatus;
  return <Badge variant={s === 'open' ? 'destructive' : s === 'in_progress' ? 'default' : 'secondary'}>{STATUS_LABEL[s] ?? status}</Badge>;
}

function EscalationsList({ onOpen }: { onOpen: (e: AssistantEscalation) => void }) {
  const [status, setStatus] = useState<EscalationStatus | 'all'>('open');
  const q = useAssistantEscalations(status);
  return (
    <div className="space-y-3 pt-2">
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button key={f} size="sm" variant={status === f ? 'default' : 'outline'} className="rounded-full" onClick={() => setStatus(f)}>
            {f === 'all' ? 'All' : STATUS_LABEL[f]}
          </Button>
        ))}
      </div>
      {q.isLoading ? <ListSkeleton /> : q.isError ? <ErrorState onRetry={() => q.refetch()} /> : !q.data?.length ? (
        <Empty text="No escalations right now" />
      ) : (
        <div className="space-y-2">
          {q.data.map((e) => (
            <button key={e.id} type="button" onClick={() => onOpen(e)}
              className="w-full text-left rounded-2xl bg-card border border-border/60 p-4 hover:bg-muted/40 transition-colors">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-sm truncate">{agentName(e.person)}</p>
                  <p className="text-xs text-muted-foreground">{e.person?.phone || 'No phone'}</p>
                </div>
                <StatusBadge status={e.status} />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>{ESCALATION_REASON_LABEL[e.reason as EscalationReason] ?? e.reason}</span>
                <span>{ago(e.created_at)}</span>
                <span>{e.conversation?.failedTurns ?? 0} unanswered</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ConversationsList({ onOpen }: { onOpen: (c: AssistantConversation) => void }) {
  const [onlyWithFailures, setOnly] = useState(false);
  const q = useAssistantConversations({ onlyWithFailures });
  return (
    <div className="space-y-3 pt-2">
      <div className="flex items-center gap-2">
        <Switch id="only-failures" checked={onlyWithFailures} onCheckedChange={setOnly} />
        <Label htmlFor="only-failures">Only with unanswered questions</Label>
      </div>
      {q.isLoading ? <ListSkeleton /> : q.isError ? <ErrorState onRetry={() => q.refetch()} /> : !q.data?.length ? (
        <Empty text="No conversations yet" />
      ) : (
        <div className="space-y-2">
          {q.data.map((c) => (
            <button key={c.id} type="button" onClick={() => onOpen(c)}
              className="w-full text-left rounded-2xl bg-card border border-border/60 p-4 hover:bg-muted/40 transition-colors">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-sm truncate">{agentName(c.person)}</p>
                  <p className="text-xs text-muted-foreground">{c.person?.phone || 'No phone'}</p>
                </div>
                {c.failedTurns > 0 && <Badge variant="destructive">{c.failedTurns} unanswered</Badge>}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                <span>Active {ago(c.last_active_at)}</span>
                <span>{c.message_count} messages</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DetailSheet({ selected, onClose }: { selected: Selected | null; onClose: () => void }) {
  const conversation = selected?.kind === 'escalation' ? selected.item.conversation : selected?.item ?? null;
  const conversationId = selected?.kind === 'escalation' ? selected.item.conversation_id : selected?.item.id ?? null;
  const person = selected?.item.person;
  return (
    <Sheet open={!!selected} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        {selected && (
          <div className="space-y-4">
            <SheetHeader className="text-left">
              <SheetTitle>{agentName(person)}</SheetTitle>
              <SheetDescription>{person?.phone || 'No phone'}</SheetDescription>
            </SheetHeader>
            {selected.kind === 'escalation' && <EscalationActions key={selected.item.id} esc={selected.item} />}
            <Thread conversationId={conversationId} />
            <ContextCard conversation={conversation} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function EscalationActions({ esc }: { esc: AssistantEscalation }) {
  const { user } = useAuth();
  const update = useUpdateAssistantEscalation();
  const [status, setStatus] = useState<EscalationStatus>(esc.status as EscalationStatus);
  const [notes, setNotes] = useState(esc.resolution_notes ?? '');
  const [assignee, setAssignee] = useState(esc.assigned_to);
  useEffect(() => { setStatus(esc.status as EscalationStatus); }, [esc.status]);

  const run = (input: Parameters<typeof update.mutate>[0], ok: string, after?: () => void) =>
    update.mutate(input, {
      onSuccess: () => { toast.success(ok); after?.(); },
      onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save'),
    });

  return (
    <div className="rounded-2xl bg-card border border-border/60 p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={status} />
        <span className="text-sm text-muted-foreground">{ESCALATION_REASON_LABEL[esc.reason as EscalationReason] ?? esc.reason}</span>
      </div>
      {esc.user_note && (
        <div className="rounded-xl bg-muted/50 p-3 text-sm whitespace-pre-wrap break-words">
          <p className="text-xs text-muted-foreground mb-1">Agent's note</p>{esc.user_note}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={!user?.id || assignee === user?.id || update.isPending}
          onClick={() => run({ id: esc.id, assigned_to: user!.id }, 'Assigned to you', () => setAssignee(user!.id))}>
          {assignee === user?.id ? 'Assigned to you' : 'Assign to me'}
        </Button>
        <Select value={status} onValueChange={(v) => {
          const s = v as EscalationStatus;
          run({ id: esc.id, status: s }, `Status set to ${STATUS_LABEL[s]}`, () => setStatus(s));
        }}>
          <SelectTrigger className="w-40 h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(Object.keys(STATUS_LABEL) as EscalationStatus[]).map((s) => <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="res-notes">Resolution notes</Label>
        <Textarea id="res-notes" value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} rows={3} />
        <Button size="sm" disabled={update.isPending || notes === (esc.resolution_notes ?? '')}
          onClick={() => run({ id: esc.id, resolution_notes: notes.trim() || null }, 'Notes saved')}>
          Save notes
        </Button>
      </div>
    </div>
  );
}

function Thread({ conversationId }: { conversationId: string | null }) {
  const q = useAssistantThread(conversationId);
  if (!conversationId) return null;
  if (q.isLoading) return <ListSkeleton />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  if (!q.data?.length) return <Empty text="No messages in this conversation" />;
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">Conversation</h3>
      {q.data.map((m) => {
        const isUser = m.role === 'user';
        const failed = !isUser && m.outcome && ASSISTANT_FAILURE_OUTCOMES.includes(m.outcome as AssistantOutcome);
        const tools = Array.isArray(m.tools_called) ? (m.tools_called as unknown[]).map(String) : [];
        return (
          <div key={m.id} className={cn('flex flex-col gap-1', isUser ? 'items-end' : 'items-start')}>
            <div className={cn('max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm',
              isUser ? 'bg-primary text-primary-foreground' : failed ? 'bg-destructive/10 text-foreground border border-destructive/40' : 'bg-muted text-foreground')}>
              {m.content}
            </div>
            <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
              <span>{format(new Date(m.created_at), 'd MMM HH:mm')}</span>
              {failed && <Badge variant="destructive" className="text-[10px]">{FAILURE_LABEL[m.outcome as AssistantOutcome] ?? m.outcome}</Badge>}
              {tools.map((t, i) => <Badge key={`${t}-${i}`} variant="outline" className="text-[10px] font-mono">{t}</Badge>)}
              {!isUser && m.model && <span>{m.model}</span>}
              {!isUser && m.latency_ms != null && <span>{m.latency_ms} ms</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Field({ label, value }: { label: string; value: unknown }) {
  const v = value === null || value === undefined || value === '' ? '-' : String(value);
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-all">{v}</span>
    </div>
  );
}

function ContextCard({ conversation }: { conversation: AssistantConversation | null }) {
  if (!conversation) return null;
  const c = conversation;
  const device = c.client_device && typeof c.client_device === 'object' && !Array.isArray(c.client_device)
    ? Object.entries(c.client_device as Record<string, unknown>) : [];
  const hasGps = c.geo_lat != null && c.geo_lng != null;
  return (
    <div className="rounded-2xl bg-card border border-border/60 p-4 space-y-4">
      <h3 className="text-sm font-semibold">Context</h3>
      <div className="space-y-1.5">
        <p className="text-xs font-medium">Observed by our server</p>
        <Field label="IP address" value={c.ip_address} />
        <Field label="Device class" value={c.device_class} />
        <Field label="Browser" value={c.device_browser} />
        <Field label="OS" value={c.device_os} />
        <Field label="User agent" value={c.user_agent} />
      </div>
      <div className="space-y-1.5 border-t border-border/60 pt-3">
        <p className="text-xs font-medium">Reported by the agent's device (can be spoofed, treat as a hint)</p>
        {device.length ? device.map(([k, v]) => <Field key={k} label={k} value={v} />) : <Field label="Device" value="Not shared" />}
        {hasGps ? (
          <>
            <Field label="GPS" value={`${c.geo_lat}, ${c.geo_lng}`} />
            <Field label="Accuracy" value={c.geo_accuracy_m != null ? `${Math.round(c.geo_accuracy_m)} m` : null} />
            <Field label="Captured" value={c.geo_captured_at ? format(new Date(c.geo_captured_at), 'd MMM yyyy HH:mm') : null} />
            <a href={`https://www.google.com/maps?q=${c.geo_lat},${c.geo_lng}`} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary underline">
              Open in Maps <ExternalLink className="h-3 w-3" />
            </a>
          </>
        ) : <Field label="GPS" value="Not shared" />}
      </div>
    </div>
  );
}
