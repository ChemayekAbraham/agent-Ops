import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, ExternalLink, Fingerprint, Loader2, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  useAgentVettingQueue, useAgentVettingDetail, useAgentVettingPhotos, useDecideAgentVetting,
  type AgentVettingDetail,
  useAgentKycOverview, useAgentKycIdentitySummary,
} from '@/hooks/useAgentVettingQueue';
import { VETTING_STATUS_LABEL, idComparison, type VettingStatus, type IdSnapshot } from '@/lib/agentVetting';
import VettingMap, { type MapPoint } from '@/components/agent-vetting/VettingMap';
import KycOverview from '@/components/agent-vetting/KycOverview';
import KycIdentityConnections from '@/components/agent-vetting/KycIdentityConnections';
import KycReviewTable from '@/components/agent-vetting/KycReviewTable';
import { useUserAvatars } from '@/hooks/useUserAvatars';
import { useAuth } from '@/hooks/useAuth';
import { useRequestIdReupload } from '@/hooks/useAgentVettingQueue';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

const TABS: { value: VettingStatus; label: string }[] = [
  { value: 'submitted', label: 'To review' },
  { value: 'rejected', label: 'Sent back' },
  { value: 'verified', label: 'Verified' },
  { value: 'unverified', label: 'Not started' },
];
const PAGE = 50;

const abs = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short' }) : '';

