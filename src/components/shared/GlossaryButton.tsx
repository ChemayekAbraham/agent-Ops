import { useState } from 'react';
import { BookOpen, Search, X, Plus, Pencil, Trash2, EyeOff, Eye, Save, Loader2 } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';

export interface GlossaryTerm {
  id: string;
  term: string;
  category: string;
  short: string;
  example: string | null;
  also: string[];
  sort_order: number;
  is_active: boolean;
}

const CATEGORY_ORDER = [
  'Money',
  'Process',
  'Agent Ops',
  'Tenant',
  'Landlord',
  'Roles',
] as const;

const CATEGORIES: string[] = [...CATEGORY_ORDER];

interface GlossaryButtonProps {
  variant?: 'header' | 'inline' | 'menu';
  className?: string;
  label?: string;
}

/**
 * Glossary trigger + dialog. Drop anywhere — completely self-contained.
 * Use `variant="header"` for top bars, `variant="menu"` inside menu lists,
 * `variant="inline"` for normal page placement.
 */
export function GlossaryButton({ variant = 'inline', className, label = 'Glossary' }: GlossaryButtonProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTerm, setEditingTerm] = useState<GlossaryTerm | null>(null);

  const { roles } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const isAdmin = roles.includes('manager') || roles.includes('super_admin');

  const { data: terms = [], isLoading } = useQuery({
    queryKey: ['glossary-terms', isAdmin],
    queryFn: async (): Promise<GlossaryTerm[]> => {
      const builder = supabase
        .from('glossary_terms')
        .select('id, term, category, short, example, also, sort_order, is_active')
        .order('sort_order', { ascending: true })
        .order('term', { ascending: true });
      // RLS already filters non-admins to active rows; admins get everything.
      const { data, error } = await builder;
      if (error) throw error;
      return (data || []) as GlossaryTerm[];
    },
    staleTime: 60_000,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('glossary_terms').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: 'Term deleted' });
      queryClient.invalidateQueries({ queryKey: ['glossary-terms'] });
    },
    onError: (err: Error) =>
      toast({ title: 'Delete failed', description: err.message, variant: 'destructive' }),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async (t: GlossaryTerm) => {
      const { error } = await supabase
        .from('glossary_terms')
        .update({ is_active: !t.is_active })
        .eq('id', t.id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['glossary-terms'] }),
    onError: (err: Error) =>
      toast({ title: 'Update failed', description: err.message, variant: 'destructive' }),
  });

  const q = query.trim().toLowerCase();
  const filtered = q
    ? terms.filter(
        (t) =>
          t.term.toLowerCase().includes(q) ||
          t.short.toLowerCase().includes(q) ||
          (t.example?.toLowerCase().includes(q) ?? false),
      )
    : terms;

  // Build category list dynamically from data + the canonical order.
  const allCategories = Array.from(
    new Set([...CATEGORY_ORDER, ...terms.map((t) => t.category)]),
  );
  const grouped = allCategories
    .map((cat) => ({
      category: cat,
      terms: filtered.filter((t) => t.category === cat),
    }))
    .filter((g) => g.terms.length > 0);

  const openEditor = (t: GlossaryTerm | null) => {
    setEditingTerm(t);
    setEditorOpen(true);
  };

  const trigger = (() => {
    if (variant === 'header') {
      return (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium hover:bg-white/10 transition-colors whitespace-nowrap',
            className,
          )}
          title="Welile glossary — shared team vocabulary"
        >
          <BookOpen className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{label}</span>
        </button>
      );
    }
    if (variant === 'menu') {
      return (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(
            'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors',
            className,
          )}
        >
          <BookOpen className="h-4 w-4 shrink-0" />
          <span>{label}</span>
        </button>
      );
    }
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium border border-border bg-card hover:bg-muted transition-colors',
          className,
        )}
      >
        <BookOpen className="h-4 w-4" />
        {label}
      </button>
    );
  })();

  return (
    <>
      {trigger}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col p-0">
          <DialogHeader className="px-6 pt-6 pb-3 border-b border-border">
            <div className="flex items-center justify-between gap-3">
              <DialogTitle className="flex items-center gap-2">
                <BookOpen className="h-5 w-5 text-primary" />
                Welile Glossary
              </DialogTitle>
              {isAdmin && (
                <Button size="sm" onClick={() => openEditor(null)} className="shrink-0">
                  <Plus className="h-4 w-4 mr-1" />
                  Add term
                </Button>
              )}
            </div>
            <DialogDescription>
              Shared vocabulary so the whole team — agents, ops, finance, execs — uses the same words for the same things.
              {isAdmin && (
                <span className="block mt-1 text-[11px] text-primary">
                  You're an editor — you can add, edit, archive, or remove terms.
                </span>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="px-6 pt-3 pb-2 shrink-0">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search a term (e.g., float, refill, advance)…"
                className="pl-9 pr-9"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md hover:bg-muted"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-5">
            {isLoading ? (
              <div className="flex items-center justify-center py-10 text-muted-foreground gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">Loading glossary…</span>
              </div>
            ) : grouped.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-10">
                {q ? `No terms match "${query}". Try a different word.` : 'No terms yet.'}
              </p>
            ) : (
              grouped.map((g) => (
                <section key={g.category}>
                  <h3 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
                    {g.category}
                  </h3>
                  <div className="space-y-2">
                    {g.terms.map((t) => (
                      <div
                        key={t.term}
                        className={cn(
                          'rounded-xl border border-border bg-card/60 p-3',
                          !t.is_active && 'opacity-60 border-dashed',
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2 flex-wrap min-w-0">
                            <h4 className="font-semibold text-sm">{t.term}</h4>
                            <Badge variant="outline" className="text-[10px] font-normal">
                              {t.category}
                            </Badge>
                            {!t.is_active && (
                              <Badge variant="outline" className="text-[10px] font-normal border-warning/40 text-warning">
                                Archived
                              </Badge>
                            )}
                          </div>
                          {isAdmin && (
                            <div className="flex items-center gap-0.5 shrink-0">
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7"
                                title={t.is_active ? 'Archive' : 'Restore'}
                                onClick={() => toggleActiveMutation.mutate(t)}
                                disabled={toggleActiveMutation.isPending}
                              >
                                {t.is_active ? (
                                  <EyeOff className="h-3.5 w-3.5" />
                                ) : (
                                  <Eye className="h-3.5 w-3.5" />
                                )}
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7"
                                title="Edit"
                                onClick={() => openEditor(t)}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7 text-destructive hover:text-destructive"
                                title="Delete"
                                onClick={() => {
                                  if (window.confirm(`Delete "${t.term}"? This cannot be undone.`)) {
                                    deleteMutation.mutate(t.id);
                                  }
                                }}
                                disabled={deleteMutation.isPending}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
                          {t.short}
                        </p>
                        {t.example && (
                          <p className="text-xs text-foreground/80 mt-2 pl-3 border-l-2 border-primary/40">
                            <span className="font-semibold">Example:</span> {t.example}
                          </p>
                        )}
                        {t.also && t.also.length > 0 && (
                          <p className="text-[11px] text-muted-foreground mt-2">
                            See also: {t.also.join(', ')}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              ))
            )}

            <p className="text-[11px] text-muted-foreground text-center pt-2">
              {isAdmin
                ? 'Tip: archived terms stay hidden from non-admins but remain in your view.'
                : "Missing a term? Tell Ops and they'll add it here."}
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {isAdmin && (
        <GlossaryEditorDialog
          open={editorOpen}
          onOpenChange={setEditorOpen}
          term={editingTerm}
          onSaved={() => {
            setEditorOpen(false);
            queryClient.invalidateQueries({ queryKey: ['glossary-terms'] });
          }}
        />
      )}
    </>
  );
}

// ---------------- Admin editor dialog ----------------

interface GlossaryEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  term: GlossaryTerm | null;
  onSaved: () => void;
}

function GlossaryEditorDialog({ open, onOpenChange, term, onSaved }: GlossaryEditorDialogProps) {
  const { toast } = useToast();
  const isEdit = !!term;

  const [formTerm, setFormTerm] = useState('');
  const [category, setCategory] = useState<string>('Money');
  const [short, setShort] = useState('');
  const [example, setExample] = useState('');
  const [also, setAlso] = useState('');
  const [sortOrder, setSortOrder] = useState<number>(100);
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);

  // Reset form whenever the dialog opens with a different term.
  // useState init runs only once, so we sync via an effect-like pattern:
  const lastTermId = useState<string | null>(null);
  if (open && lastTermId[0] !== (term?.id ?? null)) {
    lastTermId[1](term?.id ?? null);
    setFormTerm(term?.term ?? '');
    setCategory(term?.category ?? 'Money');
    setShort(term?.short ?? '');
    setExample(term?.example ?? '');
    setAlso((term?.also ?? []).join(', '));
    setSortOrder(term?.sort_order ?? 100);
    setIsActive(term?.is_active ?? true);
  }

  const handleSave = async () => {
    const t = formTerm.trim();
    const s = short.trim();
    if (!t || !s) {
      toast({ title: 'Term and definition are required', variant: 'destructive' });
      return;
    }

    setSaving(true);
    const payload = {
      term: t,
      category: category.trim() || 'Money',
      short: s,
      example: example.trim() ? example.trim() : null,
      also: also
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
      sort_order: Number.isFinite(sortOrder) ? sortOrder : 100,
      is_active: isActive,
    };

    try {
      if (isEdit && term) {
        const { error } = await supabase
          .from('glossary_terms')
          .update(payload)
          .eq('id', term.id);
        if (error) throw error;
        toast({ title: 'Term updated' });
      } else {
        const { error } = await supabase.from('glossary_terms').insert(payload);
        if (error) throw error;
        toast({ title: 'Term added' });
      }
      onSaved();
    } catch (err: any) {
      toast({
        title: 'Save failed',
        description: err?.message ?? 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit term' : 'Add new term'}</DialogTitle>
          <DialogDescription>
            Keep definitions short and in plain English so the whole team can use them.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 overflow-y-auto pr-1">
          <div className="space-y-1.5">
            <Label htmlFor="g-term">Term</Label>
            <Input
              id="g-term"
              value={formTerm}
              onChange={(e) => setFormTerm(e.target.value)}
              placeholder="e.g. Float"
              maxLength={80}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="g-cat">Category</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger id="g-cat">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="g-sort">Sort order</Label>
              <Input
                id="g-sort"
                type="number"
                value={sortOrder}
                onChange={(e) => setSortOrder(parseInt(e.target.value, 10) || 100)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="g-short">Definition</Label>
            <Textarea
              id="g-short"
              rows={3}
              value={short}
              onChange={(e) => setShort(e.target.value)}
              placeholder="Plain-English meaning. One or two sentences."
              maxLength={500}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="g-example">
              Example <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Textarea
              id="g-example"
              rows={2}
              value={example}
              onChange={(e) => setExample(e.target.value)}
              placeholder="A concrete scenario showing the term in use."
              maxLength={400}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="g-also">
              See also <span className="text-muted-foreground font-normal">(comma separated)</span>
            </Label>
            <Input
              id="g-also"
              value={also}
              onChange={(e) => setAlso(e.target.value)}
              placeholder="Float Limit, Refill"
            />
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            <span>Visible to everyone (uncheck to archive)</span>
          </label>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-1" />
            )}
            {isEdit ? 'Save changes' : 'Add term'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}