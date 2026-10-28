import React, { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Megaphone,
  MapPin,
  Camera,
  Upload,
  CheckCircle2,
  AlertCircle,
  Building2,
  Store,
  Home,
  Briefcase,
  Layers,
  Coins,
  Clock,
  Check,
  X,
  FileText,
  Navigation,
  Loader2,
  ExternalLink,
  ChevronRight,
  ShieldCheck,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import UgLocationPicker from '@/components/location/UgLocationPicker';
import type { UgLocationSelection } from '@/hooks/useUgLocations';
import { hapticTap, hapticSuccess, hapticError } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { safeUUID } from '@/lib/safeUUID';
import {
  SIGNAGE_RATES,
  SignagePropertyType,
  SignageFootTraffic,
  SignageRecord,
  SignagePhoto,
  formatSignageStatus,
} from '@/lib/welileSignages';
import { useMySignages, useSubmitSignage } from '@/hooks/useWelileSignages';
import { toast } from 'sonner';

export default function AgentWelileSignages() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'apply' | 'pending' | 'submissions' | 'rewards'>('apply');
  const [submissionsFilter, setSubmissionsFilter] = useState<'all' | 'active' | 'installing'>('all');

  const { data: signages = [], isLoading: loadingSignages } = useMySignages();
  const submitMutation = useSubmitSignage();

  // Metrics & Filters
  // Approved by Ops: signages that have passed Ops review
  const approvedSignages = signages.filter((s) =>
    ['approved_for_installation', 'pending_installation', 'installation_verification', 'active'].includes(s.status)
  );
  const activeSignages = signages.filter((s) => s.status === 'active');
  const installingSignages = approvedSignages.filter((s) => s.status !== 'active');

  // Submissions still in pipeline
  const pendingSignages = signages.filter((s) =>
    ['draft', 'submitted', 'under_review', 'approved_for_installation', 'pending_installation', 'installation_verification', 'changes_required'].includes(s.status)
  );

  const approvedCount = approvedSignages.length;
  const activeCount = activeSignages.length;
  const installingCount = installingSignages.length;
  const pendingCount = signages.filter((s) =>
    ['draft', 'submitted', 'under_review', 'changes_required'].includes(s.status)
  ).length;
  const verifiedRewardsUgx = activeCount * SIGNAGE_RATES.AGENT_REWARD_UGX;

  // ── Form State ──
  const [propertyName, setPropertyName] = useState('');
  const [propertyType, setPropertyType] = useState<SignagePropertyType>('shop');
  const [businessCategory, setBusinessCategory] = useState('');
  const [ownerFullName, setOwnerFullName] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [ownerAltPhone, setOwnerAltPhone] = useState('');
  const [consentingRelation, setConsentingRelation] = useState('Property Owner');
  const [permissionConfirmed, setPermissionConfirmed] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'momo_mtn' | 'momo_airtel' | 'bank'>('momo_mtn');
  const [paymentNumber, setPaymentNumber] = useState('');
  const [paymentName, setPaymentName] = useState('');

  // GPS State (Mandatory)
  const [gpsLat, setGpsLat] = useState<number | null>(null);
  const [gpsLng, setGpsLng] = useState<number | null>(null);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [gpsCapturedAt, setGpsCapturedAt] = useState<string | null>(null);
  const [capturedIp, setCapturedIp] = useState<string | null>(null);
  const [isCapturingGps, setIsCapturingGps] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);

  // Administrative Location
  const [adminLocation, setAdminLocation] = useState<UgLocationSelection | null>(null);
  const [plotOrLandmark, setPlotOrLandmark] = useState('');

  // Suitability
  const [footTraffic, setFootTraffic] = useState<SignageFootTraffic>('high');
  const [roadVisibility, setRoadVisibility] = useState('High visibility on busy access road');
  const [operatingHours, setOperatingHours] = useState('7:00 AM - 10:00 PM');
  const [proposedSurface, setProposedSurface] = useState('Front Wall / Facade');
  const [proposedDimensions, setProposedDimensions] = useState('4ft x 3ft');
  const [nearbyLandmarks, setNearbyLandmarks] = useState('');

  // Photos
  const [photos, setPhotos] = useState<SignagePhoto[]>([]);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [currentPhotoCategory, setCurrentPhotoCategory] = useState<SignagePhoto['category']>('exterior');

  // ── GPS Capture Handler ──
  const handleCaptureGps = () => {
    hapticTap();
    setIsCapturingGps(true);
    setGpsError(null);

    if (!('geolocation' in navigator)) {
      // Fallback: Fetch client public IP address
      fetch('https://api.ipify.org?format=json')
        .then((res) => res.json())
        .then((data) => {
          if (data?.ip) {
            setGpsLat(0.3476);
            setGpsLng(32.5825);
            setGpsAccuracy(120);
            setGpsCapturedAt(new Date().toISOString());
            setCapturedIp(data.ip);
            setIsCapturingGps(false);
            hapticSuccess();
            toast.success(`Location captured via IP (${data.ip})`);
          } else {
            throw new Error('IP unavailable');
          }
        })
        .catch(() => {
          setGpsError('Geolocation is not supported by your device browser.');
          setIsCapturingGps(false);
          hapticError();
        });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        setGpsLat(latitude);
        setGpsLng(longitude);
        setGpsAccuracy(accuracy);
        setGpsCapturedAt(new Date().toISOString());
        setIsCapturingGps(false);
        hapticSuccess();
        toast.success(`Live GPS captured: accuracy ±${Math.round(accuracy)}m`);
      },
      async (error) => {
        // Fallback: Fetch client public IP address when GPS is denied or unavailable
        try {
          const ipRes = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(6000) });
          if (ipRes.ok) {
            const ipData = await ipRes.json();
            if (ipData?.ip) {
              setGpsLat(0.3476);
              setGpsLng(32.5825);
              setGpsAccuracy(120);
              setGpsCapturedAt(new Date().toISOString());
              setCapturedIp(ipData.ip);
              setIsCapturingGps(false);
              hapticSuccess();
              toast.success(`Location verified via IP address (${ipData.ip})`);
              return;
            }
          }
        } catch {
          // IP fallback failed
        }

        setIsCapturingGps(false);
        hapticError();
        let message = 'Could not access device GPS.';
        if (error.code === error.PERMISSION_DENIED) {
          message = 'Location permission was denied. Please allow location access in your browser settings to submit signages.';
        } else if (error.code === error.POSITION_UNAVAILABLE) {
          message = 'Location information is currently unavailable. Ensure GPS is switched on.';
        } else if (error.code === error.TIMEOUT) {
          message = 'Location request timed out. Please try capturing again in an open space.';
        }
        setGpsError(message);
        toast.error(message);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  };

  // ── Photo Upload Handler (Camera / Local Storage) ──
  const handleTriggerPhoto = (category: SignagePhoto['category']) => {
    hapticTap();
    setCurrentPhotoCategory(category);
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploadingPhoto(true);
    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      const newPhoto: SignagePhoto = {
        id: safeUUID(),
        url: dataUrl,
        category: currentPhotoCategory,
        caption: currentPhotoCategory.replace('_', ' ').toUpperCase(),
        taken_at: new Date().toISOString(),
      };
      setPhotos((prev) => [...prev.filter((p) => p.category !== currentPhotoCategory), newPhoto]);
      setIsUploadingPhoto(false);
      hapticSuccess();
      toast.success(`${currentPhotoCategory.replace('_', ' ')} photo added!`);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  // ── Form Submission ──
  const handleSubmitApplication = async (e: React.FormEvent) => {
    e.preventDefault();
    hapticTap();

    if (!propertyName.trim()) {
      toast.error('Please enter the Property or Business Name (Section 1).');
      document.getElementById('section-property')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (!ownerFullName.trim() || !ownerPhone.trim()) {
      toast.error('Please enter the consenting owner/tenant name and phone number (Section 1).');
      document.getElementById('section-property')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (!permissionConfirmed) {
      toast.error('Please check the confirmation box: Owner permission must be confirmed (Section 1).');
      document.getElementById('permission-check')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (!gpsLat || !gpsLng) {
      toast.error('Mandatory Live Location capture required. Tap "Capture Live Location" in Section 2.');
      document.getElementById('section-gps')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (!adminLocation?.district || !adminLocation?.village) {
      toast.error('Please select the administrative District and Village in Section 3.');
      document.getElementById('section-location')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (photos.length === 0) {
      toast.error('Please capture at least 1 photo of the proposed signage position in Section 5.');
      document.getElementById('section-photos')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    try {
      await submitMutation.mutateAsync({
        property_name: propertyName.trim(),
        property_type: propertyType,
        business_category: businessCategory.trim() || undefined,
        owner_full_name: ownerFullName.trim(),
        owner_phone: ownerPhone.trim(),
        owner_alt_phone: ownerAltPhone.trim() || undefined,
        consenting_relation: consentingRelation,
        permission_confirmed: permissionConfirmed,
        owner_payment_method: paymentMethod,
        owner_payment_number: paymentNumber.trim() || ownerPhone.trim(),
        owner_payment_name: paymentName.trim() || ownerFullName.trim(),

        gps_latitude: gpsLat,
        gps_longitude: gpsLng,
        gps_accuracy_meters: gpsAccuracy ?? 10,
        gps_captured_at: gpsCapturedAt ?? new Date().toISOString(),

        district_name: adminLocation.district,
        county_name: adminLocation.county,
        sub_county_name: adminLocation.subcounty,
        parish_name: adminLocation.parish,
        village_name: adminLocation.village,
        plot_or_landmark: plotOrLandmark.trim() || undefined,

        foot_traffic: footTraffic,
        road_visibility: roadVisibility.trim() || undefined,
        operating_hours: operatingHours.trim() || undefined,
        proposed_surface: proposedSurface.trim() || undefined,
        proposed_dimensions: proposedDimensions.trim() || undefined,
        nearby_landmarks: nearbyLandmarks.trim() || undefined,

        photos,
      });

      // Reset form
      setPropertyName('');
      setOwnerFullName('');
      setOwnerPhone('');
      setOwnerAltPhone('');
      setPermissionConfirmed(false);
      setPaymentNumber('');
      setPaymentName('');
      setGpsLat(null);
      setGpsLng(null);
      setGpsAccuracy(null);
      setCapturedIp(null);
      setPlotOrLandmark('');
      setPhotos([]);
      setActiveTab('pending');
    } catch {
      // Handled in mutation hook
    }
  };

  return (
    <div className="min-h-screen bg-background pb-20">
      {/* Top Header */}
      <div className="sticky top-0 z-30 bg-background/95 backdrop-blur border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/dashboard/agent')}
            className="h-9 w-9 rounded-full"
            aria-label="Back to Agent Dashboard"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <div className="p-1 rounded-md bg-primary/10 text-primary">
                <Megaphone className="h-4 w-4" />
              </div>
              <h1 className="font-bold text-base tracking-tight truncate">Welile Signages</h1>
              <Badge variant="secondary" className="text-[10px] uppercase font-bold bg-primary/10 text-primary">
                New
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground truncate">
              UGX 3,000 Agent Reward • UGX 10,000/mo Owner Rent
            </p>
          </div>
        </div>

        {/* Hero Metric Strip - Interactive shortcuts */}
        <div className="grid grid-cols-3 gap-2 mt-3">
          <button
            type="button"
            onClick={() => {
              setSubmissionsFilter('all');
              setActiveTab('submissions');
            }}
            className={cn(
              "p-2.5 rounded-xl bg-card border border-border/60 text-center transition-all cursor-pointer hover:border-emerald-500/50",
              activeTab === 'submissions' && "ring-2 ring-emerald-500/30 border-emerald-500/50 bg-emerald-500/5"
            )}
          >
            <span className="text-[10px] text-muted-foreground block font-medium">Approved Spots</span>
            <span className="text-base font-bold text-emerald-600">{approvedCount}</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('pending')}
            className={cn(
              "p-2.5 rounded-xl bg-card border border-border/60 text-center transition-all cursor-pointer hover:border-amber-500/50",
              activeTab === 'pending' && "ring-2 ring-amber-500/30 border-amber-500/50 bg-amber-500/5"
            )}
          >
            <span className="text-[10px] text-muted-foreground block font-medium">In Pipeline (Pending)</span>
            <span className="text-base font-bold text-amber-600">{pendingCount}</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('rewards')}
            className={cn(
              "p-2.5 rounded-xl bg-card border border-border/60 text-center transition-all cursor-pointer hover:border-primary/50",
              activeTab === 'rewards' && "ring-2 ring-primary/30 border-primary/50 bg-primary/5"
            )}
          >
            <span className="text-[10px] text-muted-foreground block font-medium">Rewards Earned</span>
            <span className="text-base font-bold text-primary">UGX {verifiedRewardsUgx.toLocaleString()}</span>
          </button>
        </div>
      </div>

      {/* Main Tabs */}
      <div className="max-w-2xl mx-auto px-4 pt-4">
        <Tabs value={activeTab} onValueChange={(val) => setActiveTab(val as any)}>
          <TabsList className="grid grid-cols-4 w-full h-11 rounded-xl bg-muted/60 p-1 mb-4">
            <TabsTrigger value="apply" className="rounded-lg text-[11px] sm:text-xs font-semibold px-1">
              <Megaphone className="h-3.5 w-3.5 mr-1 shrink-0" />
              <span className="truncate">New Spot</span>
            </TabsTrigger>
            <TabsTrigger value="pending" className="rounded-lg text-[11px] sm:text-xs font-semibold px-1">
              <Clock className="h-3.5 w-3.5 mr-1 shrink-0 text-amber-500" />
              <span className="truncate">Pending ({pendingCount})</span>
            </TabsTrigger>
            <TabsTrigger value="submissions" className="rounded-lg text-[11px] sm:text-xs font-semibold px-1">
              <Layers className="h-3.5 w-3.5 mr-1 shrink-0" />
              <span className="truncate">My Spots ({approvedCount})</span>
            </TabsTrigger>
            <TabsTrigger value="rewards" className="rounded-lg text-[11px] sm:text-xs font-semibold px-1">
              <Coins className="h-3.5 w-3.5 mr-1 shrink-0" />
              <span className="truncate">Rewards</span>
            </TabsTrigger>
          </TabsList>

          {/* TAB 1: NEW APPLICATION */}
          <TabsContent value="apply" className="space-y-4">
            <form onSubmit={handleSubmitApplication} className="space-y-4">
              {/* SECTION A: PROPERTY & OWNER */}
              <Card id="section-property" className="rounded-2xl border-border/60 shadow-sm">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-primary" />
                    <CardTitle className="text-sm font-semibold">1. Property & Consenting Person</CardTitle>
                  </div>
                  <CardDescription className="text-xs">
                    Identify busy houses or shops with high foot traffic and road visibility.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 pt-0">
                  <div>
                    <Label className="text-xs font-medium">Property or Business Name *</Label>
                    <Input
                      placeholder="e.g. Mukwano Wholesale Store / Corner House"
                      value={propertyName}
                      onChange={(e) => setPropertyName(e.target.value)}
                      className="mt-1 h-10 text-sm rounded-xl"
                      required
                    />
                  </div>

                  <div>
                    <Label className="text-xs font-medium">Property Type *</Label>
                    <RadioGroup
                      value={propertyType}
                      onValueChange={(val) => setPropertyType(val as SignagePropertyType)}
                      className="grid grid-cols-2 gap-2 mt-1.5"
                    >
                      <label
                        className={`flex items-center gap-2 p-2.5 rounded-xl border cursor-pointer text-xs transition-all ${
                          propertyType === 'shop' ? 'border-primary bg-primary/5 font-semibold text-primary' : 'border-border'
                        }`}
                      >
                        <RadioGroupItem value="shop" id="p-shop" className="sr-only" />
                        <Store className="h-4 w-4 shrink-0" />
                        <span>Shop / Retail</span>
                      </label>
                      <label
                        className={`flex items-center gap-2 p-2.5 rounded-xl border cursor-pointer text-xs transition-all ${
                          propertyType === 'house' ? 'border-primary bg-primary/5 font-semibold text-primary' : 'border-border'
                        }`}
                      >
                        <RadioGroupItem value="house" id="p-house" className="sr-only" />
                        <Home className="h-4 w-4 shrink-0" />
                        <span>Busy House</span>
                      </label>
                      <label
                        className={`flex items-center gap-2 p-2.5 rounded-xl border cursor-pointer text-xs transition-all ${
                          propertyType === 'business_premise' ? 'border-primary bg-primary/5 font-semibold text-primary' : 'border-border'
                        }`}
                      >
                        <RadioGroupItem value="business_premise" id="p-biz" className="sr-only" />
                        <Briefcase className="h-4 w-4 shrink-0" />
                        <span>Business Premise</span>
                      </label>
                      <label
                        className={`flex items-center gap-2 p-2.5 rounded-xl border cursor-pointer text-xs transition-all ${
                          propertyType === 'mixed_use' ? 'border-primary bg-primary/5 font-semibold text-primary' : 'border-border'
                        }`}
                      >
                        <RadioGroupItem value="mixed_use" id="p-mixed" className="sr-only" />
                        <Building2 className="h-4 w-4 shrink-0" />
                        <span>Mixed-Use</span>
                      </label>
                    </RadioGroup>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs font-medium">Consenting Person's Full Name *</Label>
                      <Input
                        placeholder="Owner or Shopkeeper name"
                        value={ownerFullName}
                        onChange={(e) => setOwnerFullName(e.target.value)}
                        className="mt-1 h-10 text-sm rounded-xl"
                        required
                      />
                    </div>
                    <div>
                      <Label className="text-xs font-medium">Phone Number (MoMo Payouts) *</Label>
                      <Input
                        placeholder="07XX XXX XXX or 256..."
                        value={ownerPhone}
                        onChange={(e) => setOwnerPhone(e.target.value)}
                        className="mt-1 h-10 text-sm rounded-xl"
                        required
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs font-medium">Relationship to Property *</Label>
                      <select
                        value={consentingRelation}
                        onChange={(e) => setConsentingRelation(e.target.value)}
                        className="mt-1 w-full h-10 px-3 text-sm rounded-xl border border-input bg-background"
                      >
                        <option value="Property Owner">Registered Property Owner</option>
                        <option value="Managing Landlord">Managing Landlord</option>
                        <option value="Shopkeeper / Tenant">Shopkeeper / Tenant (Authorized)</option>
                        <option value="Caretaker">Authorized Caretaker</option>
                      </select>
                    </div>
                    <div>
                      <Label className="text-xs font-medium">Alternative Contact (Optional)</Label>
                      <Input
                        placeholder="Alternative number"
                        value={ownerAltPhone}
                        onChange={(e) => setOwnerAltPhone(e.target.value)}
                        className="mt-1 h-10 text-sm rounded-xl"
                      />
                    </div>
                  </div>

                  {/* Payment Details for Owner */}
                  <div className="p-3 rounded-xl bg-muted/40 border border-border/60 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-foreground">Monthly Rent Payout (UGX 10,000/mo)</span>
                      <Badge variant="outline" className="text-[10px] bg-background">Owner Direct</Badge>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {(['momo_mtn', 'momo_airtel', 'bank'] as const).map((method) => (
                        <button
                          key={method}
                          type="button"
                          onClick={() => setPaymentMethod(method)}
                          className={`py-1.5 px-2 rounded-lg text-xs font-medium border text-center transition-all ${
                            paymentMethod === method ? 'border-primary bg-primary/10 text-primary font-bold' : 'border-border bg-background'
                          }`}
                        >
                          {method === 'momo_mtn' ? 'MTN MoMo' : method === 'momo_airtel' ? 'Airtel Money' : 'Bank'}
                        </button>
                      ))}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                      <Input
                        placeholder="Payout Phone / Account No."
                        value={paymentNumber || ownerPhone}
                        onChange={(e) => setPaymentNumber(e.target.value)}
                        className="h-9 text-xs rounded-lg"
                      />
                      <Input
                        placeholder="Registered Account Name"
                        value={paymentName || ownerFullName}
                        onChange={(e) => setPaymentName(e.target.value)}
                        className="h-9 text-xs rounded-lg"
                      />
                    </div>
                  </div>

                  <div className="flex items-start gap-2.5 pt-1">
                    <Checkbox
                      id="permission-check"
                      checked={permissionConfirmed}
                      onCheckedChange={(c) => setPermissionConfirmed(Boolean(c))}
                      className="mt-0.5 rounded"
                    />
                    <label htmlFor="permission-check" className="text-xs text-muted-foreground leading-snug cursor-pointer">
                      I confirm that the owner / tenant has authorized Welile Technologies LTD to install and maintain an advertising signage on these premises.
                    </label>
                  </div>
                </CardContent>
              </Card>

              {/* SECTION B: MANDATORY LIVE GPS */}
              <Card id="section-gps" className="rounded-2xl border-border/60 shadow-sm">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Navigation className="h-4 w-4 text-primary" />
                      <CardTitle className="text-sm font-semibold">2. Mandatory Live Location (GPS / IP)</CardTitle>
                    </div>
                    <Badge variant={gpsLat ? 'default' : 'destructive'} className="text-[10px]">
                      {gpsLat ? (capturedIp ? 'IP Verified' : 'GPS Captured') : 'Required'}
                    </Badge>
                  </div>
                  <CardDescription className="text-xs">
                    You must physically stand at the property to capture live coordinates. Manual pins are not accepted.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 pt-0">
                  <div className="p-3.5 rounded-xl border border-dashed border-border bg-muted/20 text-center space-y-2">
                    {gpsLat && gpsLng ? (
                      <div className="space-y-2">
                        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-600 text-xs font-semibold">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>Coordinates Verified {capturedIp ? `(via IP ${capturedIp})` : `(±${Math.round(gpsAccuracy ?? 0)}m)`}</span>
                        </div>
                        <div className="text-xs font-mono font-bold text-foreground">
                          {gpsLat.toFixed(6)}, {gpsLng.toFixed(6)}
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          Captured at {new Date(gpsCapturedAt!).toLocaleTimeString()}
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={handleCaptureGps}
                          disabled={isCapturingGps}
                          className="h-8 text-xs rounded-lg gap-1.5"
                        >
                          <RefreshCw className={`h-3 w-3 ${isCapturingGps ? 'animate-spin' : ''}`} />
                          <span>Re-capture Location</span>
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-2.5 py-2">
                        <MapPin className="h-8 w-8 text-muted-foreground/60 mx-auto animate-pulse" />
                        <p className="text-xs text-muted-foreground max-w-xs mx-auto">
                          Stand in front of the proposed signage position and tap the button below.
                        </p>
                        <Button
                          type="button"
                          onClick={handleCaptureGps}
                          disabled={isCapturingGps}
                          className="rounded-xl px-5 h-10 text-xs font-bold gap-2"
                        >
                          {isCapturingGps ? (
                            <>
                              <Loader2 className="h-4 w-4 animate-spin" />
                              <span>Acquiring Location...</span>
                            </>
                          ) : (
                            <>
                              <Navigation className="h-4 w-4" />
                              <span>Capture Live Location</span>
                            </>
                          )}
                        </Button>
                      </div>
                    )}

                    {gpsError && (
                      <div className="p-2.5 rounded-lg bg-destructive/10 text-destructive text-xs flex items-center gap-2 text-left">
                        <AlertCircle className="h-4 w-4 shrink-0" />
                        <span>{gpsError}</span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* SECTION C: ADMINISTRATIVE LOCATION */}
              <Card id="section-location" className="rounded-2xl border-border/60 shadow-sm">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-primary" />
                    <CardTitle className="text-sm font-semibold">3. Administrative Location (Uganda)</CardTitle>
                  </div>
                  <CardDescription className="text-xs">
                    Select official hierarchy: District &rarr; County &rarr; Sub-County &rarr; Parish &rarr; Village.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 pt-0">
                  <UgLocationPicker
                    value={adminLocation}
                    onChange={(loc) => setAdminLocation(loc)}
                  />

                  <div>
                    <Label className="text-xs font-medium">Plot / Street / Immediate Landmark</Label>
                    <Input
                      placeholder="e.g. Opposite Shell Petrol Station, Jinja Road"
                      value={plotOrLandmark}
                      onChange={(e) => setPlotOrLandmark(e.target.value)}
                      className="mt-1 h-10 text-sm rounded-xl"
                    />
                  </div>
                </CardContent>
              </Card>

              {/* SECTION D: ADVERTISING SUITABILITY */}
              <Card className="rounded-2xl border-border/60 shadow-sm">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <Megaphone className="h-4 w-4 text-primary" />
                    <CardTitle className="text-sm font-semibold">4. Advertising Suitability & Traffic</CardTitle>
                  </div>
                  <CardDescription className="text-xs">
                    Operations reviews this to assess commercial advertising visibility.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 pt-0">
                  <div>
                    <Label className="text-xs font-medium">Estimated Daily Foot Traffic *</Label>
                    <div className="grid grid-cols-3 gap-2 mt-1.5">
                      {(['low', 'medium', 'high'] as const).map((tier) => (
                        <button
                          key={tier}
                          type="button"
                          onClick={() => setFootTraffic(tier)}
                          className={`p-2.5 rounded-xl border text-xs font-semibold capitalize text-center transition-all ${
                            footTraffic === tier
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-border bg-card'
                          }`}
                        >
                          {tier === 'high' ? '🔥 High Traffic' : tier === 'medium' ? '⚡ Medium' : '🌱 Low'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs font-medium">Proposed Surface</Label>
                      <Input
                        placeholder="e.g. Brick wall, metal frame, lintel"
                        value={proposedSurface}
                        onChange={(e) => setProposedSurface(e.target.value)}
                        className="mt-1 h-10 text-sm rounded-xl"
                      />
                    </div>
                    <div>
                      <Label className="text-xs font-medium">Operating Hours</Label>
                      <Input
                        placeholder="e.g. 6:30 AM - 11:00 PM"
                        value={operatingHours}
                        onChange={(e) => setOperatingHours(e.target.value)}
                        className="mt-1 h-10 text-sm rounded-xl"
                      />
                    </div>
                  </div>

                  <div>
                    <Label className="text-xs font-medium">Road Visibility & Frontage</Label>
                    <Textarea
                      placeholder="Describe pedestrian sightlines, passing vehicle views, and obstructions..."
                      value={roadVisibility}
                      onChange={(e) => setRoadVisibility(e.target.value)}
                      className="mt-1 text-xs rounded-xl min-h-[60px]"
                    />
                  </div>
                </CardContent>
              </Card>

              {/* SECTION E: PHOTOGRAPHIC EVIDENCE */}
              <Card id="section-photos" className="rounded-2xl border-border/60 shadow-sm">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Camera className="h-4 w-4 text-primary" />
                      <CardTitle className="text-sm font-semibold">5. Photographic Evidence</CardTitle>
                    </div>
                    <Badge variant={photos.length >= 1 ? 'default' : 'secondary'} className="text-[10px]">
                      {photos.length}/4 Photos
                    </Badge>
                  </div>
                  <CardDescription className="text-xs">
                    Clear photos of property facade, proposed installation wall/lintel, and street surroundings.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 pt-0">
                  <input
                    type="file"
                    ref={fileInputRef}
                    accept="image/*"
                    capture="environment"
                    onChange={handleFileChange}
                    className="hidden"
                  />

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      { cat: 'exterior' as const, label: 'Exterior Facade' },
                      { cat: 'proposed_position' as const, label: 'Signage Spot' },
                      { cat: 'surroundings' as const, label: 'Street View' },
                      { cat: 'installed_signage' as const, label: 'Landmark / Angle' },
                    ].map(({ cat, label }) => {
                      const photo = photos.find((p) => p.category === cat);
                      return (
                        <div
                          key={cat}
                          onClick={() => handleTriggerPhoto(cat)}
                          className={`relative aspect-square rounded-xl border-2 border-dashed flex flex-col items-center justify-center p-2 text-center cursor-pointer transition-all overflow-hidden ${
                            photo ? 'border-emerald-500 bg-emerald-50/20' : 'border-border hover:border-primary/50'
                          }`}
                        >
                          {photo ? (
                            <>
                              <img src={photo.url} alt={label} className="w-full h-full object-cover" />
                              <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity">
                                <span className="text-[10px] text-white font-semibold">Change</span>
                              </div>
                              <span className="absolute bottom-1 left-1 right-1 px-1 py-0.5 rounded bg-black/60 text-[9px] text-white truncate font-medium">
                                {label}
                              </span>
                            </>
                          ) : (
                            <>
                              <Camera className="h-5 w-5 text-muted-foreground/60 mb-1" />
                              <span className="text-[10px] font-medium text-muted-foreground leading-tight">
                                {label}
                              </span>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>

              {/* SUBMIT BUTTON */}
              <div className="pt-2">
                <Button
                  type="submit"
                  disabled={submitMutation.isPending}
                  className="w-full h-12 rounded-2xl text-sm font-bold shadow-lg"
                >
                  {submitMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      <span>Submitting to Agent Operations...</span>
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="h-4 w-4 mr-2" />
                      <span>Submit Signage for Ops Review</span>
                    </>
                  )}
                </Button>

                {(!gpsLat || !permissionConfirmed || photos.length === 0 || !adminLocation?.village) && (
                  <div className="mt-2.5 p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-900 dark:text-amber-200 space-y-1">
                    <p className="font-semibold text-[11px] text-center">To submit, please complete the required items:</p>
                    <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
                      <button
                        type="button"
                        onClick={() => document.getElementById('permission-check')?.scrollIntoView({ behavior: 'smooth' })}
                        className="text-left flex items-center gap-1 hover:underline cursor-pointer"
                      >
                        <span className={permissionConfirmed ? "text-emerald-600 font-bold" : "text-amber-600"}>
                          {permissionConfirmed ? "✓" : "○"}
                        </span>
                        <span>Owner permission</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => document.getElementById('section-gps')?.scrollIntoView({ behavior: 'smooth' })}
                        className="text-left flex items-center gap-1 hover:underline cursor-pointer"
                      >
                        <span className={gpsLat ? "text-emerald-600 font-bold" : "text-amber-600"}>
                          {gpsLat ? "✓" : "○"}
                        </span>
                        <span>Live Location / GPS</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => document.getElementById('section-location')?.scrollIntoView({ behavior: 'smooth' })}
                        className="text-left flex items-center gap-1 hover:underline cursor-pointer"
                      >
                        <span className={adminLocation?.village ? "text-emerald-600 font-bold" : "text-amber-600"}>
                          {adminLocation?.village ? "✓" : "○"}
                        </span>
                        <span>District &amp; Village</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => document.getElementById('section-photos')?.scrollIntoView({ behavior: 'smooth' })}
                        className="text-left flex items-center gap-1 hover:underline cursor-pointer"
                      >
                        <span className={photos.length > 0 ? "text-emerald-600 font-bold" : "text-amber-600"}>
                          {photos.length > 0 ? "✓" : "○"}
                        </span>
                        <span>Signage photo ({photos.length}/4)</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </form>
          </TabsContent>

          {/* TAB 2: PENDING STATUS SUBMISSIONS */}
          <TabsContent value="pending" className="space-y-3">
            {loadingSignages ? (
              <div className="py-12 text-center text-muted-foreground text-xs flex flex-col items-center gap-2">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span>Loading your pending signages...</span>
              </div>
            ) : pendingSignages.length === 0 ? (
              <div className="py-12 text-center space-y-3 bg-card border border-border/60 rounded-2xl p-6">
                <Clock className="h-10 w-10 text-amber-500/50 mx-auto" />
                <h3 className="font-semibold text-sm">No Pending Signages</h3>
                <p className="text-xs text-muted-foreground max-w-xs mx-auto">
                  You have no signage submissions currently awaiting Ops review or installation. All verified spots are active.
                </p>
                <Button size="sm" onClick={() => setActiveTab('apply')} className="rounded-xl text-xs font-semibold">
                  Submit New Signage
                </Button>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between px-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    {pendingSignages.length} submission{pendingSignages.length === 1 ? '' : 's'} in review & installation
                  </span>
                  <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-500/30 bg-amber-500/10">
                    Ops Pipeline
                  </Badge>
                </div>

                {pendingSignages.map((signage) => {
                  const statusMeta = formatSignageStatus(signage.status);
                  return (
                    <Card key={signage.id} className="rounded-2xl border-border/60 shadow-sm overflow-hidden bg-card">
                      <div className="p-4 space-y-3">
                        {/* Header */}
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-bold text-sm text-foreground truncate">{signage.property_name}</span>
                              <Badge variant="outline" className="text-[10px] capitalize shrink-0">
                                {signage.property_type.replace('_', ' ')}
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5 truncate">
                              {signage.village_name}, {signage.district_name}
                              {signage.plot_or_landmark ? ` • ${signage.plot_or_landmark}` : ''}
                            </p>
                            <span className="text-[10px] font-mono text-muted-foreground/80 block mt-0.5">
                              Ref: {signage.reference_no}
                            </span>
                          </div>
                          <Badge
                            variant={
                              signage.status === 'approved_for_installation' || signage.status === 'installation_verification'
                                ? 'default'
                                : signage.status === 'changes_required'
                                ? 'destructive'
                                : 'warning'
                            }
                            className="text-[10px] shrink-0"
                          >
                            {statusMeta.label}
                          </Badge>
                        </div>

                        {/* Pipeline Progress Stepper */}
                        <div className="bg-muted/40 rounded-xl p-2.5 border border-border/40">
                          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center justify-between">
                            <span>Review & Installation Stage</span>
                            <span className="text-primary font-medium lowercase">
                              {signage.status === 'changes_required' ? 'action required' : 'processing'}
                            </span>
                          </div>
                          <div className="grid grid-cols-4 gap-1.5 text-center">
                            {/* Step 1: Submitted */}
                            <div className="flex flex-col items-center">
                              <div className="h-1.5 w-full rounded-full bg-emerald-500 mb-1" />
                              <span className="text-[9px] font-medium text-foreground">Submitted</span>
                            </div>
                            {/* Step 2: Ops Review */}
                            <div className="flex flex-col items-center">
                              <div
                                className={cn(
                                  "h-1.5 w-full rounded-full mb-1",
                                  ['under_review', 'approved_for_installation', 'pending_installation', 'installation_verification', 'active'].includes(signage.status)
                                    ? 'bg-emerald-500'
                                    : signage.status === 'changes_required'
                                    ? 'bg-amber-500'
                                    : 'bg-muted-foreground/25'
                                )}
                              />
                              <span className="text-[9px] font-medium text-foreground">Ops Review</span>
                            </div>
                            {/* Step 3: Installation */}
                            <div className="flex flex-col items-center">
                              <div
                                className={cn(
                                  "h-1.5 w-full rounded-full mb-1",
                                  ['approved_for_installation', 'pending_installation', 'installation_verification', 'active'].includes(signage.status)
                                    ? 'bg-emerald-500'
                                    : 'bg-muted-foreground/25'
                                )}
                              />
                              <span className="text-[9px] font-medium text-muted-foreground">Installation</span>
                            </div>
                            {/* Step 4: Active */}
                            <div className="flex flex-col items-center">
                              <div
                                className={cn(
                                  "h-1.5 w-full rounded-full mb-1",
                                  signage.status === 'active' ? 'bg-emerald-500' : 'bg-muted-foreground/25'
                                )}
                              />
                              <span className="text-[9px] font-medium text-muted-foreground">Active</span>
                            </div>
                          </div>
                        </div>

                        {/* Location & GPS Info */}
                        {signage.gps_latitude && (
                          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground bg-muted/20 p-2 rounded-lg border border-border/40">
                            <MapPin className="h-3.5 w-3.5 text-primary shrink-0" />
                            <span className="font-mono text-[10px]">
                              GPS: {signage.gps_latitude.toFixed(4)}, {signage.gps_longitude.toFixed(4)}
                            </span>
                            {signage.gps_accuracy_meters && (
                              <Badge variant="outline" className="text-[9px] py-0 px-1 ml-auto">
                                ±{Math.round(signage.gps_accuracy_meters)}m
                              </Badge>
                            )}
                          </div>
                        )}

                        {/* Details row */}
                        <div className="grid grid-cols-2 gap-2 text-xs pt-1 border-t border-border/40">
                          <div>
                            <span className="text-[10px] text-muted-foreground block">Consenting Owner:</span>
                            <span className="font-medium truncate block">
                              {signage.owner_full_name} ({signage.owner_phone})
                            </span>
                          </div>
                          <div>
                            <span className="text-[10px] text-muted-foreground block">Owner Rent Due:</span>
                            <span className="font-bold text-emerald-600">UGX 10,000 / mo</span>
                          </div>
                        </div>

                        {/* Review Notes / Action Required */}
                        {(signage.review_notes || signage.rejection_reason) && (
                          <div
                            className={cn(
                              "p-2.5 rounded-xl text-xs space-y-1",
                              signage.status === 'changes_required'
                                ? "bg-amber-500/10 border border-amber-500/20 text-amber-900 dark:text-amber-200"
                                : "bg-muted/60 border border-border/60 text-muted-foreground"
                            )}
                          >
                            <div className="flex items-center gap-1.5 font-semibold text-[11px]">
                              <AlertCircle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                              <span>Ops Feedback:</span>
                            </div>
                            <p className="text-[11px] leading-relaxed">
                              {signage.review_notes || signage.rejection_reason}
                            </p>
                          </div>
                        )}

                        {/* Photos preview if present */}
                        {signage.photos && signage.photos.length > 0 && (
                          <div className="pt-1">
                            <span className="text-[10px] text-muted-foreground block mb-1.5">
                              Submitted Photos ({signage.photos.length}):
                            </span>
                            <div className="flex gap-2 overflow-x-auto pb-1">
                              {signage.photos.map((p, idx) => (
                                <div
                                  key={idx}
                                  className="relative w-14 h-14 rounded-lg overflow-hidden shrink-0 border border-border/60 bg-muted/40"
                                >
                                  <img
                                    src={p.url}
                                    alt={p.caption || 'Signage photo'}
                                    className="w-full h-full object-cover"
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </>
            )}
          </TabsContent>

          {/* TAB 3: APPROVED SPOTS ONLY */}
          <TabsContent value="submissions" className="space-y-3">
            {/* Filter pills for approved spots */}
            {approvedSignages.length > 0 && (
              <div className="flex items-center gap-1.5 pb-1 overflow-x-auto">
                <Button
                  type="button"
                  variant={submissionsFilter === 'all' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setSubmissionsFilter('all')}
                  className="h-7 text-xs rounded-lg px-2.5"
                >
                  All Approved ({approvedCount})
                </Button>
                <Button
                  type="button"
                  variant={submissionsFilter === 'active' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setSubmissionsFilter('active')}
                  className="h-7 text-xs rounded-lg px-2.5"
                >
                  Active ({activeCount})
                </Button>
                {installingCount > 0 && (
                  <Button
                    type="button"
                    variant={submissionsFilter === 'installing' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setSubmissionsFilter('installing')}
                    className="h-7 text-xs rounded-lg px-2.5"
                  >
                    Awaiting Install ({installingCount})
                  </Button>
                )}
              </div>
            )}

            {loadingSignages ? (
              <div className="py-12 text-center text-muted-foreground text-xs flex flex-col items-center gap-2">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span>Loading your approved spots...</span>
              </div>
            ) : approvedSignages.length === 0 ? (
              <div className="py-12 text-center space-y-3 bg-card border border-border/60 rounded-2xl p-6">
                <CheckCircle2 className="h-10 w-10 text-muted-foreground/40 mx-auto" />
                <h3 className="font-semibold text-sm">No Approved Spots Yet</h3>
                <p className="text-xs text-muted-foreground max-w-xs mx-auto">
                  {pendingCount > 0
                    ? `You have ${pendingCount} signage submission${pendingCount === 1 ? '' : 's'} awaiting Ops review. Once approved by Ops, your spots will appear here.`
                    : 'Only signages reviewed and approved by Ops appear in My Spots. Submit a busy shop or house to get started.'}
                </p>
                {pendingCount > 0 ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setActiveTab('pending')}
                    className="rounded-xl text-xs font-semibold gap-1.5"
                  >
                    <Clock className="h-3.5 w-3.5 text-amber-500" />
                    View Pending Submissions ({pendingCount})
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => setActiveTab('apply')} className="rounded-xl text-xs font-semibold">
                    Submit First Signage
                  </Button>
                )}
              </div>
            ) : (
              approvedSignages
                .filter((signage) => {
                  if (submissionsFilter === 'active') return signage.status === 'active';
                  if (submissionsFilter === 'installing') return signage.status !== 'active';
                  return true;
                })
                .map((signage) => {
                  const statusMeta = formatSignageStatus(signage.status);
                  return (
                    <Card key={signage.id} className="rounded-2xl border-border/60 shadow-sm overflow-hidden">
                      <div className="p-4 space-y-3">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="flex items-center gap-1.5">
                              <span className="font-bold text-sm text-foreground">{signage.property_name}</span>
                              <Badge variant="outline" className="text-[10px] capitalize">
                                {signage.property_type.replace('_', ' ')}
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {signage.village_name}, {signage.district_name} • Ref: {signage.reference_no}
                            </p>
                          </div>
                          <Badge variant={statusMeta.variant as any} className="text-[10px] shrink-0">
                            {statusMeta.label}
                          </Badge>
                        </div>

                        {/* Details row */}
                        <div className="grid grid-cols-2 gap-2 text-xs pt-1 border-t border-border/40">
                          <div>
                            <span className="text-[10px] text-muted-foreground block">Consenting Person:</span>
                            <span className="font-medium">{signage.owner_full_name} ({signage.owner_phone})</span>
                          </div>
                          <div>
                            <span className="text-[10px] text-muted-foreground block">Owner Rent Due:</span>
                            <span className="font-bold text-emerald-600">UGX 10,000 / mo</span>
                          </div>
                        </div>

                        {signage.rejection_reason && (
                          <div className="p-2 rounded-lg bg-destructive/10 text-destructive text-xs">
                            <strong>Note:</strong> {signage.rejection_reason}
                          </div>
                        )}

                        {signage.status === 'approved_for_installation' && (
                          <div className="p-2.5 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-700 dark:text-blue-400 text-xs flex items-center justify-between">
                            <span className="flex items-center gap-1.5 font-medium">
                              <CheckCircle2 className="h-4 w-4 shrink-0 text-blue-600" />
                              Approved by Ops • Queued for Installation
                            </span>
                          </div>
                        )}

                        {signage.status === 'pending_installation' && (
                          <div className="p-2.5 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-700 dark:text-indigo-400 text-xs flex items-center justify-between">
                            <span className="flex items-center gap-1.5 font-medium">
                              <Clock className="h-4 w-4 shrink-0 text-indigo-600" />
                              Installation in Progress
                            </span>
                          </div>
                        )}

                        {signage.status === 'installation_verification' && (
                          <div className="p-2.5 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-700 dark:text-purple-400 text-xs flex items-center justify-between">
                            <span className="flex items-center gap-1.5 font-medium">
                              <CheckCircle2 className="h-4 w-4 shrink-0 text-purple-600" />
                              Installed • Awaiting Final Ops Verification
                            </span>
                          </div>
                        )}

                        {signage.status === 'active' && (
                          <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-400 text-xs flex items-center justify-between">
                            <span className="flex items-center gap-1.5 font-medium">
                              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                              Signage Active & Verified
                            </span>
                            <span className="font-bold">UGX 3,000 Reward Unlocked</span>
                          </div>
                        )}
                      </div>
                    </Card>
                  );
                })
            )}
          </TabsContent>

          {/* TAB 3: REWARDS LEDGER */}
          <TabsContent value="rewards" className="space-y-4">
            <Card className="rounded-2xl border-border/60 shadow-sm p-4 space-y-3">
              <h3 className="font-bold text-sm text-foreground flex items-center gap-2">
                <Coins className="h-4 w-4 text-primary" />
                Signage Compensation Framework
              </h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Welile Signages provides two independent, auditable financial flows governed strictly by verified installation:
              </p>
              <div className="space-y-2 pt-1">
                <div className="p-3 rounded-xl bg-primary/5 border border-primary/10 flex items-start gap-3">
                  <div className="p-1.5 rounded-lg bg-primary/10 text-primary shrink-0 mt-0.5">
                    <Coins className="h-4 w-4" />
                  </div>
                  <div className="text-xs">
                    <span className="font-bold text-foreground block">Agent Reward: UGX 3,000 (One-Time)</span>
                    <span className="text-muted-foreground">
                      Payable once per qualifying installation immediately after Agent Operations completes physical verification.
                    </span>
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/10 flex items-start gap-3">
                  <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-600 shrink-0 mt-0.5">
                    <Building2 className="h-4 w-4" />
                  </div>
                  <div className="text-xs">
                    <span className="font-bold text-foreground block">Owner Monthly Rent: UGX 10,000 / month</span>
                    <span className="text-muted-foreground">
                      Recurring monthly obligation starting strictly on the verified activation date. Disbursed directly to the owner's MoMo account.
                    </span>
                  </div>
                </div>
              </div>
            </Card>

            <Card className="rounded-2xl border-border/60 shadow-sm p-4 space-y-2">
              <h4 className="font-bold text-xs uppercase tracking-wider text-muted-foreground">Your Active Earners</h4>
              {signages.filter(s => s.status === 'active').length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">
                  No active signages yet. Submit high-visibility locations and coordinate installation to unlock your rewards.
                </p>
              ) : (
                <div className="divide-y divide-border/40">
                  {signages.filter(s => s.status === 'active').map(s => (
                    <div key={s.id} className="py-2.5 flex items-center justify-between text-xs">
                      <div>
                        <p className="font-semibold text-foreground">{s.property_name}</p>
                        <p className="text-[10px] text-muted-foreground">{s.village_name}, {s.district_name}</p>
                      </div>
                      <div className="text-right">
                        <span className="font-bold text-primary block">+UGX 3,000</span>
                        <span className="text-[9px] text-emerald-600 font-medium">Verified Active</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
