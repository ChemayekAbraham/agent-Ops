import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bike, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { updateBikeLeaseAsset } from '@/hooks/useBikeLeases';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Overdue = {
  lease_id: string; agent_name: string | null; brand: string | null; model: string | null;
  tracking_reference: string | null; cfo_disbursed_at: string;
  plate_number: string | null; chassis_number: string | null; battery_serial: string | null;
};

/**
 * Persistent reminder shown only to the assigned bike supplier (server decides
 * who that is) when 72h have passed since CFO disbursement and plate, chassis
 * or battery serial is still missing. It cannot be dismissed; saving clears it.
 */
export function SupplierBikeAssetReminder() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data = [] } = useQuery({
    queryKey: ['my-overdue-bike-asset-details', user?.id],
    enabled: !!user?.id,
    refetchInterval: 10 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_my_overdue_bike_asset_details');
      if (error) throw error;
      return (data || []) as Overdue[];
    },
  });
  const lease = data[0];
  const [form, setForm] = useState<Record<string, string>>({});
  const [formFor, setFormFor] = useState<string | null>(null);
  if (lease && lease.lease_id !== formFor) {
    setFormFor(lease.lease_id);
    setForm({ plate_number: lease.plate_number || '', chassis_number: lease.chassis_number || '', battery_serial: lease.battery_serial || '' });
  }

  const save = useMutation({
    mutationFn: () => updateBikeLeaseAsset(lease!.lease_id, {
      plate_number: form.plate_number.trim(), chassis_number: form.chassis_number.trim(), battery_serial: form.battery_serial.trim(),
    }),
    onSuccess: () => {
      toast.success('Bike details saved. Thank you.');
      qc.invalidateQueries({ queryKey: ['my-overdue-bike-asset-details'] });
      qc.invalidateQueries({ queryKey: ['bike-lease-queue'] });
    },
    onError: (e: any) => toast.error(e.message || 'Could not save bike details'),
  });

  if (!lease) return null;
  const complete = ['plate_number', 'chassis_number', 'battery_serial'].every((k) => form[k]?.trim());
  const fields: [string, string, string][] = [
    ['plate_number', 'Plate number', 'e.g. UBJ 123A'],
    ['chassis_number', 'Chassis number', 'e.g. LAEPCJ1A1PB012345'],
    ['battery_serial', 'Battery serial', 'e.g. BAT-2026-00123'],
  ];

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        className="w-[calc(100vw-1.5rem)] sm:max-w-md [&>button]:hidden"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Bike className="h-4 w-4 text-primary" /> Bike details overdue
          </DialogTitle>
          <DialogDescription className="text-xs">
            You received funds for {lease.agent_name || 'an agent'}'s {[lease.brand, lease.model].filter(Boolean).join(' ') || 'bike'}
            {lease.tracking_reference ? ` (${lease.tracking_reference})` : ''} on{' '}
            {new Date(lease.cfo_disbursed_at).toLocaleDateString('en-GB', { timeZone: 'Africa/Kampala' })}.
            More than 72 hours have passed. Please record the bike details to continue.
            {data.length > 1 ? ` ${data.length - 1} more bike(s) also need details.` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {fields.map(([k, label, ph]) => (
            <div key={k} className="space-y-1">
              <Label className="text-xs">{label}</Label>
              <Input value={form[k] || ''} placeholder={ph} className="h-9 font-mono text-sm"
                onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value.toUpperCase() }))} />
            </div>
          ))}
          <Button className="w-full" disabled={!complete || save.isPending} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />} Save bike details
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
