import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Play, Upload, Lightbulb } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import {
  claimCancel, claimLink, claimPrepare, claimRelease, claimsList, listMyLiveClaimVideoIds, listMyVideos, listTopics,
  proposeTopic, submitVideo, withdrawVideo,
} from '../api';
import { uploadTutorial, type UploadStage } from '../lib/uploadTutorial';
import TutorialPlayerDialog, { formatDuration, type TutorialPlayerVideo } from '../components/TutorialPlayerDialog';

const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'Africa/Kampala' });
const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Kampala' });
const STATUS: Record<string, string> = { uploading: 'Uploading', draft: 'Draft', submitted: 'Submitted', accepted: 'Accepted', rejected: 'Rejected', withdrawn: 'Withdrawn' };
const STAGE_TEXT: Record<string, string> = { supervisor: 'Department head', coo: 'COO', ceo: 'CEO', cfo: 'CFO' };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function groupByMonth<T>(rows: T[], key: (r: T) => string) {
  const out: { label: string; items: T[] }[] = [];
  rows.forEach((r) => {
    const label = monthFmt.format(new Date(key(r)));
    let g = out.find((x) => x.label === label);
    if (!g) { g = { label, items: [] }; out.push(g); }
    g.items.push(r);
  });
  return out;
}

function claimStatus(c: any): string {
  if (c.status === 'draft') return 'Not sent';
  if (c.status === 'released') return 'Released';
  if (c.status === 'cancelled') return 'Cancelled';
  const s = c.req_stage;
  if (s && STAGE_TEXT[s]) return `With ${STAGE_TEXT[s]}`;
  if (s === 'returned') return 'Returned — update it in Make a requisition';
  if (s === 'approved') return c.wallet_credit_status === 'credited' ? `Paid ${c.credited_at ? dateFmt.format(new Date(c.credited_at)) : ''}`.trim() : c.wallet_credit_status === 'reversed' ? 'Payment reversed' : 'Approved — crediting';
  if (s === 'rejected') return `Declined: ${c.rejection_reason ?? ''}`.trim();
  return 'Submitted';
}

