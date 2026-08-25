import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, Smartphone, Pencil, Search, FileDown, X, Check } from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { formatUGX } from '@/lib/rentCalculations';

const db = supabase as any;

export interface SmartphoneCatalogEntry {
  id: string;
  brand: string;
  model_name: string | null;
  default_amount: number | null;
  specifications: string | null;
  is_active: boolean;
  created_at?: string | null;
}

export const SMARTPHONE_CATALOG_QUERY_KEY = ['smartphone-catalog'];

export function useSmartphoneCatalog() {
  return useQuery({
    queryKey: SMARTPHONE_CATALOG_QUERY_KEY,
    queryFn: async (): Promise<SmartphoneCatalogEntry[]> => {
      const { data, error } = await db
        .from('smartphone_catalog')
        .select('id, brand, model_name, default_amount, specifications, is_active, created_at')
        .order('brand', { ascending: true })
        .order('model_name', { ascending: true });
      if (error) throw error;
      return (data || []) as SmartphoneCatalogEntry[];
    },
  });
}

function fmtDate(d?: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function labelOf(e: SmartphoneCatalogEntry): string {
  return e.model_name ? `${e.brand} · ${e.model_name}` : `${e.brand} · any model`;
}

async function exportCatalogPdf(rows: SmartphoneCatalogEntry[], from: string, to: string) {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 14;

  doc.setFillColor(79, 70, 229);
  doc.rect(0, 0, pageWidth, 22, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('WELILE', margin, 10);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('Agent Smartphone Catalog', margin, 17);

  doc.setTextColor(60, 60, 60);
  doc.setFontSize(9);
  const range = from || to ? `${from ? fmtDate(from) : 'start'} — ${to ? fmtDate(to) : 'today'}` : 'All dates';
  doc.text(`Added between: ${range}`, margin, 30);
  doc.text(`Generated: ${fmtDate(new Date().toISOString())}`, margin, 35);
  doc.text(`Models: ${rows.length}  ·  Active: ${rows.filter((r) => r.is_active).length}`, margin, 40);

  autoTable(doc, {
    startY: 46,
    head: [['Brand', 'Model', 'Default amount', 'Status', 'Added']],
    body: rows.map((r) => [
      r.brand,
      r.model_name || 'Any model',
      r.default_amount != null ? formatUGX(Number(r.default_amount)) : '—',
      r.is_active ? 'Active' : 'Inactive',
      fmtDate(r.created_at),
    ]),
    styles: { fontSize: 8.5, cellPadding: 2 },
    headStyles: { fillColor: [79, 70, 229], textColor: 255, fontStyle: 'bold' },
    margin: { left: margin, right: margin },
  });

  doc.save(`welile-smartphone-catalog-${new Date().toISOString().slice(0, 10)}.pdf`);
}

/** Agent Ops dialog to manage phone models agents can order. */
export function SmartphoneCatalogDialog() {
  const [open, setOpen] = useState(false);
  const [brand, setBrand] = useState('');
  const [modelName, setModelName] = useState('');
  const [amount, setAmount] = useState('');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBrand, setEditBrand] = useState('');
  const [editModel, setEditModel] = useState('');
  const [editAmount, setEditAmount] = useState('');
  const [pendingDelete, setPendingDelete] = useState<SmartphoneCatalogEntry | null>(null);
  const queryClient = useQueryClient();

  const { data: entries = [], isLoading } = useSmartphoneCatalog();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: SMARTPHONE_CATALOG_QUERY_KEY });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const fromTs = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : null;
    const toTs = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : null;
    return entries.filter((e) => {
      if (q && !`${e.brand} ${e.model_name ?? ''}`.toLowerCase().includes(q)) return false;
      if (fromTs || toTs) {
        const t = e.created_at ? new Date(e.created_at).getTime() : null;
        if (t == null) return false;
        if (fromTs && t < fromTs) return false;
        if (toTs && t > toTs) return false;
      }
      return true;
    });
  }, [entries, search, fromDate, toDate]);

  const parseAmount = (raw: string): number | null => {
    const t = raw.trim();
    if (!t) return null;
    const n = Math.max(0, parseInt(t, 10) || 0);
    if (n < 1000) throw new Error('Enter a default amount of at least UGX 1,000');
    return n;
  };

  const addEntry = useMutation({
    mutationFn: async () => {
      if (brand.trim().length < 2) throw new Error('Enter a brand');
      if (modelName.trim().length > 0 && modelName.trim().length < 2) throw new Error('Model name is too short');
      const total = parseAmount(amount);
      const { error } = await db.from('smartphone_catalog').insert({
        brand: brand.trim(),
        model_name: modelName.trim() || null,
        default_amount: total,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Phone added to catalog');
      setBrand('');
      setModelName('');
      setAmount('');
      invalidate();
    },
    onError: (e: any) => toast.error(e.message || 'Could not add phone'),
  });

  const updateEntry = useMutation({
    mutationFn: async (id: string) => {
      if (editBrand.trim().length < 2) throw new Error('Enter a brand');
      if (editModel.trim().length > 0 && editModel.trim().length < 2) throw new Error('Model name is too short');
      const total = parseAmount(editAmount);
      const { error } = await db
        .from('smartphone_catalog')
        .update({
          brand: editBrand.trim(),
          model_name: editModel.trim() || null,
          default_amount: total,
        })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Phone updated');
      setEditingId(null);
      invalidate();
    },
    onError: (e: any) => toast.error(e.message || 'Could not update phone'),
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, next }: { id: string; next: boolean }) => {
      const { error } = await db.from('smartphone_catalog').update({ is_active: next }).eq('id', id);
      if (error) throw error;
      return next;
    },
    onSuccess: (next) => {
      toast.success(next ? 'Phone activated' : 'Phone deactivated');
      invalidate();
    },
    onError: (e: any) => toast.error(e.message || 'Could not change status'),
  });

  const removeEntry = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db.from('smartphone_catalog').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Phone removed');
      setPendingDelete(null);
      invalidate();
    },
    onError: (e: any) => toast.error(e.message || 'Could not remove phone'),
  });

  const startEdit = (e: SmartphoneCatalogEntry) => {
    setEditingId(e.id);
    setEditBrand(e.brand);
    setEditModel(e.model_name ?? '');
    setEditAmount(e.default_amount != null ? String(Number(e.default_amount)) : '');
  };

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" className="gap-1.5">
            <Plus className="h-4 w-4" /> Manage Phone Catalog
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Smartphone className="h-4 w-4 text-primary" /> Smartphone catalog
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Brand</Label>
                <Input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="e.g. Samsung" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Model name <span className="text-muted-foreground font-normal">— optional</span></Label>
                <Input value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="e.g. Galaxy A14" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Default amount (UGX) <span className="text-muted-foreground font-normal">— optional</span></Label>
                <Input
                  type="number"
                  min={1000}
                  step={1000}
                  inputMode="numeric"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="e.g. 1200000"
                />
              </div>
            </div>
            <Button className="w-full" onClick={() => addEntry.mutate()} disabled={addEntry.isPending}>
              {addEntry.isPending ? 'Saving…' : 'Add to catalog'}
            </Button>
          </div>

          <div className="mt-1 grid grid-cols-1 sm:grid-cols-4 gap-2 rounded-lg border bg-muted/30 p-2">
            <div className="sm:col-span-2 space-y-1">
              <Label className="text-xs">Search</Label>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-7"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Brand or model"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Added from</Label>
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Added to</Label>
              <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {filtered.length} of {entries.length} model{entries.length === 1 ? '' : 's'}
            </p>
            <div className="flex items-center gap-2">
              {(search || fromDate || toDate) && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSearch('');
                    setFromDate('');
                    setToDate('');
                  }}
                >
                  Clear filters
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={filtered.length === 0}
                onClick={() =>
                  exportCatalogPdf(filtered, fromDate, toDate).catch((e: any) =>
                    toast.error(e.message || 'Could not export PDF'),
                  )
                }
              >
                <FileDown className="h-4 w-4" /> Export PDF
              </Button>
            </div>
          </div>

          <div className="space-y-2 max-h-72 overflow-y-auto">
            {isLoading ? (
              <p className="text-xs text-muted-foreground">Loading catalog…</p>
            ) : filtered.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {entries.length === 0 ? 'No phones registered yet.' : 'No phones match these filters.'}
              </p>
            ) : (
              filtered.map((e) =>
                editingId === e.id ? (
                  <div key={e.id} className="space-y-2 rounded-lg border p-2">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <Input value={editBrand} onChange={(ev) => setEditBrand(ev.target.value)} placeholder="Brand" />
                      <Input value={editModel} onChange={(ev) => setEditModel(ev.target.value)} placeholder="Model (optional)" />
                      <Input
                        type="number"
                        min={1000}
                        step={1000}
                        inputMode="numeric"
                        value={editAmount}
                        onChange={(ev) => setEditAmount(ev.target.value)}
                        placeholder="Default amount"
                      />
                    </div>
                    <div className="flex items-center justify-end gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                        <X className="mr-1 h-3.5 w-3.5" /> Cancel
                      </Button>
                      <Button size="sm" onClick={() => updateEntry.mutate(e.id)} disabled={updateEntry.isPending}>
                        <Check className="mr-1 h-3.5 w-3.5" /> {updateEntry.isPending ? 'Saving…' : 'Save'}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div key={e.id} className="flex items-center justify-between gap-2 rounded-lg border p-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{labelOf(e)}</p>
                      <p className="text-xs text-muted-foreground">
                        {e.default_amount != null ? formatUGX(Number(e.default_amount)) : 'No default amount'}
                        {' · added '}
                        {fmtDate(e.created_at)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Badge variant={e.is_active ? 'default' : 'secondary'}>
                        {e.is_active ? 'active' : 'inactive'}
                      </Badge>
                      <Switch
                        checked={e.is_active}
                        onCheckedChange={(next) => toggleActive.mutate({ id: e.id, next })}
                        disabled={toggleActive.isPending}
                        aria-label={`Toggle ${labelOf(e)}`}
                      />
                      <Button size="icon" variant="ghost" onClick={() => startEdit(e)} aria-label={`Edit ${labelOf(e)}`}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setPendingDelete(e)}
                        aria-label={`Remove ${labelOf(e)}`}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                ),
              )
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this phone from the catalog?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete ? labelOf(pendingDelete) : ''} will no longer be orderable by agents. Deactivate instead if
              you only want to hide it temporarily.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => pendingDelete && removeEntry.mutate(pendingDelete.id)}
              disabled={removeEntry.isPending}
            >
              {removeEntry.isPending ? 'Removing…' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
