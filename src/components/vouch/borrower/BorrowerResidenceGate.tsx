import { useState, useEffect, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Building2, MapPin, UserCheck, Loader2,
  CheckCircle2, Plus, Search, X, ArrowRight, Home, Gavel,
  Clock, XCircle, BadgeCheck, Send, Bell, Mail, MessageSquare,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import LandlordRegistrationForm from '@/components/shared/LandlordRegistrationForm';
import { LandlordAutocompleteInput } from '@/components/agent/LandlordAutocompleteInput';
import type { LandlordOption } from '@/components/agent/LandlordSearchSelect';
import { UgLocationPicker } from '@/components/location/UgLocationPicker';
import type { UgLocationSelection } from '@/hooks/useUgLocations';

export type VerifStatus = 'verified' | 'pending' | 'rejected';

interface LinkedLandlord {
  id: string;
  name: string;
  phone: string | null;
  verified: boolean | null;
  verification_status: VerifStatus | null;
  verification_reason: string | null;
  latitude: number | null;
  longitude: number | null;
  property_address: string | null;
  village: string | null;
  district: string | null;
  registered_by: string | null;
}

interface LinkedLc1 {
  id: string;
  name: string;
  phone: string | null;
  verified: boolean | null;
  verification_status: VerifStatus | null;
  verification_reason: string | null;
  village: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired once the borrower's residence profile is complete and they tap continue. */
  onComplete: () => void;
}

/** Authoritative verification status comes from the verification_status column,
 *  falling back to the legacy verified boolean. */
function landlordVerifStatus(l: LinkedLandlord): VerifStatus {
  if (l.verification_status) return l.verification_status;
  return l.verified ? 'verified' : 'pending';
}
function lc1VerifStatus(l: LinkedLc1): VerifStatus {
  if (l.verification_status) return l.verification_status;
  return l.verified ? 'verified' : 'pending';
}

/** A residence profile is allowed to request a loan ONLY when the borrower has a
 *  VERIFIED landlord WITH GPS, and a VERIFIED LC1 chairperson. Pending / rejected
 *  records block the request. */
export function isResidenceComplete(landlord: LinkedLandlord | null, lc1: LinkedLc1 | null) {
  const landlordOk = !!landlord && landlordVerifStatus(landlord) === 'verified' && landlord.latitude != null && landlord.longitude != null;
  const lc1Ok = !!lc1 && lc1VerifStatus(lc1) === 'verified';
  return landlordOk && lc1Ok;
}

/** Pill that renders the pending / verified / rejected verification state. */
function StatusBadge({ status }: { status: VerifStatus }) {
  if (status === 'verified') {
    return <Badge className="bg-emerald-500/15 text-emerald-700 border-0 text-[9px] font-bold gap-0.5"><BadgeCheck className="h-2.5 w-2.5" />Verified</Badge>;
  }
  if (status === 'rejected') {
    return <Badge className="bg-destructive/15 text-destructive border-0 text-[9px] font-bold gap-0.5"><XCircle className="h-2.5 w-2.5" />Rejected</Badge>;
  }
  return <Badge className="bg-amber-500/15 text-amber-700 border-0 text-[9px] font-bold gap-0.5"><Clock className="h-2.5 w-2.5" />Pending review</Badge>;
}

export default function BorrowerResidenceGate({ open, onOpenChange, onComplete }: Props) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [landlord, setLandlord] = useState<LinkedLandlord | null>(null);
  const [lc1, setLc1] = useState<LinkedLc1 | null>(null);
  const [agentName, setAgentName] = useState<string | null>(null);

  // verification status derived from the *.verified flag + the borrower's own
  // verification-request rows (pending/rejected).
  const [landlordStatus, setLandlordStatus] = useState<VerifStatus>('pending');
  const [lc1Status, setLc1Status] = useState<VerifStatus>('pending');
  const [landlordReject, setLandlordReject] = useState<string | null>(null);
  const [lc1Reject, setLc1Reject] = useState<string | null>(null);
  const [llReqState, setLlReqState] = useState<'idle' | 'sending' | 'sent' | 'exists'>('idle');
  const [lc1ReqState, setLc1ReqState] = useState<'idle' | 'sending' | 'sent' | 'exists'>('idle');
  const [meContact, setMeContact] = useState<{ full_name: string | null; phone: string | null }>({ full_name: null, phone: null });

  // optional email / SMS alert preferences
  const [notifyEmail, setNotifyEmail] = useState(true);
  const [notifySms, setNotifySms] = useState(true);
  const [hasEmail, setHasEmail] = useState(false);

  // sub-flows
  const [addLandlord, setAddLandlord] = useState(false);
  const [addLc1, setAddLc1] = useState(false);

  // landlord search
  const [landlordSearch, setLandlordSearch] = useState('');

  // lc1 search + manual add
  const [lc1Search, setLc1Search] = useState('');
  const [lc1Results, setLc1Results] = useState<LinkedLc1[]>([]);
  const [lc1Searching, setLc1Searching] = useState(false);
  const [lc1Form, setLc1Form] = useState({ name: '', phone: '', village: '' });
  // Official dataset village for a newly-added LC1 (mandatory).
  const [lc1UgLoc, setLc1UgLoc] = useState<UgLocationSelection | null>(null);

  const loadProfile = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setLlReqState('idle');
    setLc1ReqState('idle');
    setLandlordReject(null);
    setLc1Reject(null);
    const { data: prof } = await supabase
      .from('profiles')
      .select('borrower_landlord_id, borrower_lc1_id, full_name, phone, email, verification_notify_email, verification_notify_sms')
      .eq('id', user.id)
      .maybeSingle();
    setMeContact({ full_name: prof?.full_name ?? null, phone: prof?.phone ?? null });
    setNotifyEmail((prof as any)?.verification_notify_email ?? true);
    setNotifySms((prof as any)?.verification_notify_sms ?? true);
    setHasEmail(!!(prof as any)?.email);

    let ll: LinkedLandlord | null = null;
    if (prof?.borrower_landlord_id) {
      const { data } = await supabase
        .from('landlords_directory')
        .select('id, name, phone, verified, verification_status, verification_reason, latitude, longitude, property_address, village, district, registered_by')
        .eq('id', prof.borrower_landlord_id)
        .maybeSingle();
      ll = (data as LinkedLandlord) ?? null;
    }
    setLandlord(ll);
    // Derive landlord verification status from the authoritative column.
    if (ll) {
      const st = landlordVerifStatus(ll);
      setLandlordStatus(st);
      if (st === 'rejected') setLandlordReject(ll.verification_reason ?? null);
      if (st === 'pending') {
        // surface whether the borrower already has an open request
        const { data: req } = await supabase
          .from('landlord_verification_requests')
          .select('status')
          .eq('landlord_id', ll.id)
          .eq('requested_by', user.id)
          .eq('status', 'pending')
          .limit(1)
          .maybeSingle();
        if (req) setLlReqState('exists');
      }
    }

    let chair: LinkedLc1 | null = null;
    if (prof?.borrower_lc1_id) {
      const { data } = await supabase
        .from('lc1_chairpersons')
        .select('id, name, phone, verified, verification_status, verification_reason, village')
        .eq('id', prof.borrower_lc1_id)
        .maybeSingle();
      chair = (data as LinkedLc1) ?? null;
    }
    setLc1(chair);
    // Derive LC1 verification status from the authoritative column.
    if (chair) {
      const st = lc1VerifStatus(chair);
      setLc1Status(st);
      if (st === 'rejected') setLc1Reject(chair.verification_reason ?? null);
      if (st === 'pending') {
        const { data: req } = await supabase
          .from('lc1_verification_requests')
          .select('status')
          .eq('lc1_id', chair.id)
          .eq('requested_by', user.id)
          .eq('status', 'pending')
          .limit(1)
          .maybeSingle();
        if (req) setLc1ReqState('exists');
      }
    }

    if (ll?.registered_by) {
      const { data: ag } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', ll.registered_by)
        .maybeSingle();
      setAgentName(ag?.full_name ?? null);
    } else {
      setAgentName(null);
    }
    setLoading(false);
  }, [user]);

  useEffect(() => {
    if (open) {
      setAddLandlord(false);
      setAddLc1(false);
      setLandlordSearch('');
      setLc1Search('');
      setLc1Form({ name: '', phone: '', village: '' });
      setLc1UgLoc(null);
      loadProfile();
    }
  }, [open, loadProfile]);

  // LC1 search effect
  useEffect(() => {
    const term = lc1Search.trim();
    if (term.length < 2) { setLc1Results([]); return; }
    let active = true;
    setLc1Searching(true);
    const t = setTimeout(async () => {
      const digits = term.replace(/\D/g, '');
      const orParts = [`name.ilike.%${term}%`, `phone.ilike.%${term}%`];
      if (digits.length >= 3 && digits !== term) orParts.push(`phone.ilike.%${digits}%`);
      const { data } = await supabase
        .from('lc1_chairpersons')
        .select('id, name, phone, verified, village')
        .or(orParts.join(','))
        .limit(8);
      if (active) {
        const rows = (data ?? []) as LinkedLc1[];
        rows.sort((a, b) => (Boolean(a.verified) === Boolean(b.verified) ? 0 : a.verified ? -1 : 1));
        setLc1Results(rows);
        setLc1Searching(false);
      }
    }, 250);
    return () => { active = false; clearTimeout(t); };
  }, [lc1Search]);

  const linkLandlord = async (landlordId: string) => {
    if (!user) return;
    setSaving(true);
    const { error } = await supabase
      .from('profiles')
      .update({ borrower_landlord_id: landlordId })
      .eq('id', user.id);
    setSaving(false);
    if (error) { toast.error('Could not link landlord: ' + error.message); return; }
    toast.success('Landlord added to your profile');
    setAddLandlord(false);
    setLandlordSearch('');
    loadProfile();
  };

  const linkLc1 = async (lc1Id: string) => {
    if (!user) return;
    setSaving(true);
    const { error } = await supabase
      .from('profiles')
      .update({ borrower_lc1_id: lc1Id })
      .eq('id', user.id);
    setSaving(false);
    if (error) { toast.error('Could not link LC1: ' + error.message); return; }
    toast.success('LC1 chairperson added to your profile');
    setAddLc1(false);
    setLc1Search('');
    loadProfile();
  };

  const handleSelectLandlord = (l: LandlordOption) => {
    if (l.latitude == null || l.longitude == null) {
      toast.error('That landlord has no GPS location yet. Pick another or add your own with GPS.');
    }
    linkLandlord(l.id);
  };

  const handleAddLc1 = async () => {
    if (!user) return;
    if (!lc1Form.name.trim()) { toast.error('LC1 name is required'); return; }
    if (!lc1Form.phone.trim()) { toast.error('LC1 phone is required'); return; }
    if (!lc1UgLoc) { toast.error('Select the LC1 village from the official list'); return; }
    setSaving(true);
    const { data, error } = await supabase
      .from('lc1_chairpersons')
      .insert({
        name: lc1Form.name.trim(),
        phone: lc1Form.phone.trim(),
        village: lc1UgLoc.village,
        region: lc1UgLoc.region ?? null,
        district: lc1UgLoc.district,
        county: lc1UgLoc.county,
        sub_county: lc1UgLoc.subcounty,
        parish: lc1UgLoc.parish,
        ug_village_id: lc1UgLoc.villageId,
        registered_by: user.id,
        verified: false,
      } as any)
      .select('id')
      .single();
    setSaving(false);
    if (error || !data) { toast.error('Could not add LC1: ' + (error?.message ?? 'unknown')); return; }
    await linkLc1(data.id);
  };

  const requestLandlordVerification = async () => {
    if (!user || !landlord) return;
    setLlReqState('sending');
    const { error } = await supabase.from('landlord_verification_requests').insert({
      landlord_id: landlord.id,
      landlord_name: landlord.name,
      landlord_phone: landlord.phone,
      requested_by: user.id,
      agent_name: meContact.full_name,
      agent_phone: meContact.phone,
      note: 'Borrower requested landlord verification for a lending-agent loan',
      status: 'pending',
    });
    if (error) {
      // 23505 = a pending request already exists (unique index)
      if ((error as any).code === '23505') { setLlReqState('exists'); toast.success('Verification already requested'); return; }
      setLlReqState('idle');
      toast.error('Could not request verification: ' + error.message);
      return;
    }
    setLlReqState('sent');
    toast.success('Verification requested — our team will review your landlord');
  };

  const requestLc1Verification = async () => {
    if (!user || !lc1) return;
    setLc1ReqState('sending');
    const { error } = await supabase.from('lc1_verification_requests').insert({
      lc1_id: lc1.id,
      lc1_name: lc1.name,
      lc1_phone: lc1.phone,
      lc1_village: lc1.village,
      requested_by: user.id,
      agent_name: meContact.full_name,
      agent_phone: meContact.phone,
      note: 'Borrower requested LC1 verification for a lending-agent loan',
      status: 'pending',
    });
    if (error) {
      if ((error as any).code === '23505') { setLc1ReqState('exists'); toast.success('Verification already requested'); return; }
      setLc1ReqState('idle');
      toast.error('Could not request verification: ' + error.message);
      return;
    }
    setLc1ReqState('sent');
    toast.success('Verification requested — our team will review your LC1');
  };

  const updateAlertPref = async (field: 'verification_notify_email' | 'verification_notify_sms', value: boolean) => {
    if (!user) return;
    if (field === 'verification_notify_email') setNotifyEmail(value); else setNotifySms(value);
    const { error } = await supabase.from('profiles').update({ [field]: value }).eq('id', user.id);
    if (error) {
      // revert on failure
      if (field === 'verification_notify_email') setNotifyEmail(!value); else setNotifySms(!value);
      toast.error('Could not update alert preference');
    }
  };

  const complete = isResidenceComplete(landlord, lc1);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[92vh] overflow-y-auto p-0 gap-0">
        {/* Header */}
        <DialogHeader className="px-5 pt-5 pb-3 border-b">
          <DialogTitle className="flex items-center gap-2.5 text-base">
            <div className="h-9 w-9 rounded-full bg-gradient-to-br from-primary to-emerald-500 flex items-center justify-center">
              <Home className="h-4 w-4 text-white" />
            </div>
            <div>
              <p className="text-sm font-bold tracking-tight">Complete your residence profile</p>
              <p className="text-[11px] font-normal text-muted-foreground">Required before you can request a loan</p>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="px-5 py-4 space-y-4">
          {loading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : addLandlord ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold">Add your landlord</p>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setAddLandlord(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <LandlordRegistrationForm
                registeredByRole="tenant"
                onClose={() => setAddLandlord(false)}
                onSuccess={(l) => { if (l?.id) linkLandlord(l.id); }}
                toastFn={(opts) => {
                  if (opts.variant === 'destructive') toast.error(opts.title, { description: opts.description });
                  else toast.success(opts.title, { description: opts.description });
                }}
              />
            </div>
          ) : addLc1 ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold">Add your LC1 chairperson</p>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setAddLc1(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="space-y-2">
                <div>
                  <Label className="text-xs">Chairperson name *</Label>
                  <Input value={lc1Form.name} onChange={(e) => setLc1Form((f) => ({ ...f, name: e.target.value }))} placeholder="Full name" className="h-9 text-sm" />
                </div>
                <div>
                  <Label className="text-xs">Phone *</Label>
                  <Input value={lc1Form.phone} onChange={(e) => setLc1Form((f) => ({ ...f, phone: e.target.value }))} placeholder="07XXXXXXXX" inputMode="tel" className="h-9 text-sm" />
                </div>
                <UgLocationPicker
                  value={lc1UgLoc}
                  onChange={(sel) => {
                    setLc1UgLoc(sel);
                    setLc1Form((f) => ({ ...f, village: sel?.village ?? '' }));
                  }}
                  label="LC1 village (official)"
                  required
                  districtName={landlord?.district ?? null}
                />
                <p className="text-[10px] text-muted-foreground">Your LC1 will be verified by our team later. You can still continue now.</p>
                <Button size="sm" className="w-full h-9 font-bold" disabled={saving} onClick={handleAddLc1}>
                  {saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                  Save LC1 chairperson
                </Button>
              </div>
            </div>
          ) : (
            <>
              {/* LANDLORD SECTION */}
              <Card className={landlord ? 'border-emerald-500/40' : 'border-dashed'}>
                <CardContent className="p-3.5 space-y-2.5">
                  <div className="flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-primary" />
                    <p className="text-sm font-bold">Your landlord</p>
                    {landlord && landlordStatus === 'verified' && (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500 ml-auto" />
                    )}
                  </div>

                  {landlord ? (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <p className="text-sm font-semibold">{landlord.name}</p>
                        <StatusBadge status={landlordStatus} />
                      </div>
                      <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                        <MapPin className="h-3 w-3 shrink-0" />
                        {landlord.latitude != null && landlord.longitude != null
                          ? `GPS ${landlord.latitude.toFixed(5)}, ${landlord.longitude.toFixed(5)}`
                          : <span className="text-amber-600 font-semibold">No GPS — add a landlord with location</span>}
                      </p>
                      {(landlord.property_address || landlord.village) && (
                        <p className="text-[11px] text-muted-foreground">{landlord.property_address || landlord.village}</p>
                      )}
                      <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                        <UserCheck className="h-3 w-3 shrink-0" />
                        {agentName ? `Registered by ${agentName}` : 'Registered by you'}
                      </p>
                      {landlordStatus === 'pending' && (
                        <div className="rounded-lg bg-amber-500/10 px-2.5 py-2 space-y-1.5">
                          <p className="text-[11px] text-amber-700 flex items-center gap-1.5"><Clock className="h-3 w-3 shrink-0" />Our team must verify this landlord's GPS before you can borrow.</p>
                          {llReqState === 'idle' ? (
                            <Button size="sm" variant="outline" className="h-7 w-full text-[11px] font-bold border-amber-500/40" onClick={requestLandlordVerification}>
                              <Send className="h-3 w-3 mr-1" /> Request verification
                            </Button>
                          ) : llReqState === 'sending' ? (
                            <Button size="sm" variant="outline" className="h-7 w-full text-[11px]" disabled><Loader2 className="h-3 w-3 mr-1 animate-spin" />Sending…</Button>
                          ) : (
                            <p className="text-[11px] font-semibold text-amber-700 flex items-center gap-1"><CheckCircle2 className="h-3 w-3" />Verification requested</p>
                          )}
                        </div>
                      )}
                      {landlordStatus === 'rejected' && (
                        <div className="rounded-lg bg-destructive/10 px-2.5 py-2 space-y-1.5">
                          <p className="text-[11px] text-destructive flex items-center gap-1.5"><XCircle className="h-3 w-3 shrink-0" />Verification rejected{landlordReject ? `: ${landlordReject}` : '.'}</p>
                          <p className="text-[10px] text-muted-foreground">Change to another registered landlord, or fix the details and request again.</p>
                          {llReqState === 'idle' ? (
                            <Button size="sm" variant="outline" className="h-7 w-full text-[11px] font-bold" onClick={requestLandlordVerification}>
                              <Send className="h-3 w-3 mr-1" /> Request verification again
                            </Button>
                          ) : llReqState === 'sending' ? (
                            <Button size="sm" variant="outline" className="h-7 w-full text-[11px]" disabled><Loader2 className="h-3 w-3 mr-1 animate-spin" />Sending…</Button>
                          ) : (
                            <p className="text-[11px] font-semibold text-muted-foreground flex items-center gap-1"><CheckCircle2 className="h-3 w-3" />Verification requested</p>
                          )}
                        </div>
                      )}
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-primary" onClick={() => setLandlord(null)}>
                        Change landlord
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label className="text-[11px] text-muted-foreground">Search a registered landlord by name or phone</Label>
                      <LandlordAutocompleteInput
                        field="name"
                        value={landlordSearch}
                        onChange={setLandlordSearch}
                        onSelect={handleSelectLandlord}
                        placeholder="Landlord name or phone"
                        className="h-9 text-sm"
                      />
                      <Button variant="outline" size="sm" className="w-full h-9 text-xs font-bold" onClick={() => setAddLandlord(true)}>
                        <Plus className="h-3.5 w-3.5 mr-1.5" /> My landlord isn't registered — add them
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* LC1 SECTION */}
              <Card className={lc1 ? 'border-emerald-500/40' : 'border-dashed'}>
                <CardContent className="p-3.5 space-y-2.5">
                  <div className="flex items-center gap-2">
                    <Gavel className="h-4 w-4 text-primary" />
                    <p className="text-sm font-bold">Your LC1 chairperson</p>
                    {lc1 && lc1Status === 'verified' && <CheckCircle2 className="h-4 w-4 text-emerald-500 ml-auto" />}
                  </div>

                  {lc1 ? (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <p className="text-sm font-semibold">{lc1.name}</p>
                        <StatusBadge status={lc1Status} />
                      </div>
                      {(lc1.phone || lc1.village) && (
                        <p className="text-[11px] text-muted-foreground">{[lc1.phone, lc1.village].filter(Boolean).join(' · ')}</p>
                      )}
                      {lc1Status === 'pending' && (
                        <div className="rounded-lg bg-amber-500/10 px-2.5 py-2 space-y-1.5">
                          <p className="text-[11px] text-amber-700 flex items-center gap-1.5"><Clock className="h-3 w-3 shrink-0" />Our team must verify this LC1 chairperson before you can borrow.</p>
                          {lc1ReqState === 'idle' ? (
                            <Button size="sm" variant="outline" className="h-7 w-full text-[11px] font-bold border-amber-500/40" onClick={requestLc1Verification}>
                              <Send className="h-3 w-3 mr-1" /> Request verification
                            </Button>
                          ) : lc1ReqState === 'sending' ? (
                            <Button size="sm" variant="outline" className="h-7 w-full text-[11px]" disabled><Loader2 className="h-3 w-3 mr-1 animate-spin" />Sending…</Button>
                          ) : (
                            <p className="text-[11px] font-semibold text-amber-700 flex items-center gap-1"><CheckCircle2 className="h-3 w-3" />Verification requested</p>
                          )}
                        </div>
                      )}
                      {lc1Status === 'rejected' && (
                        <div className="rounded-lg bg-destructive/10 px-2.5 py-2 space-y-1.5">
                          <p className="text-[11px] text-destructive flex items-center gap-1.5"><XCircle className="h-3 w-3 shrink-0" />Verification rejected{lc1Reject ? `: ${lc1Reject}` : '.'}</p>
                          <p className="text-[10px] text-muted-foreground">Pick another LC1, or fix the details and request again.</p>
                          {lc1ReqState === 'idle' ? (
                            <Button size="sm" variant="outline" className="h-7 w-full text-[11px] font-bold" onClick={requestLc1Verification}>
                              <Send className="h-3 w-3 mr-1" /> Request verification again
                            </Button>
                          ) : lc1ReqState === 'sending' ? (
                            <Button size="sm" variant="outline" className="h-7 w-full text-[11px]" disabled><Loader2 className="h-3 w-3 mr-1 animate-spin" />Sending…</Button>
                          ) : (
                            <p className="text-[11px] font-semibold text-muted-foreground flex items-center gap-1"><CheckCircle2 className="h-3 w-3" />Verification requested</p>
                          )}
                        </div>
                      )}
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-primary" onClick={() => setLc1(null)}>
                        Change LC1
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label className="text-[11px] text-muted-foreground">Search your LC1 chairperson by name or phone</Label>
                      <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                        <Input value={lc1Search} onChange={(e) => setLc1Search(e.target.value)} placeholder="LC1 name or phone" className="h-9 text-sm pl-8" />
                      </div>
                      {lc1Searching && <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />Searching…</p>}
                      {lc1Results.length > 0 && (
                        <div className="rounded-xl border divide-y overflow-hidden">
                          {lc1Results.map((r) => (
                            <button key={r.id} type="button" onClick={() => linkLc1(r.id)} className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-accent transition-colors">
                              <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                                <Gavel className="h-4 w-4 text-primary" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold truncate">{r.name}</p>
                                <p className="text-[11px] text-muted-foreground truncate">{[r.phone, r.village].filter(Boolean).join(' · ') || 'LC1 chairperson'}</p>
                              </div>
                              <span className="text-[11px] font-semibold text-primary shrink-0">Use</span>
                            </button>
                          ))}
                        </div>
                      )}
                      <Button variant="outline" size="sm" className="w-full h-9 text-xs font-bold" onClick={() => setAddLc1(true)}>
                        <Plus className="h-3.5 w-3.5 mr-1.5" /> My LC1 isn't listed — add them
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* CONTINUE */}
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                {/* OPTIONAL ALERTS */}
                <Card className="mb-3 border-border/60">
                  <CardContent className="p-3.5 space-y-2.5">
                    <div className="flex items-center gap-2">
                      <Bell className="h-4 w-4 text-muted-foreground" />
                      <p className="text-xs font-bold">Alerts for verification updates</p>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-snug -mt-1">
                      Get notified when your landlord GPS or LC1 status changes (rejection reasons included).
                    </p>
                    <div className="flex items-center justify-between">
                      <Label htmlFor="notify-sms" className="flex items-center gap-1.5 text-xs font-medium cursor-pointer">
                        <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" /> SMS{meContact.phone ? '' : ' (add a phone first)'}
                      </Label>
                      <Switch id="notify-sms" checked={notifySms} disabled={!meContact.phone} onCheckedChange={(v) => updateAlertPref('verification_notify_sms', v)} />
                    </div>
                    <div className="flex items-center justify-between">
                      <Label htmlFor="notify-email" className="flex items-center gap-1.5 text-xs font-medium cursor-pointer">
                        <Mail className="h-3.5 w-3.5 text-muted-foreground" /> Email{hasEmail ? '' : ' (add an email first)'}
                      </Label>
                      <Switch id="notify-email" checked={notifyEmail} disabled={!hasEmail} onCheckedChange={(v) => updateAlertPref('verification_notify_email', v)} />
                    </div>
                  </CardContent>
                </Card>
                <Button
                  className="w-full h-11 font-bold"
                  disabled={!complete || saving}
                  onClick={() => { onOpenChange(false); onComplete(); }}
                >
                  {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                  {complete
                    ? <>Continue to loan request <ArrowRight className="h-4 w-4 ml-1.5" /></>
                    : (!landlord || !lc1) ? 'Add landlord & LC1 to continue' : 'Awaiting verification to continue'}
                </Button>
                {!complete && (
                  <p className="text-[10px] text-center text-muted-foreground mt-2">
                    Loan requests are blocked until your landlord's GPS and your LC1 chairperson are <span className="font-semibold text-foreground">verified</span> by our team.
                  </p>
                )}
              </motion.div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
