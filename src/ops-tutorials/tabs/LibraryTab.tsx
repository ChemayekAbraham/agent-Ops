import { useEffect, useMemo, useState } from 'react';
import { Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { listLibrary } from '../api';
import TutorialPlayerDialog, { formatDuration, type TutorialPlayerVideo } from '../components/TutorialPlayerDialog';

const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'Africa/Kampala' });

export default function LibraryTab() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [topic, setTopic] = useState('all');
  const [playing, setPlaying] = useState<TutorialPlayerVideo | null>(null);

  useEffect(() => {
    listLibrary().then(setRows).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  const topics = useMemo(() => {
    const m = new Map<string, string>();
    rows.forEach((r) => r.topic && m.set(r.topic_id, `${r.topic.topic_code} · ${r.topic.title}`));
    return [...m.entries()];
  }, [rows]);

  const groups = useMemo(() => {
    const out: { label: string; items: any[] }[] = [];
    rows.filter((r) => topic === 'all' || r.topic_id === topic).forEach((r) => {
      const label = monthFmt.format(new Date(r.published_at));
      let g = out.find((x) => x.label === label);
      if (!g) { g = { label, items: [] }; out.push(g); }
      g.items.push(r);
    });
    return out;
  }, [rows, topic]);

  if (loading) return <p role="status" className="text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;

  return (
    <div className="space-y-4">
      <Select value={topic} onValueChange={setTopic}>
        <SelectTrigger className="w-full sm:w-72"><SelectValue placeholder="All topics" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All topics</SelectItem>
          {topics.map(([id, label]) => <SelectItem key={id} value={id}>{label}</SelectItem>)}
        </SelectContent>
      </Select>
      {!groups.length && <p className="py-8 text-center text-sm text-muted-foreground">No tutorials published yet.</p>}
      {groups.map((g) => {
        const mins = Math.round(g.items.reduce((s, r) => s + (Number(r.duration_seconds) || 0), 0) / 60);
        return (
          <section key={g.label} className="space-y-2">
            <h3 className="text-sm font-semibold text-muted-foreground">
              {g.label} · {g.items.length} video{g.items.length === 1 ? '' : 's'} · {mins} min
            </h3>
            {g.items.map((r) => (
              <div key={r.id} className="flex items-center gap-3 rounded-md border border-border p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium break-words">{r.video_code} • {r.title}</p>
                  <p className="text-xs text-muted-foreground">{r.topic?.topic_code ?? ''} · {formatDuration(r.duration_seconds)}</p>
                </div>
                <Button size="sm" onClick={() => setPlaying(r)}><Play className="mr-1 h-4 w-4" />Play</Button>
              </div>
            ))}
          </section>
        );
      })}
      <TutorialPlayerDialog video={playing} context="library" open={!!playing} onOpenChange={(o) => { if (!o) setPlaying(null); }} />
    </div>
  );
}
