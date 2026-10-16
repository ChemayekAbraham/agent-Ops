import { useCallback, useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { acceptVideo, listAccepted, listReviewQueue, listTopics, listTopicVideos, myReviewProgress, proposeTopic, rejectVideo, setPublished, setTopicStatus } from '../api';
import TutorialPlayerDialog, { formatDuration } from '../components/TutorialPlayerDialog';

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Kampala' });
const monthKey = (d: string | Date) => new Intl.DateTimeFormat('en-GB', { month: 'numeric', year: 'numeric', timeZone: 'Africa/Kampala' }).format(new Date(d));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Selects a tab once on mount (used to make Review the default for reviewers who are not creators). */
export function DefaultTabOnce({ value, onSet }: { value: string; onSet: (v: string) => void }) {
  const done = useRef(false);
  useEffect(() => { if (!done.current) { done.current = true; onSet(value); } }, [value, onSet]);
  return null;
}

export default function ReviewTab() {
  const [queue, setQueue] = useState<any[]>([]);
  const [dupes, setDupes] = useState<Record<string, string>>({});
  const [accepted, setAccepted] = useState<any[]>([]);
  const [topics, setTopics] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<any | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [q, a, t] = await Promise.all([listReviewQueue(), listAccepted(), listTopics()]);
      setQueue(q); setAccepted(a); setTopics(t);
      const byTopic = new Map<string, any[]>();
      await Promise.all([...new Set(q.map((v) => v.topic_id))].map(async (id) => {
        try { byTopic.set(id, await listTopicVideos(id)); } catch { byTopic.set(id, []); }
      }));
      const d: Record<string, string> = {};
      q.forEach((v) => {
        const other = (byTopic.get(v.topic_id) ?? []).find((o) => o.id !== v.id && o.status !== 'withdrawn'
          && Math.abs(Number(o.duration_seconds) - Number(v.duration_seconds)) <= 3);
        if (other) d[v.id] = other.video_code;
      });
      setDupes(d);
    } catch (e) { setError(errText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try { await fn(); toast.success(ok); await load(); }
    catch (e) { toast.error(errText(e)); }
    finally { setBusy(null); }
  }

  const thisMonth = accepted.filter((v) => v.reviewed_at && monthKey(v.reviewed_at) === monthKey(new Date()));
  const monthMin = Math.round(thisMonth.reduce((s, v) => s + (Number(v.duration_seconds) || 0), 0) / 60);
  const proposed = topics.filter((t) => t.status === 'proposed');
  const open = topics.filter((t) => t.status === 'open');

  return (
    <div className="space-y-6">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      <section className="space-y-2">
        <h2 className="text-base font-semibold">Queue</h2>
        {!queue.length && <p className="text-sm text-muted-foreground">Nothing waiting for review.</p>}
        {queue.map((v) => (
          <button key={v.id} type="button" onClick={() => setReviewing(v)}
            className="w-full rounded-md border border-border p-3 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <p className="text-sm font-medium break-words">{v.video_code} • {v.title}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{v.topic?.topic_code ?? ''}</span>
              <span>{v.kind === 'revision' ? 'Revision' : 'Original'}</span>
              <span>{formatDuration(v.duration_seconds)}</span>
              {v.submitted_at && <span>Submitted {dateFmt.format(new Date(v.submitted_at))}</span>}
              {dupes[v.id] && <Badge className="border-warning/40 bg-warning/15 text-foreground hover:bg-warning/15">Possible duplicate of {dupes[v.id]}</Badge>}
            </div>
          </button>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">Accepted</h2>
        <p className="text-sm text-muted-foreground">This month: {thisMonth.length} accepted · {monthMin} min</p>
        {accepted.map((v) => (
          <div key={v.id} className="flex items-center gap-3 rounded-md border border-border p-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium break-words">{v.video_code} • {v.title}</p>
              <p className="text-xs text-muted-foreground">{v.topic?.topic_code ?? ''} · {formatDuration(v.duration_seconds)}</p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              {v.published_at ? 'Published' : 'Unpublished'}
              <Switch checked={!!v.published_at} disabled={busy === v.id}
                onCheckedChange={(c) => run(v.id, () => setPublished({ p_video_id: v.id, p_published: c }), c ? 'Published' : 'Unpublished')} />
            </label>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Topics</h2>
          <Button size="sm" onClick={() => setNewOpen(true)}>New topic</Button>
        </div>
        {[...proposed, ...open].map((t) => (
          <div key={t.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium break-words">{t.topic_code} • {t.title}</p>
              <p className="text-xs text-muted-foreground capitalize">{t.tier} · {t.status}</p>
            </div>
            {t.status === 'proposed' && (
              <Button size="sm" disabled={busy === t.id} onClick={() => run(t.id, () => setTopicStatus({ p_topic_id: t.id, p_status: 'open' }), 'Topic opened')}>Open</Button>
            )}
            <Button size="sm" variant="outline" disabled={busy === t.id} onClick={() => run(t.id, () => setTopicStatus({ p_topic_id: t.id, p_status: 'closed' }), 'Topic closed')}>Close</Button>
          </div>
        ))}
        {!proposed.length && !open.length && <p className="text-sm text-muted-foreground">No proposed or open topics.</p>}
      </section>

      <ReviewDialog video={reviewing} onClose={() => setReviewing(null)} onDone={load} />
      <NewTopicDialog open={newOpen} onOpenChange={setNewOpen} onDone={load} />
    </div>
  );
}

function ReviewDialog({ video, onClose, onDone }: { video: any | null; onClose: () => void; onDone: () => void }) {
  const [watched, setWatched] = useState(0);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [noData, setNoData] = useState(false);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setWatched(0); setNoData(false); setNote(''); setReason(''); setRejecting(false); setError(null); }, [video?.id]);
  useEffect(() => {
    if (!video?.id) return;
    let live = true;
    myReviewProgress(video.id).then((v) => { if (live) setWatched((w) => Math.max(w, v)); }).catch(() => {});
    return () => { live = false; };
  }, [video?.id]);

  const dur = Number(video?.duration_seconds) || 0;
  const pct = dur ? Math.min(100, Math.round((watched / dur) * 100)) : 0;

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setError(null);
    try { await fn(); toast.success(ok); onClose(); onDone(); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  }

  return (
    <>
      <Dialog open={!!video && !playerOpen} onOpenChange={(o) => { if (!o) onClose(); }}>
        <DialogContent className="w-[calc(100%-1rem)] max-w-lg max-h-[90vh] overflow-y-auto rounded-lg">
          <DialogHeader>
            <DialogTitle className="pr-8 break-words">{video ? `${video.video_code} • ${video.title}` : 'Review'}</DialogTitle>
            <DialogDescription>{formatDuration(dur)} • You have watched {pct}%</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Button variant="outline" onClick={() => setPlayerOpen(true)}><Play className="mr-2 h-4 w-4" />Watch video</Button>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={noData} onCheckedChange={(c) => setNoData(c === true)} className="mt-0.5" />
              No real tenant, landlord, agent or staff personal data is visible
            </label>
            <div className="space-y-1"><Label>Note (optional)</Label><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></div>
            {rejecting && (
              <div className="space-y-1"><Label>Reason for rejecting</Label>
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="At least 10 characters" /></div>
            )}
            {error && <p role="alert" className="text-sm text-destructive break-words">{error}</p>}
          </div>
          <DialogFooter className="gap-2">
            {rejecting ? (
              <>
                <Button variant="outline" onClick={() => setRejecting(false)}>Back</Button>
                <Button variant="destructive" disabled={busy || reason.trim().length < 10}
                  onClick={() => act(() => rejectVideo({ p_video_id: video.id, p_reason: reason.trim() }), 'Video rejected')}>Reject</Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => setRejecting(true)}>Reject…</Button>
                <Button disabled={busy || pct < 50 || !noData}
                  onClick={() => act(() => acceptVideo({ p_video_id: video.id, p_no_personal_data: noData, p_note: note.trim() || null }), 'Video accepted')}>Accept</Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <TutorialPlayerDialog video={video} context="review" open={!!video && playerOpen}
        onOpenChange={setPlayerOpen} onWatched={(s) => setWatched((w) => Math.max(w, s))} />
    </>
  );
}

function NewTopicDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tier, setTier] = useState('basic');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setSaving(true); setError(null);
    try {
      await proposeTopic({ p_title: title.trim(), p_description: description.trim(), p_tier: tier });
      toast.success('Topic created'); setTitle(''); setDescription(''); onOpenChange(false); onDone();
    } catch (e) { setError(errText(e)); } finally { setSaving(false); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100%-1rem)] max-w-lg rounded-lg">
        <DialogHeader><DialogTitle>New topic</DialogTitle><DialogDescription>Opens straight away for creators</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1"><Label>Title</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="space-y-1"><Label>Description</Label><Textarea value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <div className="space-y-1"><Label>Tier</Label>
            <Select value={tier} onValueChange={setTier}><SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="basic">Basic</SelectItem><SelectItem value="standard">Standard</SelectItem><SelectItem value="advanced">Advanced</SelectItem></SelectContent>
            </Select></div>
          {error && <p role="alert" className="text-sm text-destructive break-words">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={saving || title.trim().length < 5} onClick={() => void save()}>{saving ? 'Saving…' : 'Create'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
