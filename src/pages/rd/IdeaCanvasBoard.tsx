import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Lightbulb, Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react';

type CanvasKey =
  | 'partners' | 'activities' | 'resources' | 'value' | 'relationships'
  | 'channels' | 'segments' | 'costs' | 'revenue';

type Idea = {
  id: string; title: string; owner: string; date: string; summary: string;
  canvas: Record<CanvasKey, string>;
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
  const [ideas, setIdeas] = useState<Idea[]>(() => {
    try { const v = localStorage.getItem(KEY); if (v) return JSON.parse(v); } catch { /* ignore */ }
    return [];
  });
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(ideas)); } catch { /* ignore */ } }, [ideas]);

  const upd = (id: string, patch: Partial<Idea>) => setIdeas((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const add = () => {
    const id = crypto.randomUUID();
    setIdeas((l) => [{ id, title: 'New idea', owner: '', date: new Date().toISOString().slice(0, 10), summary: '', canvas: emptyCanvas() }, ...l]);
    setOpen(id);
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="flex items-center gap-2 text-base font-semibold text-foreground"><Lightbulb className="h-4 w-4 text-primary" />New Ideas &amp; Business Model Canvas</p>
          <p className="mt-0.5 pl-6 text-xs text-muted-foreground">Record a new idea and fill in its business model canvas. Saved on this device.</p>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={add}><Plus className="h-4 w-4" />Record idea</Button>
      </div>

      {ideas.length === 0 && <p className="mt-3 text-xs text-muted-foreground">No ideas recorded yet.</p>}

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
                <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Delete idea"
                  onClick={() => { if (confirm('Delete this idea?')) setIdeas((l) => l.filter((x) => x.id !== i.id)); }}>
                  <Trash2 className="h-3.5 w-3.5" />
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
