import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
  CONCERN_PRIORITY_LABEL,
  CONCERN_STATUS_LABEL,
  type ConcernStatus,
  type ForwardedConcern,
  useConcernEvents,
  useForwardedConcerns,
} from '@/hooks/useCallingConcerns';
import { LandlordForwardConcernDialog } from './LandlordForwardConcernDialog';
import {
  AlertTriangle,
  Clock,
  MessageSquare,
  Plus,
  Search,
  UserCheck,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { formatHumanLabel } from './ccUi';

export function LandlordConcernsReviewTab() {
  const [statusFilter, setStatusFilter] = useState<'all' | ConcernStatus>('all');
  const [scope, setScope] = useState<'all' | 'to_me' | 'from_me'>('all');
  const [search, setSearch] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [active, setActive] = useState<ForwardedConcern | null>(null);

  const list = useForwardedConcerns({ days: 60, scope });

  // Scope to landlord subject_type
  const rows = useMemo(() => {
    const landlordOnly = (list.data ?? []).filter(
      (r) => !r.subject_type || r.subject_type === 'landlord',
    );
    const byStatus =
      statusFilter === 'all'
        ? landlordOnly
        : landlordOnly.filter((r) => r.status === statusFilter);
    const q = search.trim().toLowerCase();
    if (!q) return byStatus;
    return byStatus.filter((r) =>
      [r.title, r.context ?? '', r.caller_name ?? '', r.forwarded_to_name ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [list.data, statusFilter, search]);

  const sentCount = rows.filter((r) => r.status === 'sent' || r.status === 'received').length;
  const inProgressCount = rows.filter((r) => r.status === 'in_progress').length;
  const completedCount = rows.filter((r) => r.status === 'completed').length;
  const highPriorityCount = rows.filter(
    (r) => r.status !== 'completed' && (r.priority === 'high' || r.priority === 'critical'),
  ).length;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Card className="p-3">
          <div className="text-[11px] text-muted-foreground">Sent / Received</div>
          <div className="text-xl font-bold tabular-nums text-amber-600">{sentCount}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[11px] text-muted-foreground">Being Worked On</div>
          <div className="text-xl font-bold tabular-nums text-primary">{inProgressCount}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[11px] text-muted-foreground">High / Critical</div>
          <div className="text-xl font-bold tabular-nums text-destructive">{highPriorityCount}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[11px] text-muted-foreground">Completed</div>
          <div className="text-xl font-bold tabular-nums text-emerald-600">{completedCount}</div>
        </Card>
      </div>

      <Card className="p-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="h-3.5 w-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search landlord, issue title, or reviewer…"
            className="pl-8 h-8 text-xs"
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)}>
          <SelectTrigger className="h-8 text-xs w-[150px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="received">Received</SelectItem>
            <SelectItem value="in_progress">Being worked on</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex rounded-md border p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setScope('all')}
            className={`px-2 py-1 rounded ${scope === 'all' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
          >
            All
          </button>
          <button
            type="button"
            onClick={() => setScope('to_me')}
            className={`px-2 py-1 rounded ${scope === 'to_me' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
          >
            Assigned to Me
          </button>
        </div>
        <Button size="sm" className="h-8 text-xs gap-1.5" onClick={() => setNewOpen(true)}>
          <Plus className="h-3.5 w-3.5" /> Forward Landlord Issue
        </Button>
      </Card>

      <Card className="divide-y">
        {list.isLoading && (
          <div className="p-6 text-center text-xs text-muted-foreground">
            Loading landlord issues…
          </div>
        )}
        {!list.isLoading && rows.length === 0 && (
          <div className="p-8 text-center space-y-2">
            <AlertTriangle className="h-8 w-8 text-muted-foreground mx-auto" />
            <div className="text-sm font-medium">No landlord issues in this view</div>
            <p className="text-xs text-muted-foreground max-w-md mx-auto">
              Forward any landlord payout question, dispute, or property issue from a call so reviewers can resolve and track it.
            </p>
          </div>
        )}
        {rows.map((c) => {
          const statusLabel =
            CONCERN_STATUS_LABEL[c.status as ConcernStatus] ?? formatHumanLabel(c.status);
          const priorityLabel = CONCERN_PRIORITY_LABEL[c.priority] ?? formatHumanLabel(c.priority);
          return (
            <div
              key={c.id}
              onClick={() => setActive(c)}
              className="p-3 hover:bg-muted/40 cursor-pointer flex flex-col sm:flex-row sm:items-start justify-between gap-2 text-xs"
            >
              <div className="space-y-1 min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Badge variant="outline" className="text-[10px]">
                    {priorityLabel}
                  </Badge>
                  <Badge
                    variant={c.status === 'completed' ? 'default' : 'secondary'}
                    className="text-[10px]"
                  >
                    {statusLabel}
                  </Badge>
                  {c.caller_name && <span className="font-semibold text-sm">{c.caller_name}</span>}
                </div>
                <div className="font-medium text-foreground">{c.title}</div>
                {c.context && (
                  <p className="text-muted-foreground line-clamp-2 whitespace-pre-wrap">
                    {c.context}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <UserCheck className="h-3 w-3" />
                    Reviewer:{' '}
                    <strong className="text-foreground">{c.forwarded_to_name ?? 'Staff'}</strong>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Forwarded {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })} by{' '}
                    {c.forwarded_by_name ?? 'Staff'}
                  </span>
                </div>
                {c.outcome && (
                  <div className="mt-1 rounded bg-emerald-500/10 border border-emerald-500/20 px-2 py-1 text-[11px] text-emerald-700 dark:text-emerald-300">
                    <strong>Outcome:</strong> {c.outcome}
                  </div>
                )}
              </div>
              <Button size="sm" variant="outline" className="h-7 text-xs shrink-0">
                View Trail
              </Button>
            </div>
          );
        })}
      </Card>

      <LandlordForwardConcernDialog open={newOpen} onOpenChange={setNewOpen} />
      {active && (
        <LandlordConcernDetailDialog
          concern={active}
          open={!!active}
          onOpenChange={(v) => !v && setActive(null)}
        />
      )}
    </div>
  );
}

function LandlordConcernDetailDialog({
  concern,
  open,
  onOpenChange,
}: {
  concern: ForwardedConcern;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const events = useConcernEvents(concern.id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 text-primary" /> Landlord Issue —{' '}
            {concern.caller_name || concern.title}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="rounded-md bg-muted/40 p-2.5 text-xs flex flex-wrap gap-3">
            <span>
              Status:{' '}
              <strong>
                {CONCERN_STATUS_LABEL[concern.status as ConcernStatus] ??
                  formatHumanLabel(concern.status)}
              </strong>
            </span>
            <span>
              Priority:{' '}
              <strong>
                {CONCERN_PRIORITY_LABEL[concern.priority] ?? formatHumanLabel(concern.priority)}
              </strong>
            </span>
            <span>
              Assigned to: <strong>{concern.forwarded_to_name ?? 'Staff'}</strong>
            </span>
            <span>
              Raised by: <strong>{concern.forwarded_by_name ?? 'Staff'}</strong>
            </span>
          </div>

          <div>
            <div className="text-xs font-semibold text-muted-foreground">Summary</div>
            <div className="text-sm font-medium mt-0.5">{concern.title}</div>
          </div>

          {concern.context && (
            <div>
              <div className="text-xs font-semibold text-muted-foreground">Context & Notes</div>
              <div className="rounded bg-muted/30 p-2.5 text-xs whitespace-pre-wrap mt-0.5">
                {concern.context}
              </div>
            </div>
          )}

          {concern.outcome && (
            <div className="rounded bg-emerald-500/10 border border-emerald-500/20 p-2.5 text-xs text-emerald-700 dark:text-emerald-300">
              <strong>Resolution Outcome:</strong> {concern.outcome}
            </div>
          )}

          <div className="border-t pt-3 space-y-2">
            <div className="text-xs font-semibold flex items-center gap-1.5">
              <MessageSquare className="h-3.5 w-3.5" /> Activity Trail
            </div>
            <div className="max-h-48 overflow-y-auto space-y-1.5 text-xs">
              {(events.data ?? []).map((ev) => (
                <div key={ev.id} className="rounded bg-muted/40 px-2.5 py-1.5">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>
                      <strong className="text-foreground">{ev.actor_name ?? 'Staff'}</strong> ·{' '}
                      {formatHumanLabel(ev.action)}
                    </span>
                    <span>{formatDistanceToNow(new Date(ev.created_at), { addSuffix: true })}</span>
                  </div>
                  {ev.note && <div className="text-foreground mt-0.5">{ev.note}</div>}
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
