import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { HandCoins, Loader2, MapPin, ShieldCheck } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Lc1VillagePicker } from '@/components/location/Lc1VillagePicker';
import { formatUGX } from '@/lib/rentCalculations';

const OPEN_STATUSES = ['submitted', 'claimed', 'visit_verified', 'approved'];

const STATUS_COPY: Record<string, { label: string; note: string }> = {
  submitted: { label: 'With Service Centre', note: 'Your request was sent to the nearest Welile Service Centre. An agent will be assigned to review you.' },
  claimed: { label: 'Agent assigned', note: 'An agent picked up your request and will visit your house to verify it.' },
  visit_verified: { label: 'House verified', note: 'Your house was verified. The agent is finishing the review.' },
  approved: { label: 'Approved', note: 'You were approved. Your agent will now raise the rent plan for you.' },
  rent_requested: { label: 'Rent plan raised', note: 'Your agent has raised your rent plan. Follow it from your rent plan card.' },
  declined: { label: 'Not approved', note: '' },
};

export function TenantRentRequestCard({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [village, setVillage] = useState('');
  const [district, setDistrict] = useState<string | null>(null);
  const [landlordName, setLandlordName] = useState('');
  const [landlordPhone, setLandlordPhone] = useState('');
  const [note, setNote] = useState('');
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const { data: latest } = useQuery({
    queryKey: ['tenant-rent-intake', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tenant_rent_intake_requests')
        .select('id, status, rent_amount, service_centre_name, decline_reason, created_at')
        .eq('tenant_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const openRequest = latest && OPEN_STATUSES.includes(latest.status) ? latest : null;

  const captureLocation = () => {
    if (!navigator.geolocation) {
      toast.error('Location is not available on this device');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating(false);
        toast.success('Location captured');
      },
      () => {
        setLocating(false);
        toast.error('Could not get your location. Allow location access and try again.');
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  const submit = async () => {
    const rent = Number(amount.replace(/[^\d.]/g, ''));
    if (!rent || rent <= 0) { toast.error('Enter your monthly rent'); return; }
    if (!landlordName.trim() || !landlordPhone.trim()) { toast.error('Add your landlord name and phone'); return; }
    setSubmitting(true);
    try {
      const { data, error } = await supabase.rpc('submit_tenant_rent_intake', {
        p_rent_amount: rent,
        p_landlord_name: landlordName.trim(),
        p_landlord_phone: landlordPhone.trim(),
        p_village_name: village || null,
        p_district_name: district,
        p_location_name: [village, district].filter(Boolean).join(', ') || null,
        p_latitude: coords?.lat ?? null,
        p_longitude: coords?.lng ?? null,
        p_note: note.trim() || null,
      });
      if (error) throw error;
      const centre = (data as any)?.service_centre_name as string | undefined;
      toast.success('Request sent', {
        description: centre
          ? `Routed to ${centre}. An agent will review you and verify your house.`
          : 'An agent will be assigned to review you and verify your house.',
      });
      setOpen(false);
      setAmount(''); setNote('');
      qc.invalidateQueries({ queryKey: ['tenant-rent-intake', userId] });
    } catch (e: any) {
      toast.error('Could not send request', { description: e?.message });
    } finally {
      setSubmitting(false);
    }
  };

  const status = openRequest ? STATUS_COPY[openRequest.status] : null;

  return (
    <>
      <button
        type="button"
        onClick={() => (openRequest ? undefined : setOpen(true))}
        disabled={!!openRequest}
        className="w-full rounded-[28px] border bg-card p-4 text-left flex items-start gap-3 shadow-sm active:scale-[0.99] transition-transform touch-manipulation disabled:active:scale-100"
      >
        <div className="p-2.5 rounded-2xl bg-primary/10 shrink-0">
          <HandCoins className="h-6 w-6 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-base leading-tight">Request rent as tenant</p>
          {openRequest ? (
            <>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className="text-[10px]">{status?.label}</Badge>
                <span className="text-[11px] text-muted-foreground">{formatUGX(Number(openRequest.rent_amount))}</span>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground leading-snug">{status?.note}</p>
            </>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground leading-snug">
              Ask for rent yourself. We send you to the nearest Welile Service Centre, an agent reviews you and
              verifies your house, then raises your rent plan.
            </p>
          )}
          {latest?.status === 'declined' && !openRequest && latest.decline_reason && (
            <p className="mt-1 text-[11px] text-destructive leading-snug">
              Last request not approved: {latest.decline_reason}
            </p>
          )}
        </div>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Request rent as tenant</DialogTitle>
            <DialogDescription>
              Give us the basics. Your request goes to the nearest Welile Service Centre for agent review.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <Label htmlFor="tri-amount">Monthly rent (UGX)</Label>
              <Input
                id="tri-amount" inputMode="numeric" placeholder="e.g. 250000"
                value={amount} onChange={(e) => setAmount(e.target.value)}
              />
            </div>

            <Lc1VillagePicker
              label="Where is your house?"
              value={village}
              districtName={district}
              onChange={(name, sel) => { setVillage(name); setDistrict(sel?.district ?? null); }}
            />

            <Button type="button" variant="outline" className="w-full" onClick={captureLocation} disabled={locating}>
              {locating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <MapPin className="mr-2 h-4 w-4" />}
              {coords ? 'Location captured — tap to refresh' : 'Share my house location'}
            </Button>
            <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              Sharing your location helps us route you to the closest Service Centre and speeds up house verification.
            </p>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="tri-ll-name">Landlord name</Label>
                <Input id="tri-ll-name" value={landlordName} onChange={(e) => setLandlordName(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="tri-ll-phone">Landlord phone</Label>
                <Input id="tri-ll-phone" inputMode="tel" value={landlordPhone} onChange={(e) => setLandlordPhone(e.target.value)} />
              </div>
            </div>

            <div>
              <Label htmlFor="tri-note">Anything the agent should know (optional)</Label>
              <Textarea id="tri-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={submitting}>Cancel</Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Send request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default TenantRentRequestCard;
