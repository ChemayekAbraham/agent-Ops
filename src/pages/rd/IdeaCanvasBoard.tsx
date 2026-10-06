import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Lightbulb, Plus, Save, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';

type CanvasKey =
  | 'partners' | 'activities' | 'resources' | 'value' | 'relationships'
  | 'channels' | 'segments' | 'costs' | 'revenue';

type Idea = {
  id: string; title: string; owner: string; date: string; summary: string;
  canvas: Record<CanvasKey, string>;
  isNew?: boolean; dirty?: boolean;
};

const BLOCKS: { key: CanvasKey; title: string; hint: string; area: string }[] = [
  { key: 'partners', title: 'Key Partners', hint: 'Who helps us deliver?', area: 'md:col-start-1 md:row-start-1 md:row-span-2' },
  { key: 'activities', title: 'Key Activities', hint: 'What must we do well?', area: 'md:col-start-2 md:row-start-1' },
  { key: 'resources', title: 'Key Resources', hint: 'What do we need?', area: 'md:col-start-2 md:row-start-2' },
  { key: 'value', title: 'Value Proposition', hint: 'What problem do we solve?', area: 'md:col-start-3 md:row-start-1 md:row-span-2' },
  { key: 'relationships', title: 'Customer Relationships', hint: 'How do we keep customers?', area: 'md:col-start-4 md:row-start-1' },
  { key: 'channels', title: 'Channels', hint: 'How do we reach them?', area: 'md:col-start-4 md:row-start-2' },
  { key: 'segments', title: 'Customer Segments', hint: 'Who is it for?', area: 'md:col-start-5 md:row-start-1 md:row-span-2' },
  { key: 'costs', title: 'Cost Structure', hint: 'Main costs', area: 'md:col-start-1 md:col-span-2 md:row-start-3' },
  { key: 'revenue', title: 'Revenue Streams', hint: 'How do we earn?', area: 'md:col-start-3 md:col-span-3 md:row-start-3' },
];

const KEY = 'rd-idea-canvases-v1';
const emptyCanvas = (): Record<CanvasKey, string> =>
  Object.fromEntries(BLOCKS.map((b) => [b.key, ''])) as Record<CanvasKey, string>;

export default function IdeaCanvasBoard() {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const db = supabase as any;

  useEffect(() => {
    (async () => {
      const { data, error } = await db.from('rd_ideas').select('*').order('created_at', { ascending: false });
      if (error) { toast.error('Could not load ideas'); setLoading(false); return; }
      const rows: Idea[] = (data ?? []).map((r: any) => ({ id: r.id, title: r.title, owner: r.owner, date: r.idea_date, summary: r.summary, canvas: { ...emptyCanvas(), ...(r.canvas || {}) } }));
      // Bring over ideas previously kept only in this browser, marked unsaved.
      let local: Idea[] = [];
      try { const v = localStorage.getItem(KEY); if (v) local = JSON.parse(v); } catch { /* ignore */ }
      const known = new Set(rows.map((r) => r.id));
      const pending = local.filter((l) => !known.has(l.id)).map((l) => ({ ...l, isNew: true, dirty: true }));
      setIdeas([...pending, ...rows]);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(ideas.filter((i) => i.dirty))); } catch { /* ignore */ }
  }, [ideas]);

  const upd = (id: string, patch: Partial<Idea>) => setIdeas((l) => l.map((x) => (x.id === id ? { ...x, ...patch, dirty: true } : x)));
  const add = () => {
    const id = crypto.randomUUID();
    setIdeas((l) => [{ id, title: 'New idea', owner: '', date: new Date().toISOString().slice(0, 10), summary: '', canvas: emptyCanvas(), isNew: true, dirty: true }, ...l]);
    setOpen(id);
  };
  const save = async (i: Idea) => {
    setSaving(i.id);
    const row = { title: i.title, owner: i.owner, idea_date: i.date, summary: i.summary, canvas: i.canvas };
    const { error } = i.isNew
      ? await db.from('rd_ideas').insert({ id: i.id, ...row })
      : await db.from('rd_ideas').update(row).eq('id', i.id);
    setSaving(null);
    if (error) { toast.error('Could not save idea: ' + error.message); return; }
    setIdeas((l) => l.map((x) => (x.id === i.id ? { ...x, isNew: false, dirty: false } : x)));
    toast.success('Idea saved');
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="flex items-center gap-2 text-base font-semibold text-foreground"><Lightbulb className="h-4 w-4 text-primary" />New Ideas &amp; Business Model Canvas</p>
          <p className="mt-0.5 pl-6 text-xs text-muted-foreground">Record a new idea and fill in its business model canvas. Tap Save to keep it for the whole team.</p>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={add}><Plus className="h-4 w-4" />Record idea</Button>
      </div>

      {loading && <p className="mt-3 text-xs text-muted-foreground">Loading ideas…</p>}
      {!loading && ideas.length === 0 && <p className="mt-3 text-xs text-muted-foreground">No ideas recorded yet.</p>}

      <div className="mt-3 space-y-3">
        {ideas.map((i) => {
          const isOpen = open === i.id;
          const filled = BLOCKS.filter((b) => i.canvas[b.key]?.trim()).length;
          return (
            <div key={i.id} className="rounded-xl border border-border bg-background">
              <div className="flex items-center gap-2 p-3">
                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(isOpen ? null : i.id)}>
                  {isOpen ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
                  <span className="truncate text-sm font-semibold text-foreground">{i.title || 'Untitled idea'}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{i.date} · canvas {filled}/9</span>
                </button>
                {i.dirty && <span className="shrink-0 text-xs text-muted-foreground">Not saved</span>}
                <Button size="sm" variant={i.dirty ? 'default' : 'outline'} className="h-7 gap-1.5" disabled={!i.dirty || saving === i.id} onClick={() => save(i)}>
                  {saving === i.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}{i.dirty ? 'Save' : 'Saved'}
                </Button>
              </div>
              {isOpen && (
                <div className="space-y-3 border-t border-border p-3">
                  <div className="grid gap-2 sm:grid-cols-[1fr_12rem_10rem]">
                    <Input className="text-sm" placeholder="Idea name" value={i.title} onChange={(e) => upd(i.id, { title: e.target.value })} />
                    <Input className="text-sm" placeholder="Proposed by" value={i.owner} onChange={(e) => upd(i.id, { owner: e.target.value })} />
                    <Input type="date" className="text-sm" value={i.date} onChange={(e) => upd(i.id, { date: e.target.value })} />
                  </div>
                  <Textarea rows={2} className="text-sm" placeholder="Short description of the idea" value={i.summary}
                    onChange={(e) => upd(i.id, { summary: e.target.value })} />
                  <div className="grid gap-2 md:grid-cols-5 md:grid-rows-[auto_auto_auto]">
                    {BLOCKS.map((b) => (
                      <div key={b.key} className={`flex flex-col rounded-lg border border-border bg-muted/40 p-2 ${b.area}`}>
                        <p className="text-xs font-semibold text-foreground">{b.title}</p>
                        <Textarea className="mt-1 min-h-[90px] flex-1 bg-background text-xs" placeholder={b.hint}
                          value={i.canvas[b.key]} onChange={(e) => upd(i.id, { canvas: { ...i.canvas, [b.key]: e.target.value } })} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