export default function MyVideosTab() {
  const [videos, setVideos] = useState<any[]>([]);
  const [topics, setTopics] = useState<any[]>([]);
  const [liveIds, setLiveIds] = useState<Set<string>>(new Set());
  const [claims, setClaims] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<TutorialPlayerVideo | null>(null);
  const [withdrawing, setWithdrawing] = useState<any | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [uploadOpen, setUploadOpen] = useState(false);
  const [proposeOpen, setProposeOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [v, t, ids, c] = await Promise.all([listMyVideos(), listTopics(), listMyLiveClaimVideoIds(), claimsList()]);
      setVideos(v); setTopics(t); setLiveIds(new Set(ids)); setClaims(c ?? []);
    } catch (e) { setError(errText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const ready = useMemo(() => videos.filter((v) => v.status === 'accepted' && !liveIds.has(v.id)), [videos, liveIds]);
  const total = ready.filter((v) => picked.has(v.id)).reduce((s, v) => s + Number(v.rate_amount || 0), 0);

  async function run(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    try { await fn(); if (ok) toast.success(ok); await load(); }
    catch (e) { toast.error(errText(e)); }
    finally { setBusy(null); }
  }

  async function requestPayment() {
    setBusy('claim');
    let claimId: string | null = null;
    try {
      const prep = await claimPrepare([...picked]);
      claimId = prep.claim_id;
      const { error: reqErr } = await invokeEdgeFunction('staff-requisition-submit', {
        body: { title: prep.req_title, amount: prep.total_amount, category: 'Tutorial videos', reason: prep.req_reason, request_kind: 'requisition' },
        errorTitle: 'Could not raise the requisition',
      });
      if (reqErr) {
        try { await claimCancel(prep.claim_id); } catch { /* claim stays as a draft in My claims */ }
        return;
      }
      try { await claimLink(prep.claim_id); }
      catch (e) { toast.error(errText(e)); return; }
      setPicked(new Set());
      toast.success('Payment requested — it now goes through the normal requisition approvals.');
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(null); void load(); void claimId;
    }
  }

  const videoGroups = groupByMonth(videos, (v) => v.created_at);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setUploadOpen(true)}><Upload className="mr-2 h-4 w-4" />Upload a video</Button>
        <Button variant="outline" onClick={() => setProposeOpen(true)}><Lightbulb className="mr-2 h-4 w-4" />Propose a topic</Button>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      <section className="space-y-3">
        <h2 className="text-base font-semibold">My videos</h2>
        {!videos.length && <p className="text-sm text-muted-foreground">You haven't uploaded any videos yet.</p>}
        {videoGroups.map((g) => (
          <div key={g.label} className="space-y-2">
            <h3 className="text-sm font-semibold text-muted-foreground">
              {g.label} · {g.items.length} video{g.items.length === 1 ? '' : 's'} · {Math.round(g.items.reduce((s, v) => s + (Number(v.duration_seconds) || 0), 0) / 60)} min
            </h3>
            {g.items.map((v) => (
              <div key={v.id} className="rounded-md border border-border p-3 space-y-2">
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium break-words">{v.video_code} • {v.title}</p>
                    <p className="text-xs text-muted-foreground">{v.topic?.topic_code ?? ''} · {formatDuration(v.duration_seconds)}</p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant={v.status === 'rejected' ? 'destructive' : v.status === 'accepted' ? 'default' : 'secondary'}>{STATUS[v.status] ?? v.status}</Badge>
                    {v.published_at && <Badge variant="outline">Published</Badge>}
                    {liveIds.has(v.id) && <Badge variant="outline">On claim</Badge>}
                  </div>
                </div>
                {v.status === 'rejected' && v.review_note && <p className="text-xs text-destructive break-words">{v.review_note}</p>}
                <div className="flex flex-wrap gap-2">
                  {v.status === 'draft' && (
                    <Button size="sm" disabled={busy === v.id} onClick={() => run(v.id, () => submitVideo(v.id), 'Sent for review')}>Submit for review</Button>
                  )}
                  {['uploading', 'draft', 'submitted'].includes(v.status) && (
                    <Button size="sm" variant="outline" onClick={() => setWithdrawing(v)}>Withdraw</Button>
                  )}
                  {v.status !== 'uploading' && (
                    <Button size="sm" variant="ghost" onClick={() => setPlaying(v)}><Play className="mr-1 h-4 w-4" />Play</Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Ready to claim</h2>
        {!ready.length && <p className="text-sm text-muted-foreground">No accepted videos waiting for payment.</p>}
        {ready.map((v) => (
          <label key={v.id} className="flex items-center gap-3 rounded-md border border-border p-3 cursor-pointer">
            <Checkbox checked={picked.has(v.id)} onCheckedChange={(c) => setPicked((old) => { const n = new Set(old); c ? n.add(v.id) : n.delete(v.id); return n; })} />
            <span className="min-w-0 flex-1 text-sm break-words">{v.video_code} • {v.title}</span>
            <span className="text-sm font-medium">{formatUGX(Number(v.rate_amount || 0))}</span>
          </label>
        ))}
        {!!ready.length && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm">Total: <strong>{formatUGX(total)}</strong></span>
            <Button disabled={!picked.size || busy === 'claim'} onClick={() => void requestPayment()}>
              {busy === 'claim' ? 'Requesting…' : 'Request payment'}
            </Button>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">My claims</h2>
          <Link to="/me/requisitions" className="text-sm text-primary underline-offset-4 hover:underline">Open in Make a requisition</Link>
        </div>
        {!claims.length && <p className="text-sm text-muted-foreground">No claims yet.</p>}
        {claims.map((c) => {
          const approved = c.req_approved_amount == null ? null : Number(c.req_approved_amount);
          return (
            <div key={c.claim_id} className="rounded-md border border-border p-3 space-y-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{c.claim_code}</p>
                  <p className="text-xs text-muted-foreground">
                    {dateFmt.format(new Date(c.created_at))} · {c.video_count} video{c.video_count === 1 ? '' : 's'} · {formatUGX(Number(c.total_amount))}
                    {approved != null && approved !== Number(c.total_amount) && <> · Approved {formatUGX(approved)}</>}
                  </p>
                </div>
                <span className="text-sm break-words">{claimStatus(c)}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {c.status === 'draft' && (
                  <>
                    <Button size="sm" disabled={busy === c.claim_id} onClick={() => run(c.claim_id, () => claimLink(c.claim_id), 'Requisition linked')}>Link requisition</Button>
                    <Button size="sm" variant="outline" disabled={busy === c.claim_id} onClick={() => run(c.claim_id, () => claimCancel(c.claim_id), 'Claim cancelled')}>Cancel</Button>
                  </>
                )}
                {c.status === 'submitted' && c.req_stage === 'rejected' && (
                  <Button size="sm" variant="outline" disabled={busy === c.claim_id} onClick={() => run(c.claim_id, () => claimRelease(c.claim_id), 'Videos released')}>Release videos</Button>
                )}
              </div>
            </div>
          );
        })}
      </section>

      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} topics={topics} myVideos={videos} onDone={load} />
      <ProposeDialog open={proposeOpen} onOpenChange={setProposeOpen} onDone={load} />
      <TutorialPlayerDialog video={playing} context="own" open={!!playing} onOpenChange={(o) => { if (!o) setPlaying(null); }} />
      <AlertDialog open={!!withdrawing} onOpenChange={(o) => { if (!o) setWithdrawing(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Withdraw {withdrawing?.video_code}?</AlertDialogTitle>
            <AlertDialogDescription>The video will no longer be reviewed or paid. You can upload it again later.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const v = withdrawing; setWithdrawing(null); if (v) void run(v.id, () => withdrawVideo(v.id), 'Video withdrawn'); }}>Withdraw</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const STAGE_LABEL: Record<UploadStage, string> = {
  checking: 'Checking', hashing: 'Fingerprinting', registering: 'Registering', uploading: 'Uploading', finalising: 'Finalising', done: 'Done',
};

function UploadDialog({ open, onOpenChange, topics, myVideos, onDone }: {
  open: boolean; onOpenChange: (o: boolean) => void; topics: any[]; myVideos: any[]; onDone: () => void;
}) {
  const [topicId, setTopicId] = useState('');
  const [kind, setKind] = useState<'original' | 'revision'>('original');
  const [replaces, setReplaces] = useState('');
  const [why, setWhy] = useState('');
  const [title, setTitle] = useState('');
  const [recordedOn, setRecordedOn] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<UploadStage | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const running = !!stage && stage !== 'done';

  useEffect(() => { if (open) { setStage(null); setProgress(0); setError(null); } }, [open]);

  const openTopics = topics.filter((t) => t.status === 'open');
  const replaceable = myVideos.filter((v) => v.topic_id === topicId && v.status === 'accepted');
  const valid = !!topicId && title.trim().length >= 5 && !!file && (kind === 'original' || (!!replaces && why.trim().length >= 10));

  async function start() {
    if (!file) return;
    setError(null);
    try {
      const res = await uploadTutorial({
        file, topicId, kind, title: title.trim(),
        supersedesVideoId: kind === 'revision' ? replaces : null,
        revisionReason: kind === 'revision' ? why.trim() : null,
        recordedOn: recordedOn || null,
        onStage: setStage, onProgress: setProgress,
      });
      toast.success(`${res.videoCode} uploaded — submit it for review when ready.`);
      setTitle(''); setFile(null); setWhy(''); setReplaces('');
      onDone();
    } catch (e) { setError(errText(e)); setStage(null); }
  }

  const stageText = stage ? (stage === 'uploading' ? `Uploading ${Math.round(progress * 100)}%` : STAGE_LABEL[stage]) : '';

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!running) onOpenChange(o); }}>
      <DialogContent className="w-[calc(100%-1rem)] max-w-lg max-h-[90vh] overflow-y-auto rounded-lg">
        <DialogHeader><DialogTitle>Upload a video</DialogTitle><DialogDescription>Tutorial video for a Welile topic</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label>Topic</Label>
            <Select value={topicId} onValueChange={(v) => { setTopicId(v); setReplaces(''); }} disabled={running}>
              <SelectTrigger><SelectValue placeholder="Choose an open topic" /></SelectTrigger>
              <SelectContent>{openTopics.map((t) => <SelectItem key={t.id} value={t.id}>{t.topic_code} · {t.title}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Type</Label>
            <RadioGroup value={kind} onValueChange={(v) => setKind(v as 'original' | 'revision')} className="flex gap-4" disabled={running}>
              <label className="flex items-center gap-2 text-sm"><RadioGroupItem value="original" />Original</label>
              <label className="flex items-center gap-2 text-sm"><RadioGroupItem value="revision" />Revision</label>
            </RadioGroup>
          </div>
          {kind === 'revision' && (
            <>
              <div className="space-y-1">
                <Label>Replaces</Label>
                <Select value={replaces} onValueChange={setReplaces} disabled={running}>
                  <SelectTrigger><SelectValue placeholder={replaceable.length ? 'Choose the video it replaces' : 'No accepted video on this topic'} /></SelectTrigger>
                  <SelectContent>{replaceable.map((v) => <SelectItem key={v.id} value={v.id}>{v.video_code} · {v.title}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Why a revision</Label>
                <Textarea value={why} onChange={(e) => setWhy(e.target.value)} disabled={running} placeholder="At least 10 characters" />
              </div>
            </>
          )}
          <div className="space-y-1"><Label>Title</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={running} /></div>
          <div className="space-y-1">
            <Label>Recorded on (optional)</Label>
            <Input type="date" value={recordedOn} onChange={(e) => setRecordedOn(e.target.value)} disabled={running} />
            <p className="text-xs text-muted-foreground">As recorded — for your records</p>
          </div>
          <div className="space-y-1">
            <Label>File</Label>
            <Input type="file" accept="video/mp4" disabled={running} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <p className="text-xs text-muted-foreground">MP4 (H.264), max 500 MB. Record on a demo account — no real tenant, landlord, agent or staff details on screen.</p>
          </div>
          {stage && (
            <div className="space-y-1" role="status">
              <Progress value={stage === 'done' ? 100 : Math.round(progress * 100)} />
              <p className="text-xs text-muted-foreground">{stageText}</p>
            </div>
          )}
          {error && <p role="alert" className="text-sm text-destructive break-words">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={running} onClick={() => onOpenChange(false)}>{stage === 'done' ? 'Close' : 'Cancel'}</Button>
          <Button disabled={!valid || running} onClick={() => void start()}>Upload</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProposeDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tier, setTier] = useState('basic');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true); setError(null);
    try {
      await proposeTopic({ p_title: title.trim(), p_description: description.trim(), p_tier: tier });
      toast.success('Topic proposed');
      setTitle(''); setDescription(''); setTier('basic');
      onOpenChange(false); onDone();
    } catch (e) { setError(errText(e)); }
    finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100%-1rem)] max-w-lg rounded-lg">
        <DialogHeader><DialogTitle>Propose a topic</DialogTitle><DialogDescription>Suggest a tutorial topic for review</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1"><Label>Title</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="space-y-1"><Label>Description</Label><Textarea value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <div className="space-y-1">
            <Label>Tier</Label>
            <Select value={tier} onValueChange={setTier}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="basic">Basic</SelectItem>
                <SelectItem value="standard">Standard</SelectItem>
                <SelectItem value="advanced">Advanced</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {error && <p role="alert" className="text-sm text-destructive break-words">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={saving || title.trim().length < 5} onClick={() => void save()}>{saving ? 'Saving…' : 'Propose'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
