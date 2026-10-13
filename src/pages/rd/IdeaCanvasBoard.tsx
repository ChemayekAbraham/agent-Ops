import { safeUUID } from '@/lib/safeUUID';
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Lightbulb, Plus, ChevronDown, ChevronUp, Eye, Pencil, Save } from 'lucide-react';

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

const emptyCanvas = (): Record<CanvasKey, string> =>
  Object.fromEntries(BLOCKS.map((b) => [b.key, ''])) as Record<CanvasKey, string>;

type Row = Idea & { saved: boolean; dirty: boolean; mode: 'preview' | 'edit' };

export default function IdeaCanvasBoard() {
  const { toast } = useToast();
  const [ideas, setIdeas] = useState<Row[]>([]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const setOpen = (id: string | null, close?: string) => setClosed((c) => { const n = new Set(c); if (id) n.delete(id); if (close) n.add(close); return n; });
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('rd_ideas').select('*').order('created_at', { ascending: false });
    if (error) { toast({ title: 'Could not load ideas', description: error.message, variant: 'destructive' }); return; }
    setIdeas((cur) => {
      const drafts = cur.filter((x) => !x.saved);
      const db: Row[] = (data ?? []).map((r) => {
        const existing = cur.find((x) => x.id === r.id);
        if (existing?.dirty) return existing;
        return {
          id: r.id, title: r.title, owner: r.owner, date: r.idea_date, summary: r.summary,
          canvas: { ...emptyCanvas(), ...((r.canvas as Record<string, string>) ?? {}) },
          saved: true, dirty: false, mode: existing?.mode ?? 'preview',
        };
      });
      return [...drafts, ...db];
    });
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const upd = (id: string, patch: Partial<Idea>) =>
    setIdeas((l) => l.map((x) => (x.id === id ? { ...x, ...patch, dirty: true } : x)));
  const setMode = (id: string, mode: 'preview' | 'edit') => {
    setIdeas((l) => l.map((x) => (x.id === id ? { ...x, mode } : x)));
    setOpen(id);
  };
  const add = () => {
    const id = safeUUID();
    setIdeas((l) => [{ id, title: '', owner: '', date: new Date().toISOString().slice(0, 10), summary: '', canvas: emptyCanvas(), saved: false, dirty: true, mode: 'edit' }, ...l]);
    setOpen(id);
  };

  const save = async (i: Row) => {
    if (!i.title.trim()) { toast({ title: 'Give the idea a name first', variant: 'destructive' }); return; }
    setBusy(i.id);
    const fields = { title: i.title.trim(), owner: i.owner, idea_date: i.date, summary: i.summary, canvas: i.canvas };
    const { error } = i.saved
      ? await supabase.from('rd_ideas').update(fields).eq('id', i.id)
      : await supabase.from('rd_ideas').insert({ id: i.id, ...fields });
    setBusy(null);
    if (error) { toast({ title: 'Could not save', description: error.message, variant: 'destructive' }); return; }
    setIdeas((l) => l.map((x) => (x.id === i.id ? { ...x, saved: true, dirty: false, mode: 'preview' } : x)));
    toast({ title: 'Idea saved' });
  };

  const drafts = ideas.filter((x) => !x.saved);
  const saved = ideas.filter((x) => x.saved);
  const renderIdea = (i: Row) => {
          const isOpen = !closed.has(i.id);
          const editing = i.mode === 'edit';
          const filled = BLOCKS.filter((b) => i.canvas[b.key]?.trim()).length;
          return (
            <div key={i.id} className="rounded-xl border border-border bg-background">
              <div className="flex flex-wrap items-center gap-2 p-3">
                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => (isOpen ? setOpen(null, i.id) : setOpen(i.id))}>
                  {isOpen ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
                  <span className="truncate text-sm font-semibold text-foreground">{i.title || 'Untitled idea'}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{i.date}{i.owner ? ` · ${i.owner}` : ''} · canvas {filled}/9</span>
                  {!i.saved && <span className="shrink-0 text-xs text-amber-600">Not saved</span>}
                  {i.saved && i.dirty && <span className="shrink-0 text-xs text-amber-600">Unsaved changes</span>}
                </button>
                {i.saved && !editing && (
                  <>
                    <Button size="sm" variant="ghost" className="h-7 gap-1" onClick={() => setMode(i.id, 'preview')}><Eye className="h-3.5 w-3.5" />Preview</Button>
                    <Button size="sm" variant="ghost" className="h-7 gap-1" onClick={() => setMode(i.id, 'edit')}><Pencil className="h-3.5 w-3.5" />Edit</Button>
                  </>
                )}
                {editing && (
                  <Button size="sm" className="h-7 gap-1" disabled={busy === i.id || (i.saved && !i.dirty)} onClick={() => save(i)}>
                    <Save className="h-3.5 w-3.5" />{busy === i.id ? 'Saving…' : 'Save'}
                  </Button>
                )}
              </div>
              {isOpen && (
                <div className="space-y-3 border-t border-border p-3">
                  {editing ? (
                    <>
                      <div className="grid gap-2 sm:grid-cols-[1fr_12rem_10rem]">
                        <Input className="text-sm" placeholder="Idea name" value={i.title} onChange={(e) => upd(i.id, { title: e.target.value })} />
                        <Input className="text-sm" placeholder="Proposed by" value={i.owner} onChange={(e) => upd(i.id, { owner: e.target.value })} />
                        <Input type="date" className="text-sm" value={i.date} onChange={(e) => upd(i.id, { date: e.target.value })} />
                      </div>
                      <Textarea rows={2} className="text-sm" placeholder="Short description of the idea" value={i.summary}
                        onChange={(e) => upd(i.id, { summary: e.target.value })} />
                    </>
                  ) : (
                    <div className="text-sm">
                      <p className="text-xs text-muted-foreground">Proposed by {i.owner || '—'} on {i.date}</p>
                      <p className="mt-1 whitespace-pre-wrap text-foreground">{i.summary || 'No description.'}</p>
                    </div>
                  )}
                  <div className="grid gap-2 md:grid-cols-5 md:grid-rows-[auto_auto_auto]">
                    {BLOCKS.map((b) => (
                      <div key={b.key} className={`flex flex-col rounded-lg border border-border bg-muted/40 p-2 ${b.area}`}>
                        <p className="text-xs font-semibold text-foreground">{b.title}</p>
                        {editing ? (
                          <Textarea className="mt-1 min-h-[90px] flex-1 bg-background text-xs" placeholder={b.hint}
                            value={i.canvas[b.key]} onChange={(e) => upd(i.id, { canvas: { ...i.canvas, [b.key]: e.target.value } })} />
                        ) : (
                          <p className="mt-1 min-h-[60px] flex-1 whitespace-pre-wrap text-xs text-foreground">
                            {i.canvas[b.key]?.trim() || <span className="text-muted-foreground">{b.hint}</span>}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
  };

  return (
    <div className="space-y-4">
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="flex items-center gap-2 text-base font-semibold text-foreground"><Lightbulb className="h-4 w-4 text-primary" />New Ideas &amp; Business Model Canvas</p>
          <p className="mt-0.5 pl-6 text-xs text-muted-foreground">Record a new idea and its canvas here. Once saved, it moves to the Recorded ideas section below.</p>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={add}><Plus className="h-4 w-4" />Record idea</Button>
      </div>

      {drafts.length === 0 && <p className="mt-3 text-xs text-muted-foreground">Tap Record idea to start a new one.</p>}
      <div className="mt-3 space-y-3">{drafts.map(renderIdea)}</div>
    </div>

    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <p className="flex items-center gap-2 text-base font-semibold text-foreground"><Lightbulb className="h-4 w-4 text-primary" />Recorded Ideas</p>
      <p className="mt-0.5 pl-6 text-xs text-muted-foreground">Each saved idea with its Business Model Canvas. Tap Edit to change the idea or its canvas.</p>
      {saved.length === 0 && <p className="mt-3 text-xs text-muted-foreground">No ideas saved yet.</p>}
      <div className="mt-3 space-y-3">{saved.map(renderIdea)}</div>
    </div>
    </div>
  );
}
