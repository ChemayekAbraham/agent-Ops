import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, Clock, HandCoins, Loader2, MapPin, ShieldCheck } from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
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
  submitted: { label: 'With Service Centre', note: 'Sent to your nearest Welile Service Centre for agent review.' },
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

  const [trackOpen, setTrackOpen] = useState(false);

  const { data: latest } = useQuery({
    queryKey: ['tenant-rent-intake', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tenant_rent_intake_requests')
        .select('id, status, rent_amount, service_centre_name, decline_reason, created_at, claimed_at, visit_verified_at, decided_at, distance_km, location_name, rent_request_id')
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

    const startLivePin = () => {
      // Watch briefly so the pin refines to a more accurate live fix.
      let settled = false;
      let best: GeolocationPosition | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        navigator.geolocation.clearWatch(watchId);
        if (best) {
          setCoords({ lat: best.coords.latitude, lng: best.coords.longitude });
          toast.success('Location pinned', {
            description: `Accuracy ±${Math.round(best.coords.accuracy)}m`,
          });
        } else {
          toast.error('Could not get your location', {
            description: 'Turn on Location/GPS on your device and allow browser access, then try again.',
          });
        }
        setLocating(false);
      };
      const watchId = navigator.geolocation.watchPosition(
        (pos) => {
          best = pos;
          setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
          // Stop once we have a good-enough fix (< 30m) or after timeout.
          if (pos.coords.accuracy <= 30) finish();
        },
        () => finish(),
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
      );
      setTimeout(finish, 20000);
    };

    const promptEnable = (state: PermissionState) => {
      setLocating(false);
      if (state === 'denied') {
        toast.error('Location is off or blocked', {
          duration: 8000,
          description: 'Enable Location on your device, then tap the lock/site icon in your browser and allow Location for this app.',
        });
      }
    };

    // Check permission first so we can prompt the user to enable location if it's off.
    if ('permissions' in navigator) {
      navigator.permissions
        .query({ name: 'geolocation' as PermissionName })
        .then((perm) => {
          if (perm.state === 'denied') promptEnable('denied');
          else startLivePin();
        })
        .catch(() => startLivePin());
    } else {
      startLivePin();
    }
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
      // Fire-and-forget: pushes the "request received" SMS out now instead of
      // waiting for the 15-minute dispatch sweep.
      supabase.functions.invoke('tenant-rent-intake-notices').catch(() => {});
      toast.success('Request sent', {
        description: centre
          ? `Routed to ${centre}. We'll SMS and notify you at every step.`
          : `An agent will be assigned to review you. We'll SMS and notify you at every step.`,
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

  const trackSteps = latest
    ? [
        { key: 'submitted', label: 'Request sent', at: latest.created_at, note: latest.service_centre_name ? `Routed to ${latest.service_centre_name}` : 'Routed to your nearest Service Centre' },
        { key: 'claimed', label: 'Agent assigned', at: latest.claimed_at, note: 'An agent picked up your request' },
        { key: 'visit_verified', label: 'House verified', at: latest.visit_verified_at, note: 'The agent visited and verified your house' },
        {
          key: 'decided',
          label: latest.status === 'declined' ? 'Not approved' : 'Approved',
          at: latest.decided_at,
          note: latest.status === 'declined'
            ? (latest.decline_reason || 'Your agent did not approve this request')
            : 'Your agent will now raise your rent plan',
        },
      ]
    : [];
  const doneCount = trackSteps.filter((s) => !!s.at).length;

  return (
    <>
      <button
        type="button"
        onClick={() => (openRequest ? setTrackOpen(true) : setOpen(true))}
        className="w-full aspect-square lg:aspect-auto rounded-[28px] border bg-success/10 border-success/20 p-2.5 lg:p-5 text-left flex flex-col shadow-sm active:scale-[0.99] transition-transform touch-manipulation overflow-hidden"
      >
        <div className="flex flex-col justify-between h-full w-full gap-2 lg:gap-4">
          <div className="space-y-2 lg:space-y-3">
            <div className="p-1.5 lg:p-2.5 rounded-xl bg-success/20 w-fit">
              <HandCoins className="h-[18px] w-[18px] lg:h-7 lg:w-7 text-success" />
            </div>
            <p className="font-bold text-sm lg:text-lg leading-tight text-foreground">Request rent as tenant</p>
          </div>

          <div className="space-y-1.5 lg:space-y-2">
            {openRequest ? (
              <>
                <div className="flex items-center gap-1">
                  {trackSteps.map((s, i) => (
                    <span
                      key={s.key}
                      className={`h-1.5 flex-1 rounded-full ${i < doneCount ? 'bg-success' : 'bg-success/20'}`}
                    />
                  ))}
                </div>
                <p className="text-[10px] lg:text-sm font-semibold text-success leading-tight">
                  Step {Math.max(doneCount, 1)} of {trackSteps.length} · {status?.label}
                </p>
                <p className="text-[10px] lg:text-sm text-foreground/70 leading-tight lg:leading-relaxed line-clamp-2 lg:line-clamp-3 break-words">{status?.note}</p>
                <p className="text-[10px] lg:text-xs font-medium text-success/90 underline">Track progress</p>
              </>
            ) : (
              <p className="text-xs lg:text-sm text-foreground/70 leading-snug lg:leading-relaxed line-clamp-2 lg:line-clamp-3 break-words">
                Request rent · agent verifies your house
              </p>
            )}
            {latest?.status === 'declined' && !openRequest && latest.decline_reason && (
              <p className="text-[10px] lg:text-xs text-destructive leading-snug line-clamp-1">
                Last request not approved: {latest.decline_reason}
              </p>
            )}
          </div>
        </div>
      </button>




      <Dialog open={trackOpen} onOpenChange={setTrackOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Your rent request</DialogTitle>
            <DialogDescription>
              {latest ? `${formatUGX(Number(latest.rent_amount))} · sent ${format(new Date(latest.created_at), 'd MMM yyyy, HH:mm')}` : ''}
            </DialogDescription>
          </DialogHeader>

          {latest && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {latest.service_centre_name && (
                  <Badge variant="outline" className="text-[11px]">{latest.service_centre_name}</Badge>
                )}
                {latest.location_name && (
                  <Badge variant="outline" className="text-[11px]">{latest.location_name}</Badge>
                )}
              </div>

              <ol className="relative space-y-4 border-l border-border ml-2 pl-4">
                {trackSteps.map((s, i) => {
                  const done = !!s.at;
                  const current = !done && i === doneCount;
                  const declined = s.key === 'decided' && latest.status === 'declined';
                  return (
                    <li key={s.key} className="relative">
                      <span
                        className={`absolute -left-[22px] top-0.5 h-4 w-4 rounded-full flex items-center justify-center border-2 bg-background ${
                          done ? (declined ? 'border-destructive' : 'border-success') : current ? 'border-primary' : 'border-border'
                        }`}
                      >
                        {done ? (
                          <CheckCircle2 className={`h-3 w-3 ${declined ? 'text-destructive' : 'text-success'}`} />
                        ) : current ? (
                          <Clock className="h-3 w-3 text-primary" />
                        ) : null}
                      </span>
                      <p className={`text-sm font-medium ${done ? (declined ? 'text-destructive' : 'text-success') : current ? 'text-primary' : 'text-muted-foreground'}`}>
                        {s.label}
                        {current && <span className="ml-2 text-[10px] uppercase tracking-wide">In progress</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">{s.note}</p>
                      {s.at && (
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {format(new Date(s.at), 'd MMM yyyy, HH:mm')} · {formatDistanceToNow(new Date(s.at), { addSuffix: true })}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ol>

              <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                We SMS and notify you at every step. No need to call.
              </p>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setTrackOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

            <Button
              type="button"
              variant="outline"
              className="w-full border-success/30 bg-success/10 text-success hover:bg-success/20 hover:text-success-foreground"
              onClick={captureLocation}
              disabled={locating}
            >
              {locating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <MapPin className="mr-2 h-4 w-4" />}
              {locating ? 'Pinning live location…' : coords ? 'Location pinned — tap to refresh' : 'Share my house location'}
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
