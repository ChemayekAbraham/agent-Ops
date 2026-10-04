import { useState, useEffect, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useCaptureLocation } from '@/hooks/useCaptureLocation';
import { useProfile } from '@/hooks/useProfile';
import { hapticTap } from '@/lib/haptics';
import { formatUGX } from '@/lib/rentCalculations';
import {
  MapPin, Loader2, CheckCircle2, User, Phone, Home, Banknote,
  Smartphone, Wallet, AlertTriangle, Navigation, Search, ArrowLeft,
  ShieldCheck, Copy
} from 'lucide-react';
import { format } from 'date-fns';

type WizardStep = 'search' | 'profile' | 'gps' | 'payment' | 'confirm';
type PaymentMode = 'mobile_money' | 'cash' | 'in_app_wallet';
type MomoNetwork = 'MTN' | 'Airtel';

interface Tenant {
  id: string;
  full_name: string;
  phone: string;
  city?: string;
  monthly_rent?: number;
}

interface AgentVisitPaymentWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  /** If provided, skip search step and go directly to profile */
  preselectedTenant?: Tenant;
}

function generateTrackingId(): string {
  const year = new Date().getFullYear();
  const seq = Math.floor(100000 + Math.random() * 900000);
  return `WEL-TXN-${year}-${seq}`;
}

function getDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function AgentVisitPaymentWizard({ open, onOpenChange, onSuccess, preselectedTenant }: AgentVisitPaymentWizardProps) {
  const { profile } = useProfile();
  const { toast } = useToast();
  const { loading: gpsLoading, captureLocation } = useCaptureLocation();

  // Wizard state
  const [step, setStep] = useState<WizardStep>('search');
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null);

  // GPS state
  const [gpsData, setGpsData] = useState<{ lat: number; lng: number; accuracy: number | null } | null>(null);
  const [locationName, setLocationName] = useState<string | null>(null);
  const [visitStatus, setVisitStatus] = useState<'verified' | 'mismatch' | null>(null);
  const [visitId, setVisitId] = useState<string | null>(null);
  const [gpsCapturing, setGpsCapturing] = useState(false);

  // Payment state
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('cash');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [momoNetwork, setMomoNetwork] = useState<MomoNetwork>('MTN');
  const [momoPhone, setMomoPhone] = useState('');
  const [momoPayerName, setMomoPayerName] = useState('');
  const [momoTxnId, setMomoTxnId] = useState('');
  const [walletRef, setWalletRef] = useState('');
  const [cashConfirmed, setCashConfirmed] = useState(false);

  // Confirm state
  const [submitting, setSubmitting] = useState(false);
  const [trackingId, setTrackingId] = useState('');
  const [completed, setCompleted] = useState(false);
  const [smsSending] = useState(false);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setStep('search');
      setSelectedTenant(null);
      setSearchQuery('');
      setGpsData(null);
      setLocationName(null);
      setVisitStatus(null);
      setVisitId(null);
      setPaymentMode('cash');
      setAmount('');
      setNotes('');
      setMomoNetwork('MTN');
      setMomoPhone('');
      setMomoPayerName('');
      setMomoTxnId('');
      setWalletRef('');
      setCashConfirmed(false);
      setTrackingId('');
      setCompleted(false);
      setGpsCapturing(false);
      // smsSending no longer managed locally
    }
  }, [open]);

  // Load tenants and handle preselected
  useEffect(() => {
    if (open && profile?.id) {
      loadTenants();
      if (preselectedTenant) {
        setSelectedTenant(preselectedTenant);
        setStep('profile');
      }
    }
  }, [open, profile?.id]);

  const loadTenants = async () => {
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, phone, city, monthly_rent')
      .eq('referrer_id', profile!.id)
      .order('full_name');
    setTenants((data as Tenant[]) || []);
  };

  const filtered = tenants.filter(t =>
    t.full_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.phone.includes(searchQuery) ||
    t.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Reverse geocode
  const reverseGeocode = useCallback(async (lat: number, lng: number) => {
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`);
      if (res.ok) {
        const data = await res.json();
        const addr = data.address;
        setLocationName(
          [addr?.road, addr?.suburb || addr?.village || addr?.town, addr?.city || addr?.county]
            .filter(Boolean)
            .join(', ') || data.display_name?.split(',').slice(0, 3).join(',') || 'Unknown location'
        );
      }
    } catch {
      setLocationName('Location captured');
    }
  }, []);

  // GPS Capture — best of 3 readings
  const handleGpsCapture = async () => {
    setGpsCapturing(true);
    hapticTap();

    let bestReading: { lat: number; lng: number; accuracy: number } | null = null;

    for (let i = 0; i < 3; i++) {
      const loc = await captureLocation();
      if (loc && (!bestReading || (loc.accuracy ?? Infinity) < bestReading.accuracy)) {
        bestReading = { lat: loc.latitude, lng: loc.longitude, accuracy: loc.accuracy ?? 999 };
      }
    }

    if (!bestReading) {
      toast({ title: 'Could not capture GPS location', description: 'Please enable location services and try again.', variant: 'destructive' });
      setGpsCapturing(false);
      return;
    }

    setGpsData({ lat: bestReading.lat, lng: bestReading.lng, accuracy: bestReading.accuracy });
    reverseGeocode(bestReading.lat, bestReading.lng);

    // Check proximity to tenant's landlord location
    const { data: landlord } = await supabase
      .from('landlords')
      .select('latitude, longitude')
      .eq('tenant_id', selectedTenant!.id)
      .not('latitude', 'is', null)
      .maybeSingle();

    if (landlord?.latitude && landlord?.longitude) {
      const dist = getDistanceMeters(bestReading.lat, bestReading.lng, landlord.latitude, landlord.longitude);
      setVisitStatus(dist <= 50 ? 'verified' : 'mismatch');
    } else {
      // No stored location to compare — mark as mismatch (no reference)
      setVisitStatus('mismatch');
    }

    // Record visit
    const { data: visit, error } = await supabase.from('agent_visits').insert({
      agent_id: profile!.id,
      tenant_id: selectedTenant!.id,
      latitude: bestReading.lat,
      longitude: bestReading.lng,
      accuracy: bestReading.accuracy,
      location_name: null, // Will be updated async
    }).select('id').single();

    if (!error && visit) {
      setVisitId(visit.id);
    }

    setGpsCapturing(false);
  };

  // Payment validation
  const isPaymentValid = (): boolean => {
    if (!amount || Number(amount) <= 0) return false;
    if (paymentMode === 'mobile_money') {
      return !!(momoPhone.trim() && momoPayerName.trim() && momoTxnId.trim());
    }
    if (paymentMode === 'cash') return cashConfirmed;
    if (paymentMode === 'in_app_wallet') return !!walletRef.trim();
    return false;
  };

  // Submit payment
  const handleSubmitPayment = async () => {
    if (!selectedTenant || !profile?.id || !gpsData) return;
    setSubmitting(true);
    hapticTap();

    const txnId = generateTrackingId();
    setTrackingId(txnId);
    const paidAmount = Number(amount);

    try {
      // Get float info for cash payments
      let floatBefore = 0;
      let floatAfter = 0;
      if (paymentMode === 'cash') {
        const { data: floatData } = await supabase
          .from('agent_float_limits')
          .select('collected_today, float_limit')
          .eq('agent_id', profile.id)
          .maybeSingle();
        if (floatData) {
          floatBefore = floatData.collected_today || 0;
          floatAfter = floatBefore + paidAmount;
          if (floatAfter > floatData.float_limit) {
            toast({ title: 'Float limit exceeded', description: `Limit: ${formatUGX(floatData.float_limit)}, Current: ${formatUGX(floatBefore)}`, variant: 'destructive' });
            setSubmitting(false);
            return;
          }
        }
      }

      // Insert collection record
      const { data: collection, error: colError } = await supabase.from('agent_collections').insert({
        agent_id: profile.id,
        tenant_id: selectedTenant.id,
        amount: paidAmount,
        payment_method: paymentMode,
        visit_id: visitId,
        tracking_id: txnId,
        momo_phone: paymentMode === 'mobile_money' ? momoPhone.trim() : null,
        momo_payer_name: paymentMode === 'mobile_money' ? momoPayerName.trim() : null,
        momo_transaction_id: paymentMode === 'mobile_money' ? momoTxnId.trim() : null,
        momo_provider: paymentMode === 'mobile_money' ? momoNetwork : null,
        location_name: locationName,
        notes: notes.trim() || null,
        float_before: paymentMode === 'cash' ? floatBefore : 0,
        float_after: paymentMode === 'cash' ? floatAfter : 0,
      }).select('id').single();

      if (colError) throw colError;

      // Update float for cash
      if (paymentMode === 'cash') {
        await supabase
          .from('agent_float_limits')
          .update({ collected_today: floatAfter })
          .eq('agent_id', profile.id);
      }

      // Update visit with location name
      if (visitId && locationName) {
        await supabase.from('agent_visits').update({ location_name: locationName }).eq('id', visitId);
      }

      setCompleted(true);
      toast({ title: 'Payment recorded successfully!' });

      // Fire SMS via Inngest (fire-and-forget, retries handled by Inngest)
      supabase.functions.invoke('inngest-send-sms', {
        body: {
          tenant_name: selectedTenant.full_name,
          tenant_phone: selectedTenant.phone,
          agent_name: profile.full_name,
          agent_phone: profile.phone,
          amount: paidAmount,
          payment_mode: paymentMode,
          tracking_id: txnId,
          date: format(new Date(), 'dd MMM yyyy'),
          collection_id: collection?.id,
        },
      }).catch(() => console.warn('Inngest SMS dispatch failed silently'));

      onSuccess?.();
    } catch (err: any) {
      toast({ title: 'Failed to record payment', description: err.message, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyTrackingId = () => {
    navigator.clipboard.writeText(trackingId);
    toast({ title: 'Copied to clipboard' });
  };

  const stepIndicator = (
    <div className="flex items-center gap-1 mb-4">
      {(['search', 'profile', 'gps', 'payment', 'confirm'] as WizardStep[]).map((s, i) => (
        <div key={s} className={`h-1 flex-1 rounded-full transition-colors ${
          i <= ['search', 'profile', 'gps', 'payment', 'confirm'].indexOf(step) ? 'bg-primary' : 'bg-muted'
        }`} />
      ))}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5 text-primary" />
            {step === 'search' && 'Select Tenant'}
            {step === 'profile' && 'Tenant Details'}
            {step === 'gps' && 'GPS Verification'}
            {step === 'payment' && 'Record Payment'}
            {step === 'confirm' && 'Payment Confirmed'}
          </DialogTitle>
        </DialogHeader>

        {!completed && stepIndicator}

        {/* STEP 1: Search */}
        {step === 'search' && (
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search by name, phone or ID..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full h-12 rounded-lg border border-input bg-background pl-10 pr-3 text-base focus:outline-none focus:ring-2 focus:ring-ring"
                style={{ fontSize: '16px' }}
              />
            </div>
            <div className="max-h-72 overflow-y-auto space-y-1">
              {filtered.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-6">No tenants found</p>
              )}
              {filtered.map(t => (
                <button
                  key={t.id}
                  onClick={() => { setSelectedTenant(t); setStep('profile'); hapticTap(); }}
                  className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-muted/50 text-left transition-colors active:scale-[0.98]"
                >
                  <div className="p-2 rounded-lg bg-primary/10 shrink-0">
                    <User className="h-4 w-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{t.full_name}</p>
                    <p className="text-xs text-muted-foreground">{t.phone}</p>
                  </div>
                  {t.monthly_rent && (
                    <span className="text-xs font-mono text-muted-foreground shrink-0">
                      {formatUGX(t.monthly_rent)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* STEP 2: Profile */}
        {step === 'profile' && selectedTenant && (
          <div className="space-y-4">
            <div className="bg-secondary/50 rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-2">
                <User className="h-4 w-4 text-muted-foreground" />
                <span className="font-semibold">{selectedTenant.full_name}</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Phone className="h-3.5 w-3.5" />
                <span>{selectedTenant.phone}</span>
              </div>
              {selectedTenant.city && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Home className="h-3.5 w-3.5" />
                  <span>{selectedTenant.city}</span>
                </div>
              )}
              {selectedTenant.monthly_rent && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Banknote className="h-3.5 w-3.5" />
                  <span>Monthly Rent: {formatUGX(selectedTenant.monthly_rent)}</span>
                </div>
              )}
              <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
                <span>ID: {selectedTenant.id.substring(0, 8)}...</span>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => { setSelectedTenant(null); setStep('search'); }} className="flex-1 h-12">
                <ArrowLeft className="h-4 w-4 mr-1" />
                Back
              </Button>
              <Button onClick={() => setStep('gps')} className="flex-1 h-12">
                <Navigation className="h-4 w-4 mr-1" />
                Verify Location
              </Button>
            </div>
          </div>
        )}

        {/* STEP 3: GPS */}
        {step === 'gps' && (
          <div className="space-y-4">
            {!gpsData ? (
              <div className="text-center space-y-4 py-4">
                <div className="w-16 h-16 mx-auto bg-primary/10 rounded-full flex items-center justify-center">
                  <Navigation className="h-8 w-8 text-primary" />
                </div>
                <p className="text-sm text-muted-foreground">
                  We need to verify your location before recording a payment.
                </p>
                <Button
                  onClick={handleGpsCapture}
                  disabled={gpsCapturing || gpsLoading}
                  className="w-full h-12"
                >
                  {gpsCapturing ? (
                    <><Loader2 className="h-4 w-4 animate-spin mr-2" />Capturing GPS...</>
                  ) : (
                    <><MapPin className="h-4 w-4 mr-2" />Capture Location</>
                  )}
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Visit status badge */}
                <div className={`rounded-xl p-4 flex items-center gap-3 ${
                  visitStatus === 'verified'
                    ? 'bg-success/10 border border-success/30'
                    : 'bg-warning/10 border border-warning/30'
                }`}>
                  {visitStatus === 'verified' ? (
                    <ShieldCheck className="h-6 w-6 text-success shrink-0" />
                  ) : (
                    <AlertTriangle className="h-6 w-6 text-warning shrink-0" />
                  )}
                  <div>
                    <p className={`font-semibold text-sm ${visitStatus === 'verified' ? 'text-success' : 'text-warning'}`}>
                      {visitStatus === 'verified' ? 'VISIT VERIFIED' : 'LOCATION MISMATCH'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {visitStatus === 'verified'
                        ? 'You are at the tenant\'s registered address.'
                        : 'You are not at the tenant\'s registered location. Payment will still be recorded.'}
                    </p>
                  </div>
                </div>

                {/* GPS details */}
                <div className="bg-secondary/50 rounded-xl p-3 space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Coordinates</span>
                    <span className="font-mono">{gpsData.lat.toFixed(6)}, {gpsData.lng.toFixed(6)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Accuracy</span>
                    <span className="font-mono">{gpsData.accuracy ? `±${Math.round(gpsData.accuracy)}m` : 'N/A'}</span>
                  </div>
                  {locationName && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Place</span>
                      <span className="text-right max-w-[60%] truncate">{locationName}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Time</span>
                    <span>{format(new Date(), 'dd MMM yyyy, HH:mm')}</span>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setStep('profile')} className="flex-1 h-12">
                    <ArrowLeft className="h-4 w-4 mr-1" />
                    Back
                  </Button>
                  <Button onClick={() => setStep('payment')} className="flex-1 h-12">
                    <Banknote className="h-4 w-4 mr-1" />
                    Record Payment
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* STEP 4: Payment */}
        {step === 'payment' && (
          <div className="space-y-4">
            {/* Amount */}
            <div className="space-y-1.5">
              <Label>Amount (UGX)</Label>
              <Input
                placeholder="e.g. 150000"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
                inputMode="numeric"
                className="h-14 text-lg font-mono"
                style={{ fontSize: '16px' }}
              />
              {amount && Number(amount) > 0 && (
                <p className="text-xs text-muted-foreground">{formatUGX(Number(amount))}</p>
              )}
            </div>

            {/* Payment Mode */}
            <div className="space-y-2">
              <Label>Payment Mode</Label>
              <RadioGroup
                value={paymentMode}
                onValueChange={(v) => setPaymentMode(v as PaymentMode)}
                className="space-y-2"
              >
                {[
                  { value: 'mobile_money', label: 'Mobile Money', icon: Smartphone, color: 'text-yellow-600', desc: 'MTN / Airtel' },
                  { value: 'cash', label: 'Cash', icon: Banknote, color: 'text-amber-600', desc: 'Deducts from float' },
                  { value: 'in_app_wallet', label: 'Agent Wallet', icon: Wallet, color: 'text-success', desc: 'Welile balance' },
                ].map(opt => (
                  <Label
                    key={opt.value}
                    htmlFor={`pm-${opt.value}`}
                    className={`flex items-center gap-3 p-3 rounded-xl border-2 cursor-pointer transition-all ${
                      paymentMode === opt.value ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/30'
                    }`}
                  >
                    <RadioGroupItem value={opt.value} id={`pm-${opt.value}`} className="sr-only" />
                    <opt.icon className={`h-5 w-5 ${opt.color}`} />
                    <div className="flex-1">
                      <p className="font-medium text-sm">{opt.label}</p>
                      <p className="text-xs text-muted-foreground">{opt.desc}</p>
                    </div>
                  </Label>
                ))}
              </RadioGroup>
            </div>

            {/* Mobile Money Fields */}
            {paymentMode === 'mobile_money' && (
              <div className="space-y-3 bg-secondary/30 rounded-xl p-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Network</Label>
                  <div className="flex gap-2">
                    {(['MTN', 'Airtel'] as MomoNetwork[]).map(n => (
                      <Button
                        key={n}
                        type="button"
                        size="sm"
                        variant={momoNetwork === n ? 'default' : 'outline'}
                        onClick={() => setMomoNetwork(n)}
                        className="flex-1 h-10"
                      >
                        {n}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Phone Number</Label>
                  <PhoneInput
                    placeholder="0771234567"
                    value={momoPhone}
                    onChange={(v) => setMomoPhone(v)}
                    onContactPicked={({ name }) => {
                      if (name && !momoPayerName.trim()) setMomoPayerName(name);
                    }}
                    style={{ fontSize: '16px' }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Name on Phone</Label>
                  <Input
                    placeholder="e.g. John Doe"
                    value={momoPayerName}
                    onChange={(e) => setMomoPayerName(e.target.value)}
                    style={{ fontSize: '16px' }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Transaction ID</Label>
                  <Input
                    placeholder="e.g. PP260309.1234.A56789"
                    value={momoTxnId}
                    onChange={(e) => setMomoTxnId(e.target.value)}
                    style={{ fontSize: '16px' }}
                  />
                </div>
              </div>
            )}

            {/* Cash Fields */}
            {paymentMode === 'cash' && (
              <label className="flex items-center gap-3 p-3 rounded-xl bg-secondary/30 cursor-pointer">
                <input
                  type="checkbox"
                  checked={cashConfirmed}
                  onChange={(e) => setCashConfirmed(e.target.checked)}
                  className="h-5 w-5 rounded border-input accent-primary"
                />
                <span className="text-sm">I confirm I have received the cash</span>
              </label>
            )}

            {/* Wallet Fields */}
            {paymentMode === 'in_app_wallet' && (
              <div className="space-y-1.5 bg-secondary/30 rounded-xl p-3">
                <Label className="text-xs">Wallet Reference</Label>
                <Input
                  placeholder="Transaction reference"
                  value={walletRef}
                  onChange={(e) => setWalletRef(e.target.value)}
                  style={{ fontSize: '16px' }}
                />
              </div>
            )}

            {/* Notes */}
            <div className="space-y-1.5">
              <Label>Notes (optional)</Label>
              <Textarea
                placeholder="Any additional details..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="resize-none"
                style={{ fontSize: '16px' }}
                maxLength={200}
              />
            </div>

            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep('gps')} className="flex-1 h-12">
                <ArrowLeft className="h-4 w-4 mr-1" />
                Back
              </Button>
              <Button
                onClick={handleSubmitPayment}
                disabled={submitting || !isPaymentValid()}
                className="flex-1 h-12"
              >
                {submitting ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-1" />Processing</>
                ) : (
                  <><CheckCircle2 className="h-4 w-4 mr-1" />Submit</>
                )}
              </Button>
            </div>
          </div>
        )}

        {/* STEP 5: Confirmation */}
        {completed && (
          <div className="space-y-4 py-2">
            <div className="text-center space-y-3">
              <div className="w-16 h-16 mx-auto bg-success/20 rounded-full flex items-center justify-center">
                <CheckCircle2 className="h-8 w-8 text-success" />
              </div>
              <h3 className="text-lg font-semibold">Payment Recorded!</h3>
            </div>

            <div className="bg-secondary/50 rounded-xl p-4 space-y-2.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tenant</span>
                <span className="font-medium">{selectedTenant?.full_name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Amount</span>
                <span className="font-mono font-semibold text-success">{formatUGX(Number(amount))}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Mode</span>
                <span className="capitalize">{paymentMode.replace(/_/g, ' ')}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Date</span>
                <span>{format(new Date(), 'dd MMM yyyy, HH:mm')}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Visit</span>
                <span className={visitStatus === 'verified' ? 'text-success font-medium' : 'text-warning font-medium'}>
                  {visitStatus === 'verified' ? 'Verified' : 'Mismatch'}
                </span>
              </div>
              {locationName && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Location</span>
                  <span className="text-right max-w-[60%] text-xs">{locationName}</span>
                </div>
              )}
              <div className="border-t border-border pt-2 mt-2">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Tracking ID</span>
                  <button
                    onClick={handleCopyTrackingId}
                    className="flex items-center gap-1 font-mono text-xs font-bold text-primary active:scale-95 transition-transform"
                  >
                    {trackingId}
                    <Copy className="h-3 w-3" />
                  </button>
                </div>
              </div>
            </div>

            {smsSending && (
              <p className="text-xs text-muted-foreground text-center flex items-center justify-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" />
                Sending SMS confirmations...
              </p>
            )}

            <Button onClick={() => onOpenChange(false)} className="w-full h-12">
              Done
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
