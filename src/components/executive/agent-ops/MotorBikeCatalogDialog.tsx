import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, Bike, Pencil, Power, Check, Loader2, Sparkles, Save, Layers, ChevronDown } from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
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
import { Textarea } from '@/components/ui/textarea';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { spiroLeaseGrid, SPIRO_LEASE_PERIODS } from '@/lib/spiroBikeLease';

const db = supabase as any;

export interface MotorBikeCatalogItem {
  id: string;
  item_name: string;
  unit_price: number;
  unit_cost: number;
  description: string | null;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
}

export const MOTORBIKE_CATALOG_QUERY_KEY = ['motorbike-catalog-management'];

// Baseline existing Spiro models guaranteed to be available
export const DEFAULT_MOTORBIKES: Omit<MotorBikeCatalogItem, 'id'>[] = [
  {
    item_name: 'Spiro Ekoride',
    unit_price: 159_600,
    unit_cost: 159_600,
    description: 'Flagship electric delivery motorbike with dual swappable battery configuration.',
    is_active: true,
  },
  {
    item_name: 'Spiro Ekocycle',
    unit_price: 145_000,
    unit_cost: 145_000,
    description: 'Lightweight urban electric bike optimized for local errands and fast dispatch.',
    is_active: true,
  },
  {
    item_name: 'Spiro Commando',
    unit_price: 185_000,
    unit_cost: 185_000,
    description: 'Heavy-duty long-range electric bike built for rural routes and heavier utility loads.',
    is_active: true,
  },
  {
    item_name: 'Spiro bike',
    unit_price: 159_600,
    unit_cost: 159_600,
    description: 'Standard Spiro electric commercial lease model.',
    is_active: true,
  },
];

/**
 * Shared hook to get active and all motorbike catalog items with automatic baseline seed.
 */
/** Sentinel stored in description to mark catalog rows owned by this dialog. */
export const MOTOR_BIKE_SENTINEL = '[motor_bike]';

/** Sentinel prefix for disabled lease terms stored in description e.g. [disabled_terms:1,3] */
const DISABLED_TERMS_REGEX = /\[disabled_terms:([0-9,]+)\]/;

export function parseDisabledTerms(desc: string | null | undefined): Set<number> {
  if (!desc) return new Set();
  const match = desc.match(DISABLED_TERMS_REGEX);
  if (!match) return new Set();
  const nums = match[1]
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n) && n > 0 && n <= 24);
  return new Set(nums);
}

export const MOTOR_BIKE_DELETED_SENTINEL = '[deleted]';

export function cleanDescription(desc: string | null | undefined): string {
  if (!desc) return '';
  return desc
    .replace(/\[motor_bike\]/g, '')
    .replace(/\[deleted\]/g, '')
    .replace(/\[disabled_terms:[0-9,]+\]/g, '')
    .trim();
}

export function buildTaggedDescription(rawDesc: string | null | undefined, disabledTerms?: Set<number>): string {
  const base = cleanDescription(rawDesc);
  const parts: string[] = [];
  if (base) parts.push(base);
  parts.push(MOTOR_BIKE_SENTINEL);
  if (disabledTerms && disabledTerms.size > 0) {
    const sorted = Array.from(disabledTerms).sort((a, b) => a - b);
    parts.push(`[disabled_terms:${sorted.join(',')}]`);
  }
  return parts.join(' ');
}

/** Precise bike model keywords and whole-word regex. */
const BIKE_MODEL_WORDS = /\b(spiro|ekoride|ekocycle|commando|mocoo|ebike|motorcycle|motorbike|boda)\b/i;

/** Exclude apparel, accessories, stationery, electronics and office gear. */
const NON_BIKE_EXCLUSIONS = /\b(jacket|helmet|glove|polo|shirt|jumper|lock|kettle|motorola|phone|smartphone|laptop|signage|board|chair|table|id|evidence|accessory|parts|tyre|tire)\b/i;

function isMotorBikeRow(row: MotorBikeCatalogItem): boolean {
  const desc = (row.description || '').toLowerCase();
  const name = (row.item_name || '').toLowerCase();

  // Exclude soft-deleted rows
  if (desc.includes(MOTOR_BIKE_DELETED_SENTINEL)) return false;

  // Explicitly tagged as a motorbike by this dialog
  if (desc.includes(MOTOR_BIKE_SENTINEL)) return true;

  // Never match apparel, accessories, phones, or non-vehicle merchandise
  if (NON_BIKE_EXCLUSIONS.test(name) || NON_BIKE_EXCLUSIONS.test(desc)) return false;

  // Match genuine bike vehicles by model/vehicle keywords
  if (BIKE_MODEL_WORDS.test(name)) return true;
  if (/\bbike\b/i.test(name)) return true;

  return false;
}

