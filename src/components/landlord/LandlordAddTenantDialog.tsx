import { useState } from 'react';
import { Lc1VillagePicker } from '@/components/location/Lc1VillagePicker';
import { motion, AnimatePresence } from 'framer-motion';
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
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
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
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';

interface LandlordAddTenantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export default function LandlordAddTenantDialog({
  open,
  onOpenChange,
  onSuccess,
}: LandlordAddTenantDialogProps) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [capturingLocation, setCapturingLocation] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  // Tenant info
  const [tenantName, setTenantName] = useState('');
  const [tenantPhone, setTenantPhone] = useState('');

  // Rental details
  const [propertyAddress, setPropertyAddress] = useState('');
  const [monthlyRent, setMonthlyRent] = useState('');
  const [numberOfRooms, setNumberOfRooms] = useState('');
  const [rentalNotes, setRentalNotes] = useState('');

  // Location
  const [latitude, setLatitude] = useState<number | null>(null);
  const [longitude, setLongitude] = useState<number | null>(null);

  // LC1 Chairperson
  const [lc1Name, setLc1Name] = useState('');
  const [lc1Phone, setLc1Phone] = useState('');
  const [lc1Village, setLc1Village] = useState('');

  const platformFee = monthlyRent ? Math.round(parseInt(monthlyRent) * 0.10) : 0;

  const resetForm = () => {
    setTenantName('');
    setTenantPhone('');
    setPropertyAddress('');
    setMonthlyRent('');
    setNumberOfRooms('');
    setRentalNotes('');
    setLatitude(null);
    setLongitude(null);
    setLc1Name('');
    setLc1Phone('');
    setLc1Village('');
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
        toast.success('Location captured successfully');
      },
      (error) => {
        setCapturingLocation(false);
        toast.error('Failed to capture location. Please allow location access.');
        console.error('Geolocation error:', error);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    if (!tenantName.trim() || !tenantPhone.trim()) {
      toast.error('Please provide tenant name and phone');
      return;
    }

    if (!propertyAddress.trim()) {
      toast.error('Please provide the property address');
      return;
    }

    if (!monthlyRent.trim()) {
      toast.error('Please provide the monthly rent amount');
      return;
    }

    if (!acceptedTerms) {
      toast.error('Please accept the Welile Guaranteed Rent terms');
      return;
    }

    setLoading(true);

    try {
      // Find tenant by phone
      const { data: tenantProfile } = await supabase
        .from('profiles')
        .select('id')
        .eq('phone', tenantPhone.trim())
        .maybeSingle();

      // Get landlord's own profile for phone
      const { data: landlordProfile } = await supabase
        .from('profiles')
        .select('phone, full_name')
        .eq('id', user.id)
        .single();

      if (!landlordProfile) {
        toast.error('Could not load your profile');
        setLoading(false);
        return;
      }

      // Insert into landlords table
      const { data: landlordRecord, error: landlordError } = await supabase.from('landlords').insert({
        tenant_id: tenantProfile?.id || null,
        name: landlordProfile.full_name || 'Landlord',
        phone: landlordProfile.phone || '',
        property_address: propertyAddress.trim(),
        monthly_rent: parseInt(monthlyRent),
        number_of_houses: numberOfRooms ? parseInt(numberOfRooms) : null,
        latitude: latitude,
        longitude: longitude,
        location_captured_at: latitude ? new Date().toISOString() : null,
        location_captured_by: user.id,
        registered_by: user.id,
      }).select('id').single();

      if (landlordError) {
        if (landlordError.code === '23505') {
          toast.error('This tenant is already registered at this property');
        } else {
          toast.error('Failed to register tenant');
          console.error('Registration error:', landlordError);
        }
        setLoading(false);
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

      // If tenant has an account, update their rent info and create Welile Homes subscription
      if (tenantProfile?.id) {
        // Update tenant profile
        await supabase
          .from('profiles')
          .update({
            monthly_rent: parseInt(monthlyRent),
          })
          .eq('id', tenantProfile.id);

        // Create Welile Homes subscription for this tenant (landlord-registered)
        const { error: subError } = await supabase
          .from('welile_homes_subscriptions')
          .insert({
            tenant_id: tenantProfile.id,
            landlord_id: user.id,
            monthly_rent: parseInt(monthlyRent),
            subscription_status: 'active',
            landlord_registered: true,
            total_savings: 0,
            months_enrolled: 0,
            notes: `Guaranteed rent subscription. Landlord: ${landlordProfile.full_name}. Property: ${propertyAddress.trim()}. 10% platform fee auto-saved to Welile Homes.`,
          });

        if (subError && subError.code !== '23505') {
          console.error('Welile Homes subscription error:', subError);
          // Don't block - tenant is already registered
        }
      }

      setSuccess(true);
      toast.success('Tenant registered under Welile Guaranteed Rent!');
      onSuccess?.();
    } catch (err) {
      toast.error('An unexpected error occurred');
      console.error('Error:', err);
    }

    setLoading(false);
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) resetForm();
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <User className="h-5 w-5 text-primary" />
            Add a Tenant
          </DialogTitle>
          <DialogDescription>
            Register your tenant under Welile Guaranteed Rent
          </DialogDescription>
        </DialogHeader>

        <AnimatePresence mode="wait">
          {success ? (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="py-8 text-center"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 300, damping: 20, delay: 0.1 }}
                className="w-16 h-16 mx-auto mb-4 rounded-full bg-emerald-500/20 flex items-center justify-center"
              >
                <CheckCircle2 className="h-8 w-8 text-emerald-500" />
              </motion.div>
              <h3 className="text-lg font-semibold mb-2">Tenant Registered!</h3>
              <p className="text-muted-foreground text-sm mb-2">
                Your tenant is now under <span className="font-semibold text-primary">Welile Guaranteed Rent</span>.
              </p>
              <div className="text-xs text-muted-foreground space-y-1 mb-4">
                <p>✅ 10% platform fee will be auto-saved to their Welile Homes</p>
                <p>✅ Their savings grow at 5% monthly (compounding)</p>
                <p>✅ Your rent is guaranteed even if the tenant leaves</p>
              </div>
              <Button onClick={() => handleOpenChange(false)}>Done</Button>
            </motion.div>
          ) : (
            <motion.form
              key="form"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              onSubmit={handleSubmit}
              className="space-y-5"
            >
              {/* Guaranteed Rent Banner */}
              <div className="p-3 rounded-xl bg-gradient-to-r from-primary/10 via-purple-500/10 to-emerald-500/10 border border-primary/20">
                <div className="flex items-start gap-2.5">
                  <div className="p-1.5 rounded-lg bg-primary/15 shrink-0 mt-0.5">
                    <Sparkles className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">Welile Guaranteed Rent</p>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                      Your rent is guaranteed every month. If this tenant leaves, Welile will find a replacement through our agent network at no extra cost.
                    </p>
                  </div>
                </div>
              </div>

              {/* Tenant Details */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
                  <User className="h-4 w-4 text-primary" />
                  Tenant Details
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="lt-tenantName" className="text-xs">
                      Full Name *
                    </Label>
                    <Input
                      id="lt-tenantName"
                      value={tenantName}
                      onChange={(e) => setTenantName(e.target.value)}
                      placeholder="Tenant's full name"
                      className="h-9"
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="lt-tenantPhone" className="text-xs">
                      Phone Number *
                    </Label>
                    <Input
                      id="lt-tenantPhone"
                      value={tenantPhone}
                      onChange={(e) => setTenantPhone(e.target.value)}
                      placeholder="0783..."
                      className="h-9"
                      required
                    />
                  </div>
                </div>
              </div>

              {/* Rental Details */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
                  <Home className="h-4 w-4 text-primary" />
                  Rental Details
                </h4>

                <div className="space-y-1">
                  <Label htmlFor="lt-propertyAddress" className="text-xs flex items-center gap-1">
                    <MapPin className="h-3 w-3" /> Property Address *
                  </Label>
                  <Input
                    id="lt-propertyAddress"
                    value={propertyAddress}
                    onChange={(e) => setPropertyAddress(e.target.value)}
                    placeholder="e.g. Kira Road, Block 5, Room 12"
                    className="h-9"
                    required
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="lt-monthlyRent" className="text-xs flex items-center gap-1">
                      <Banknote className="h-3 w-3" /> Monthly Rent (UGX) *
                    </Label>
                    <Input
                      id="lt-monthlyRent"
                      type="number"
                      value={monthlyRent}
                      onChange={(e) => setMonthlyRent(e.target.value)}
                      placeholder="500000"
                      className="h-9"
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="lt-numberOfRooms" className="text-xs">
                      Number of Rooms
                    </Label>
                    <Input
                      id="lt-numberOfRooms"
                      type="number"
                      value={numberOfRooms}
                      onChange={(e) => setNumberOfRooms(e.target.value)}
                      placeholder="e.g. 2"
                      className="h-9"
                    />
                  </div>
                </div>

                {/* Platform Fee Breakdown */}
                {monthlyRent && parseInt(monthlyRent) > 0 && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="p-3 rounded-lg bg-muted/50 border border-border/50 space-y-2"
                  >
                    <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                      <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
                      Fee & Savings Breakdown
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
                        <p className="font-medium text-emerald-600">{formatUGX(parseInt(monthlyRent) - platformFee)}</p>
                      </div>
                      <div className="text-xs">
                        <p className="text-muted-foreground">Tenant's Welile Homes</p>
                        <p className="font-medium text-purple-600">{formatUGX(platformFee)}/mo + 5% growth</p>
                      </div>
                    </div>
                  </motion.div>
                )}

                <div className="space-y-1">
                  <Label htmlFor="lt-rentalNotes" className="text-xs">
                    Additional Notes
                  </Label>
                  <Textarea
                    id="lt-rentalNotes"
                    value={rentalNotes}
                    onChange={(e) => setRentalNotes(e.target.value)}
                    placeholder="Any extra details about the rental..."
                    className="min-h-[60px] resize-none"
                  />
                </div>
              </div>

              {/* Location Capture */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
                  <Navigation className="h-4 w-4 text-primary" />
                  Property Location
                </h4>
                <div className="p-3 rounded-lg bg-muted/50 border border-border/50">
                  {latitude && longitude ? (
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs text-emerald-500 font-medium">📍 Location captured</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {latitude.toFixed(5)}, {longitude.toFixed(5)}
                        </p>
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
                          Capturing...
                        </>
                      ) : (
                        <>
                          <Navigation className="h-4 w-4" />
                          Capture Current Location
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>

              {/* LC1 Chairperson */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
                  <Shield className="h-4 w-4 text-primary" />
                  LC1 Chairperson Details
                </h4>
                <div className="p-3 rounded-lg bg-muted/50 border border-border/50 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="lt-lc1Name" className="text-xs">
                        LC1 Name
                      </Label>
                      <Input
                        id="lt-lc1Name"
                        value={lc1Name}
                        onChange={(e) => setLc1Name(e.target.value)}
                        placeholder="Chairperson name"
                        className="h-9"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="lt-lc1Phone" className="text-xs">
                        LC1 Phone
                      </Label>
                      <Input
                        id="lt-lc1Phone"
                        value={lc1Phone}
                        onChange={(e) => setLc1Phone(e.target.value)}
                        placeholder="0783..."
                        className="h-9"
                      />
                    </div>
                  </div>
                  <Lc1VillagePicker
                    className="space-y-1"
                    value={lc1Village}
                    onChange={(name) => setLc1Village(name)}
                  />
                </div>
              </div>

              {/* Terms Agreement */}
              <div className="p-3 rounded-xl border border-amber-500/30 bg-amber-500/5">
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="lt-terms"
                    checked={acceptedTerms}
                    onCheckedChange={(checked) => setAcceptedTerms(checked === true)}
                    className="mt-0.5"
                  />
                  <label htmlFor="lt-terms" className="text-xs leading-relaxed text-muted-foreground cursor-pointer">
                    I agree to the <span className="font-semibold text-foreground">Welile Guaranteed Rent</span> terms:
                    A <span className="font-semibold text-primary">10% platform fee</span> is deducted from each rent deposit and saved into the tenant's{' '}
                    <span className="font-semibold text-purple-600">Welile Homes</span> account, growing at{' '}
                    <span className="font-semibold text-emerald-600">5% monthly compounding</span>.
                    Welile guarantees continuous rent and will replace tenants who leave at no extra cost.
                  </label>
                </div>
              </div>

              <Button type="submit" className="w-full" disabled={loading || !acceptedTerms}>
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Registering Tenant...
                  </>
                ) : (
                  <>
                    <Shield className="h-4 w-4 mr-2" />
                    Register Under Guaranteed Rent
                  </>
                )}
              </Button>
            </motion.form>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
