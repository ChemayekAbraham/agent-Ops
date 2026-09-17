/**
 * Received Calls — calls that came IN to the Calling Center.
 *
 * Kept separate from the outbound `cc_*` calling spine on purpose: an incoming
 * call has no queue row, no cycle and no attempt number. The officer either ties
 * the caller to an existing person or types their name in by hand, records what
 * they said, and can forward the concern to a member of staff.
 */
import { useMemo, useState } from 'react';
import { CCBlock, CCDialogHeading, CCEmpty, CCPanel, CC_ROW } from './ccUi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Download, Forward, PhoneIncoming, Plus, Search, UserSearch } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { KPICard } from '../../KPICard';
import { ForwardConcernDialog, type ForwardConcernSource } from './ForwardConcernDialog';
import {
  RECEIVED_STATUS_LABEL,
  useCallerLookup,
  useForwardedConcerns,
  useConcernReviewers,
  useReceivedCalls,
  useRecordReceivedCall,
  useUpdateReceivedCall,
  type ReceivedCall,
  type ReceivedCallStatus,
} from '@/hooks/useCallingConcerns';
import { generateReceivedCallsPdf, type ReceivedCallPdfRow } from '@/lib/callingCenterConcernPdf';

const DAY_CHOICES = [7, 30, 90];

const stamp = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—';

const localInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function RecordReceivedCallDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const record = useRecordReceivedCall();
  const lookup = useCallerLookup();
  const [callerName, setCallerName] = useState('');
  const [callerPhone, setCallerPhone] = useState('');
  const [linkedUserId, setLinkedUserId] = useState<string | null>(null);
  const [lookupTerm, setLookupTerm] = useState('');
  const [matches, setMatches] = useState<{ id: string; full_name: string | null; phone: string | null }[]>([]);
  const [searching, setSearching] = useState(false);
  const [calledAt, setCalledAt] = useState(localInput(new Date()));
  const [concern, setConcern] = useState('');
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState<ReceivedCallStatus>('open');
  const [followUpAt, setFollowUpAt] = useState('');
  const [followUpNote, setFollowUpNote] = useState('');

  const reset = () => {
    setCallerName('');
    setCallerPhone('');
    setLinkedUserId(null);
    setLookupTerm('');
    setMatches([]);
    setCalledAt(localInput(new Date()));
    setConcern('');
    setNotes('');
    setStatus('open');
    setFollowUpAt('');
    setFollowUpNote('');
  };

  const runLookup = async () => {
    setSearching(true);
    setMatches(await lookup(lookupTerm));
    setSearching(false);
  };

  const submit = async () => {
    try {
      await record.mutateAsync({
        caller_name: callerName.trim(),
        caller_phone: callerPhone.trim() || null,
        linked_user_id: linkedUserId,
        linked_kind: linkedUserId ? 'user' : null,
        called_at: new Date(calledAt).toISOString(),
        concern: concern.trim(),
        notes: notes.trim() || null,
        status,
        follow_up_at: followUpAt ? new Date(followUpAt).toISOString() : null,
        follow_up_note: followUpNote.trim() || null,
      });
      toast.success('Received call saved.');
      reset();
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not save this call.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto rounded-2xl">
        <DialogHeader>
          <DialogTitle asChild>
            <CCDialogHeading
              icon={PhoneIncoming}
              title="Record a call that came in"
              hint="Tie the caller to someone we know, or type their details by hand."
            />
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <CCBlock>

            <Label className="text-[11px] font-semibold">Is the caller already with us?</Label>
            <div className="mt-1.5 flex gap-1.5">
              <div className="relative flex-1">
                <UserSearch className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={lookupTerm}
                  onChange={(e) => setLookupTerm(e.target.value)}
                  placeholder="Search by name or phone"
                  className="h-9 pl-9 text-xs"
                />
              </div>
              <Button size="sm" variant="outline" className="h-9 text-xs" onClick={runLookup} disabled={searching}>
                {searching ? 'Searching…' : 'Search'}
              </Button>
            </div>
            {matches.length > 0 && (
              <div className="mt-2 space-y-1">
                {matches.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`flex w-full items-center justify-between rounded-lg border px-2.5 py-2 text-left text-[11px] transition-colors ${
                      linkedUserId === m.id
                        ? 'border-primary bg-primary/10 font-semibold'
                        : 'border-border bg-card hover:border-primary/40 hover:bg-muted/50'
                    }`}

                    onClick={() => {
                      setLinkedUserId(m.id);
                      setCallerName(m.full_name ?? '');
                      setCallerPhone(m.phone ?? '');
                    }}
                  >
                    <span className="truncate">{m.full_name ?? 'Unnamed'}</span>
                    <span className="text-muted-foreground">{m.phone ?? '—'}</span>
                  </button>
                ))}
              </div>
            )}
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              If they are not with us, just type their name and number below.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[11px] font-semibold">Caller's name</Label>
              <Input value={callerName} onChange={(e) => setCallerName(e.target.value)} className="h-9 text-xs" />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] font-semibold">Phone</Label>
              <Input value={callerPhone} onChange={(e) => setCallerPhone(e.target.value)} className="h-9 text-xs" />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] font-semibold">When did they call?</Label>
            <Input
              type="datetime-local"
              value={calledAt}
              onChange={(e) => setCalledAt(e.target.value)}
              className="h-9 text-xs"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] font-semibold">What was their concern?</Label>
            <Textarea value={concern} onChange={(e) => setConcern(e.target.value)} rows={3} className="text-xs" />
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] font-semibold">Your notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="text-xs" />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[11px] font-semibold">Where does it stand?</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as ReceivedCallStatus)}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(RECEIVED_STATUS_LABEL) as ReceivedCallStatus[]).map((s) => (
                    <SelectItem key={s} value={s} className="text-xs">
                      {RECEIVED_STATUS_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] font-semibold">Follow up on</Label>
              <Input
                type="datetime-local"
                value={followUpAt}
                onChange={(e) => setFollowUpAt(e.target.value)}
                className="h-9 text-xs"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] font-semibold">Follow-up note</Label>
            <Input value={followUpNote} onChange={(e) => setFollowUpNote(e.target.value)} className="h-9 text-xs" />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" className="h-9 text-xs" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" className="h-9 text-xs font-semibold" onClick={submit} disabled={record.isPending}>
              {record.isPending ? 'Saving…' : 'Save call'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ReceivedCallsTab() {
  const [days, setDays] = useState(30);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [recordOpen, setRecordOpen] = useState(false);
  const [forwardSource, setForwardSource] = useState<ForwardConcernSource | null>(null);
  const [exporting, setExporting] = useState(false);

  const { data, isLoading } = useReceivedCalls(days);
  const concerns = useForwardedConcerns({ days: Math.max(days, 60) });
  const update = useUpdateReceivedCall();

  const all = useMemo(() => data ?? [], [data]);

  const concernIds = useMemo(() => (concerns.data ?? []).map((c) => c.id), [concerns.data]);
  const reviewers = useConcernReviewers(concernIds);
  const concernByCall = useMemo(() => {
    const map = new Map<string, (typeof concerns.data extends (infer T)[] | undefined ? T : never)>();
    (concerns.data ?? []).forEach((c) => {
      if (c.received_call_id && !map.has(c.received_call_id)) map.set(c.received_call_id, c);
    });
    return map;
  }, [concerns.data]);
  const reviewersByConcern = useMemo(() => {
    const map = new Map<string, string[]>();
    (reviewers.data ?? []).forEach((r) => {
      const list = map.get(r.concern_id) ?? [];
      if (r.full_name && !list.includes(r.full_name)) list.push(r.full_name);
      map.set(r.concern_id, list);
    });
    return map;
  }, [reviewers.data]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (!q) return true;
      return [r.caller_name, r.caller_phone ?? '', r.concern, r.notes ?? '', r.recorded_by_name ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [all, search, statusFilter]);

  const kpis = useMemo(
    () => ({
      total: all.length,
      open: all.filter((r) => r.status === 'open' || r.status === 'following_up').length,
      resolved: all.filter((r) => r.status === 'resolved' || r.status === 'closed').length,
      forwarded: all.filter((r) => concernByCall.has(r.id)).length,
    }),
    [all, concernByCall],
  );

  const exportPdf = async () => {
    setExporting(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const pdfRows: ReceivedCallPdfRow[] = rows.map((r) => ({
        when: stamp(r.called_at),
        caller: r.caller_name,
        phone: r.caller_phone ?? '—',
        concern: r.concern,
        notes: r.notes ?? '—',
        status: RECEIVED_STATUS_LABEL[r.status as ReceivedCallStatus] ?? r.status,
        followUp: r.follow_up_at ? stamp(r.follow_up_at) : '—',
        officer: r.recorded_by_name ?? '—',
        forwardedTo: (() => {
          const concern = concernByCall.get(r.id);
          return concern ? (reviewersByConcern.get(concern.id) ?? [concern.forwarded_to_name ?? 'Staff member']).join(', ') : '—';
        })(),
      }));
      const blob = await generateReceivedCallsPdf(
        pdfRows,
        [
          { label: 'Calls received', value: String(rows.length) },
          { label: 'Still open', value: String(rows.filter((r) => r.status === 'open' || r.status === 'following_up').length) },
          { label: 'Resolved or closed', value: String(rows.filter((r) => r.status === 'resolved' || r.status === 'closed').length) },
          { label: 'Forwarded to staff', value: String(rows.filter((r) => concernByCall.has(r.id)).length) },
        ],
        {
          generatedBy: auth?.user?.user_metadata?.full_name ?? 'Tenant Operations',
          email: auth?.user?.email ?? '—',
          generatedAt: new Date(),
          reportPeriod: `Last ${days} days${statusFilter === 'all' ? '' : ` · ${RECEIVED_STATUS_LABEL[statusFilter as ReceivedCallStatus] ?? statusFilter}`}${search.trim() ? ` · “${search.trim()}”` : ''}`,
        },
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `received-calls-${new Date().toISOString().slice(0, 10)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not build the report.');
    } finally {
      setExporting(false);
    }
  };

  const setStatus = async (r: ReceivedCall, status: ReceivedCallStatus) => {
    try {
      await update.mutateAsync({ id: r.id, status });
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not update this call.');
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <KPICard title="Calls received" value={kpis.total} icon={PhoneIncoming} color="bg-primary/10 text-primary" />
        <KPICard title="Still open" value={kpis.open} icon={PhoneIncoming} color="bg-amber-500/10 text-amber-600" />
        <KPICard title="Resolved" value={kpis.resolved} icon={PhoneIncoming} color="bg-emerald-500/10 text-emerald-600" />
        <KPICard title="Forwarded" value={kpis.forwarded} icon={Forward} color="bg-sky-500/10 text-sky-600" />
      </div>

      <CCPanel
        icon={PhoneIncoming}
        title="Received calls"
        subtitle="Calls that came in to the Calling Center, and where each concern now stands."
        actions={
          <>
            <Button size="sm" className="h-8 text-[11px] font-semibold" onClick={() => setRecordOpen(true)}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Record a call
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-[11px] font-semibold"
              onClick={exportPdf}
              disabled={exporting || !rows.length}
            >
              <Download className="mr-1 h-3.5 w-3.5" />
              {exporting ? 'Building…' : 'Download report'}
            </Button>
          </>
        }
      >

          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label className="text-[11px] font-semibold text-muted-foreground">Period</Label>
              <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
                <SelectTrigger className="h-9 w-[130px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAY_CHOICES.map((d) => (
                    <SelectItem key={d} value={String(d)} className="text-xs">
                      Last {d} days
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] font-semibold text-muted-foreground">Status</Label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="h-9 w-[150px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-xs">
                    All
                  </SelectItem>
                  {(Object.keys(RECEIVED_STATUS_LABEL) as ReceivedCallStatus[]).map((s) => (
                    <SelectItem key={s} value={s} className="text-xs">
                      {RECEIVED_STATUS_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-[200px] flex-1 space-y-1">
              <Label className="text-[11px] font-semibold text-muted-foreground">Search</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Caller, phone, concern or officer"
                  className="h-9 w-full pl-9 text-xs"
                />
              </div>
            </div>
          </div>

          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-2/3" />
            </div>
          ) : rows.length === 0 ? (
            <CCEmpty
              icon={PhoneIncoming}
              title="No received calls recorded for this period"
              hint="Use “Record a call” the moment someone rings in, so the concern can be traced."
            />
          ) : (
            <div className="space-y-2">
              {rows.map((r) => {
                const existingConcern = concernByCall.get(r.id);
                const reviewerNames = existingConcern
                  ? reviewersByConcern.get(existingConcern.id) ?? [existingConcern.forwarded_to_name ?? 'Staff member']
                  : [];
                return (
                  <div key={r.id} className={CC_ROW}>

                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-bold">{r.caller_name}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {r.caller_phone ?? 'No number'} · {stamp(r.called_at)} · recorded by{' '}
                          {r.recorded_by_name ?? 'Officer'}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" className="text-[10px]">
                          {RECEIVED_STATUS_LABEL[r.status as ReceivedCallStatus] ?? r.status}
                        </Badge>
                        {existingConcern && (
                          <Badge className="bg-sky-500/10 text-[10px] text-sky-700 hover:bg-sky-500/10">
                            Forwarded · {reviewerNames.length} reviewer{reviewerNames.length === 1 ? '' : 's'}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <p className="mt-2 text-[11px] leading-snug">{r.concern}</p>
                    {r.notes && <p className="mt-1 text-[11px] italic leading-snug text-muted-foreground">{r.notes}</p>}
                    {r.follow_up_at && (
                      <p className="mt-1 text-[11px] font-semibold text-amber-700">
                        Follow up {stamp(r.follow_up_at)}
                        {r.follow_up_note ? ` — ${r.follow_up_note}` : ''}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-[11px] font-semibold"
                        onClick={() =>
                          setForwardSource({
                            source_kind: 'received_call',
                            received_call_id: r.id,
                            caller_name: r.caller_name,
                            caller_user_id: r.linked_user_id,
                            suggestedTitle: r.concern.slice(0, 110),
                            suggestedContext: [r.concern, r.notes].filter(Boolean).join('\n\n'),
                          })
                        }
                      >
                        <Forward className="mr-1 h-3.5 w-3.5" />
                        {existingConcern ? 'Add another reviewer' : 'Forward concern'}
                      </Button>
                      <Select value={r.status} onValueChange={(v) => setStatus(r, v as ReceivedCallStatus)}>
                        <SelectTrigger className="h-8 w-[150px] text-[11px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(Object.keys(RECEIVED_STATUS_LABEL) as ReceivedCallStatus[]).map((s) => (
                            <SelectItem key={s} value={s} className="text-xs">
                              {RECEIVED_STATUS_LABEL[s]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
      </CCPanel>


      <RecordReceivedCallDialog open={recordOpen} onClose={() => setRecordOpen(false)} />
      <ForwardConcernDialog
        open={!!forwardSource}
        source={forwardSource}
        addReviewer={!!forwardSource?.received_call_id && concernByCall.has(forwardSource.received_call_id)}
        onClose={() => setForwardSource(null)}
      />
    </div>
  );
}