export function useMotorBikeCatalog() {
  return useQuery<MotorBikeCatalogItem[]>({
    queryKey: MOTORBIKE_CATALOG_QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await db
        .from('merchandise_catalog')
        .select('*')
        .order('item_name', { ascending: true });

      if (error) {
        console.warn('Could not fetch merchandise_catalog directly, falling back to defaults:', error.message);
        return DEFAULT_MOTORBIKES.map((b, i) => ({ ...b, id: `default-${i}` }));
      }

      const rows: MotorBikeCatalogItem[] = (data || []) as MotorBikeCatalogItem[];

      // Track all names present in the database (including soft-deleted ones) so deleted defaults are not re-seeded
      const existingDbNames = new Set(
        rows.map((r) => r.item_name.toLowerCase().trim())
      );

      // Only keep rows that are motor bikes (sentinel or keyword match, not deleted).
      const bikeRows = rows.filter(isMotorBikeRow);

      // Merge defaults: only inject baseline models that do NOT already exist in db
      const merged: MotorBikeCatalogItem[] = [...bikeRows];
      for (const def of DEFAULT_MOTORBIKES) {
        const nameKey = def.item_name.toLowerCase().trim();
        if (!existingDbNames.has(nameKey)) {
          merged.push({
            id: `default-${nameKey.replace(/\s+/g, '-')}`,
            ...def,
          });
        }
      }

      return merged;
    },
    staleTime: 30_000,
  });
}

