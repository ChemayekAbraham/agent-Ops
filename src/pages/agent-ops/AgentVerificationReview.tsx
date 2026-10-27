import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { format, formatDistanceToNow } from 'date-fns';
import { ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight, ExternalLink, Loader2, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  useAgentVettingQueue, useAgentVettingDetail, useAgentVettingPhotos, useDecideAgentVetting,
  type AgentVettingDetail,
} from '@/hooks/useAgentVettingQueue';
import type { VettingQueueRow, VettingStatus } from '@/lib/agentVetting';
import { VettingMap, type VettingMapPoint } from '@/components/agent/vetting/VettingMap';

const TABS: { value: VettingStatus; label: string }[] = [
  { value: 'submitted', label: 'To review' },
  { value: 'rejected', label: 'Sent back' },
  { value: 'verified', label: 'Verified' },
  { value: 'unverified', label: 'Not started' },
];
const PAGE_SIZE = 50;
const fmt = (iso: unknown) => (typeof iso === 'string' && iso ? format(new Date(iso), 'd MMM yyyy, h:mm a') : '');
const n = (x: unknown): number | null => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ''));

function IdTag({ source }: { source: 'own' | 'parent' | null }) {
  if (!source) return null;
  return source === 'parent' ? (
    <Badge variant="outline" className="border-warning/40 bg-warning/15 text-warning-foreground">Parent's ID</Badge>
  ) : (
    <Badge variant="outline">Own ID</Badge>
  );
}

function When({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-muted-foreground">—</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild><span>{formatDistanceToNow(new Date(iso), { addSuffix: true })}</span></TooltipTrigger>
      <TooltipContent>{fmt(iso)}</TooltipContent>
    </Tooltip>
  );
}

