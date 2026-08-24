import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, Smartphone } from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';

const db = supabase as any;

export interface SmartphoneCatalogEntry {
  id: string;
  brand: string;
  model_name: string;
  default_amount: number;
  is_active: boolean;
}

export const SMARTPHONE_CATALOG_QUERY_KEY = ['smartphone-catalog'];

export function useSmartphoneCatalog() {
  return useQuery({
    queryKey: SMARTPHONE_CATALOG_QUERY_KEY,
    queryFn: async (): Promise<SmartphoneCatalogEntry[]> => {
      const { data, error } = await db
        .from('smartphone_catalog')
        .select('id, brand, model_name, default_amount, is_active')
        .order('brand', { ascending: true })
        .order('model_name', { ascending: true });
      if (error) throw error;
      return (data || []) as SmartphoneCatalogEntry[];
    },
  });
}

/** Agent Ops dialog to register phone models agents can order. */
export function SmartphoneCatalogDialog() {
  const [open, setOpen] = useState(false);
  const [brand, setBrand] = useState('');
  const [modelName, setModelName] = useState('');
  const [amount, setAmount] = useState('');
  const queryClient = useQueryClient();

  const { data: entries = [], isLoading } = useSmartphoneCatalog();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: SMARTPHONE_CATALOG_QUERY_KEY });

  const addEntry = useMutation({
    mutationFn: async () => {
      const total = Math.max(0, parseInt(amount || '0', 10) || 0);
      if (brand.trim().length < 2) throw new Error('Enter a brand');
      if (modelName.trim().length < 2) throw new Error('Enter a model name');
      if (total < 1000) throw new Error('Enter a default amount of at least UGX 1,000');
      const { error } = await db.from('smartphone_catalog').insert({
        brand: brand.trim(),
        model_name: modelName.trim(),
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

  const removeEntry = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db.from('smartphone_catalog').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Phone removed');
      invalidate();
    },
    onError: (e: any) => toast.error(e.message || 'Could not remove phone'),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-1.5">
          <Plus className="h-4 w-4" /> Add Phone to Catalog
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-primary" /> Smartphone catalog
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Brand</Label>
              <Input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="e.g. Samsung" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Model name</Label>
              <Input value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="e.g. Galaxy A14" />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Default amount (UGX)</Label>
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
          <Button
            className="w-full"
            onClick={() => addEntry.mutate()}
            disabled={addEntry.isPending}
          >
            {addEntry.isPending ? 'Saving…' : 'Add to catalog'}
          </Button>
        </div>

        <div className="mt-2 space-y-2 max-h-64 overflow-y-auto">
          {isLoading ? (
            <p className="text-xs text-muted-foreground">Loading catalog…</p>
          ) : entries.length === 0 ? (
            <p className="text-xs text-muted-foreground">No phones registered yet.</p>
          ) : (
            entries.map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-2 rounded-lg border p-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{e.brand} · {e.model_name}</p>
                  <p className="text-xs text-muted-foreground">{formatUGX(Number(e.default_amount))}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  {!e.is_active && <Badge variant="secondary">inactive</Badge>}
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => removeEntry.mutate(e.id)}
                    disabled={removeEntry.isPending}
                    aria-label={`Remove ${e.brand} ${e.model_name}`}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