export default function AgentVerificationReview() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<VettingStatus>('submitted');
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [inScope, setInScope] = useState(false);
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reviewTrail, setReviewTrail] = useState<string[]>([]);
  const [days, setDays] = useState<7 | 30>(7);

  useEffect(() => { const t = setTimeout(() => { setSearch(searchText); setPage(0); }, 300); return () => clearTimeout(t); }, [searchText]);

  const q = useAgentVettingQueue({ status, search, inScopeOnly: inScope, page, pageSize: PAGE });
  const data = q.data;
  const { avatarFor } = useUserAvatars(data?.rows.map((r) => r.agent_id) ?? []);
  const overview = useAgentKycOverview(days, inScope);
  const identities = useAgentKycIdentitySummary(data?.rows.map((r) => r.agent_id) ?? []);
  const from = data && data.total ? page * PAGE + 1 : 0;
  const to = data ? Math.min((page + 1) * PAGE, data.total) : 0;

  const changeTab = (s: string) => {
    setStatus(s as VettingStatus);
    setInScope(s === 'unverified');
    setPage(0);
  };
  const openReview = (id: string) => { setReviewTrail([]); setOpenId(id); };
  const refresh = () => { q.refetch(); overview.refetch(); if (data?.rows.length) identities.refetch(); };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-4 sm:px-6">
          <Button variant="ghost" size="icon" className="h-11 w-11" onClick={() => navigate(-1)} aria-label="Back">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0 flex-1"><p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><ShieldCheck className="h-3.5 w-3.5" />Agent Operations / Identity & compliance</p><h1 className="text-xl font-semibold sm:text-2xl">Agent KYC Command Center</h1></div>
          <Button variant="outline" size="icon" className="h-11 w-11 shrink-0" aria-label="Refresh KYC reports" title="Refresh KYC reports" disabled={q.isFetching || overview.isFetching} onClick={refresh}><RefreshCw className={`h-4 w-4 ${q.isFetching || overview.isFetching ? 'animate-spin motion-reduce:animate-none' : ''}`} /></Button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 pb-24 pt-5 sm:px-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{inScope ? 'Active agent scope' : 'All registered KYC agents'}</span><span>{overview.data?.generated_at ? `Updated ${abs(overview.data.generated_at)}` : 'Awaiting latest report'}</span></div>
        <KycOverview data={overview.data} loading={overview.isLoading} error={!!overview.error} counts={data?.counts} status={status} onStatus={changeTab} days={days} onDays={setDays} onRetry={() => overview.refetch()} />
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 pt-7"><div><h2 className="text-lg font-semibold">Agent review queue</h2><p className="mt-1 text-xs text-muted-foreground">{data ? `${data.total.toLocaleString()} agents` : 'Loading agents'} · Oldest submissions first</p></div><Badge variant="outline" className="gap-1.5"><Fingerprint className="h-3.5 w-3.5" />National ID review</Badge></div>
        <Tabs value={status} onValueChange={changeTab}>
          <TabsList variant="underline" className="h-auto w-full justify-start gap-0 overflow-x-auto p-0">
            {TABS.map((t) => (
              <TabsTrigger variant="underline" key={t.value} value={t.value} className="min-h-12 shrink-0 gap-2 px-3 py-3 text-xs sm:px-4 sm:text-sm">
                {t.label}<span className="rounded-md bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">{data?.counts[t.value] ?? '—'}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
          {/* [&_input]:!pl-9 outranks index.css's ≤360px `.px-4 { padding-left … !important }`, which otherwise puts the text under the icon. */}
          <div className="relative flex-1 [&_input]:!pl-9">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="min-h-11 pl-9" aria-label="Search agents by name or phone" placeholder="Search name or phone" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
          </div>
          <label className="flex min-h-11 items-center gap-2 whitespace-nowrap text-sm">
            <Switch aria-label="Active agents only" checked={inScope} onCheckedChange={(c) => { setInScope(c); setPage(0); }} /> Active agents only
          </label>
        </div>

        {q.isLoading ? (
          <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
        ) : q.error ? (
          <div className="border-y border-border p-4 space-y-2">
            <p className="text-sm">{(q.error as Error).message}</p>
            <Button className="min-h-11" variant="outline" onClick={() => q.refetch()}>Retry</Button>
          </div>
        ) : !data || data.rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 border-y border-border py-16"><ShieldCheck className="h-8 w-8 text-muted-foreground" /><p className="text-sm text-muted-foreground">No agents here.</p></div>
        ) : (
          <div className="border-y border-border">
            {identities.error && <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground">Identity-link counts unavailable. <Button variant="link" size="sm" onClick={() => identities.refetch()}>Retry</Button></p>}
            <KycReviewTable rows={data.rows} links={identities.data} photos={Object.fromEntries(data.rows.map((r) => [r.agent_id, avatarFor(r.agent_id)]))} selectedId={openId} onOpen={openReview} />
          </div>
        )}

        {data && data.total > 0 && (
          <div className="flex items-center justify-between gap-2 py-4">
            <span className="text-sm text-muted-foreground">{from}–{to} of {data.total}</span>
            <div className="flex gap-2">
              <Button variant="outline" className="min-h-11" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <Button variant="outline" className="min-h-11" disabled={to >= data.total} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        )}
      </main>

      <Sheet open={!!openId} onOpenChange={(o) => { if (!o) { setOpenId(null); setReviewTrail([]); } }}>
        <SheetContent side="center" aria-describedby={undefined} className="max-h-[88dvh] w-[calc(100vw-2rem)] overflow-y-auto rounded-lg p-5 sm:max-w-3xl lg:max-w-4xl xl:max-w-4xl">
          {reviewTrail.length > 0 && <Button variant="ghost" className="mb-2 gap-2" onClick={() => { const previous = reviewTrail[reviewTrail.length - 1]; if (previous) { setOpenId(previous); setReviewTrail((trail) => trail.slice(0, -1)); } }}><ArrowLeft className="h-4 w-4" />Back to previous agent</Button>}
          {openId && <ReviewPanel key={openId} agentId={openId} onDone={() => setOpenId(null)} onOpenLinked={(id) => { setReviewTrail((trail) => [...trail, openId]); setOpenId(id); }} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = {
  submitted: 'Submitted',
  approved: 'Approved',
  rejected: 'Sent back',
  phone_confirmed: 'Phone confirmed',
  email_confirmed: 'Email confirmed',
  parent_id_link_requested: "Asked to use parent's ID",
  id_replaced: 'Replaced National ID',
  id_reupload_requested: 'Asked to re-upload ID',
};

function eventLabel(e: AgentVettingDetail['events'][number]) {
  if (e.event === 'reopened') {
    const c = (e.detail as any)?.changed;
    return `Changed ${Array.isArray(c) ? c.join(', ') : c ?? 'details'} after verification`;
  }
  return EVENT_LABEL[e.event] ?? e.event.replace(/_/g, ' ');
}

const n = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

function ReviewPanel({ agentId, onDone, onOpenLinked }: { agentId: string; onDone: () => void; onOpenLinked: (id: string) => void }) {
  const detailQ = useAgentVettingDetail(agentId);
  const d = detailQ.data;
  const photos = useAgentVettingPhotos(d);
  const decide = useDecideAgentVetting();
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [note, setNote] = useState('');
  const [zoom, setZoom] = useState<string | null>(null);
  const { user } = useAuth();
  const reupload = useRequestIdReupload();
  const [reuploadOpen, setReuploadOpen] = useState(false);
  const [reason, setReason] = useState('');
  const reasonOk = reason.trim().length >= 5;
  const sendReupload = async () => {
    try {
      await reupload.mutateAsync({ agentId, reason: reason.trim() });
      toast.success('Sent back to the agent');
      setReuploadOpen(false);
      setReason('');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  useEffect(() => { photos.refetch(); }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (detailQ.isLoading) return <div className="space-y-3 pt-6">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>;
  if (detailQ.error) return <p className="pt-6 text-sm">{(detailQ.error as Error).message}</p>;
  if (!d) return <p className="pt-6 text-sm">Not found.</p>;

  const verdict = (d.passport_photo_check as any)?.verdict as string | undefined;
  const res = (d.residence ?? {}) as Record<string, any>;
  const resText = [d.res_village ?? res.village, d.res_parish ?? res.parish, d.res_sub_county ?? res.sub_county, d.res_district ?? res.district, d.res_region ?? res.region, d.res_town ?? res.town, d.res_city ?? res.city].filter(Boolean).join(', ');

  const pts: MapPoint[] = [];
  const g1 = { lat: n(d.gps1_lat), lng: n(d.gps1_lng) };
  const g2 = { lat: n(d.gps2_lat), lng: n(d.gps2_lng) };
  if (g1.lat != null && g1.lng != null) pts.push({ lat: g1.lat, lng: g1.lng, label: 'First reading', tone: 'muted' });
  const pin = d.residence_pin as any;
  const pinLat = n(pin?.lat), pinLng = n(pin?.lng);
  if (pinLat != null && pinLng != null) pts.push({ lat: pinLat, lng: pinLng, label: 'Residence pin', tone: 'accent' });
  if (g2.lat != null && g2.lng != null) pts.push({ lat: g2.lat, lng: g2.lng, label: 'At submit', tone: 'primary' });

  const run = (approve: boolean) =>
    decide.mutate({ agentId, approve, note: approve ? undefined : note }, {
      onSuccess: () => { toast.success(approve ? 'Agent verified' : 'Sent back to the agent'); onDone(); },
      onError: (e) => { toast.error((e as Error).message); detailQ.refetch(); },
    });

  const idVerified = (d as { identity_verified?: boolean }).identity_verified === true;
  const Photo = ({ url, alt, missingText }: { url: string | null | undefined; alt: string; missingText?: string }) =>
    url ? (
      <Button variant="ghost" aria-label={`Enlarge ${alt}`} onClick={() => setZoom(url)} className="block h-auto min-h-11 w-full min-w-0 p-0">
        <img src={url} alt={alt} className="h-32 w-full rounded-lg border border-border object-cover" />
      </Button>
    ) : <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">{missingText ?? `No ${alt.toLowerCase()}`}</div>;

  const Section = ({ title, badge, children }: { title: string; badge?: React.ReactNode; children: React.ReactNode }) => (
    <section className="space-y-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">{title}</h3>{badge}</div>{children}
    </section>
  );

  const events = [...(d.events ?? [])].sort((a, b) => (a.at < b.at ? 1 : -1));
  const comparison = idComparison(d);
  const IdCard = ({ snapshot, previous = false }: { snapshot: IdSnapshot; previous?: boolean }) => <div className="min-w-0 space-y-2">
    <div className="grid grid-cols-2 gap-2">
      <Photo url={previous ? photos.data?.prev_id_front : photos.data?.id_front} alt={previous ? 'Previous ID front' : 'ID front'} />
      <Photo url={previous ? photos.data?.prev_id_back : photos.data?.id_back} alt={previous ? 'Previous ID back' : 'ID back'} missingText={idVerified && !previous ? 'Back photo not required' : undefined} />
    </div>
    <p className={`break-words text-sm ${comparison.previous && comparison.current.name !== comparison.previous.name ? 'rounded border border-warning/30 bg-warning/10 p-2 text-warning' : ''}`}>Name on ID: {snapshot.name ?? 'Not on file'}</p>
    <p className={`break-all font-mono text-sm ${comparison.previous && comparison.current.nin_masked !== comparison.previous.nin_masked ? 'rounded border border-warning/30 bg-warning/10 p-2 text-warning' : ''}`}>NIN: {snapshot.nin_masked ?? 'Not on file'}</p>
    {snapshot.captured_at && <p className="text-xs text-muted-foreground">Uploaded {abs(snapshot.captured_at)}</p>}
  </div>;

  return (
    <div className="space-y-5 pb-4">
      <SheetHeader className="border-b border-border pb-5 text-left">
        <p className="text-xs font-medium text-muted-foreground">AGENT DOSSIER</p>
        <div className="flex items-center gap-4 pt-2"><Avatar className="h-16 w-16 border border-border"><AvatarImage src={d.avatar_url ?? undefined} alt={`${d.name ?? 'Agent'} profile photo`} /><AvatarFallback className="text-lg font-semibold">{(d.name ?? 'A').split(' ').filter(Boolean).slice(0, 2).map((s: string) => s[0]).join('')}</AvatarFallback></Avatar><div className="min-w-0"><SheetTitle className="break-words text-xl">{d.name ?? 'Agent'}</SheetTitle><p className="my-2 text-sm text-muted-foreground">{d.profile_phone ?? d.phone ?? 'No phone on file'}</p><Badge variant={d.status === 'rejected' ? 'destructive' : 'secondary'} className="w-fit whitespace-normal">{VETTING_STATUS_LABEL[d.status]}</Badge></div></div>
      </SheetHeader>

      <Section title="Identity">
        <div className="max-w-xs space-y-1"><Photo url={photos.data?.passport} alt="Passport photo" />
          {verdict && <Badge variant={verdict === 'fail' ? 'destructive' : verdict === 'review' ? 'outline' : 'default'}>Photo: {verdict}</Badge>}
        </div>
      </Section>

      <Section title="National ID" badge={idVerified ? <Badge variant="outline" className="border-success/30 bg-success/10 text-success">ID verified by Admin</Badge> : undefined}>
        {comparison.previous ? <>
          <Badge variant="outline" className="h-auto whitespace-normal border-warning/30 bg-warning/10 text-warning">Changed {abs(comparison.changed_at) || 'date unavailable'}</Badge>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <div className="min-w-0 space-y-2"><h4 className="text-sm font-semibold">Previous</h4><IdCard snapshot={comparison.previous} previous /></div>
            <div className="min-w-0 space-y-2"><h4 className="text-sm font-semibold">New</h4><IdCard snapshot={comparison.current} /></div>
          </div>
        </> : <IdCard snapshot={comparison.current} />}
        <p className="text-sm">
          {d.id_source === 'parent'
            ? `Using ${d.id_holder?.name ?? 'parent agent'}'s ID (${d.id_holder?.phone ?? ''})`
            : 'Own ID'}
        </p>
        {(d.has_id_photos || d.id_front_path || d.id_back_path) && user?.id !== agentId && (
          <Button variant="warning" className="min-h-11 w-full sm:w-auto" onClick={() => setReuploadOpen(true)}><RefreshCw className="h-4 w-4" />Ask agent to re-upload ID</Button>
        )}
      </Section>

      <KycIdentityConnections key={agentId} agentId={agentId} onOpen={onOpenLinked} />

      <Section title="Contact">
        <p className="text-sm">{d.profile_phone ?? d.phone ?? '—'} {d.phone_verified_at && <span className="text-muted-foreground"><Check className="inline h-4 w-4 text-primary" /> confirmed {abs(d.phone_verified_at)}</span>}</p>
        <p className="text-sm">{d.email ?? '—'} {d.email_verified_at && <span className="text-muted-foreground"><Check className="inline h-4 w-4 text-primary" /> confirmed {abs(d.email_verified_at)}</span>}</p>
      </Section>

      <Section title="Where they stay"><p className="text-sm">{resText || '—'}</p></Section>

      <Section title="Live location">
        <VettingMap points={pts} height={220} />
        {d.gps_drift_m != null && <p className="text-sm">Moved {Math.round(Number(d.gps_drift_m))} m between readings</p>}
        {g1.lat != null && <p className="text-sm text-muted-foreground">First: ±{Math.round(Number(d.gps1_accuracy_m ?? 0))} m · {abs(d.gps1_captured_at)}</p>}
        {g2.lat != null && <p className="text-sm text-muted-foreground">At submit: ±{Math.round(Number(d.gps2_accuracy_m ?? 0))} m · {abs(d.gps2_captured_at)}</p>}
        {g2.lat != null && (
          <a className="inline-flex min-h-11 items-center gap-1 text-sm text-primary" target="_blank" rel="noreferrer"
            href={`https://www.google.com/maps?q=${g2.lat},${g2.lng}`}>
            Open in Google Maps <ExternalLink className="h-4 w-4" />
          </a>
        )}
      </Section>

      <Section title="Next of kin">
        <p className="text-sm">{[d.nok_name, d.nok_phone, d.nok_relationship].filter(Boolean).join(', ') || '—'}{d.nok_source === 'parent_agent' ? ' (parent agent)' : ''}</p>
      </Section>

      <Section title="Activity"><p className="text-sm">{d.rent_requests ?? 0} rent requests, {d.collections ?? 0} collections</p></Section>

      <Section title="History">
        <ul className="space-y-1">
          {events.map((e, i) => <li key={i} className="text-sm"><span className="text-muted-foreground">{abs(e.at)}</span> · {eventLabel(e)}{e.event === 'id_reupload_requested' && (e.detail as any)?.reason ? <span className="block break-words text-muted-foreground">{String((e.detail as any).reason)}</span> : null}</li>)}
          {events.length === 0 && <li className="text-sm text-muted-foreground">No history yet.</li>}
        </ul>
      </Section>

      {d.status === 'submitted' && (
        <div className="sticky bottom-0 flex gap-2 border-t border-border bg-background p-3">
          <Button variant="outline" className="min-h-11 flex-1" disabled={decide.isPending} onClick={() => setRejectOpen(true)}>Send back</Button>
          <Button className="min-h-11 flex-1" disabled={decide.isPending} onClick={() => setApproveOpen(true)}>
            {decide.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Approve
          </Button>
        </div>
      )}

      <AlertDialog open={approveOpen} onOpenChange={setApproveOpen}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Approve {d.name ?? 'this agent'}?</AlertDialogTitle>
            <AlertDialogDescription>They will be able to add tenants and post Rent Plan requests.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction className="min-h-11" onClick={() => run(true)}>Approve</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>What should the agent fix?</AlertDialogTitle>
            <AlertDialogDescription>The agent sees this word for word.</AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: Your passport photo is blurry. Please take it again in good light." />
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction className="min-h-11" disabled={!note.trim()} onClick={() => run(false)}>Send back</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={reuploadOpen} onOpenChange={(o) => { if (!reupload.isPending) setReuploadOpen(o); }}>
        <DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-md overflow-y-auto">
          <DialogTitle>Ask agent to re-upload ID</DialogTitle>
          <DialogDescription>The agent's ID photos will be removed and they will be asked to upload the correct National ID. Until they do, they cannot withdraw. The current ID stays on record for comparison.</DialogDescription>
          <label htmlFor="reupload-reason" className="text-sm font-medium">Reason</label>
          <Textarea id="reupload-reason" required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="The NIN on the card does not match the number entered" />
          {!reasonOk && <p className="text-xs text-muted-foreground">At least 5 characters.</p>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" className="min-h-11" disabled={reupload.isPending} onClick={() => setReuploadOpen(false)}>Cancel</Button>
            <Button className="min-h-11" disabled={!reasonOk || reupload.isPending} onClick={sendReupload}>{reupload.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Send back to agent</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!zoom} onOpenChange={(o) => !o && setZoom(null)}>
        <DialogContent aria-describedby={undefined} className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-3xl overflow-y-auto p-3"><DialogTitle className="sr-only">ID photo</DialogTitle>{zoom && <img src={zoom} alt="Zoomed photo" className="max-h-[80dvh] w-full rounded object-contain" />}</DialogContent>
      </Dialog>
    </div>
  );
}