function eventLabel(e: AgentVettingDetail['events'][number]): string {
  switch (e.event) {
    case 'submitted': return 'Submitted';
    case 'approved': return 'Approved';
    case 'rejected': return 'Sent back';
    case 'reopened': {
      const c = (e.detail as Record<string, unknown>)?.changed;
      return `Changed ${Array.isArray(c) ? c.join(', ') : c ?? 'details'} after verification`;
    }
    case 'phone_confirmed': return 'Phone confirmed';
    case 'email_confirmed': return 'Email confirmed';
    case 'parent_id_link_requested': return "Asked to use parent's ID";
    default: return e.event.replace(/_/g, ' ');
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 border-b border-border pb-4 last:border-0">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Photo({ url, alt, onZoom, className }: { url: string | null | undefined; alt: string; onZoom: (u: string) => void; className?: string }) {
  if (!url) return <div className={cn('flex items-center justify-center rounded-lg border border-dashed border-border bg-muted text-xs text-muted-foreground', className)}>No photo</div>;
  return (
    <button type="button" onClick={() => onZoom(url)} className={cn('overflow-hidden rounded-lg border border-border', className)}>
      <img src={url} alt={alt} className="h-full w-full object-cover" />
    </button>
  );
}

function ReviewPanel({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const detailQ = useAgentVettingDetail(agentId);
  const d = detailQ.data;
  const photos = useAgentVettingPhotos(d);
  const decide = useDecideAgentVetting();
  const [zoom, setZoom] = useState<string | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => { photos.refetch(); /* fresh links each open */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  const run = (approve: boolean) => {
    decide.mutate(
      { agentId, approve, note: approve ? undefined : note },
      {
        onSuccess: () => { setApproveOpen(false); setRejectOpen(false); toast.success(approve ? 'Approved' : 'Sent back'); onClose(); },
        onError: (e) => { toast.error(errMsg(e)); detailQ.refetch(); },
      },
    );
  };

  if (detailQ.isLoading) return <div className="space-y-3 p-1"><Skeleton className="h-40 w-full" /><Skeleton className="h-24 w-full" /><Skeleton className="h-48 w-full" /></div>;
  if (detailQ.error) return <p className="p-2 text-sm text-foreground">{errMsg(detailQ.error)}</p>;
  if (!d) return <p className="p-2 text-sm text-muted-foreground">This agent has no verification record.</p>;

  const check = (d.passport_photo_check ?? {}) as Record<string, unknown>;
  const verdict = typeof check.verdict === 'string' ? check.verdict : null;
  const res = (d.residence ?? {}) as Record<string, unknown>;
  const resText = ['village', 'parish', 'sub_county', 'district', 'region', 'town', 'city']
    .map((k) => (d[`residence_${k}`] ?? d[k] ?? res[k]) as string | null)
    .filter(Boolean).join(', ');
  const holder = (d.id_holder ?? null) as { name?: string; phone?: string } | null;
  const pin = (d.residence_pin ?? null) as { lat?: number; lng?: number } | null;

  const points: VettingMapPoint[] = [];
  const g1 = { lat: n(d.gps1_lat), lng: n(d.gps1_lng) };
  const g2 = { lat: n(d.gps2_lat), lng: n(d.gps2_lng) };
  if (g1.lat !== null && g1.lng !== null) points.push({ lat: g1.lat, lng: g1.lng, label: 'First reading', tone: 'muted' });
  if (g2.lat !== null && g2.lng !== null) points.push({ lat: g2.lat, lng: g2.lng, label: 'At submit', tone: 'primary' });
  if (pin && n(pin.lat) !== null && n(pin.lng) !== null) points.push({ lat: Number(pin.lat), lng: Number(pin.lng), label: 'Home pin', tone: 'accent' });

  const events = [...(d.events ?? [])].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <div className="space-y-4 pb-24">
      <div>
        <p className="text-lg font-semibold text-foreground">{d.name ?? 'Agent'}</p>
        <p className="text-sm text-muted-foreground">{d.profile_phone ?? ''}</p>
      </div>

      <Section title="Identity">
        <div className="flex gap-3">
          <Photo url={photos.data?.passport} alt="Passport photo" onZoom={setZoom} className="h-40 w-32" />
          {d.avatar_url ? (
            <Photo url={d.avatar_url as string} alt="Profile photo" onZoom={setZoom} className="h-40 w-32" />
          ) : null}
        </div>
        {verdict && (
          <Badge variant="outline" className={cn(
            verdict === 'pass' && 'border-success/40 bg-success/15 text-success',
            verdict === 'review' && 'border-warning/40 bg-warning/15 text-warning-foreground',
            verdict === 'fail' && 'border-destructive/40 bg-destructive/10 text-destructive',
          )}>Passport photo: {verdict}</Badge>
        )}
      </Section>

      <Section title="National ID">
        <div className="grid grid-cols-2 gap-2">
          <Photo url={photos.data?.id_front} alt="ID front" onZoom={setZoom} className="aspect-[3/2] w-full" />
          <Photo url={photos.data?.id_back} alt="ID back" onZoom={setZoom} className="aspect-[3/2] w-full" />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {d.id_nin_masked && <span className="font-mono text-foreground">{d.id_nin_masked as string}</span>}
          <IdTag source={(d.id_source ?? null) as 'own' | 'parent' | null} />
        </div>
        {d.id_source === 'parent' && holder && (
          <p className="text-sm text-foreground">Using {holder.name ?? 'parent agent'}'s ID{holder.phone ? ` (${holder.phone})` : ''}</p>
        )}
      </Section>

      <Section title="Contact">
        <p className="flex items-center gap-1.5 text-sm text-foreground">
          {d.phone_verified_at && <CheckCircle2 className="h-4 w-4 text-success" />}
          {(d.phone ?? d.profile_phone ?? '—') as string}
          {d.phone_verified_at && <span className="text-muted-foreground">confirmed {fmt(d.phone_verified_at)}</span>}
        </p>
        <p className="flex flex-wrap items-center gap-1.5 text-sm text-foreground break-all">
          {d.email_verified_at && <CheckCircle2 className="h-4 w-4 text-success" />}
          {(d.email ?? '—') as string}
          {d.email_verified_at && <span className="text-muted-foreground">confirmed {fmt(d.email_verified_at)}</span>}
        </p>
      </Section>

      <Section title="Where they stay">
        <p className="text-sm text-foreground">{resText || '—'}</p>
      </Section>

      <Section title="Live location">
        <VettingMap points={points} height={220} />
        {n(d.gps_drift_m) !== null && <p className="text-sm text-foreground">Moved {Math.round(Number(d.gps_drift_m))} m between readings</p>}
        <div className="space-y-0.5 text-sm text-muted-foreground">
          {g1.lat !== null && <p>First reading: accurate to {Math.round(n(d.gps1_accuracy_m) ?? 0)} m, {fmt(d.gps1_at ?? d.gps1_captured_at)}</p>}
          {g2.lat !== null && <p>At submit: accurate to {Math.round(n(d.gps2_accuracy_m) ?? 0)} m, {fmt(d.gps2_at ?? d.gps2_captured_at)}</p>}
        </div>
        {g2.lat !== null && (
          <a href={`https://www.google.com/maps?q=${g2.lat},${g2.lng}`} target="_blank" rel="noreferrer"
            className="inline-flex min-h-11 items-center gap-1 text-sm text-primary underline-offset-4 hover:underline">
            Open in Google Maps <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </Section>

      <Section title="Next of kin">
        <p className="text-sm text-foreground">
          {[d.nok_name, d.nok_phone, d.nok_relationship].filter(Boolean).join(', ') || '—'}
          {d.nok_source === 'parent_agent' && ' (parent agent)'}
        </p>
      </Section>

      <Section title="Activity">
        <p className="text-sm text-foreground">{Number(d.rent_requests ?? 0)} rent requests, {Number(d.collections ?? 0)} collections</p>
      </Section>

      <Section title="History">
        {events.length === 0 ? <p className="text-sm text-muted-foreground">No history yet.</p> : (
          <ul className="space-y-1.5">
            {events.map((e, i) => (
              <li key={i} className="text-sm">
                <span className="text-foreground">{eventLabel(e)}</span>
                <span className="ml-2 text-muted-foreground">{fmt(e.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {d.status === 'submitted' && (
        <div className="sticky bottom-0 -mx-1 flex gap-2 border-t border-border bg-background p-3">
          <Button variant="outline" className="min-h-11 flex-1" onClick={() => setRejectOpen(true)} disabled={decide.isPending}>Send back</Button>
          <Button className="min-h-11 flex-1" onClick={() => setApproveOpen(true)} disabled={decide.isPending}>Approve</Button>
        </div>
      )}

      <Dialog open={!!zoom} onOpenChange={(o) => !o && setZoom(null)}>
        <DialogContent className="max-w-[calc(100vw-1rem)] p-2 sm:max-w-2xl">
          {zoom && <img src={zoom} alt="Photo" className="max-h-[80vh] w-full object-contain" />}
        </DialogContent>
      </Dialog>

      <AlertDialog open={approveOpen} onOpenChange={setApproveOpen}>
        <AlertDialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Approve {d.name ?? 'this agent'}?</AlertDialogTitle>
            <AlertDialogDescription>They will be verified and can add tenants and post Rent Plan requests.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
            <Button className="min-h-11" disabled={decide.isPending} onClick={() => run(true)}>
              {decide.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Approve
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <AlertDialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Send back</AlertDialogTitle>
            <AlertDialogDescription>The agent sees your note word for word.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="vet-note">What should the agent fix?</Label>
            <Textarea id="vet-note" rows={4} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Your ID photo is blurry. Please take it again in good light." />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
            <Button className="min-h-11" disabled={!note.trim() || decide.isPending} onClick={() => run(false)}>
              {decide.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Send back
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function AgentVerificationReview() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<VettingStatus>('submitted');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [inScope, setInScope] = useState(false);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const on = () => setIsDesktop(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  useEffect(() => { const t = setTimeout(() => { setSearch(searchInput); setPage(0); }, 300); return () => clearTimeout(t); }, [searchInput]);

  const q = useAgentVettingQueue({ status, search, inScopeOnly: inScope, page, pageSize: PAGE_SIZE });
  const data = q.data;
  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);

  const onTab = (s: string) => {
    const next = s as VettingStatus;
    setStatus(next);
    setInScope(next === 'unverified');
    setPage(0);
  };

  const rowsView = (rows: VettingQueueRow[]) => (
    <>
      {/* Mobile cards */}
      <div className="space-y-2 md:hidden">
        {rows.map((r) => (
          <button key={r.agent_id} type="button" onClick={() => setSelected(r.agent_id)}
            className={cn('w-full rounded-xl border border-border bg-card p-3 text-left', selected === r.agent_id && 'border-primary')}>
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold text-foreground">{r.name ?? 'Agent'}</p>
              <IdTag source={r.id_source} />
            </div>
            <p className="text-sm text-muted-foreground">{r.phone ?? '—'} · {r.district ?? '—'}</p>
            <p className="text-xs text-muted-foreground"><When iso={r.submitted_at} /></p>
          </button>
        ))}
      </div>
      {/* Desktop table */}
      <div className="hidden overflow-hidden rounded-xl border border-border md:block">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr><th className="p-3">Name</th><th className="p-3">Phone</th><th className="p-3">District</th><th className="p-3">Submitted</th><th className="p-3">ID</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.agent_id} onClick={() => setSelected(r.agent_id)}
                className={cn('cursor-pointer border-t border-border hover:bg-muted/40', selected === r.agent_id && 'bg-primary/5')}>
                <td className="p-3 font-medium text-foreground">{r.name ?? 'Agent'}</td>
                <td className="p-3 text-foreground">{r.phone ?? '—'}</td>
                <td className="p-3 text-foreground">{r.district ?? '—'}</td>
                <td className="p-3 text-foreground"><When iso={r.submitted_at} /></td>
                <td className="p-3"><IdTag source={r.id_source} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background">
        <div className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-background/95 px-3 py-2 backdrop-blur">
          <Button variant="ghost" size="icon" className="h-11 w-11" onClick={() => navigate(-1)} aria-label="Back"><ArrowLeft className="h-5 w-5" /></Button>
          <h1 className="text-base font-semibold text-foreground">Agent verification</h1>
        </div>

        <div className={cn('mx-auto max-w-7xl gap-4 p-4', isDesktop && selected && 'grid grid-cols-[1fr_440px]')}>
          <div className="min-w-0 space-y-3">
            <Tabs value={status} onValueChange={onTab}>
              <TabsList className="grid h-auto w-full grid-cols-2 sm:grid-cols-4">
                {TABS.map((t) => (
                  <TabsTrigger key={t.value} value={t.value} className="min-h-11 gap-1.5">
                    {t.label}
                    <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">{data?.counts[t.value] ?? 0}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search name or phone" className="min-h-11 pl-9" />
              </div>
              <div className="flex items-center gap-2">
                <Switch id="vet-scope" checked={inScope} onCheckedChange={(c) => { setInScope(c); setPage(0); }} />
                <Label htmlFor="vet-scope" className="text-sm">Active agents only</Label>
              </div>
            </div>

            {q.isLoading ? (
              <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}</div>
            ) : q.error ? (
              <div className="rounded-xl border border-border p-6 text-center">
                <p className="text-sm text-foreground">{errMsg(q.error)}</p>
                <Button variant="outline" className="mt-3 min-h-11" onClick={() => q.refetch()}>Retry</Button>
              </div>
            ) : (data?.rows.length ?? 0) === 0 ? (
              <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Nobody here right now.</p>
            ) : rowsView(data!.rows)}

            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">{from}–{to} of {total}</span>
              <div className="flex gap-2">
                <Button variant="outline" size="icon" className="h-11 w-11" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="Previous"><ChevronLeft className="h-4 w-4" /></Button>
                <Button variant="outline" size="icon" className="h-11 w-11" disabled={to >= total} onClick={() => setPage((p) => p + 1)} aria-label="Next"><ChevronRight className="h-4 w-4" /></Button>
              </div>
            </div>
          </div>

          {isDesktop && selected && (
            <aside className="sticky top-16 max-h-[calc(100vh-5rem)] overflow-y-auto rounded-xl border border-border bg-card p-4">
              <div className="mb-2 flex justify-end"><Button variant="ghost" size="sm" onClick={() => setSelected(null)}>Close</Button></div>
              <ReviewPanel key={selected} agentId={selected} onClose={() => setSelected(null)} />
            </aside>
          )}
        </div>

        {!isDesktop && (
          <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
            <SheetContent side="bottom" className="h-[92vh] overflow-y-auto">
              <SheetHeader><SheetTitle>Review</SheetTitle></SheetHeader>
              {selected && <ReviewPanel key={selected} agentId={selected} onClose={() => setSelected(null)} />}
            </SheetContent>
          </Sheet>
        )}
      </div>
    </TooltipProvider>
  );
}
