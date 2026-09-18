import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import {
  Banknote, MapPin, Camera, Upload, Loader2, CheckCircle2, X, Phone,
  AlertCircle, ArrowRight, Clock, User2, Home
} from 'lucide-react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';

interface AgentLandlordPayoutFlowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = 'select' | 'pay' | 'receipt' | 'done';

const GPS_MATCH_THRESHOLD_METERS = 500; // auto-approve within 500m
// Receipt number capture becomes mandatory for payouts made from Monday 21 Sept 2026.
const RECEIPT_NUMBER_REQUIRED_FROM = new Date('2026-09-21T00:00:00+03:00');
const receiptNumberRequired = () => new Date() >= RECEIPT_NUMBER_REQUIRED_FROM;

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function AgentLandlordPayoutFlow({ open, onOpenChange }: AgentLandlordPayoutFlowProps) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>('select');
  const [selectedRequest, setSelectedRequest] = useState<any>(null);
  const [transactionId, setTransactionId] = useState('');
  const [receiptNumber, setReceiptNumber] = useState('');
  const [provider, setProvider] = useState('');
  const [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [gps, setGps] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [payoutId, setPayoutId] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  // Fetch agent's landlord float balance
  const { data: floatData } = useQuery({
    queryKey: ['agent-landlord-float-balance', user?.id],
    queryFn: async () => {
      if (!user) return null;
      const { data } = await supabase
        .from('agent_landlord_float')
        .select('balance, total_funded, total_paid_out')
        .eq('agent_id', user.id)
        .maybeSingle();
      return data;
    },
    enabled: !!user && open,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });

  // Fetch disbursed rent requests for landlords assigned to this agent
  const { data: assignedRequests = [], isLoading } = useQuery({
    queryKey: ['agent-landlord-payout-requests', user?.id],
    queryFn: async () => {
      if (!user) return [];
      
      // Get assigned landlord IDs for this agent
      const { data: assignments } = await supabase
        .from('agent_landlord_assignments')
        .select('landlord_id')
        .eq('agent_id', user.id)
        .eq('status', 'active');
      
      const assignedLandlordIds = (assignments || []).map(a => a.landlord_id);
      if (assignedLandlordIds.length === 0) return [];

      const { data, error } = await supabase
        .from('rent_requests')
        .select('id, rent_amount, tenant_id, landlord_id, status, request_latitude, request_longitude, created_at, daily_repayment, duration_days')
        .in('landlord_id', assignedLandlordIds)
        .in('status', ['funded'])
        .order('created_at', { ascending: false });
      if (error) throw error;

      // Fetch landlord + tenant info. A tenant is "already funded" when a payout
      // exists in `landlord_payouts` (the live flow) — the legacy
      // `agent_landlord_payouts` table is only checked for old records.
      const enriched = await Promise.all((data || []).map(async (r: any) => {
        const [{ data: landlord }, { data: tenant }, { data: livePayouts }, { data: legacyPayout }] = await Promise.all([
          supabase.from('landlords').select('id, name, phone, mobile_money_number').eq('id', r.landlord_id).single(),
          supabase.from('profiles').select('id, full_name, phone').eq('id', r.tenant_id).single(),
          supabase
            .from('landlord_payouts')
            .select('id, status')
            .eq('rent_request_id', r.id)
            .not('status', 'in', '(failed,rejected,cancelled)')
            .limit(1),
          supabase.from('agent_landlord_payouts').select('id').eq('rent_request_id', r.id).eq('agent_id', user.id).maybeSingle(),
        ]);
        const hasPayout = ((livePayouts || []).length > 0) || !!legacyPayout?.id;
        return { ...r, landlord, tenant, hasPayout };
      }));

      return enriched.filter((r: any) => !r.hasPayout);
    },
    enabled: !!user && open,
  });

  const resetForm = () => {
    setStep('select');
    setSelectedRequest(null);
    setTransactionId('');
    setProvider('');
    setNotes('');
    setPhotos([]);
    setGps(null);
    setPayoutId('');
  };

  const handleClose = () => {
    resetForm();
    onOpenChange(false);
  };

  const captureGPS = () => {
    if (!navigator.geolocation) { toast.error('GPS not supported'); return; }
    setGpsLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
        setGpsLoading(false);
        toast.success('GPS captured');
      },
      () => { setGpsLoading(false); toast.error('GPS access denied'); },
      { enableHighAccuracy: true }
    );
  };

  const handleFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (photos.length + files.length > 3) { toast.error('Max 3 photos'); return; }
    setPhotos(prev => [...prev, ...files].slice(0, 3));
  };

  const removePhoto = (i: number) => setPhotos(prev => prev.filter((_, idx) => idx !== i));

  const submitPayout = useMutation({
    mutationFn: async () => {
      if (!user || !selectedRequest || !gps) throw new Error('Missing data');
      if (photos.length === 0) throw new Error('Please add at least one receipt photo');

      const payoutAmount = selectedRequest.rent_amount;

      // Check Landlord Payout Float FIRST — money comes from this ring-fenced pool, NOT wallet float.
      const { data: currentFloat, error: floatErr } = await supabase
        .from('agent_landlord_float')
        .select('id, balance, total_paid_out')
        .eq('agent_id', user.id)
        .maybeSingle();

      if (floatErr) throw new Error('Failed to check float balance');
      if (!currentFloat) throw new Error('No Landlord Payout Float account found. Ask your manager to fund Landlord Payout Float.');
      if (currentFloat.balance < payoutAmount) {
        throw new Error(`Insufficient Landlord Payout Float. You have ${formatUGX(currentFloat.balance)} but need ${formatUGX(payoutAmount)}. Request Landlord Payout Float.`);
      }

      // Upload photos
      const photoUrls: string[] = [];
      for (const file of photos) {
        const ext = file.name.split('.').pop() || 'jpg';
        const path = `landlord-payouts/${selectedRequest.id}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
        const { error: upErr } = await supabase.storage.from('receipts').upload(path, file);
        if (upErr) throw upErr;
        const { data: urlData } = supabase.storage.from('receipts').getPublicUrl(path);
        photoUrls.push(urlData.publicUrl);
      }

      // Calculate GPS match
      const propLat = selectedRequest.request_latitude;
      const propLng = selectedRequest.request_longitude;
      let gpsMatch = false;
      let distance = 0;
      if (propLat && propLng) {
        distance = haversineDistance(gps.lat, gps.lng, propLat, propLng);
        gpsMatch = distance <= GPS_MATCH_THRESHOLD_METERS;
      }

      const initialStatus = gpsMatch ? 'landlord_ops_approved' : 'pending_landlord_ops';

      // Deduct from Landlord Payout Float (NOT wallet/rent-collection float)
      const { error: deductErr } = await supabase
        .from('agent_landlord_float')
        .update({
          balance: currentFloat.balance - payoutAmount,
          total_paid_out: (currentFloat.total_paid_out || 0) + payoutAmount,
          updated_at: new Date().toISOString(),
        } as any)
        .eq('id', currentFloat.id);

      if (deductErr) throw new Error('Failed to deduct from Landlord Payout Float. Please try again.');

      // Record the payout
      const { data: payout, error } = await supabase.from('agent_landlord_payouts').insert({
        agent_id: user.id,
        rent_request_id: selectedRequest.id,
        landlord_id: selectedRequest.landlord_id,
        tenant_id: selectedRequest.tenant_id,
        amount: payoutAmount,
        landlord_phone: selectedRequest.landlord?.mobile_money_number || selectedRequest.landlord?.phone || '',
        landlord_name: selectedRequest.landlord?.name || 'Unknown',
        mobile_money_provider: provider,
        transaction_id: transactionId.trim() || null,
        receipt_photo_urls: photoUrls,
        latitude: gps.lat,
        longitude: gps.lng,
        location_accuracy: gps.accuracy,
        property_latitude: propLat || null,
        property_longitude: propLng || null,
        gps_match: gpsMatch,
        gps_distance_meters: propLat ? Math.round(distance) : null,
        status: initialStatus,
        notes: notes || null,
      } as any).select('id').single();

      if (error) {
        // Rollback float deduction if payout insert fails
        await supabase
          .from('agent_landlord_float')
          .update({
            balance: currentFloat.balance,
            total_paid_out: currentFloat.total_paid_out,
            updated_at: new Date().toISOString(),
          } as any)
          .eq('id', currentFloat.id);
        throw error;
      }

      return { id: payout?.id, gpsMatch, distance };
    },
    onSuccess: (result) => {
      setPayoutId(result?.id || '');
      setStep('done');
      qc.invalidateQueries({ queryKey: ['agent-landlord-payout-requests'] });
      qc.invalidateQueries({ queryKey: ['agent-landlord-float-balance'] });
      qc.invalidateQueries({ queryKey: ['agent-landlord-payout-float-balance'] });
      qc.invalidateQueries({ queryKey: ['agent-landlord-float-row'] });
      if (result?.gpsMatch) {
        toast.success('Payout submitted & auto-approved! Landlord Payout Float deducted. GPS matched.');
      } else {
        toast.success('Payout submitted from Landlord Payout Float. Awaiting Landlord Ops approval.');
      }
    },
    onError: (e: any) => toast.error(e.message || 'Failed to submit payout'),
  });

  const req = selectedRequest;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Banknote className="h-5 w-5 text-primary" />
            Pay Landlord via MoMo
          </DialogTitle>
        </DialogHeader>

        <AnimatePresence mode="wait">
          {/* Step 1: Select rent request */}
          {step === 'select' && (
            <motion.div key="select" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
              {/* Float Balance Banner */}
              <div className={`rounded-xl p-3 border text-sm ${
                (floatData?.balance || 0) > 0
                  ? 'bg-success/5 border-success/30'
                  : 'bg-destructive/5 border-destructive/30'
              }`}>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground font-medium">Landlord Payout Float</span>
                  <span className={`font-bold font-mono ${(floatData?.balance || 0) > 0 ? 'text-success' : 'text-destructive'}`}>
                    {formatUGX(floatData?.balance || 0)}
                  </span>
                </div>
                {(floatData?.balance || 0) <= 0 && (
                  <p className="text-[10px] text-destructive mt-1">Landlord Payout Float is empty. Request Landlord Payout Float before paying landlords.</p>
                )}
              </div>
              <p className="text-sm text-muted-foreground">Select a rent request to pay the landlord from Landlord Payout Float:</p>
              {isLoading ? (
                <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
              ) : assignedRequests.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  <Home className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  No pending landlord payouts assigned to you.
                </div>
              ) : (
                assignedRequests.map((r: any) => (
                  <Card
                    key={r.id}
                    className="cursor-pointer hover:border-primary/50 transition-colors"
                    onClick={() => { setSelectedRequest(r); setStep('pay'); }}
                  >
                    <CardContent className="p-3 space-y-1">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <User2 className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium text-sm">{r.landlord?.name || 'Unknown Landlord'}</span>
                        </div>
                        <Badge variant="secondary" className="text-xs">{formatUGX(r.rent_amount)}</Badge>
                      </div>
                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{r.landlord?.mobile_money_number || r.landlord?.phone || 'N/A'}</span>
                        <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{format(new Date(r.created_at), 'dd MMM')}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Tenant: {r.tenant?.full_name || 'Unknown'}
                      </div>
                      <div className="flex items-center justify-end">
                        <ArrowRight className="h-4 w-4 text-primary" />
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </motion.div>
          )}

          {/* Step 2: Pay landlord */}
          {step === 'pay' && req && (
            <motion.div key="pay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
              {/* Float deduction notice */}
              <div className={`rounded-lg p-2 text-xs flex items-center justify-between ${
                (floatData?.balance || 0) >= (req?.rent_amount || 0)
                  ? 'bg-success/10 border border-success/20'
                  : 'bg-destructive/10 border border-destructive/20'
              }`}>
                <span className="text-muted-foreground">Landlord Payout Float after payout:</span>
                <span className={`font-bold font-mono ${
                  (floatData?.balance || 0) >= (req?.rent_amount || 0) ? 'text-success' : 'text-destructive'
                }`}>
                  {formatUGX(Math.max(0, (floatData?.balance || 0) - (req?.rent_amount || 0)))}
                </span>
              </div>
              {/* Landlord details - prominent */}
              <div className="p-4 rounded-xl bg-primary/5 border border-primary/20 space-y-2">
                <h3 className="font-bold text-sm text-primary">Landlord Details</h3>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div><span className="text-muted-foreground">Name:</span> <span className="font-bold">{req.landlord?.name}</span></div>
                  <div><span className="text-muted-foreground">Amount:</span> <span className="font-bold text-primary">{formatUGX(req.rent_amount)}</span></div>
                  <div className="col-span-2 flex items-center gap-1">
                    <Phone className="h-3 w-3" />
                    <span className="font-mono font-bold text-base">{req.landlord?.mobile_money_number || req.landlord?.phone || 'N/A'}</span>
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  ⚠️ Send exactly {formatUGX(req.rent_amount)} to the number above. The phone must be registered in the name of <strong>{req.landlord?.name}</strong>.
                </p>
              </div>

              <div className="space-y-1">
                <Label className="text-xs font-bold">Mobile Money Provider *</Label>
                <Select value={provider} onValueChange={setProvider}>
                  <SelectTrigger><SelectValue placeholder="Select provider" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MTN">MTN Mobile Money</SelectItem>
                    <SelectItem value="Airtel">Airtel Money</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label className="text-xs font-bold">Transaction ID (TID)</Label>
                <Input
                  value={transactionId}
                  onChange={e => setTransactionId(e.target.value)}
                  placeholder="Auto-filled — not required"
                  className="font-mono"
                  disabled
                />
                <p className="text-[10px] text-muted-foreground">
                  Not needed — this payment is drawn directly from your Landlord Payout Float, not from wallet float or a fresh Mobile Money send. The payout float was already funded and verified when it was transferred to you.
                </p>
              </div>

              <Button
                className="w-full"
                disabled={!provider}
                onClick={() => setStep('receipt')}
              >
                <ArrowRight className="h-4 w-4 mr-2" />
                Next: Upload Receipt & GPS
              </Button>

              <Button variant="ghost" size="sm" className="w-full" onClick={() => { setSelectedRequest(null); setStep('select'); }}>
                ← Back to list
              </Button>
            </motion.div>
          )}

          {/* Step 3: Receipt + GPS */}
          {step === 'receipt' && req && (
            <motion.div key="receipt" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
              <div className="p-3 rounded-lg bg-warning/10 border border-warning/20 text-sm">
                <p className="font-bold text-warning flex items-center gap-1">
                  <AlertCircle className="h-4 w-4" />
                  Capture Proof of Payment
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  You must share your GPS location from the landlord's location and upload a photo of the landlord's signed receipt.
                </p>
              </div>

              {/* GPS */}
              <div>
                <Button variant="outline" size="sm" onClick={captureGPS} disabled={gpsLoading} className="w-full">
                  {gpsLoading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <MapPin className="h-3 w-3 mr-1" />}
                  {gps ? `GPS: ${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}` : 'Capture GPS Location *'}
                </Button>
                {gps && (
                  <p className="text-[10px] text-success mt-1 flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" />
                    Accuracy: {gps.accuracy.toFixed(0)}m
                    {req.request_latitude && (
                      <span className="text-muted-foreground ml-2">
                        | {Math.round(haversineDistance(gps.lat, gps.lng, req.request_latitude, req.request_longitude))}m from property
                      </span>
                    )}
                  </p>
                )}
              </div>

              {/* Photos */}
              <div>
                <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple onChange={handleFiles} className="hidden" />
                <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={photos.length >= 3} className="w-full">
                  <Upload className="h-3 w-3 mr-1" />Receipt Photos ({photos.length}/3) *
                </Button>
                {photos.length > 0 && (
                  <div className="flex gap-2 mt-2">
                    {photos.map((f, i) => (
                      <div key={i} className="relative">
                        <img src={URL.createObjectURL(f)} alt="" className="h-16 w-16 object-cover rounded border" />
                        <button onClick={() => removePhoto(i)} className="absolute -top-1 -right-1 bg-destructive text-destructive-foreground rounded-full h-4 w-4 flex items-center justify-center">
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Textarea
                placeholder="Notes (optional)"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                className="h-16 text-sm"
              />

              <Button
                onClick={() => submitPayout.mutate()}
                disabled={submitPayout.isPending || !gps || photos.length === 0}
                className="w-full"
              >
                {submitPayout.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}
                Submit Payout Proof
              </Button>

              <Button variant="ghost" size="sm" className="w-full" onClick={() => setStep('pay')}>
                ← Back
              </Button>
            </motion.div>
          )}

          {/* Step 4: Done */}
          {step === 'done' && (
            <motion.div key="done" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="py-6 text-center space-y-4">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                className="w-16 h-16 mx-auto rounded-full bg-success/20 flex items-center justify-center"
              >
                <CheckCircle2 className="h-8 w-8 text-success" />
              </motion.div>
              <h3 className="text-lg font-bold">Payout Submitted!</h3>
              <p className="text-sm text-muted-foreground">
                {req?.landlord?.name} has been paid {formatUGX(req?.rent_amount || 0)}.
              </p>
              <Badge variant="outline" className="text-xs">
                Your receipt + GPS is being reviewed
              </Badge>
              <Button onClick={handleClose} className="w-full">Done</Button>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
