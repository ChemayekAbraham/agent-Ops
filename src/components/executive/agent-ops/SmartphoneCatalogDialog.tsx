import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, Smartphone, Pencil, FileDown, X, Check, ChevronDown } from 'lucide-react';

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatUGX } from '@/lib/rentCalculations';
import { smartphoneScheduleGrid } from '@/lib/smartphoneAdvance';
import { downPaymentCopy } from '@/lib/moBanjaIphone';

const db = supabase as any;

export type SmartphoneOsType = 'android' | 'ios';

export interface SmartphoneCatalogEntry {
  id: string;
  brand: string;
  model_name: string | null;
  os_type: SmartphoneOsType;
  default_amount: number | null;
  specifications: string | null;
  more_specifications: string | null;
  is_active: boolean;
  supplier_id?: string | null;
  supplier_name?: string | null;
  supplier_phone?: string | null;
  created_at?: string | null;
}

/**
 * A model reaches the agent application dropdown when it is active and priced.
 * The supplier is optional here — Agent Ops assigns it to the order after the
 * agent submits the application.
 */
export function catalogVisibleToAgents(e: SmartphoneCatalogEntry): boolean {
  return e.is_active && Number(e.default_amount || 0) > 0;
}

export const SMARTPHONE_CATALOG_QUERY_KEY = ['smartphone-catalog'];

/**
 * iPhone release order (oldest → newest). Alphabetical sorting would place
 * "XR" after "17", so iOS models are ordered by this list instead.
 */
const IPHONE_RELEASE_ORDER: string[] = [
  'xr', 'xs', 'xs max',
  '11', '11 pro', '11 pro max',
  'se (2nd generation)',
  '12 mini', '12', '12 pro', '12 pro max',
  '13 mini', '13', '13 pro', '13 pro max',
  'se (3rd generation)',
  '14', '14 plus', '14 pro', '14 pro max',
  '15', '15 plus', '15 pro', '15 pro max',
  '16e', '16', '16 plus', '16 pro', '16 pro max',
  'air',
  '17', '17 pro', '17 pro max',
];

function modelRank(e: SmartphoneCatalogEntry): number {
  if (e.os_type !== 'ios') return -1;
  const idx = IPHONE_RELEASE_ORDER.indexOf((e.model_name ?? '').trim().toLowerCase());
  return idx === -1 ? IPHONE_RELEASE_ORDER.length : idx;
}

/** os → brand → release order (iOS) or model name (Android). */
export function sortCatalogEntries(rows: SmartphoneCatalogEntry[]): SmartphoneCatalogEntry[] {
  return [...rows].sort((a, b) => {
    if (a.os_type !== b.os_type) return a.os_type.localeCompare(b.os_type);
    const brand = a.brand.localeCompare(b.brand);
    if (brand !== 0) return brand;
    if (a.os_type === 'ios') {
      const rank = modelRank(a) - modelRank(b);
      if (rank !== 0) return rank;
    }
    return (a.model_name ?? '').localeCompare(b.model_name ?? '', undefined, { numeric: true });
  });
}

