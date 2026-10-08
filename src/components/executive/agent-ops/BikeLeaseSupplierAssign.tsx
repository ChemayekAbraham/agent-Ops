import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Loader2, Pencil, Truck } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { SupplierPicker, type SupplierChoice } from './SmartphoneCatalogDialog';

const db = supabase as any;

export interface BikeLeaseSupplier {
  supplier_id: string;
  supplier_name: string | null;
  supplier_phone: string | null;
}

export function useBikeLeaseSupplier(saleId: string | null | undefined) {
  return useQuery({
    queryKey: ['bike-lease-supplier', saleId],
    enabled: !!saleId,
    queryFn: async (): Promise<BikeLeaseSupplier | null> => {
      const { data, error } = await db.rpc('get_bike_lease_suppliers', { p_sale_ids: [saleId] });
      if (error) throw error;
      return ((data || [])[0] as BikeLeaseSupplier) ?? null;
    },
  });
}

/** Assign the internal company supplier who buys the bike. The lease stays in the agent's name. */
export function BikeLeaseSupplierAssign({ saleId, locked }: { saleId: string; locked?: boolean }) {
  const qc = useQueryClient();
  const { data: supplier, isLoading } = useBikeLeaseSupplier(saleId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<SupplierChoice | null>(null);

  const save = useMutation({
    mutationFn: async (choice: SupplierChoice) => {
      const { error } = await db.rpc('assign_bike_lease_supplier', { p_sale_id: saleId, p_supplier_id: choice.id });
      if (error) throw error;
      return choice;
    },
    onSuccess: (c) => {
      toast.success(`Supplier set to ${c.name}`);
      setEditing(false);
      setDraft(null);
      qc.invalidateQueries({ queryKey: ['bike-lease-supplier', saleId] });
    },
    onError: (e: any) => toast.error(e.message || 'Could not assign the supplier'),
  });

  return (
    <div className="rounded-lg border px-3 py-2 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <Truck className="h-4 w-4 text-primary mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-xs font-semibold">Company supplier (receives bike funds)</p>
            <p className="text-[10px] text-muted-foreground">Only internal company staff and operations team members can be the supplier. The lease stays in the agent's name.</p>
          </div>
        </div>
        {!editing && !locked && (
          <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-[11px] gap-1"
            onClick={() => {
              setEditing(true);
              setDraft(supplier ? { id: supplier.supplier_id, name: supplier.supplier_name || '', phone: supplier.supplier_phone } : null);
            }}>
            <Pencil className="h-3 w-3" />{supplier ? 'Change' : 'Assign'}
          </Button>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <SupplierPicker value={draft} onChange={setDraft} staffOnly />
          <div className="flex gap-2">
            <Button type="button" size="sm" className="h-7 text-xs" disabled={!draft || save.isPending}
              onClick={() => draft && save.mutate(draft)}>
              {save.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1" />}
              Save supplier
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" disabled={save.isPending}
              onClick={() => { setEditing(false); setDraft(null); }}>
              Cancel
            </Button>
          </div>
        </div>
      ) : isLoading ? (
        <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</p>
      ) : supplier ? (
        <div className="bg-muted/40 rounded-md p-2">
          <p className="text-xs font-semibold truncate">{supplier.supplier_name || 'Registered supplier'}</p>
          {supplier.supplier_phone && <p className="text-[10px] text-muted-foreground">{supplier.supplier_phone}</p>}
        </div>
      ) : (
        <p className="text-[11px] text-destructive">No supplier assigned yet. The CFO cannot release funds until one is set.</p>
      )}
    </div>
  );
}