export function MotorBikeCatalogDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [addMode, setAddMode] = useState(false);
  const [editItem, setEditItem] = useState<MotorBikeCatalogItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MotorBikeCatalogItem | null>(null);

  // Overview query to fetch live catalog inventory breakdown for motor bikes
  const { data: overviewData, isLoading: isOverviewLoading } = useQuery({
    queryKey: ['agent-products-overview', 'motor_bike'],
    queryFn: async () => {
      const { data, error } = await db.rpc('get_agent_products_overview', { p_category: 'motor_bike' });
      if (error) throw error;
      return (data ?? {}) as any;
    },
    staleTime: 60_000,
  });

  const breakdown: {
    label: string;
    issued_qty: number;
    issued_value: number;
    outstanding: number;
    reference_price?: number;
    models?: number;
  }[] = overviewData?.breakdown ?? [];

  const totalIssued = useMemo(
    () => breakdown.reduce((sum, b) => sum + Number(b.issued_qty || 0), 0),
    [breakdown]
  );
  const totalValue = useMemo(
    () => breakdown.reduce((sum, b) => sum + Number(b.issued_value || 0), 0),
    [breakdown]
  );
  const totalOutstanding = useMemo(
    () => breakdown.reduce((sum, b) => sum + Number(b.outstanding || 0), 0),
    [breakdown]
  );

  // Form states for Add / Edit
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [cost, setCost] = useState('');
  const [desc, setDesc] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [disabledPeriods, setDisabledPeriods] = useState<Set<number>>(new Set());

  // Quick inline price editor map: { [bikeId]: string }
  const [inlinePrices, setInlinePrices] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const { data: catalog = [], isLoading } = useMotorBikeCatalog();

  // Keep inline prices in sync with catalog
  useEffect(() => {
    const map: Record<string, string> = {};
    catalog.forEach((b) => {
      map[b.id] = String(Math.round(b.unit_price || 0));
    });
    setInlinePrices(map);
  }, [catalog]);

  const resetForm = () => {
    setName('');
    setPrice('');
    setCost('');
    setDesc('');
    setIsActive(true);
    setAddMode(false);
    setEditItem(null);
    setDisabledPeriods(new Set());
  };

  const openEdit = (item: MotorBikeCatalogItem) => {
    setEditItem(item);
    setName(item.item_name);
    setPrice(String(Math.round(item.unit_price || 0)));
    setCost(String(Math.round(item.unit_cost || 0)));
    setDesc(cleanDescription(item.description));
    setIsActive(item.is_active);
    setDisabledPeriods(parseDisabledTerms(item.description));
    setAddMode(false);
  };

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: MOTORBIKE_CATALOG_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: ['merchandise-catalog'] });
    queryClient.invalidateQueries({ queryKey: ['merchandise-catalog-admin'] });
    queryClient.invalidateQueries({ queryKey: ['agent-products-overview'] });
    queryClient.invalidateQueries({ queryKey: ['bike-catalog-costs'] });
  };

  // Upsert bike into merchandise_catalog
  const saveItem = useMutation({
    mutationFn: async () => {
      const cleanName = name.trim();
      if (!cleanName) throw new Error('Bike model name is required');
      const numPrice = Math.max(0, Math.round(Number(price) || 0));
      if (numPrice <= 0) throw new Error('Base valuation / price must be greater than zero');
      const numCost = Math.max(0, Math.round(Number(cost) || numPrice));

      // If re-adding/updating, check if a row with this name already exists in DB
      const { data: existing } = await db
        .from('merchandise_catalog')
        .select('id')
        .ilike('item_name', cleanName)
        .maybeSingle();

      const targetId = editItem && !editItem.id.startsWith('default-') ? editItem.id : existing?.id;

      if (targetId) {
        const { error } = await db
          .from('merchandise_catalog')
          .update({
            item_name: cleanName,
            unit_price: numPrice,
            unit_cost: numCost,
            description: buildTaggedDescription(desc.trim() || null, disabledPeriods),
            is_active: isActive,
            updated_at: new Date().toISOString(),
          })
          .eq('id', targetId);
        if (error) throw error;
      } else {
        const { error } = await db.from('merchandise_catalog').insert({
          item_name: cleanName,
          unit_price: numPrice,
          unit_cost: numCost,
          description: buildTaggedDescription(desc.trim() || null, disabledPeriods),
          is_active: isActive,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(editItem ? 'Bike model updated' : 'New bike model added to catalog');
      resetForm();
      invalidate();
    },
    onError: (err: any) => toast.error(err.message || 'Could not save bike model'),
  });

  // Quick inline price saver
  const saveInlinePrice = async (item: MotorBikeCatalogItem) => {
    const rawVal = inlinePrices[item.id];
    const newPrice = Math.max(0, Math.round(Number(rawVal) || 0));
    if (newPrice <= 0) {
      toast.error('Price must be greater than zero');
      return;
    }

    setSavingId(item.id);
    try {
      if (item.id.startsWith('default-')) {
        const baseDesc = (item.description || '').replace(MOTOR_BIKE_SENTINEL, '').trim();
        const { error } = await db.from('merchandise_catalog').insert({
          item_name: item.item_name,
          unit_price: newPrice,
          unit_cost: newPrice,
          description: baseDesc ? `${baseDesc} ${MOTOR_BIKE_SENTINEL}` : MOTOR_BIKE_SENTINEL,
          is_active: item.is_active,
        });
        if (error) throw error;
      } else {
        const { error } = await db
          .from('merchandise_catalog')
          .update({
            unit_price: newPrice,
            unit_cost: newPrice,
            updated_at: new Date().toISOString(),
          })
          .eq('id', item.id);
        if (error) throw error;
      }
      toast.success(`${item.item_name} price updated to ${formatUGX(newPrice)}`);
      invalidate();
    } catch (err: any) {
      toast.error(err.message || 'Could not update price');
    } finally {
      setSavingId(null);
    }
  };

  const toggleActive = useMutation({
    mutationFn: async (item: MotorBikeCatalogItem) => {
      if (!item.id.startsWith('default-')) {
        const { error } = await db
          .from('merchandise_catalog')
          .update({ is_active: !item.is_active, updated_at: new Date().toISOString() })
          .eq('id', item.id);
        if (error) throw error;
      } else {
        const { error } = await db.from('merchandise_catalog').insert({
          item_name: item.item_name,
          unit_price: item.unit_price,
          unit_cost: item.unit_cost || 100_000,
          description: item.description,
          is_active: !item.is_active,
        });
        if (error) throw error;
      }
    },
    onSuccess: (_, item) => {
      toast.success(item.is_active ? 'Bike hidden from order catalog' : 'Bike enabled in catalog');
      invalidate();
    },
    onError: (err: any) => toast.error(err.message || 'Could not update bike status'),
  });

  const deleteItem = useMutation({
    mutationFn: async (item: MotorBikeCatalogItem) => {
      const isDefault = item.id.startsWith('default-');
      const isDefaultName = DEFAULT_MOTORBIKES.some(
        (d) => d.item_name.toLowerCase().trim() === item.item_name.toLowerCase().trim()
      );

      if (isDefault) {
        // Built-in model with no DB row yet: insert a soft-deleted row so it stays permanently removed
        const { error } = await db.from('merchandise_catalog').insert({
          item_name: item.item_name,
          unit_price: item.unit_price,
          unit_cost: item.unit_cost || item.unit_price,
          description: `${MOTOR_BIKE_SENTINEL} ${MOTOR_BIKE_DELETED_SENTINEL}`,
          is_active: false,
        });
        if (error) throw error;
      } else if (isDefaultName) {
        // Built-in model that has a DB row: update description to include [deleted] and deactivate
        const cleanDesc = (item.description || '').replace(MOTOR_BIKE_DELETED_SENTINEL, '').trim();
        const { error } = await db
          .from('merchandise_catalog')
          .update({
            description: `${cleanDesc} ${MOTOR_BIKE_DELETED_SENTINEL}`.trim(),
            is_active: false,
            updated_at: new Date().toISOString(),
          })
          .eq('id', item.id);
        if (error) throw error;
      } else {
        // Custom model: delete row completely
        const { error } = await db.from('merchandise_catalog').delete().eq('id', item.id);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success('Bike model removed from catalog');
      setDeleteTarget(null);
      invalidate();
    },
    onError: (err: any) => toast.error(err.message || 'Could not delete bike model'),
  });

  const previewBasePrice = Math.max(0, Math.round(Number(price) || 0));
  const leaseSchedulePreview = useMemo(() => {
    if (previewBasePrice <= 0) return null;
    return spiroLeaseGrid(previewBasePrice);
  }, [previewBasePrice]);

  // Periods the manager has toggled off for this bike
  const togglePeriod = (months: number) => {
    setDisabledPeriods((prev) => {
      const next = new Set(prev);
      if (next.has(months)) {
        next.delete(months);
      } else {
        next.add(months);
      }
      return next;
    });
  };

  return (
    <>
      <div className="inline-flex items-center gap-2">
        {/* Quick Popover for live catalog inventory in button area */}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 h-9 text-xs sm:text-sm font-medium border-border hover:bg-muted/50"
              title="Click to view live catalog inventory breakdown"
            >
              <Layers className="h-4 w-4 text-primary" />
              <span className="hidden sm:inline">Catalog</span> Inventory
              {totalIssued > 0 && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                  {totalIssued}
                </Badge>
              )}
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground ml-0.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 sm:w-96 p-0 shadow-lg border-border" align="end">
            <div className="p-3 border-b border-border bg-muted/30">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Layers className="h-4 w-4 text-primary" />
                  <p className="text-xs font-bold text-foreground">Catalog Inventory</p>
                </div>
                <Badge variant="secondary" className="text-[10px]">
                  {totalIssued} issued
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Live breakdown of motor bikes issued to agents
              </p>
            </div>
            <div className="p-2 grid grid-cols-2 gap-1.5 bg-muted/10 border-b border-border text-[11px]">
              <div className="rounded border bg-background p-1.5">
                <span className="text-[10px] text-muted-foreground block">Fleet Value</span>
                <span className="font-bold text-foreground tabular-nums">{formatUGX(totalValue)}</span>
              </div>
              <div className="rounded border bg-background p-1.5">
                <span className="text-[10px] text-muted-foreground block">Outstanding</span>
                <span className="font-bold text-destructive tabular-nums">{formatUGX(totalOutstanding)}</span>
              </div>
            </div>
            <div className="max-h-64 overflow-y-auto divide-y divide-border">
              {isOverviewLoading && breakdown.length === 0 ? (
                <div className="p-3 space-y-2">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : breakdown.length === 0 ? (
                <p className="p-4 text-xs text-muted-foreground text-center">No catalog items issued yet.</p>
              ) : (
                breakdown.map((b) => (
                  <div key={b.label} className="p-2.5 space-y-1 hover:bg-muted/20 transition-colors">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold truncate text-foreground">{b.label}</p>
                      <span className="text-[11px] font-medium tabular-nums">{Number(b.issued_qty || 0)} issued</span>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                      <span>Ref: {formatUGX(Number(b.reference_price || 0))}</span>
                      <span>Value: {formatUGX(Number(b.issued_value || 0))}</span>
                      <span className="text-destructive font-medium">Out: {formatUGX(Number(b.outstanding || 0))}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </PopoverContent>
        </Popover>

        <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetForm(); }}>
          <DialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="gap-2 h-9 text-xs sm:text-sm font-semibold border-primary/30 text-primary hover:bg-primary/10 transition-colors"
            >
              <Bike className="h-4 w-4 text-primary" />
              Manage Bike Catalog
            </Button>
          </DialogTrigger>

          <DialogContent
            className={cn(
              'app-dialog-bottom-sheet',
              '!left-0 !right-0 !top-auto !bottom-0',
              '!translate-x-0 !translate-y-0',
              '!max-w-none !w-full',
              '!rounded-t-3xl !rounded-b-none',
              '!p-0 !gap-0',
              'h-[90dvh] max-h-[90dvh]',
              'flex flex-col overflow-hidden',
              'pointer-events-auto',
              'sm:!left-[50%] sm:!top-[50%] sm:!bottom-auto sm:!right-auto',
              'sm:!translate-x-[-50%] sm:!translate-y-[-50%]',
              'sm:!max-w-3xl sm:!w-full',
              'sm:!rounded-2xl',
              'sm:h-auto sm:max-h-[92dvh]'
            )}
          >
            <div className="sm:hidden flex justify-center pt-2.5 pb-1 shrink-0">
              <div className="h-1.5 w-12 rounded-full bg-muted-foreground/30" />
            </div>
            <DialogHeader className="px-4 sm:px-6 pt-2 sm:pt-4 pb-3 border-b border-border/50 shrink-0 pr-12 sm:pr-10 text-left">
              <div className="flex items-center justify-between gap-2">
                <DialogTitle className="flex items-center gap-2.5 text-base sm:text-lg font-bold">
                  <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center border border-primary/20">
                    <Bike className="h-4 w-4" />
                  </div>
                  Motor Bikes Catalog Management
                </DialogTitle>
                {!addMode && !editItem && (
                  <Button
                    size="sm"
                    className="hidden sm:flex h-8 gap-1.5 text-xs bg-primary hover:bg-primary/90 text-primary-foreground font-semibold shadow-sm"
                    onClick={() => { resetForm(); setAddMode(true); }}
                  >
                    <Plus className="h-3.5 w-3.5" /> Add New Bike
                  </Button>
                )}
              </div>
              <DialogDescription className="text-xs">
                View and edit baseline prices of existing motor bikes, configure repayment schedules, and add new models.
              </DialogDescription>
              {!addMode && !editItem && (
                <Button
                  size="sm"
                  className="sm:hidden mt-2 w-full h-9 gap-1.5 text-xs bg-primary hover:bg-primary/90 text-primary-foreground font-semibold shadow-sm"
                  onClick={() => { resetForm(); setAddMode(true); }}
                >
                  <Plus className="h-3.5 w-3.5" /> Add New Bike
                </Button>
              )}
            </DialogHeader>

            <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6 space-y-4 text-xs overscroll-contain">
              {/* COLLAPSIBLE CATALOG INVENTORY SECTION */}
              <Collapsible
                open={inventoryOpen}
                onOpenChange={setInventoryOpen}
                className="rounded-xl border border-primary/25 bg-primary/[0.03] overflow-hidden shadow-xs"
              >
                <CollapsibleTrigger asChild>
                  <Button
                    variant="ghost"
                    className="w-full flex items-center justify-between p-3.5 h-auto text-left hover:bg-primary/[0.07] rounded-none transition-colors"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0 border border-primary/20">
                        <Layers className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs sm:text-sm font-bold text-foreground">Catalog Inventory &amp; Field Breakdown</span>
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                            {totalIssued} issued
                          </Badge>
                        </div>
                        <p className="text-[11px] text-muted-foreground truncate">
                          Portfolio: {formatUGX(totalValue)} • Outstanding: {formatUGX(totalOutstanding)}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 text-muted-foreground shrink-0 ml-2">
                      <span className="text-[11px] hidden sm:inline font-medium text-primary">
                        {inventoryOpen ? 'Hide inventory' : 'View inventory'}
                      </span>
                      <ChevronDown className={cn("h-4 w-4 text-primary transition-transform duration-200", inventoryOpen && "rotate-180")} />
                    </div>
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="border-t border-primary/15 p-3 sm:p-4 space-y-3 bg-background/60">
                    <div className="grid grid-cols-3 gap-2">
                      <div className="rounded-lg border bg-card p-2 text-center shadow-xs">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total Issued</p>
                        <p className="text-sm sm:text-base font-bold text-foreground tabular-nums">
                          {totalIssued} units
                        </p>
                      </div>
                      <div className="rounded-lg border bg-card p-2 text-center shadow-xs">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Fleet Value</p>
                        <p className="text-sm sm:text-base font-bold text-foreground tabular-nums">
                          {formatUGX(totalValue)}
                        </p>
                      </div>
                      <div className="rounded-lg border bg-card p-2 text-center shadow-xs">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Outstanding</p>
                        <p className="text-sm sm:text-base font-bold text-destructive tabular-nums">
                          {formatUGX(totalOutstanding)}
                        </p>
                      </div>
                    </div>

                    {isOverviewLoading && breakdown.length === 0 ? (
                      <div className="p-3 space-y-2">
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                      </div>
                    ) : breakdown.length === 0 ? (
                      <p className="p-4 text-xs text-muted-foreground text-center">No issued catalog items yet.</p>
                    ) : (
                      <div className="divide-y divide-border rounded-lg border bg-card overflow-hidden">
                        {breakdown.map((b) => (
                          <div key={b.label} className="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 hover:bg-muted/30 transition-colors">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="text-xs sm:text-sm font-bold text-foreground truncate">{b.label}</p>
                                <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 bg-primary/5 text-primary border-primary/20">
                                  {Number(b.issued_qty || 0)} issued
                                </Badge>
                              </div>
                              <p className="text-[11px] text-muted-foreground">
                                Reference price: {formatUGX(Number(b.reference_price || 0))}
                              </p>
                            </div>
                            <div className="flex items-center gap-4 text-xs sm:text-right shrink-0">
                              <div>
                                <span className="text-[10px] text-muted-foreground block sm:inline mr-1">Issued Value:</span>
                                <span className="font-bold text-foreground tabular-nums">{formatUGX(Number(b.issued_value || 0))}</span>
                              </div>
                              <div>
                                <span className="text-[10px] text-muted-foreground block sm:inline mr-1">Outstanding:</span>
                                <span className="font-bold text-destructive tabular-nums">{formatUGX(Number(b.outstanding || 0))}</span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>

              {/* ADD / DETAILED EDIT FORM */}
            {(addMode || editItem) && (
              <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-4">
                <div className="flex items-center justify-between border-b border-primary/20 pb-2">
                  <h3 className="text-sm font-semibold flex items-center gap-2 text-primary">
                    {editItem ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                    {editItem ? `Edit Bike Details: ${editItem.item_name}` : 'Add New Motor Bike to Catalog'}
                  </h3>
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={resetForm}>
                    Cancel
                  </Button>
                </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs font-semibold">Bike Model Name *</Label>
                  <Input
                    placeholder="e.g. Spiro Ekoride, Spiro Ekocycle, Spiro Commando"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="h-9 text-xs"
                  />
                </div>

                <div className="space-y-1">
                  <Label className="text-xs font-semibold">Base Valuation / Price (UGX) *</Label>
                  <Input
                    type="number"
                    min={1000}
                    step={5000}
                    placeholder="e.g. 120000"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    className="h-9 text-xs font-semibold"
                  />
                  {previewBasePrice > 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      Base Valuation: <span className="font-bold text-primary">{formatUGX(previewBasePrice)}</span>
                    </p>
                  )}
                </div>

                <div className="space-y-1">
                  <Label className="text-xs font-semibold">Unit Cost (UGX, optional)</Label>
                  <Input
                    type="number"
                    min={0}
                    step={5000}
                    placeholder="e.g. 100000"
                    value={cost}
                    onChange={(e) => setCost(e.target.value)}
                    className="h-9 text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground">Company procurement / asset cost.</p>
                </div>

                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs font-semibold">Specifications &amp; Features</Label>
                  <Textarea
                    placeholder="e.g. Dual swappable battery, 85km range, 160kg cargo payload, off-road suspension"
                    value={desc}
                    onChange={(e) => setDesc(e.target.value)}
                    rows={2}
                    className="text-xs resize-none"
                  />
                </div>

                <div className="flex items-center justify-between rounded-lg border bg-background px-3 py-2 sm:col-span-2">
                  <div>
                    <p className="text-xs font-semibold">Active in Agent Order Store</p>
                    <p className="text-[11px] text-muted-foreground">
                      Available for agents to select when requesting a bike lease.
                    </p>
                  </div>
                  <Switch checked={isActive} onCheckedChange={setIsActive} />
                </div>
              </div>

              {/* Lease schedule projection preview */}
              {leaseSchedulePreview && (
                <div className="rounded-lg border bg-card p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">
                      Calculated Lease Repayment Grid (Base {formatUGX(previewBasePrice)})
                    </p>
                    {disabledPeriods.size > 0 && (
                      <button
                        type="button"
                        onClick={() => setDisabledPeriods(new Set())}
                        className="text-[10px] text-muted-foreground hover:text-primary underline"
                      >
                        Restore all
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                    {leaseSchedulePreview.map((tier) => {
                      const disabled = disabledPeriods.has(tier.months);
                      return (
                        <div
                          key={tier.months}
                          className={`rounded-md border p-2 space-y-1 transition-opacity ${
                            disabled
                              ? 'bg-muted/20 opacity-40'
                              : 'bg-muted/40'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <p className={`font-semibold text-primary text-[10px] leading-tight ${
                              disabled ? 'line-through text-muted-foreground' : ''
                            }`}>
                              {tier.months}m ({tier.feePct}% fee)
                            </p>
                            <button
                              type="button"
                              title={disabled ? 'Restore period' : 'Remove period'}
                              onClick={() => togglePeriod(tier.months)}
                              className={`shrink-0 rounded-full w-4 h-4 flex items-center justify-center text-[10px] font-bold transition-colors ${
                                disabled
                                  ? 'bg-emerald-500/20 text-emerald-600 hover:bg-emerald-500/30'
                                  : 'bg-destructive/15 text-destructive hover:bg-destructive/25'
                              }`}
                            >
                              {disabled ? '+' : '×'}
                            </button>
                          </div>
                          {!disabled && (
                            <>
                              <div className="flex justify-between text-muted-foreground">
                                <span>Total:</span>
                                <span className="font-semibold text-foreground">{formatUGX(tier.total)}</span>
                              </div>
                              <div className="flex justify-between text-muted-foreground">
                                <span>Monthly:</span>
                                <span className="font-medium text-foreground">{formatUGX(tier.monthly)}</span>
                              </div>
                              <div className="flex justify-between text-muted-foreground">
                                <span>Daily:</span>
                                <span className="font-medium text-foreground">{formatUGX(tier.daily)}</span>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {disabledPeriods.size > 0 && (
                    <p className="text-[10px] text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                      ⚠ {disabledPeriods.size} period{disabledPeriods.size > 1 ? 's' : ''} removed from this bike's order options.
                    </p>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <Button variant="outline" size="sm" className="h-8 text-xs" onClick={resetForm}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-8 text-xs bg-primary hover:bg-primary/90 text-primary-foreground font-semibold"
                  disabled={saveItem.isPending || !name.trim() || Number(price) <= 0}
                  onClick={() => saveItem.mutate()}
                >
                  {saveItem.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Check className="h-3.5 w-3.5 mr-1.5" />}
                  {editItem ? 'Save Changes' : 'Add to Catalog'}
                </Button>
              </div>
            </div>
          )}

          {/* EXISTING BIKES IN CATALOG WITH EDITABLE FIELDS */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Bike className="h-3.5 w-3.5 text-primary" />
                Existing Motor Bikes ({catalog.length})
              </span>
              <span className="text-[11px] text-muted-foreground">
                Edit prices directly in the fields below or click Edit for full specs
              </span>
            </div>

            {isLoading ? (
              <div className="py-8 text-center text-sm text-muted-foreground">Loading catalog…</div>
            ) : (
              <div className="space-y-2.5">
                {catalog.map((item) => {
                  const currentValuation = Number(inlinePrices[item.id] ?? item.unit_price);
                  const isDirty = inlinePrices[item.id] !== undefined && Number(inlinePrices[item.id]) !== item.unit_price;
                  const isPending = savingId === item.id;
                  const schedule = spiroLeaseGrid(currentValuation > 0 ? currentValuation : item.unit_price);

                  return (
                    <div
                      key={item.id}
                      className="rounded-xl border bg-card p-3.5 space-y-3 hover:border-primary/40 transition-colors shadow-sm"
                    >
                      {/* Top Header of the Bike Card */}
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                        <div className="space-y-0.5 min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-bold truncate text-foreground">{item.item_name}</p>
                            <Badge
                              variant="outline"
                              className={`text-[10px] px-1.5 py-0 ${
                                item.is_active
                                  ? 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30'
                                  : 'bg-muted text-muted-foreground'
                              }`}
                            >
                              {item.is_active ? 'Active in Store' : 'Hidden'}
                            </Badge>
                          </div>
                          {item.description && (
                            <p className="text-xs text-muted-foreground line-clamp-1">{item.description}</p>
                          )}
                        </div>

                        {/* Actions */}
                        <div className="flex items-center justify-center gap-1.5 shrink-0 self-center sm:self-center">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 px-2.5 text-xs gap-1 border-primary/30 text-primary hover:bg-primary/10"
                            onClick={() => openEdit(item)}
                          >
                            <Pencil className="h-3.5 w-3.5" /> Edit Details
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className={`h-8 px-2 text-xs gap-1 ${
                              item.is_active ? 'text-amber-600 hover:text-amber-700' : 'text-emerald-600 hover:text-emerald-700'
                            }`}
                            onClick={() => toggleActive.mutate(item)}
                          >
                            <Power className="h-3.5 w-3.5" />
                            {item.is_active ? 'Hide' : 'Show'}
                          </Button>
                          {!item.id.startsWith('default-') && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 text-destructive hover:bg-destructive/10"
                              onClick={() => setDeleteTarget(item)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>

                      {/* Editable Price Field Bar */}
                      <div className="rounded-lg border bg-muted/30 p-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="flex items-center gap-2 flex-1">
                          <Label className="text-xs font-semibold whitespace-nowrap text-muted-foreground">
                            Base Valuation:
                          </Label>
                          <div className="relative flex-1 max-w-xs">
                            <Input
                              type="number"
                              min={1000}
                              step={1000}
                              value={inlinePrices[item.id] ?? String(Math.round(item.unit_price))}
                              onChange={(e) =>
                                setInlinePrices((prev) => ({
                                  ...prev,
                                  [item.id]: e.target.value,
                                }))
                              }
                              className={`h-8 text-xs font-bold ${
                                isDirty ? 'border-primary ring-1 ring-primary/30 bg-primary/5' : ''
                              }`}
                            />
                          </div>
                          <span className="text-xs font-bold text-primary">
                            {formatUGX(currentValuation || 0)}
                          </span>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {isDirty && (
                            <Button
                              size="sm"
                              className="h-8 px-3 text-xs gap-1.5 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold shadow-sm"
                              disabled={isPending || currentValuation <= 0}
                              onClick={() =>
                                void saveInlinePrice(item)
                              }
                            >
                              {isPending ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Save className="h-3.5 w-3.5" />
                              )}
                              Save Price
                            </Button>
                          )}
                        </div>
                      </div>

                      {/* Repayment Breakdown Chips */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                        {schedule.map((tier) => (
                          <div
                            key={tier.months}
                            className="rounded-md border bg-background/80 px-2 py-1.5 space-y-0.5"
                          >
                            <p className="font-semibold text-primary">{tier.months}m ({tier.feePct}% fee)</p>
                            <p className="font-bold text-foreground">{formatUGX(tier.total)}</p>
                            <p className="text-[10px] text-muted-foreground">{formatUGX(tier.monthly)}/mo</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="p-3 sm:p-4 border-t bg-card/50 shrink-0 flex flex-col-reverse sm:flex-row items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground text-center sm:text-left">
              Prices apply to all agent bike lease orders and rent plans.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-9 text-xs w-full sm:w-auto justify-center"
              onClick={() => setOpen(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>

      {/* DELETE CONFIRMATION */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.item_name}?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              This will remove this model from the catalog. Existing applications already submitted will retain their recorded valuation.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteItem.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90 text-white"
              disabled={deleteItem.isPending}
              onClick={() => deleteTarget && deleteItem.mutate(deleteTarget)}
            >
              {deleteItem.isPending ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
