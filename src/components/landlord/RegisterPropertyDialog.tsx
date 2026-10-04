import { useState } from 'react';
import { motion } from 'framer-motion';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  User,
  Phone,
  MapPin,
  Banknote,
  Loader2,
  CheckCircle2,
  Shield,
  Home,
  Navigation,
  Sparkles,
  TrendingUp,
  Zap,
  Droplets,
  UserPlus,
  Building2,
} from 'lucide-react';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import { UgLocationPicker } from '@/components/location/UgLocationPicker';
import { ugLocationLabel, type UgLocationSelection } from '@/hooks/useUgLocations';

interface RegisterPropertyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

type PropertyStatus = 'occupied' | 'empty';

export default function RegisterPropertyDialog({
  open,
  onOpenChange,
  onSuccess,
}: RegisterPropertyDialogProps) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [capturingLocation, setCapturingLocation] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  // Property details
  const [propertyAddress, setPropertyAddress] = useState('');
  const [numberOfHouses, setNumberOfHouses] = useState('');
  const [monthlyRent, setMonthlyRent] = useState('');
  const [electricityMeter, setElectricityMeter] = useState('');
  const [waterMeter, setWaterMeter] = useState('');
  const [payoutDate, setPayoutDate] = useState('');

  // Caretaker
  const [caretakerName, setCaretakerName] = useState('');
  const [caretakerPhone, setCaretakerPhone] = useState('');

  // Location
  const [latitude, setLatitude] = useState<number | null>(null);
  const [longitude, setLongitude] = useState<number | null>(null);

  // Tenant or empty
  const [propertyStatus, setPropertyStatus] = useState<PropertyStatus>('empty');
  const [tenantName, setTenantName] = useState('');
  const [tenantPhone, setTenantPhone] = useState('');

  // LC1
  const [lc1Name, setLc1Name] = useState('');
  const [lc1Phone, setLc1Phone] = useState('');

  // Official Uganda location (region → village) from the shared ug_* dataset.
  // Mandatory, and it also supplies the LC1 chairperson's village.
  const [ugLoc, setUgLoc] = useState<UgLocationSelection | null>(null);
  const [ugLocError, setUgLocError] = useState<string | null>(null);
  const lc1Village = ugLoc?.village ?? '';

  const platformFee = monthlyRent ? Math.round(parseInt(monthlyRent) * 0.10) : 0;

  const resetForm = () => {
    setPropertyAddress('');
    setNumberOfHouses('');
    setMonthlyRent('');
    setElectricityMeter('');
    setWaterMeter('');
    setPayoutDate('');
    setCaretakerName('');
    setCaretakerPhone('');
    setLatitude(null);
    setLongitude(null);
    setPropertyStatus('empty');
    setTenantName('');
    setTenantPhone('');
    setLc1Name('');
    setLc1Phone('');
    setUgLoc(null);
    setUgLocError(null);
    setAcceptedTerms(false);
    setSuccess(false);
  };

  const captureLocation = () => {
    if (!navigator.geolocation) {
      toast.error('Geolocation is not supported by your browser');
      return;
    }

    setCapturingLocation(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLatitude(position.coords.latitude);
        setLongitude(position.coords.longitude);
        setCapturingLocation(false);
        toast.success('📍 Property location captured');
      },
      (error) => {
        setCapturingLocation(false);
        toast.error('Failed to capture location. Please allow location access.');
        console.error('Geolocation error:', error);
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    if (!propertyAddress.trim()) {
      toast.error('Please provide the property address');
      return;
    }

    if (!ugLoc) {
      setUgLocError('Pick your official location (region → village) from the list.');
      toast.error('Please select the official location of the property');
      return;
    }

    if (!monthlyRent.trim()) {
      toast.error('Please provide the monthly rent amount');
      return;
    }

    if (!electricityMeter.trim() && !waterMeter.trim()) {
      toast.error('Please provide at least one meter number (UEDCL or NWSC)');
      return;
    }

    if (!acceptedTerms) {
      toast.error('Please accept the Welile Guaranteed Rent terms');
      return;
    }

    if (propertyStatus === 'occupied' && (!tenantName.trim() || !tenantPhone.trim())) {
      toast.error('Please provide tenant name and phone');
      return;
    }

    setLoading(true);

    try {
      // Get landlord's profile
      const { data: landlordProfile } = await supabase
        .from('profiles')
        .select('phone, full_name')
        .eq('id', user.id)
        .single();

      if (!landlordProfile) {
        toast.error('Could not load your profile');
        return;
      }

      // Find tenant if occupied
      let tenantProfileId: string | null = null;
      if (propertyStatus === 'occupied' && tenantPhone.trim()) {
        const { data: tenantProfile } = await supabase
          .from('profiles')
          .select('id')
          .eq('phone', tenantPhone.trim())
          .maybeSingle();
        tenantProfileId = tenantProfile?.id || null;
      }

      // Insert into landlords table
      const { data: landlordRecord, error: landlordError } = await supabase.from('landlords').insert({
        tenant_id: tenantProfileId,
        name: landlordProfile.full_name || 'Landlord',
        phone: landlordProfile.phone || '',
        property_address: propertyAddress.trim(),
        region: ugLoc.region ?? null,
        district: ugLoc.district,
        county: ugLoc.county,
        sub_county: ugLoc.subcounty,
        village: ugLoc.village,
        ug_village_id: ugLoc.villageId,
        monthly_rent: parseInt(monthlyRent),
        number_of_houses: numberOfHouses ? parseInt(numberOfHouses) : null,
        electricity_meter_number: electricityMeter.trim() || null,
        water_meter_number: waterMeter.trim() || null,
        caretaker_name: caretakerName.trim() || null,
        caretaker_phone: caretakerPhone.trim() || null,
        latitude,
        longitude,
        location_captured_at: latitude ? new Date().toISOString() : null,
        location_captured_by: user.id,
        registered_by: user.id,
        desired_rent_from_welile: parseInt(monthlyRent),
        ready_to_receive: false,
      }).select('id').single();

      if (landlordError) {
        if (landlordError.code === '23505') {
          toast.error('This property is already registered');
        } else {
          toast.error('Failed to register property');
          console.error('Registration error:', landlordError);
        }
        return;
      }

      // Save LC1 chairperson if provided — a phone uniquely identifies one
      // chairperson, so reuse the existing record instead of creating a duplicate.
      if (lc1Name.trim() && lc1Phone.trim() && lc1Village.trim()) {
        const { data: existingLc1 } = await supabase
          .from('lc1_chairpersons')
          .select('id')
          .eq('phone', lc1Phone.trim())
          .limit(1)
          .maybeSingle();

        if (!existingLc1) {
          const { error: lc1InsertError } = await supabase.from('lc1_chairpersons').insert({
            name: lc1Name.trim(),
            phone: lc1Phone.trim(),
            village: lc1Village.trim(),
          });
          // 23505 = phone already exists (a concurrent/normalized-format duplicate). Safe to ignore.
          if (lc1InsertError && lc1InsertError.code !== '23505') {
            console.error('LC1 save error:', lc1InsertError);
          }
        }
      }

      // If tenant has an account, create Welile Homes subscription
      if (tenantProfileId) {
        await supabase
          .from('profiles')
          .update({ monthly_rent: parseInt(monthlyRent) })
          .eq('id', tenantProfileId);

        await supabase
          .from('welile_homes_subscriptions')
          .insert({
            tenant_id: tenantProfileId,
            landlord_id: user.id,
            monthly_rent: parseInt(monthlyRent),
            subscription_status: 'active',
            landlord_registered: true,
            total_savings: 0,
            months_enrolled: 0,
            notes: `Guaranteed rent. Property: ${propertyAddress.trim()}. UEDCL: ${electricityMeter || 'N/A'}. NWSC: ${waterMeter || 'N/A'}.`,
          });
      }

      setSuccess(true);
      toast.success('Property registered for Guaranteed Rent!');
      onSuccess?.();
    } catch (err) {
      toast.error('An unexpected error occurred');
      console.error('Error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) resetForm();
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto ios-fixed-scroll" stable>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            Register Property
          </DialogTitle>
          <DialogDescription>
            Register your property for Welile Guaranteed Monthly Rent
          </DialogDescription>
        </DialogHeader>

        {success ? (
            <div className="py-8 text-center">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-success/20 flex items-center justify-center">
                <CheckCircle2 className="h-8 w-8 text-success" />
              </div>
              <h3 className="text-lg font-semibold mb-2">Property Registered!</h3>
              <p className="text-muted-foreground text-sm mb-2">
                A manager will verify your property to activate{' '}
                <span className="font-semibold text-primary">Guaranteed Monthly Rent</span>.
              </p>
              <div className="text-xs text-muted-foreground space-y-1 mb-4">
                <p>✅ Once verified, you receive guaranteed rent for 12 months</p>
                <p>✅ Rent paid to your Welile Wallet on your selected date</p>
                <p>✅ Welile replaces tenants who leave at no cost</p>
              </div>
              <Button onClick={() => handleOpenChange(false)}>Done</Button>
            </div>
          ) : (
            <form
              onSubmit={handleSubmit}
              className="space-y-5"
            >
              {/* Guaranteed Rent Banner */}
              <div className="p-3 rounded-xl bg-gradient-to-r from-primary/10 via-purple-500/10 to-success/10 border border-primary/20">
                <div className="flex items-start gap-2.5">
                  <div className="p-1.5 rounded-lg bg-primary/15 shrink-0 mt-0.5">
                    <Sparkles className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">Guaranteed Monthly Rent</p>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                      Register your property, get verified by a manager, and receive guaranteed rent for 12 months — paid to your Welile Wallet.
                    </p>
                  </div>
                </div>
              </div>

              {/* Property Details */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
                  <Home className="h-4 w-4 text-primary" />
                  Property Details
                </h4>

                <div className="space-y-1">
                  <Label htmlFor="rp-address" className="text-xs flex items-center gap-1">
                    <MapPin className="h-3 w-3" /> Property Address *
                  </Label>
                  <Input
                    id="rp-address"
                    value={propertyAddress}
                    onChange={(e) => setPropertyAddress(e.target.value)}
                    placeholder="e.g. Kira Road, Block 5"
                    className="h-9"
                    required
                  />
                </div>

                <UgLocationPicker
                  value={ugLoc}
                  onChange={(sel) => { setUgLoc(sel); setUgLocError(null); }}
                  label="Official location (region → village)"
                  required
                  error={ugLocError}
                />

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="rp-rent" className="text-xs flex items-center gap-1">
                      <Banknote className="h-3 w-3" /> Monthly Rent (UGX) *
                    </Label>
                    <Input
                      id="rp-rent"
                      type="number"
                      value={monthlyRent}
                      onChange={(e) => setMonthlyRent(e.target.value)}
                      placeholder="500000"
                      className="h-9"
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="rp-houses" className="text-xs">
                      Number of Houses
                    </Label>
                    <Input
                      id="rp-houses"
                      type="number"
                      value={numberOfHouses}
                      onChange={(e) => setNumberOfHouses(e.target.value)}
                      placeholder="e.g. 5"
                      className="h-9"
                    />
                  </div>
                </div>

                {/* Fee Breakdown */}
                {monthlyRent && parseInt(monthlyRent) > 0 && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="p-3 rounded-lg bg-muted/50 border border-border/50 space-y-2"
                  >
                    <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                      <TrendingUp className="h-3.5 w-3.5 text-success" />
                      Payout Breakdown
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="text-xs">
                        <p className="text-muted-foreground">Monthly Rent</p>
                        <p className="font-medium">{formatUGX(parseInt(monthlyRent))}</p>
                      </div>
                      <div className="text-xs">
                        <p className="text-muted-foreground">10% Platform Fee</p>
                        <p className="font-medium text-primary">{formatUGX(platformFee)}</p>
                      </div>
                      <div className="text-xs">
                        <p className="text-muted-foreground">You Receive</p>
                        <p className="font-medium text-success">{formatUGX(parseInt(monthlyRent) - platformFee)}</p>
                      </div>
                      <div className="text-xs">
                        <p className="text-muted-foreground">12-Month Total</p>
                        <p className="font-medium text-foreground">{formatUGX((parseInt(monthlyRent) - platformFee) * 12)}</p>
                      </div>
                    </div>
                  </motion.div>
                )}

                {/* Payout Date */}
                <div className="space-y-1">
                  <Label htmlFor="rp-payout-date" className="text-xs">
                    Preferred Payout Date (monthly)
                  </Label>
                  <Select value={payoutDate} onValueChange={setPayoutDate}>
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="Select day of month" />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 28 }, (_, i) => i + 1).map((day) => (
                        <SelectItem key={day} value={String(day)}>
                          {day}{day === 1 ? 'st' : day === 2 ? 'nd' : day === 3 ? 'rd' : 'th'} of every month
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Verification Details (Meters) */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
                  <Shield className="h-4 w-4 text-primary" />
                  Verification Details
                </h4>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="rp-uedcl" className="text-xs flex items-center gap-1">
                      <Zap className="h-3 w-3 text-amber-500" /> UEDCL Meter No.
                    </Label>
                    <Input
                      id="rp-uedcl"
                      value={electricityMeter}
                      onChange={(e) => setElectricityMeter(e.target.value)}
                      placeholder="Electricity meter"
                      className="h-9"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="rp-nwsc" className="text-xs flex items-center gap-1">
                      <Droplets className="h-3 w-3 text-blue-500" /> NWSC Meter No.
                    </Label>
                    <Input
                      id="rp-nwsc"
                      value={waterMeter}
                      onChange={(e) => setWaterMeter(e.target.value)}
                      placeholder="Water meter"
                      className="h-9"
                    />
                  </div>
                </div>

                <p className="text-[10px] text-muted-foreground">
                  At least one meter number is required for property verification
                </p>
              </div>

              {/* Caretaker Details */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
                  <User className="h-4 w-4 text-primary" />
                  Caretaker (Optional)
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="rp-caretaker-name" className="text-xs">
                      Caretaker Name
                    </Label>
                    <Input
                      id="rp-caretaker-name"
                      value={caretakerName}
                      onChange={(e) => setCaretakerName(e.target.value)}
                      placeholder="Name"
                      className="h-9"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="rp-caretaker-phone" className="text-xs">
                      Caretaker Phone
                    </Label>
                    <Input
                      id="rp-caretaker-phone"
                      value={caretakerPhone}
                      onChange={(e) => setCaretakerPhone(e.target.value)}
                      placeholder="0783..."
                      className="h-9"
                    />
                  </div>
                </div>
              </div>

              {/* GPS Location */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
                  <Navigation className="h-4 w-4 text-primary" />
                  Google Map Location
                </h4>
                <div className="p-3 rounded-lg bg-muted/50 border border-border/50">
                  {latitude && longitude ? (
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs text-success font-medium">📍 Location captured</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {latitude.toFixed(5)}, {longitude.toFixed(5)}
                        </p>
                        <a
                          href={`https://www.google.com/maps?q=${latitude},${longitude}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary underline mt-1 inline-block"
                        >
                          View on Google Maps
                        </a>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={captureLocation}
                        disabled={capturingLocation}
                      >
                        Re-capture
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full gap-2"
                      onClick={captureLocation}
                      disabled={capturingLocation}
                    >
                      {capturingLocation ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Capturing Location...
                        </>
                      ) : (
                        <>
                          <Navigation className="h-4 w-4" />
                          Capture Property Location
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>

              {/* Tenant Status */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
                  <UserPlus className="h-4 w-4 text-primary" />
                  Tenant Status
                </h4>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setPropertyStatus('occupied')}
                    className={`p-3 rounded-xl border-2 text-left transition-all ${
                      propertyStatus === 'occupied' 
                        ? 'border-primary bg-primary/5' 
                        : 'border-border hover:border-border/80'
                    }`}
                  >
                    <UserPlus className={`h-5 w-5 mb-1 ${propertyStatus === 'occupied' ? 'text-primary' : 'text-muted-foreground'}`} />
                    <p className="text-sm font-medium">Add Tenant</p>
                    <p className="text-[10px] text-muted-foreground">Has a tenant</p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPropertyStatus('empty')}
                    className={`p-3 rounded-xl border-2 text-left transition-all ${
                      propertyStatus === 'empty' 
                        ? 'border-primary bg-primary/5' 
                        : 'border-border hover:border-border/80'
                    }`}
                  >
                    <Home className={`h-5 w-5 mb-1 ${propertyStatus === 'empty' ? 'text-primary' : 'text-muted-foreground'}`} />
                    <p className="text-sm font-medium">Mark Empty</p>
                    <p className="text-[10px] text-muted-foreground">Welile finds tenant</p>
                  </button>
                </div>

                {propertyStatus === 'occupied' && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="grid grid-cols-2 gap-3"
                  >
                    <div className="space-y-1">
                      <Label htmlFor="rp-tenant-name" className="text-xs">
                        Tenant Name *
                      </Label>
                      <Input
                        id="rp-tenant-name"
                        value={tenantName}
                        onChange={(e) => setTenantName(e.target.value)}
                        placeholder="Full name"
                        className="h-9"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="rp-tenant-phone" className="text-xs">
                        Tenant Phone *
                      </Label>
                      <Input
                        id="rp-tenant-phone"
                        value={tenantPhone}
                        onChange={(e) => setTenantPhone(e.target.value)}
                        placeholder="0783..."
                        className="h-9"
                      />
                    </div>
                  </motion.div>
                )}
              </div>

              {/* LC1 Chairperson */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
                  <Shield className="h-4 w-4 text-primary" />
                  LC1 Chairperson
                </h4>
                <div className="p-3 rounded-lg bg-muted/50 border border-border/50 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="rp-lc1-name" className="text-xs">LC1 Name</Label>
                      <Input
                        id="rp-lc1-name"
                        value={lc1Name}
                        onChange={(e) => setLc1Name(e.target.value)}
                        placeholder="Chairperson name"
                        className="h-9"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="rp-lc1-phone" className="text-xs">LC1 Phone</Label>
                      <Input
                        id="rp-lc1-phone"
                        value={lc1Phone}
                        onChange={(e) => setLc1Phone(e.target.value)}
                        placeholder="0783..."
                        className="h-9"
                      />
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Village / Zone:{' '}
                    <span className="font-medium text-foreground">
                      {ugLoc ? ugLocationLabel(ugLoc) : 'select the official location above'}
                    </span>
                  </p>
                </div>
              </div>

              {/* Terms Agreement */}
              <div className="p-3 rounded-xl border border-amber-500/30 bg-amber-500/5">
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="rp-terms"
                    checked={acceptedTerms}
                    onCheckedChange={(checked) => setAcceptedTerms(checked === true)}
                    className="mt-0.5"
                  />
                  <label htmlFor="rp-terms" className="text-xs leading-relaxed text-muted-foreground cursor-pointer">
                    I agree to the <span className="font-semibold text-foreground">Welile Guaranteed Rent</span> terms:
                    A <span className="font-semibold text-primary">10% platform fee</span> is deducted from each rent deposit.
                    Once verified by a manager, I will receive{' '}
                    <span className="font-semibold text-success">guaranteed monthly rent for 12 months</span>{' '}
                    paid to my Welile Wallet.
                  </label>
                </div>
              </div>

              <Button type="submit" className="w-full" disabled={loading || !acceptedTerms}>
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Registering Property...
                  </>
                ) : (
                  <>
                    <Building2 className="h-4 w-4 mr-2" />
                    Register for Guaranteed Rent
                  </>
                )}
              </Button>
            </form>
          )}
      </DialogContent>
    </Dialog>
  );
}
