import { useState } from 'react';
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
import {
  Building2,
  MapPin,
  Banknote,
  Loader2,
  CheckCircle2,
  Home,
  Navigation,
  Phone,
  User,
  BedDouble,
  Zap,
  Droplets,
  Shield,
} from 'lucide-react';
import { toast } from 'sonner';

interface AgentManagedPropertyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function AgentManagedPropertyDialog({
  open,
  onOpenChange,
  onSuccess,
}: AgentManagedPropertyDialogProps) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [capturingLocation, setCapturingLocation] = useState(false);

  // Landlord info
  const [landlordName, setLandlordName] = useState('');
  const [landlordPhone, setLandlordPhone] = useState('');
  const [mobileMoneyNumber, setMobileMoneyNumber] = useState('');

  // Property details
  const [propertyAddress, setPropertyAddress] = useState('');
  const [description, setDescription] = useState('');
  const [numberOfRooms, setNumberOfRooms] = useState('');
  const [numberOfHouses, setNumberOfHouses] = useState('');
  const [monthlyRent, setMonthlyRent] = useState('');
  const [electricityMeter, setElectricityMeter] = useState('');
  const [waterMeter, setWaterMeter] = useState('');

  // Location
  const [latitude, setLatitude] = useState<number | null>(null);
  const [longitude, setLongitude] = useState<number | null>(null);

  // Caretaker
  const [caretakerName, setCaretakerName] = useState('');
  const [caretakerPhone, setCaretakerPhone] = useState('');

  const managementFee = monthlyRent ? Math.round(parseInt(monthlyRent) * 0.02) : 0;

  const resetForm = () => {
    setLandlordName(''); setLandlordPhone(''); setMobileMoneyNumber('');
    setPropertyAddress(''); setDescription(''); setNumberOfRooms('');
    setNumberOfHouses(''); setMonthlyRent(''); setElectricityMeter('');
    setWaterMeter(''); setLatitude(null); setLongitude(null);
    setCaretakerName(''); setCaretakerPhone('');
    setSuccess(false);
  };

  const captureLocation = () => {
    if (!navigator.geolocation) {
      toast.error('Geolocation not supported');
      return;
    }
    setCapturingLocation(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLatitude(pos.coords.latitude);
        setLongitude(pos.coords.longitude);
        setCapturingLocation(false);
        toast.success('📍 Location captured');
      },
      () => {
        setCapturingLocation(false);
        toast.error('Failed to capture location');
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    if (!landlordName.trim() || !landlordPhone.trim()) {
      toast.error('Please provide landlord name and phone');
      return;
    }
    if (!mobileMoneyNumber.trim()) {
      toast.error('Please provide landlord mobile money number for payouts');
      return;
    }
    if (!propertyAddress.trim() || !monthlyRent.trim()) {
      toast.error('Please provide address and monthly rent');
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.from('landlords').insert({
        name: landlordName.trim(),
        phone: landlordPhone.trim(),
        mobile_money_number: mobileMoneyNumber.trim(),
        property_address: propertyAddress.trim(),
        description: description.trim() || null,
        number_of_rooms: numberOfRooms ? parseInt(numberOfRooms) : null,
        number_of_houses: numberOfHouses ? parseInt(numberOfHouses) : null,
        monthly_rent: parseInt(monthlyRent),
        electricity_meter_number: electricityMeter.trim() || null,
        water_meter_number: waterMeter.trim() || null,
        caretaker_name: caretakerName.trim() || null,
        caretaker_phone: caretakerPhone.trim() || null,
        latitude,
        longitude,
        location_captured_at: latitude ? new Date().toISOString() : null,
        location_captured_by: user.id,
        registered_by: user.id,
        has_smartphone: false,
        is_agent_managed: true,
        managed_by_agent_id: user.id,
        management_fee_rate: 0.02,
        desired_rent_from_welile: parseInt(monthlyRent),
        ready_to_receive: false,
      });

      if (error) {
        toast.error('Failed to register property');
        console.error(error);
      } else {
        setSuccess(true);
        toast.success('Property registered under your management!');
        onSuccess?.();
      }
    } catch (err) {
      toast.error('An unexpected error occurred');
      console.error(err);
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
            <Building2 className="h-5 w-5 text-primary" />
            Manage Property for Landlord
          </DialogTitle>
          <DialogDescription>
            Register a property on behalf of a landlord without a smartphone. You earn 2% management fee on every rent paid.
          </DialogDescription>
        </DialogHeader>

        <AnimatePresence mode="wait">
          {success ? (
            <motion.div key="success" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="py-8 text-center">
              <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 20, delay: 0.1 }}
                className="w-16 h-16 mx-auto mb-4 rounded-full bg-success/20 flex items-center justify-center">
                <CheckCircle2 className="h-8 w-8 text-success" />
              </motion.div>
              <h3 className="text-lg font-semibold mb-2">Property Registered!</h3>
              <p className="text-muted-foreground text-sm mb-4">
                You now manage this property on behalf of <span className="font-semibold">{landlordName}</span>. 
                You'll earn 2% on every rent payment.
              </p>
              <Button onClick={() => handleOpenChange(false)}>Done</Button>
            </motion.div>
          ) : (
            <motion.form key="form" initial={{ opacity: 0 }} animate={{ opacity: 1 }} onSubmit={handleSubmit} className="space-y-5">
              {/* Management Fee Banner */}
              <div className="p-3 rounded-xl bg-gradient-to-r from-amber-500/10 to-success/10 border border-amber-500/20">
                <p className="text-sm font-semibold">🏠 Agent Property Management</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  For landlords without smartphones. You manage payouts & earn <span className="font-bold text-success">2% management fee</span> per rent payment.
                </p>
              </div>

              {/* Landlord Details */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-1.5">
                  <User className="h-4 w-4 text-primary" /> Landlord Details
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Landlord Name *</Label>
                    <Input value={landlordName} onChange={(e) => setLandlordName(e.target.value)} placeholder="Full name" className="h-9" required />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Phone Number *</Label>
                    <Input value={landlordPhone} onChange={(e) => setLandlordPhone(e.target.value)} placeholder="0771234567" className="h-9" required />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs flex items-center gap-1"><Phone className="h-3 w-3" /> Mobile Money Number (for payouts) *</Label>
                  <Input value={mobileMoneyNumber} onChange={(e) => setMobileMoneyNumber(e.target.value)} placeholder="0771234567" className="h-9" required />
                </div>
              </div>

              {/* Property Details */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-1.5">
                  <Home className="h-4 w-4 text-primary" /> Property Details
                </h4>
                <div className="space-y-1">
                  <Label className="text-xs flex items-center gap-1"><MapPin className="h-3 w-3" /> Address *</Label>
                  <Input value={propertyAddress} onChange={(e) => setPropertyAddress(e.target.value)} placeholder="e.g. Kira Road, Block 5" className="h-9" required />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Description</Label>
                  <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Property description..." rows={2} />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs flex items-center gap-1"><Banknote className="h-3 w-3" /> Rent/month *</Label>
                    <Input type="number" value={monthlyRent} onChange={(e) => setMonthlyRent(e.target.value)} placeholder="500000" className="h-9" required />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Houses</Label>
                    <Input type="number" value={numberOfHouses} onChange={(e) => setNumberOfHouses(e.target.value)} placeholder="5" className="h-9" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs flex items-center gap-1"><BedDouble className="h-3 w-3" /> Rooms</Label>
                    <Input type="number" value={numberOfRooms} onChange={(e) => setNumberOfRooms(e.target.value)} placeholder="10" className="h-9" />
                  </div>
                </div>

                {/* Fee preview */}
                {monthlyRent && parseInt(monthlyRent) > 0 && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                    className="p-3 rounded-lg bg-success/10 border border-success/20 text-xs">
                    <p className="font-semibold text-success">Your 2% Management Fee: UGX {managementFee.toLocaleString()}/month</p>
                    <p className="text-muted-foreground">Automatically credited when tenant pays rent</p>
                  </motion.div>
                )}
              </div>

              {/* Meters */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-1.5">
                  <Shield className="h-4 w-4 text-primary" /> Verification Details
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs flex items-center gap-1"><Zap className="h-3 w-3 text-amber-500" /> UEDCL Meter</Label>
                    <Input value={electricityMeter} onChange={(e) => setElectricityMeter(e.target.value)} placeholder="Electricity" className="h-9" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs flex items-center gap-1"><Droplets className="h-3 w-3 text-blue-500" /> NWSC Meter</Label>
                    <Input value={waterMeter} onChange={(e) => setWaterMeter(e.target.value)} placeholder="Water" className="h-9" />
                  </div>
                </div>
              </div>

              {/* Caretaker */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold">Caretaker (optional)</h4>
                <div className="grid grid-cols-2 gap-3">
                  <Input value={caretakerName} onChange={(e) => setCaretakerName(e.target.value)} placeholder="Caretaker name" className="h-9" />
                  <Input value={caretakerPhone} onChange={(e) => setCaretakerPhone(e.target.value)} placeholder="Caretaker phone" className="h-9" />
                </div>
              </div>

              {/* GPS */}
              <Button type="button" variant="outline" size="sm" className="w-full" onClick={captureLocation} disabled={capturingLocation}>
                {capturingLocation ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Navigation className="h-4 w-4 mr-2" />}
                {latitude ? '📍 Location Captured' : 'Capture Property Location'}
              </Button>

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Building2 className="h-4 w-4 mr-2" />}
                Register Managed Property
              </Button>
            </motion.form>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
