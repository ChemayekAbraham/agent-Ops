import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, Bike, Pencil, Power, Check, Loader2, Sparkles, Save } from 'lucide-react';

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
import { spiroLeaseGrid, SPIRO_BIKE_BASE_PRICE, SPIRO_LEASE_PERIODS } from '@/lib/spiroBikeLease';

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
    unit_cost: 150_000,
    description: 'Flagship electric delivery motorbike with dual swappable battery configuration.',
    is_active: true,
  },
  {
    item_name: 'Spiro Ekocycle',
    unit_price: 145_000,
    unit_cost: 135_000,
    description: 'Lightweight urban electric bike optimized for local errands and fast dispatch.',
    is_active: true,
  },
  {
    item_name: 'Spiro Commando',
    unit_price: 185_000,
    unit_cost: 170_000,
    description: 'Heavy-duty long-range electric bike built for rural routes and heavier utility loads.',
    is_active: true,
  },
  {
    item_name: 'Spiro bike',
    unit_price: 159_600,
    unit_cost: 150_000,
    description: 'Standard Spiro electric commercial lease model.',
    is_active: true,
  },
];

/**
 * Shared hook to get active and all motorbike catalog items with automatic baseline seed.
 */
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

      // Merge with defaults: ensure all baseline Spiro models are always present
      // even if they haven't yet been seeded into the DB.
      const merged: MotorBikeCatalogItem[] = [...rows];
      for (const def of DEFAULT_MOTORBIKES) {
        const found = merged.find((m) => m.item_name.toLowerCase() === def.item_name.toLowerCase());
        if (!found) {
          merged.push({
            id: `default-${def.item_name.toLowerCase().replace(/\s+/g, '-')}`,
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
  const [addMode, setAddMode] = useState(false);
  const [editItem, setEditItem] = useState<MotorBikeCatalogItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MotorBikeCatalogItem | null>(null);

  // Form states for Add / Edit
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [cost, setCost] = useState('');
  const [desc, setDesc] = useState('');
  const [isActive, setIsActive] = useState(true);

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
  };

  const openEdit = (item: MotorBikeCatalogItem) => {
    setEditItem(item);
    setName(item.item_name);
    setPrice(String(Math.round(item.unit_price || 0)));
    setCost(String(Math.round(item.unit_cost || 0)));
    setDesc(item.description || '');
    setIsActive(item.is_active);
    setAddMode(false);
  };

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: MOTORBIKE_CATALOG_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: ['merchandise-catalog'] });
    queryClient.invalidateQueries({ queryKey: ['merchandise-catalog-admin'] });
    queryClient.invalidateQueries({ queryKey: ['agent-products-overview'] });
  };

  // Upsert bike into merchandise_catalog
  const saveItem = useMutation({
    mutationFn: async () => {
      const cleanName = name.trim();
      if (!cleanName) throw new Error('Bike model name is required');
      const numPrice = Math.max(0, Math.round(Number(price) || 0));
      if (numPrice <= 0) throw new Error('Base valuation / price must be greater than zero');
      const numCost = Math.max(0, Math.round(Number(cost) || numPrice));

      if (editItem && !editItem.id.startsWith('default-')) {
        const { error } = await db
          .from('merchandise_catalog')
          .update({
            item_name: cleanName,
            unit_price: numPrice,
            unit_cost: numCost,
            description: desc.trim() || null,
            is_active: isActive,
            updated_at: new Date().toISOString(),
          })
          .eq('id', editItem.id);
        if (error) throw error;
      } else {
        const { error } = await db.from('merchandise_catalog').insert({
          item_name: cleanName,
          unit_price: numPrice,
          unit_cost: numCost,
          description: desc.trim() || null,
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
        const { error } = await db.from('merchandise_catalog').insert({
          item_name: item.item_name,
          unit_price: newPrice,
          unit_cost: item.unit_cost || newPrice,
          description: item.description,
          is_active: item.is_active,
        });
        if (error) throw error;
      } else {
        const { error } = await db
          .from('merchandise_catalog')
          .update({
            unit_price: newPrice,
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
      if (!item.id.startsWith('default-')) {
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

  return (
    <>
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
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">
                    Calculated Lease Repayment Grid (Base {formatUGX(previewBasePrice)})
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                    {leaseSchedulePreview.map((tier) => (
                      <div key={tier.months} className="rounded-md border bg-muted/40 p-2 space-y-1">
                        <p className="font-semibold text-primary">{tier.months} Months ({tier.feePct}% fee)</p>
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
                      </div>
                    ))}
                  </div>
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