export function useSmartphoneCatalog() {
  return useQuery({
    queryKey: SMARTPHONE_CATALOG_QUERY_KEY,
    queryFn: async (): Promise<SmartphoneCatalogEntry[]> => {
    const { data, error } = await db
      .from('smartphone_catalog')
      .select('id, brand, model_name, os_type, default_amount, specifications, more_specifications, is_active, supplier_id, supplier_name, supplier_phone, created_at')
      .order('os_type', { ascending: true })
      .order('brand', { ascending: true })
      .order('model_name', { ascending: true });

      if (error) throw error;
      return sortCatalogEntries((data || []) as SmartphoneCatalogEntry[]);
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

function osLabel(os: SmartphoneOsType): string {
  return os === 'ios' ? 'iPhone (iOS)' : 'Android';
}

function defaultOsForBrand(brand: string): SmartphoneOsType {
  const b = brand.trim().toLowerCase();
  return b === 'apple' || b === 'iphone' || b.startsWith('iphone') ? 'ios' : 'android';
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
  doc.text(
    'Amounts are the down payment Welile funds — not the full phone price. The balance is paid to the supplier directly.',
    margin,
    45,
  );

  autoTable(doc, {
    startY: 51,
    head: [['Brand', 'Model', 'Specifications', 'More specifications', 'Down payment (Welile)', 'Status', 'Added']],
    body: rows.map((r) => [
      r.brand,
      r.model_name || 'Any model',
      r.specifications || '—',
      r.more_specifications || '—',
      r.default_amount != null ? formatUGX(Number(r.default_amount)) : '—',
      r.is_active ? 'Active' : 'Inactive',
      fmtDate(r.created_at),
    ]),
    styles: { fontSize: 8.5, cellPadding: 2 },
    headStyles: { fillColor: [79, 70, 229], textColor: 255, fontStyle: 'bold' },
    margin: { left: margin, right: margin },
    columnStyles: { 2: { cellWidth: 'auto' }, 3: { cellWidth: 'auto' } },
  });


  doc.save(`welile-smartphone-catalog-${new Date().toISOString().slice(0, 10)}.pdf`);
}

const NEW_BRAND = '__new__';

export interface SupplierChoice {
  id: string;
  name: string;
  phone: string | null;
  /** Set when the picker is restricted to internal staff (bike suppliers). */
  roleLabel?: string | null;
}

const STAFF_ROLE_LABELS: Record<string, string> = {
  admin: 'Admin',
  ceo: 'CEO',
  coo: 'COO',
  cfo: 'CFO',
  cto: 'CTO',
  cmo: 'CMO',
  crm: 'CRM',
  manager: 'Manager',
  super_admin: 'Super Admin',
  employee: 'Staff',
  operations: 'Operations',
  hr: 'HR',
  access_admin: 'Access Admin',
  rd: 'R&D',
  tenant_ops: 'Tenant Ops',
  landlord_ops: 'Landlord Ops',
  agent_ops: 'Agent Ops',
  financial_ops: 'Financial Ops',
  partner_ops: 'Partner Ops',
};

/** Searchable picker over registered platform users acting as phone suppliers.
 *  With staffOnly, the search runs through the server-side candidates RPC so
 *  only internal company staff and operations team members are selectable. */
export function SupplierPicker({
  value,
  onChange,
  staffOnly = false,
}: {
  value: SupplierChoice | null;
  onChange: (s: SupplierChoice | null) => void;
  staffOnly?: boolean;
}) {
  const [term, setTerm] = useState('');
  const q = term.trim();

  const { data: results = [], isFetching } = useQuery({
    queryKey: staffOnly ? ['bike-supplier-search', q] : ['smartphone-supplier-search', q],
    enabled: q.length >= 2 && !value,
    queryFn: async (): Promise<SupplierChoice[]> => {
      if (staffOnly) {
        const { data, error } = await db.rpc('search_bike_supplier_candidates', { p_search: q });
        if (error) throw error;
        return (data || []).map((r: any) => ({
          id: r.user_id,
          name: r.full_name || 'Unnamed staff',
          phone: r.phone || null,
          roleLabel: Array.isArray(r.roles) && r.roles.length
            ? r.roles.map((x: string) => STAFF_ROLE_LABELS[x] || x).join(', ')
            : null,
        }));
      }
      // Match every typed word in any order ("Kalyango Timothy" finds
      // "TIMOTHY KALYANGO"); a phone typed as 07... also matches +2567...
      const words = q.replace(/[,()%*]/g, ' ').split(/\s+/).filter(Boolean);
      const digits = q.replace(/\D/g, '');
      let query = db.from('profiles').select('id, full_name, phone');
      if (digits.length >= 4 && digits.length === q.replace(/[\s+-]/g, '').length) {
        const local = digits.replace(/^(256|0)/, '');
        query = query.ilike('phone', `%${local}%`);
      } else {
        for (const w of words) query = query.ilike('full_name', `%${w}%`);
      }
      const { data, error } = await query.limit(15);
      if (error) throw error;
      return (data || []).map((p: any) => ({
        id: p.id,
        name: p.full_name || 'Unnamed user',
        phone: p.phone || null,
      }));
    },
  });

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{value.name}</p>
          <p className="truncate text-[11px] text-muted-foreground">{value.phone || 'No phone on file'}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2"
          onClick={() => {
            onChange(null);
            setTerm('');
          }}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder={staffOnly ? 'Search internal staff or ops member by name or phone' : 'Search supplier by name or phone'}
      />
      {q.length >= 2 && (
        <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border p-1">
          {isFetching ? (
            <p className="px-1.5 py-1 text-xs text-muted-foreground">Searching…</p>
          ) : results.length === 0 ? (
            <p className="px-1.5 py-1 text-xs text-muted-foreground">
              {staffOnly
                ? 'No internal staff or operations member matches that search.'
                : 'No registered user matches that search.'}
            </p>
          ) : (
            results.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => onChange(r)}
                className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-muted"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{r.name}</span>
                  {r.roleLabel && (
                    <span className="block truncate text-[10px] text-muted-foreground">{r.roleLabel}</span>
                  )}
                </span>
                <span className="shrink-0 text-muted-foreground">{r.phone || '—'}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface ModelRow {
  key: string;
  osType: SmartphoneOsType;
  modelName: string;
  amount: string;
  specifications: string;
  moreSpecifications: string;
}

function emptyRow(defaultOs: SmartphoneOsType = 'android'): ModelRow {
  return {
    key: Math.random().toString(36).slice(2),
    osType: defaultOs,
    modelName: '',
    amount: '',
    specifications: '',
    moreSpecifications: '',
  };
}

/** Agent Ops dialog to manage phone models agents can order. */
export function SmartphoneCatalogDialog() {

  const [open, setOpen] = useState(false);
  const [brandChoice, setBrandChoice] = useState<string>(NEW_BRAND);
  const [newBrand, setNewBrand] = useState('');
  const [osType, setOsType] = useState<SmartphoneOsType>('android');
  const [rows, setRows] = useState<ModelRow[]>([emptyRow('android')]);
  const [search, setSearch] = useState('');

  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editBrand, setEditBrand] = useState('');
  const [editModel, setEditModel] = useState('');
  const [editOsType, setEditOsType] = useState<SmartphoneOsType>('android');
  const [editAmount, setEditAmount] = useState('');
  const [editSpecifications, setEditSpecifications] = useState('');
  const [editMoreSpecifications, setEditMoreSpecifications] = useState('');
  const [pendingDelete, setPendingDelete] = useState<SmartphoneCatalogEntry | null>(null);
  const [supplier, setSupplier] = useState<SupplierChoice | null>(null);
  const [editSupplier, setEditSupplier] = useState<SupplierChoice | null>(null);

  const queryClient = useQueryClient();

  const { data: entries = [], isLoading } = useSmartphoneCatalog();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: SMARTPHONE_CATALOG_QUERY_KEY });
    // Brand inventory / products overview reads the catalog server-side too
    queryClient.invalidateQueries({ queryKey: ['agent-products-overview'], exact: false });
    queryClient.invalidateQueries({ queryKey: ['smartphone-order-queue'], exact: false });
  };

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

  /** Render-safe: never throws. Returns 0 for empty/invalid input. */
  const previewAmount = (raw: string): number => {
    const n = parseInt((raw || '').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  const parseAmount = (raw: string): number | null => {
    const t = raw.trim();
    if (!t) return null;
    const n = Math.max(0, parseInt(t, 10) || 0);
    if (n < 1000) throw new Error('Enter a default amount of at least UGX 1,000');
    return n;
  };


  const brands = useMemo(
    () => Array.from(new Set(entries.map((e) => e.brand.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [entries],
  );

  const effectiveBrand = brandChoice === NEW_BRAND ? newBrand : brandChoice;

  useEffect(() => {
    setOsType(defaultOsForBrand(effectiveBrand));
  }, [effectiveBrand]);

  const updateRow = (key: string, patch: Partial<ModelRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const addRow = () => setRows((prev) => [...prev, emptyRow(osType)]);
  const removeRow = (key: string) =>
    setRows((prev) => (prev.length === 1 ? [emptyRow()] : prev.filter((r) => r.key !== key)));

  const addEntry = useMutation({
    mutationFn: async () => {
      const b = effectiveBrand.trim();
      if (b.length < 2) throw new Error('Select an existing brand or enter a new one');

      const filled = rows.filter(
        (r) => r.modelName.trim() || r.amount.trim() || r.specifications.trim() || r.moreSpecifications.trim(),
      );
      const usable = filled.length > 0 ? filled : rows.slice(0, 1);

      const payload = usable.map((r) => {
        if (r.modelName.trim().length > 0 && r.modelName.trim().length < 2) {
          throw new Error('Model name is too short');
        }
        return {
          brand: b,
          model_name: r.modelName.trim() || null,
          os_type: r.osType,
          default_amount: parseAmount(r.amount),
          specifications: r.specifications.trim() || null,
          more_specifications: r.moreSpecifications.trim() || null,
          supplier_id: supplier?.id ?? null,
          supplier_name: supplier?.name ?? null,
          supplier_phone: supplier?.phone ?? null,
        };
      });

      const seen = new Set<string>();
      for (const p of payload) {
        const k = (p.model_name ?? '').toLowerCase();
        if (seen.has(k)) throw new Error(`Duplicate model in this form: ${p.model_name || 'any model'}`);
        seen.add(k);
      }

      const { error } = await db.from('smartphone_catalog').insert(payload);
      if (error) throw error;
      return payload.length;
    },
    onSuccess: (count) => {
      toast.success(count === 1 ? 'Phone added to catalog' : `${count} models added to catalog`);
      setRows([emptyRow()]);
      if (brandChoice === NEW_BRAND) setNewBrand('');
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
          os_type: editOsType,
          default_amount: total,
          specifications: editSpecifications.trim() || null,
          more_specifications: editMoreSpecifications.trim() || null,
          supplier_id: editSupplier?.id ?? null,
          supplier_name: editSupplier?.name ?? null,
          supplier_phone: editSupplier?.phone ?? null,
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
    mutationFn: async (entry: SmartphoneCatalogEntry) => {
      const { data, error } = await db
        .from('smartphone_catalog')
        .delete()
        .eq('id', entry.id)
        .select('id');
      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error('Nothing was deleted — you may not have permission to remove catalog models.');
      }
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
    setEditOsType(e.os_type ?? 'android');
    setEditAmount(e.default_amount != null ? String(Number(e.default_amount)) : '');
    setEditSpecifications(e.specifications ?? '');
    setEditMoreSpecifications(e.more_specifications ?? '');
  };


  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" className="gap-1.5">
            <Plus className="h-4 w-4" /> Manage Phone Catalog
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Smartphone className="h-4 w-4 text-primary" /> Smartphone catalog
            </DialogTitle>
          </DialogHeader>

          <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
            <p className="text-xs font-semibold">Amounts here are down payments</p>
            <p className="text-[11px] text-muted-foreground">
              Every amount below is the down payment Welile funds so the supplier releases the phone — not the full
              phone price. The agent pays the remaining balance to the supplier directly, on the supplier’s own
              repayment plan, outside Welile. iPhones are supplied by Mo Banja.
            </p>
          </div>

          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Brand</Label>
                <Select value={brandChoice} onValueChange={setBrandChoice}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a brand" />
                  </SelectTrigger>
                  <SelectContent>
                    {brands.map((b) => (
                      <SelectItem key={b} value={b}>
                        {b}
                      </SelectItem>
                    ))}
                    <SelectItem value={NEW_BRAND}>+ New brand…</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Operating system</Label>
                <Select value={osType} onValueChange={(v) => setOsType(v as SmartphoneOsType)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select OS" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="android">Android</SelectItem>
                    <SelectItem value="ios">iPhone (iOS)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {brandChoice === NEW_BRAND && (
                <div className="space-y-1">
                  <Label className="text-xs">New brand name</Label>
                  <Input value={newBrand} onChange={(e) => setNewBrand(e.target.value)} placeholder="e.g. Samsung" />
                </div>
              )}
            </div>

            <div className="space-y-2">
              {rows.map((row, idx) => (
                <div key={row.key} className="space-y-2 rounded-lg border bg-muted/30 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-muted-foreground">
                      {effectiveBrand.trim() ? `${effectiveBrand.trim()} · ` : ''}Model {idx + 1}
                    </p>
                    {rows.length > 1 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-destructive hover:text-destructive"
                        onClick={() => removeRow(row.key)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">
                        Model name <span className="text-muted-foreground font-normal">— optional</span>
                      </Label>
                      <Input
                        value={row.modelName}
                        onChange={(e) => updateRow(row.key, { modelName: e.target.value })}
                        placeholder="e.g. Galaxy A14"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Operating system</Label>
                      <Select
                        value={row.osType}
                        onValueChange={(v) => updateRow(row.key, { osType: v as SmartphoneOsType })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="android">Android</SelectItem>
                          <SelectItem value="ios">iPhone (iOS)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">
                        Down payment (UGX) <span className="text-muted-foreground font-normal">— optional</span>
                      </Label>
                      <Input
                        type="number"
                        min={1000}
                        step={1000}
                        inputMode="numeric"
                        value={row.amount}
                        onChange={(e) => updateRow(row.key, { amount: e.target.value })}
                        placeholder="e.g. 1200000"
                      />
                    </div>
                  </div>
                  {previewAmount(row.amount) > 0 && (
                    <div className="rounded-md border border-border bg-background/60 p-2">
                      <p className="text-[11px] font-medium text-muted-foreground mb-1.5">
                        Receivables preview — internal, not shown to agents
                      </p>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                        {smartphoneScheduleGrid(previewAmount(row.amount)).map((s) => (

                          <div key={s.months} className="rounded-md bg-muted/60 p-1.5 text-center">
                            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                              {s.months} months
                            </p>
                            <p className="text-sm font-semibold tabular-nums">{formatUGX(s.total)}</p>
                            <p className="text-[10px] text-muted-foreground tabular-nums">
                              {formatUGX(s.daily)} → {formatUGX(s.dailyLast)}/day · {s.days} days · 28%/month
                              reducing (+{s.markupPct}% total)
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">
                        Phone specifications <span className="text-muted-foreground font-normal">— optional</span>
                      </Label>
                      <textarea
                        value={row.specifications}
                        onChange={(e) => updateRow(row.key, { specifications: e.target.value })}
                        placeholder={'e.g. 6.5" display, 128GB storage, 4GB RAM, Black'}
                        rows={2}
                        className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-none"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">
                        More specifications <span className="text-muted-foreground font-normal">— optional</span>
                      </Label>
                      <textarea
                        value={row.moreSpecifications}
                        onChange={(e) => updateRow(row.key, { moreSpecifications: e.target.value })}
                        placeholder="e.g. Battery 5000mAh, dual SIM, 1 year warranty"
                        rows={2}
                        className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-none"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-col-reverse sm:flex-row sm:items-center gap-2">
              <Button variant="outline" className="gap-1.5 sm:w-auto" onClick={addRow}>
                <Plus className="h-4 w-4" /> Add another model
              </Button>
              <Button className="flex-1" onClick={() => addEntry.mutate()} disabled={addEntry.isPending}>
                {addEntry.isPending
                  ? 'Saving…'
                  : rows.length > 1
                    ? `Add ${rows.length} models to catalog`
                    : 'Add to catalog'}
              </Button>
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

          <div className="space-y-2 max-h-[32rem] overflow-y-auto">
            {isLoading ? (
              <p className="text-xs text-muted-foreground">Loading catalog…</p>
            ) : filtered.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {entries.length === 0 ? 'No phones registered yet.' : 'No phones match these filters.'}
              </p>
            ) : (
              filtered.map((e) => {
                const amount = Number(e.default_amount || 0);
                const schedule = amount > 0 ? smartphoneScheduleGrid(amount) : [];
                const isExpanded = expandedId === e.id;

                return editingId === e.id ? (
                  <div key={e.id} className="space-y-2 rounded-lg border p-3 bg-card shadow-xs">
                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                      <Input value={editBrand} onChange={(ev) => setEditBrand(ev.target.value)} placeholder="Brand" />
                      <Input value={editModel} onChange={(ev) => setEditModel(ev.target.value)} placeholder="Model (optional)" />
                      <Select value={editOsType} onValueChange={(v) => setEditOsType(v as SmartphoneOsType)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="android">Android</SelectItem>
                          <SelectItem value="ios">iPhone (iOS)</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        type="number"
                        min={1000}
                        step={1000}
                        inputMode="numeric"
                        value={editAmount}
                        onChange={(ev) => setEditAmount(ev.target.value)}
                        placeholder="Down payment"
                      />
                    </div>

                    {previewAmount(editAmount) > 0 && (
                      <div className="rounded-md border border-border bg-background/60 p-2">
                        <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground mb-1.5">
                          <span>Receivables &amp; Returns preview (28%/month reducing)</span>
                          <span className="font-semibold text-foreground">{formatUGX(previewAmount(editAmount))} down payment</span>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                          {smartphoneScheduleGrid(previewAmount(editAmount)).map((s) => {
                            const profit = Math.max(0, s.total - previewAmount(editAmount));
                            return (
                              <div key={s.months} className="rounded-md bg-muted/60 p-1.5 text-center">
                                <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-0.5">
                                  <span className="font-semibold text-foreground">{s.months}m</span>
                                  <span className="text-emerald-600 font-bold">+{s.markupPct}%</span>
                                </div>
                                <p className="text-xs font-bold tabular-nums text-foreground">{formatUGX(s.total)}</p>
                                <p className="text-[10px] text-emerald-600 font-medium tabular-nums">
                                  +{formatUGX(profit)} return
                                </p>
                                <p className="text-[9px] text-muted-foreground tabular-nums">
                                  {formatUGX(s.daily)}→{formatUGX(s.dailyLast)}/d
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <textarea
                      value={editSpecifications}
                      onChange={(ev) => setEditSpecifications(ev.target.value)}
                      placeholder="Phone specifications (optional)"
                      rows={2}
                      className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-none"
                    />
                    <textarea
                      value={editMoreSpecifications}
                      onChange={(ev) => setEditMoreSpecifications(ev.target.value)}
                      placeholder="More specifications (optional)"
                      rows={2}
                      className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-none"
                    />
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
                  <div
                    key={e.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setExpandedId((prev) => (prev === e.id ? null : e.id))}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault();
                        setExpandedId((prev) => (prev === e.id ? null : e.id));
                      }
                    }}
                    className={`flex flex-col gap-2 rounded-lg border p-2 cursor-pointer transition-colors hover:bg-muted/40 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      isExpanded ? 'border-primary/50 bg-muted/20 shadow-xs' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">{labelOf(e)}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {e.os_type ? osLabel(e.os_type) : 'Phone'}
                          {' · '}
                          {amount > 0
                            ? `${formatUGX(amount)} ${downPaymentCopy(e.brand, e.model_name).amountLabelShort.toLowerCase()}`
                            : 'No down payment set'}
                          {' · added '}
                          {fmtDate(e.created_at)}
                        </p>
                        {(e.specifications || e.more_specifications) && (
                          <p className="truncate text-xs text-muted-foreground mt-0.5">
                            {[e.specifications, e.more_specifications].filter(Boolean).join(' · ')}
                          </p>
                        )}
                      </div>
                      <div
                        className="flex shrink-0 items-center gap-1.5"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        <Badge variant={e.is_active ? 'default' : 'secondary'} className="text-[10px]">
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
                        <div className="text-muted-foreground/60 pl-0.5 pointer-events-none">
                          <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${isExpanded ? 'rotate-180 text-primary' : ''}`} />
                        </div>
                      </div>
                    </div>

                    {/* Projections Breakdown — ONLY visible when the card is expanded */}
                    {isExpanded && (
                      <div
                        className="rounded-md bg-muted/40 border border-border/50 p-2 space-y-1.5 mt-0.5 animate-in fade-in-50 duration-150"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                          <span className="font-semibold text-foreground">
                            Recovery Projections &amp; Returns
                          </span>
                          <span>28%/mo reducing balance</span>
                        </div>
                        {amount > 0 ? (
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                            {schedule.map((s) => {
                              const profit = Math.max(0, s.total - amount);
                              return (
                                <div
                                  key={s.months}
                                  className="rounded bg-background/90 border border-border/60 p-1.5 text-center shadow-2xs"
                                >
                                  <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-0.5">
                                    <span className="font-semibold text-foreground">{s.months} mos</span>
                                    <span className="text-emerald-600 font-bold">+{s.markupPct}%</span>
                                  </div>
                                  <p className="text-xs font-bold tabular-nums text-foreground">{formatUGX(s.total)}</p>
                                  <p className="text-[10px] font-semibold text-emerald-600 tabular-nums">
                                    +{formatUGX(profit)} return
                                  </p>
                                  <p className="text-[9px] text-muted-foreground tabular-nums truncate">
                                    {formatUGX(s.daily)}→{formatUGX(s.dailyLast)}/d
                                  </p>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="flex items-center justify-between text-xs py-1 px-1">
                            <span className="text-muted-foreground italic text-[11px]">No down payment set for this model.</span>
                            <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => startEdit(e)}>
                              <Pencil className="h-3 w-3" /> Set down payment
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
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
              onClick={() => pendingDelete && removeEntry.mutate(pendingDelete)}
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
