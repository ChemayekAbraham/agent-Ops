import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Loader2, RefreshCw, Send, Camera, FileImage, X, ShieldCheck } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { LandlordSearchSelect, type LandlordOption } from '@/components/agent/LandlordSearchSelect';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { LandlordAgreementUploader } from '@/components/landlord/agreement/LandlordAgreementUploader';
import { joinPersonName, splitPersonName, type PersonNameParts } from '@/lib/authValidation';
import { toast, toast as sonnerToast } from 'sonner';
import { calculateRentRepayment, formatUGX } from '@/lib/rentCalculations';
import { optimizeImage } from '@/lib/imageOptimizer';
import { useAuth } from '@/hooks/useAuth';
import type { AgentRejectedRequest } from '@/hooks/useAgentRejectedRequests';
import { RESUBMIT_CAP, resubmitAttemptsLeft } from '@/lib/rentRequestReopen';

const HOUSE_CATEGORIES = [
  { value: 'single-room', label: 'Single Room' },
  { value: 'double-room', label: 'Double Room' },
  { value: '1-bed', label: '1 Bed House' },
  { value: '2-bed', label: '2 Bedroom House' },
  { value: '2-bed-full', label: '2 Bed + Sitting, Kitchen & 2 Toilets' },
  { value: '3-bed', label: '3 Bedroom Apartment' },
  { value: '3-bed-luxury', label: '3 Bed Luxury + Boys Quarter' },
  { value: '4-bed', label: '4+ Bedroom Villa' },
  { value: 'shop', label: 'Shop / Lock-up Shop' },
  { value: 'market-stall', label: 'Market Stall' },
  { value: 'kiosk', label: 'Kiosk / Container' },
  { value: 'salon-workshop', label: 'Salon / Workshop' },
  { value: 'office', label: 'Office Space' },
  { value: 'warehouse', label: 'Warehouse / Store' },
  { value: 'commercial', label: 'Other Commercial Premises' },
];

const PREFERRED_LANGUAGES = ['English', 'Luganda', 'Runyankole', 'Lusoga', 'Acholi', 'Lugbara', 'Other'];

/** Same four angles the original rent-request form captures. */
const HOUSE_PHOTO_SLOTS = ['Front', 'Back', 'Left', 'Right'] as const;
const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const ALLOWED_LC_TYPES = ['image/jpeg', 'image/jpg', 'image/png'];

interface Props {
  request: AgentRejectedRequest | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResubmitted: () => void;
}

export function AgentEditRentRequestDialog({ request, open, onOpenChange, onResubmitted }: Props) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [rentAmount, setRentAmount] = useState('');
  const [duration, setDuration] = useState('30');
  const [numberOfPayments, setNumberOfPayments] = useState('4');
  const [waterMeter, setWaterMeter] = useState('');
  const [elecMeter, setElecMeter] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [houseCategory, setHouseCategory] = useState<string>('');
  const [preferredLanguage, setPreferredLanguage] = useState<string>('');
  const [noSmartphone, setNoSmartphone] = useState(false);
  const [landlord, setLandlord] = useState<LandlordOption | null>(null);
  const [outstandingBalance, setOutstandingBalance] = useState('');
  const [graceDays, setGraceDays] = useState('');
  // Captured in parts; submission still uses the single concatenated string.
  const [landlordNameParts, setLandlordNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const landlordName = joinPersonName(landlordNameParts);
  const setLandlordName = (next: string) => setLandlordNameParts(splitPersonName(next));
  const [landlordPhone, setLandlordPhone] = useState('');
  const [landlordAddress, setLandlordAddress] = useState('');
  const [landlordOriginal, setLandlordOriginal] = useState<{ name: string; phone: string; address: string } | null>(null);
  // ── Tenant details ─────────────────────────────────────────────────
  // Reviewers commonly reject for tenant data ("put both names of the tenant"),
  // so the tenant's own record is editable here and saved on resubmit.
  const [tenantNameParts, setTenantNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const tenantName = joinPersonName(tenantNameParts);
  const [tenantPhone, setTenantPhone] = useState('');
  const [tenantNationalId, setTenantNationalId] = useState('');
  const [tenantOccupation, setTenantOccupation] = useState('');
  const [tenantOriginal, setTenantOriginal] = useState<{ name: string; phone: string; nid: string; occupation: string } | null>(null);
  // ── Evidence: house photos + LC letter ──────────────────────────────
  // `existingPhotos` are the URLs already on the request; `newPhotos` hold
  // freshly picked files per slot. A slot with a new file replaces that index
  // on resubmit; untouched slots keep their existing URL.
  const [existingPhotos, setExistingPhotos] = useState<(string | null)[]>([]);
  const [newPhotos, setNewPhotos] = useState<({ file: File; preview: string } | null)[]>([]);
  // Slots whose on-file photo the agent explicitly dropped. A dropped slot is
  // never carried into the resubmission, so the submitted set is exactly what
  // the agent is submitting now.
  const [droppedExisting, setDroppedExisting] = useState<boolean[]>([]);

  const [existingLcPath, setExistingLcPath] = useState<string | null>(null);
  const [existingLcUrl, setExistingLcUrl] = useState<string | null>(null);
  const [newLcLetter, setNewLcLetter] = useState<{ file: File; preview: string } | null>(null);
  const [uploadingEvidence, setUploadingEvidence] = useState(false);
  const [agreementAttached, setAgreementAttached] = useState(false);
  // Toasts sit outside the dialog and are routinely missed on small screens —
  // every blocking reason is ALSO rendered inline right above the Resubmit
  // button so the agent always sees why nothing happened.
  const [formError, setFormError] = useState<{ title: string; description?: string } | null>(null);

  /** Surface a failure both inline (always visible) and as a toast. */
  const fail = (title: string, description?: string) => {
    setFormError({ title, description });
    toast.error(title, description ? { description } : undefined);
  };

  const { data: agreementHistory = [] } = useQuery({
    queryKey: ['landlord-agreement-history', landlord?.id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('landlord_agreement_history', { p_landlord_id: landlord!.id });
      if (error) throw error;
      return (data ?? []) as Array<{ is_current?: boolean; status?: string }>;
    },
    enabled: !!landlord?.id,
  });
  const hasSignedAgreement = agreementAttached || agreementHistory.some((row) => row.is_current && row.status === 'active');

  useEffect(() => {
    if (request) {
      setRentAmount(String(request.rent_amount ?? ''));
      setDuration(String(request.duration_days ?? 30));
      setNumberOfPayments(String(request.number_of_payments ?? 4));
      setWaterMeter(request.tenant_water_meter ?? '');
      setElecMeter(request.tenant_electricity_meter ?? '');
      setNote('');
      setFormError(null);
      setHouseCategory(request.house_category ?? '');
      setPreferredLanguage(request.preferred_language ?? '');
      setNoSmartphone(!!request.tenant_no_smartphone);
      setOutstandingBalance(
        request.initial_outstanding_balance != null ? String(request.initial_outstanding_balance) : ''
      );
      setGraceDays(
        request.outstanding_grace_days != null ? String(request.outstanding_grace_days) : ''
      );
      // Hydrate the evidence editors.
      const urls = Array.isArray(request.house_image_urls) ? request.house_image_urls : [];
      setExistingPhotos(HOUSE_PHOTO_SLOTS.map((_, i) => urls[i] ?? null));
      setNewPhotos(HOUSE_PHOTO_SLOTS.map(() => null));
      setDroppedExisting(HOUSE_PHOTO_SLOTS.map(() => false));

      setNewLcLetter(null);
      setAgreementAttached(false);
      setExistingLcPath(request.lc_letter_path ?? null);
      setExistingLcUrl(null);
      if (request.lc_letter_path) {
        // LC letters live in a private bucket — a short-lived signed URL is the
        // only way to preview what is already on file.
        (async () => {
          const { data } = await supabase.storage
            .from(request.lc_letter_bucket || 'lc-letters')
            .createSignedUrl(request.lc_letter_path as string, 600);
          setExistingLcUrl(data?.signedUrl ?? null);
        })();
      }
      // Hydrate the tenant editor from the tenant record on the request.
      (async () => {
        if (!request.tenant_id) {
          setTenantNameParts({ firstName: '', otherNames: '', lastName: '' });
          setTenantPhone(''); setTenantNationalId(''); setTenantOccupation('');
          setTenantOriginal(null);
          return;
        }
        const { data } = await supabase
          .from('profiles')
          .select('full_name, phone, national_id, occupation')
          .eq('id', request.tenant_id)
          .maybeSingle();
        const t = (data ?? {}) as { full_name?: string | null; phone?: string | null; national_id?: string | null; occupation?: string | null };
        setTenantNameParts(splitPersonName(t.full_name ?? request.tenant_name ?? ''));
        setTenantPhone(t.phone ?? request.tenant_phone ?? '');
        setTenantNationalId(t.national_id ?? '');
        setTenantOccupation(t.occupation ?? '');
        setTenantOriginal({
          name: t.full_name ?? '',
          phone: t.phone ?? '',
          nid: t.national_id ?? '',
          occupation: t.occupation ?? '',
        });
      })();

      // Hydrate the landlord picker from the request's current landlord_id.
      (async () => {
        if (!request.landlord_id) {
          setLandlord(null);
          setLandlordName(''); setLandlordPhone(''); setLandlordAddress('');
          setLandlordOriginal(null);
          return;
        }
        const { data } = await supabase
          .from('landlords')
          .select('id, name, phone, property_address')
          .eq('id', request.landlord_id)
          .maybeSingle();
        setLandlord((data as LandlordOption) ?? null);
        if (data) {
          setLandlordName(data.name ?? '');
          setLandlordPhone(data.phone ?? '');
          setLandlordAddress(data.property_address ?? '');
          setLandlordOriginal({
            name: data.name ?? '',
            phone: data.phone ?? '',
            address: data.property_address ?? '',
          });
        }
      })();
    }
  }, [request]);

  // When agent picks a different landlord from search, hydrate the editable fields.
  useEffect(() => {
    if (!landlord) return;
    setLandlordName(landlord.name ?? '');
    setLandlordPhone(landlord.phone ?? '');
    setLandlordAddress(landlord.property_address ?? '');
    setLandlordOriginal({
      name: landlord.name ?? '',
      phone: landlord.phone ?? '',
      address: landlord.property_address ?? '',
    });
  }, [landlord?.id]);

  const pickPhoto = (slot: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!ALLOWED_PHOTO_TYPES.includes(file.type.toLowerCase())) {
      toast.error('Unsupported image', { description: 'Use a JPG, PNG, WEBP or HEIC photo.' });
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      toast.error('Photo too large', { description: 'Each house photo must be 15 MB or smaller.' });
      return;
    }
    setNewPhotos((prev) => {
      const next = [...prev];
      if (next[slot]) URL.revokeObjectURL(next[slot]!.preview);
      next[slot] = { file, preview: URL.createObjectURL(file) };
      return next;
    });
  };

  const clearNewPhoto = (slot: number) => {
    setNewPhotos((prev) => {
      const next = [...prev];
      if (next[slot]) URL.revokeObjectURL(next[slot]!.preview);
      next[slot] = null;
      return next;
    });
  };

  /** Drop the photo already on file for this slot so it is not resubmitted. */
  const toggleDropExisting = (slot: number) => {
    setDroppedExisting((prev) => {
      const next = [...prev];
      next[slot] = !next[slot];
      return next;
    });
  };


  const pickLcLetter = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!ALLOWED_LC_TYPES.includes(file.type.toLowerCase())) {
      toast.error('Only JPG, JPEG or PNG images are allowed for the LC letter');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error('The LC letter must be 10 MB or smaller');
      return;
    }
    if (newLcLetter) URL.revokeObjectURL(newLcLetter.preview);
    setNewLcLetter({ file, preview: URL.createObjectURL(file) });
  };


  /**
   * Push any newly picked evidence to storage and return the patch fragment.
   * Photos overwrite the same deterministic paths the original submission
   * used, so reviewers always look at the latest capture for each angle.
   */
  const uploadEvidence = async (requestId: string): Promise<Record<string, unknown>> => {
    const patch: Record<string, unknown> = {};
    if (!user) return patch;

    const touchedPhoto = newPhotos.some(Boolean) || droppedExisting.some(Boolean);
    if (touchedPhoto) {
      const finalUrls: string[] = [];
      for (let i = 0; i < HOUSE_PHOTO_SLOTS.length; i++) {
        const picked = newPhotos[i];
        if (!picked) {
          // A dropped slot is deliberately left out — old photos are never
          // silently carried into the new submission.
          if (existingPhotos[i] && !droppedExisting[i]) finalUrls.push(existingPhotos[i] as string);
          continue;
        }
        // Some phone captures (HEIC on older Android/iOS browsers) cannot be
        // decoded by the canvas optimizer. Falling back to the raw file keeps
        // the resubmit alive instead of dying with an opaque error.
        let uploadFile = picked.file;
        try {
          const optimized = await optimizeImage(picked.file, { maxWidth: 1200, quality: 0.8 });
          uploadFile = optimized.file;
        } catch {
          uploadFile = picked.file;
        }
        const ext = uploadFile.name.split('.').pop() || 'webp';
        // Unique path per attempt: overwriting the same object is an UPDATE in
        // storage and any missing UPDATE policy silently kills the resubmit.
        const path = `${user.id}/${requestId}/photo_${i}_${Date.now()}.${ext}`;
        const { error } = await supabase.storage
          .from('house-images')
          .upload(path, uploadFile, { cacheControl: '86400', upsert: false });
        if (error) throw new Error(`House photo (${HOUSE_PHOTO_SLOTS[i]}) upload failed: ${error.message}`);
        const { data } = supabase.storage.from('house-images').getPublicUrl(path);
        finalUrls.push(data.publicUrl);
      }
      // The resubmitted array IS the latest submission. Extra photos beyond the
      // four angles are only kept when the agent replaced nothing wholesale —
      // once a full new set is captured, stale extras are dropped so reviewers
      // never see a mixture of old and new evidence.
      const capturedAll = newPhotos.every((p, i) => Boolean(p) || Boolean(droppedExisting[i]));
      const extras = capturedAll
        ? []
        : (Array.isArray(request?.house_image_urls) ? request!.house_image_urls : []).slice(
            HOUSE_PHOTO_SLOTS.length,
          );
      patch.house_image_urls = [...finalUrls, ...extras];
    }


    if (newLcLetter) {
      let letterFile = newLcLetter.file;
      try {
        const optimized = await optimizeImage(newLcLetter.file, {
          maxWidth: 2000,
          maxHeight: 2000,
          quality: 0.85,
          format: 'image/jpeg',
        });
        letterFile = optimized.file;
      } catch {
        letterFile = newLcLetter.file;
      }
      const ext = (letterFile.name.split('.').pop() || 'jpg').toLowerCase();
      const path = `${user.id}/${requestId}/lc_letter_${Date.now()}.${ext}`;
      const { error } = await supabase.storage
        .from('lc-letters')
        .upload(path, letterFile, {
          cacheControl: '86400',
          upsert: false,
          contentType: letterFile.type,
        });
      if (error) throw new Error(`LC letter upload failed: ${error.message}`);
      patch.lc_letter_path = path;
      patch.lc_letter_bucket = 'lc-letters';
    }

    return patch;
  };

  if (!request) return null;

  const isOutstanding = request.registration_type === 'outstanding_balance';

  const rentNum = Number(rentAmount) || 0;
  const durNum = Number(duration) || 0;
  const calc = rentNum > 0 && durNum >= 7
    ? calculateRentRepayment(rentNum, durNum)
    : null;

  const submit = async () => {
    setFormError(null);
    // Every failure inside this function must ALSO land in the inline banner,
    // so `toast` is shadowed here with a mirror that writes both places.
    const toast = {
      success: sonnerToast.success,
      message: (title: string, opts?: { description?: string }) => {
        setFormError({ title, description: opts?.description });
        sonnerToast.message(title, opts);
      },
      error: (title: string, opts?: { description?: string }) => {
        fail(title, opts?.description);
      },
    };
    // Pre-flight client-side validation — every failure path gets its own toast.
    if (note.trim().length === 0) {
      toast.error('Add a resubmission note', {
        description: 'Tell the reviewer what you changed and why (at least 10 characters).',
      });
      return;
    }
    if (note.trim().length < 10) {
      toast.error('Note too short', {
        description: `Reviewer note must be at least 10 characters (you wrote ${note.trim().length}).`,
      });
      return;
    }
    if (!tenantName.trim()) {
      toast.error('Tenant name is required', {
        description: "Enter the tenant's names as they appear on the national ID.",
      });
      return;
    }
    if (tenantPhone.trim() && !/^\+?\d[\d\s-]{6,}$/.test(tenantPhone.trim())) {
      toast.error('Tenant phone looks invalid', {
        description: 'Use digits only, e.g. 0772123456 or +256772123456.',
      });
      return;
    }
    if (tenantNationalId.trim() && !/^[A-Za-z0-9]{10,14}$/.test(tenantNationalId.trim())) {
      toast.error('Tenant national ID looks invalid', {
        description: 'A national ID is 10 to 14 letters and numbers, no spaces.',
      });
      return;
    }
    if (!landlord?.id) {
      toast.error('Pick a landlord', {
        description: 'Use the search box at the top to select the landlord for this rent request.',
      });
      return;
    }
    if (!landlordName.trim()) {
      toast.error('Landlord name is required', {
        description: 'Enter the landlord\'s full name before resubmitting.',
      });
      return;
    }
    if (!landlordPhone.trim()) {
      toast.error('Landlord phone is required', {
        description: 'Enter a reachable phone number for the landlord.',
      });
      return;
    }
    if (!/^\+?\d[\d\s-]{6,}$/.test(landlordPhone.trim())) {
      toast.error('Landlord phone looks invalid', {
        description: 'Use digits only, e.g. 0772123456 or +256772123456.',
      });
      return;
    }
    if (!landlordAddress.trim()) {
      toast.error('Property address is required', {
        description: 'Enter the property address linked to this landlord.',
      });
      return;
    }
    if (!rentAmount.trim() || rentNum <= 0) {
      toast.error('Enter a rent amount', {
        description: 'Rent must be a positive UGX amount greater than 0.',
      });
      return;
    }
    if (!duration.trim() || durNum < 7 || durNum > 120) {
      toast.error('Duration out of range', {
        description: `Duration must be between 7 and 120 days (you set ${durNum || '—'}).`,
      });
      return;
    }
    // Backend only accepts these plan lengths — block early with a clear message
    // instead of failing after the photos have already uploaded.
    if (![7, 14, 21, 30, 60, 90, 120].includes(durNum)) {
      toast.error('Unsupported plan length', {
        description: `Duration must be 7, 14, 21, 30, 60, 90 or 120 days (you set ${durNum}).`,
      });
      return;
    }
    const npNum = Number(numberOfPayments) || 0;
    if (npNum < 1 || npNum > durNum) {
      toast.error('Invalid number of payments', {
        description: `Payments must be between 1 and ${durNum} (the duration). You set ${npNum || '—'}.`,
      });
      return;
    }
    // House category & preferred language are OPTIONAL on the backend RPC
    // (both COALESCE to null). Do not block resubmit when they are blank —
    // that was silently trapping users on a field scrolled off-screen.
    if (isOutstanding) {
      const obNum = outstandingBalance ? Number(outstandingBalance) : 0;
      if (!outstandingBalance.trim() || obNum <= 0) {
        toast.error('Enter the outstanding balance', {
          description: 'Outstanding-balance requests need a positive UGX amount the tenant already owes.',
        });
        return;
      }
      if (obNum > rentNum) {
        toast.error('Outstanding exceeds rent', {
          description: `Outstanding (${formatUGX(obNum)}) cannot be greater than the rent amount (${formatUGX(rentNum)}).`,
        });
        return;
      }
      const gdNum = graceDays ? parseInt(graceDays, 10) : -1;
      if (gdNum < 0 || gdNum > durNum) {
        toast.error('Days remaining out of range', {
          description: `Days remaining must be between 0 and ${durNum} (the duration).`,
        });
        return;
      }
    }
    if (submitting) {
      toast.message('Already submitting', {
        description: 'Hold on — the previous resubmit is still in flight.',
      });
      return;
    }
    setSubmitting(true);
    try {
      const nextName = landlordName.trim();
      const nextPhone = landlordPhone.trim();
      const nextAddress = landlordAddress.trim();

      // Upload replaced photos / LC letter FIRST so the resubmit carries the
      // new evidence in the same patch the reviewer sees.
      let evidencePatch: Record<string, unknown> = {};
      if (newPhotos.some(Boolean) || droppedExisting.some(Boolean) || newLcLetter) {
        setUploadingEvidence(true);
        try {
          evidencePatch = await uploadEvidence(request.id);
        } finally {
          setUploadingEvidence(false);
        }
      }

      const patch: Record<string, unknown> = {
        rent_amount: rentNum,
        duration_days: durNum,
        number_of_payments: Number(numberOfPayments) || 4,
        tenant_water_meter: waterMeter.trim() || null,
        tenant_electricity_meter: elecMeter.trim() || null,
        house_category: houseCategory || null,
        preferred_language: preferredLanguage || null,
        tenant_no_smartphone: noSmartphone,
        landlord_id: landlord.id,
        landlord_name: nextName,
        landlord_phone: nextPhone,
        landlord_address: nextAddress,
        ...evidencePatch,
      };
      // Only send tenant fields the agent actually changed, so nothing else on
      // the tenant record is touched.
      if (tenantOriginal) {
        if (tenantName.trim() && tenantName.trim() !== tenantOriginal.name) patch.tenant_name = tenantName.trim();
        if (tenantPhone.trim() && tenantPhone.trim() !== tenantOriginal.phone) patch.tenant_phone = tenantPhone.trim();
        if (tenantNationalId.trim() && tenantNationalId.trim() !== tenantOriginal.nid) patch.tenant_national_id = tenantNationalId.trim().toUpperCase();
        if (tenantOccupation.trim() && tenantOccupation.trim() !== tenantOriginal.occupation) patch.tenant_occupation = tenantOccupation.trim();
      }
      if (isOutstanding) {
        patch.initial_outstanding_balance = outstandingBalance ? Number(outstandingBalance) : null;
        patch.outstanding_grace_days = graceDays ? Math.max(0, parseInt(graceDays, 10)) : null;
      }
      const { error } = await supabase.rpc('agent_resubmit_rent_request' as any, {
        p_request_id: request.id,
        p_patch: patch,
        p_agent_note: note.trim(),
      });
      if (error) throw error;
      // Reviewer queues are already open on other screens/sessions — drop their
      // cached snapshots so the newly submitted photos appear without a manual
      // page refresh.
      [
        'rent-pipeline',
        'service-center-rent-queue',
        'partner-ops-rent-queue',
        'agent-rejected-rent-requests',
        'tenant-registration',
        'tenant-documents',
      ].forEach((key) => queryClient.invalidateQueries({ queryKey: [key] }));
      toast.success('Resubmitted for review');
      onOpenChange(false);
      onResubmitted();

    } catch (e: any) {
      const raw = (e?.message ?? '') as string;
      const code = e?.code as string | undefined;
      const details = (e?.details ?? '') as string;
      const hint = (e?.hint ?? '') as string;
      const blob = `${raw} ${details} ${hint}`.toLowerCase();

      let title = 'Failed to resubmit';
      let description: string | undefined;

      if (code === '42P01' || /relation .* does not exist/.test(blob)) {
        const m = blob.match(/relation "([^"]+)" does not exist/);
        title = 'Resubmit blocked — backend table missing';
        description = m
          ? `Required table "${m[1]}" is not deployed. Share this with support so they can run the missing migration.`
          : 'A required backend table is not deployed. Share this error with support so they can run the missing migration.';
      } else if (code === '42883' || /function .* does not exist/.test(blob)) {
        title = 'Resubmit blocked — backend function missing';
        description = 'The agent_resubmit_rent_request function is not deployed. Contact support to redeploy it.';
      } else if (/reopen limit reached/i.test(raw)) {
        title = 'Reopen limit reached';
        const m = raw.match(/Reopen limit reached \((\d+)\)/i);
        const cap = m ? m[1] : '5';
        description = `You have already resubmitted this request ${cap} times. A manager must reopen it from the Rejected Requests queue.`;
      } else if (/only the agent who created/i.test(raw)) {
        title = 'Not your request';
        description = 'Only the agent who created this request can resubmit it.';
      } else if (/only rejected requests/i.test(raw)) {
        title = 'Already moved on';
        description = raw;
      } else if (/at least 10 characters/i.test(raw) || /resubmission note must/i.test(raw)) {
        const have = note.trim().length;
        title = 'Note too short';
        description = `Reviewer note must be at least 10 characters (you wrote ${have}). Add a sentence explaining what you changed and why.`;
      } else if (/duration must be between/i.test(raw)) {
        title = 'Duration out of range';
        description = `Duration must be between 7 and 120 days (you set ${durNum || '—'}). Adjust the days field, then resubmit.`;
      } else if (/invalid rent amount/i.test(raw)) {
        title = 'Invalid rent amount';
        description = `Rent must be greater than 0 (you set ${rentNum || '—'}). Enter a positive UGX amount, then resubmit.`;
      } else if (/invalid number of payments/i.test(raw)) {
        const np = Number(numberOfPayments) || 4;
        title = 'Invalid number of payments';
        description = `Number of payments must be between 1 and the duration in days (you set ${np} for a ${durNum || '—'}-day plan). Lower the payments or extend the duration.`;
      } else if (/landlord/i.test(raw) && /not.*found|invalid/i.test(raw)) {
        title = 'Landlord missing';
        description = 'Pick a landlord from the list before resubmitting.';
      } else if (code === '23502') {
        // not-null violation — surface the offending column
        const m = (raw + ' ' + details).match(/column "([^"]+)"/i);
        title = 'Required field missing';
        description = m
          ? `"${m[1]}" can't be empty. Fill it in, then resubmit.`
          : 'A required field is empty. Check the highlighted inputs and resubmit.';
      } else if (code === '23514') {
        title = 'Value not allowed';
        description = 'One of the values breaks a database rule. Double-check rent, duration, payments, and meter numbers.';
      } else if (/permission denied|rls|row-level security/i.test(blob)) {
        title = 'Permission denied';
        description = 'Your account is not allowed to resubmit this request. Sign in as the original agent or contact a manager.';
      } else if (raw) {
        description = raw;
      }

      const debugTag = code || details || hint ? ` [${[code, details, hint].filter(Boolean).join(' · ')}]` : '';
      toast.error(title, {
        description: (description ?? raw ?? 'Unknown error') + debugTag,
      });
      console.error('[agent_resubmit_rent_request] failed', { code, raw, details, hint });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto pb-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-primary" /> Edit & Resubmit Request
          </DialogTitle>
          <DialogDescription>
            Address the reviewer's comment, then resubmit. Returns to <strong>{request.stage_label}</strong> for fresh review.
          </DialogDescription>
        </DialogHeader>

        {request.rejected_reason && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <p className="text-xs font-bold uppercase tracking-wide text-destructive mb-1">
              Reviewer comment ({request.stage_label})
            </p>
            <p className="text-foreground/90">{request.rejected_reason}</p>
          </div>
        )}

        {/* Attempts left, shown before submitting — mirrors the server rule. */}
        {(() => {
          const left = resubmitAttemptsLeft(request.reopen_count, request.rejected_reason);
          if (left === null) {
            return (
              <p className="text-xs text-muted-foreground">
                This was returned as out of date, so it does not use up your resubmission attempts.
              </p>
            );
          }
          return (
            <p className={`text-xs ${left === 0 ? 'text-destructive font-semibold' : 'text-muted-foreground'}`}>
              {left === 0
                ? `No resubmission attempts left (${RESUBMIT_CAP} of ${RESUBMIT_CAP} used). A manager must reopen this request for you.`
                : `${left} of ${RESUBMIT_CAP} resubmission attempts left.`}
            </p>
          );
        })()}

        <div className="space-y-3">
          <div className="space-y-3 rounded-md border border-primary/30 bg-primary/5 p-3">
            <p className="text-[10px] font-bold uppercase tracking-wide text-primary">
              Edit tenant details
            </p>
            <div className="space-y-1.5">
              <Label>Tenant name</Label>
              <PersonNameFields
                idPrefix="edit-rent-req-tenant"
                value={tenantNameParts}
                onChange={setTenantNameParts}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="tn-phone">Phone</Label>
                <Input id="tn-phone" inputMode="tel" value={tenantPhone}
                  onChange={(e) => setTenantPhone(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tn-nid">National ID</Label>
                <Input id="tn-nid" value={tenantNationalId}
                  onChange={(e) => setTenantNationalId(e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase())} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tn-occ">Occupation</Label>
              <Input id="tn-occ" value={tenantOccupation}
                onChange={(e) => setTenantOccupation(e.target.value)} />
            </div>
            <p className="text-[10px] text-muted-foreground">
              Saved to the tenant's record on resubmit. Use both names exactly as on the national ID.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Landlord</Label>
            <LandlordSearchSelect value={landlord} onChange={setLandlord} registeredBy={user?.id ?? null} />
          </div>

          {landlord && !hasSignedAgreement && (
            <div className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
              <div className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                <div>
                  <p className="text-xs font-semibold text-amber-800">Landlord Agreement Not Attached</p>
                  <p className="text-[10px] text-muted-foreground">Attach the signed agreement to this existing landlord record before resubmitting, if the reviewer requested it.</p>
                </div>
              </div>
              <LandlordAgreementUploader
                landlordId={landlord.id}
                landlordName={landlordName}
                landlordPhone={landlordPhone}
                propertyAddress={landlordAddress}
                monthlyRent={rentNum || landlord.monthly_rent}
                uploadOnly
                onSubmitted={() => {
                  setAgreementAttached(true);
                  queryClient.invalidateQueries({ queryKey: ['landlord-agreement-history', landlord.id] });
                }}
              />
            </div>
          )}

          {landlord && (
            <div className="space-y-3 rounded-md border border-primary/30 bg-primary/5 p-3">
              <p className="text-[10px] font-bold uppercase tracking-wide text-primary">
                Edit landlord details
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="ll-name">Landlord name</Label>
                <PersonNameFields
                  idPrefix="edit-rent-req-landlord"
                  value={landlordNameParts}
                  onChange={setLandlordNameParts}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ll-phone">Phone</Label>
                  <Input id="ll-phone" inputMode="tel" value={landlordPhone}
                    onChange={(e) => setLandlordPhone(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ll-addr">Property address</Label>
                  <Input id="ll-addr" value={landlordAddress}
                    onChange={(e) => setLandlordAddress(e.target.value)} />
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Saved to the landlord record on resubmit. Affects all rent requests linked to this landlord.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="rent">Rent amount (UGX)</Label>
            <Input id="rent" inputMode="numeric" value={rentAmount}
              onChange={(e) => setRentAmount(e.target.value.replace(/[^0-9]/g, ''))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="dur">Duration (days)</Label>
              <Input id="dur" inputMode="numeric" min={7} max={120} value={duration}
                onChange={(e) => setDuration(e.target.value.replace(/[^0-9]/g, ''))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np">Payments</Label>
              <Input id="np" inputMode="numeric" value={numberOfPayments}
                onChange={(e) => setNumberOfPayments(e.target.value.replace(/[^0-9]/g, ''))} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>House category</Label>
              <Select value={houseCategory} onValueChange={setHouseCategory}>
                <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  {HOUSE_CATEGORIES.map(c => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Preferred language</Label>
              <Select value={preferredLanguage} onValueChange={setPreferredLanguage}>
                <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  {PREFERRED_LANGUAGES.map(l => (
                    <SelectItem key={l} value={l}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="wm">Water meter</Label>
              <Input id="wm" value={waterMeter} onChange={(e) => setWaterMeter(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="em">Electricity meter</Label>
              <Input id="em" value={elecMeter} onChange={(e) => setElecMeter(e.target.value)} />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <p className="text-sm font-medium">Tenant has no smartphone</p>
              <p className="text-xs text-muted-foreground">Enable for SMS-only flows.</p>
            </div>
            <Switch checked={noSmartphone} onCheckedChange={setNoSmartphone} />
          </div>

          {isOutstanding && (
            <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3">
              <p className="text-xs font-bold uppercase tracking-wide text-primary">
                Outstanding balance
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ob">Initial outstanding (UGX)</Label>
                  <Input id="ob" inputMode="numeric" value={outstandingBalance}
                    onChange={(e) => setOutstandingBalance(e.target.value.replace(/[^0-9]/g, ''))} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="gd">Days remaining</Label>
                  <Input id="gd" inputMode="numeric" value={graceDays}
                    onChange={(e) => setGraceDays(e.target.value.replace(/[^0-9]/g, ''))} />
                </div>
              </div>
            </div>
          )}

          {calc && (
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-muted p-2">
                <p className="text-[10px] text-muted-foreground">Total due</p>
                <p className="text-sm font-bold">{formatUGX(calc.totalRepayment)}</p>
              </div>
              <div className="rounded-lg bg-muted p-2">
                <p className="text-[10px] text-muted-foreground">Daily</p>
                <p className="text-sm font-bold">{formatUGX(calc.dailyRepayment)}</p>
              </div>
              <div className="rounded-lg bg-muted p-2">
                <p className="text-[10px] text-muted-foreground">Days</p>
                <p className="text-sm font-bold">{calc.durationDays}</p>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="note">What changed? (min 10 characters)</Label>
            <Textarea id="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Explain what you corrected so the reviewer can re-check quickly…" />
          </div>

          <div className="space-y-3 rounded-md border p-3">
            <div>
              <p className="text-sm font-medium flex items-center gap-1.5">
                <Camera className="h-4 w-4 text-primary" /> House photos
              </p>
              <p className="text-xs text-muted-foreground">
                Tap a slot to retake or add a photo. Whatever is shown here is exactly what the
                reviewer will see — use Remove to drop a photo you are not resubmitting.
              </p>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {HOUSE_PHOTO_SLOTS.map((angle, i) => {
                const picked = newPhotos[i];
                const dropped = !!droppedExisting[i];
                const existing = dropped ? null : existingPhotos[i];
                const src = picked?.preview ?? existing ?? null;
                return (
                  <div key={angle} className="space-y-1">
                    <label className="relative block aspect-square cursor-pointer overflow-hidden rounded-lg border bg-muted">
                      {src ? (
                        <img src={src} alt={`${angle} of the house`} className="h-full w-full object-cover" />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center">
                          <Camera className="h-5 w-5 text-muted-foreground" />
                        </span>
                      )}
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="sr-only"
                        onChange={(e) => pickPhoto(i, e)}
                      />
                    </label>
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[10px] text-muted-foreground">{angle}</span>
                      {picked ? (
                        <button
                          type="button"
                          onClick={() => clearNewPhoto(i)}
                          className="text-[10px] text-destructive inline-flex items-center gap-0.5"
                        >
                          <X className="h-3 w-3" /> undo
                        </button>
                      ) : existingPhotos[i] ? (
                        <button
                          type="button"
                          onClick={() => toggleDropExisting(i)}
                          className="text-[10px] text-destructive inline-flex items-center gap-0.5"
                        >
                          <X className="h-3 w-3" /> {dropped ? 'keep' : 'remove'}
                        </button>
                      ) : null}
                    </div>
                    {picked && <p className="text-[10px] font-medium text-primary">New</p>}
                    {!picked && dropped && (
                      <p className="text-[10px] font-medium text-destructive">Removed</p>
                    )}
                  </div>

                );
              })}
            </div>
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm font-medium flex items-center gap-1.5">
              <FileImage className="h-4 w-4 text-primary" /> LC letter
            </p>
            <div className="flex items-center gap-3">
              {newLcLetter ? (
                <img src={newLcLetter.preview} alt="New LC letter" className="h-16 w-16 rounded-lg border object-cover" />
              ) : existingLcUrl ? (
                <img src={existingLcUrl} alt="LC letter on file" className="h-16 w-16 rounded-lg border object-cover" />
              ) : (
                <span className="flex h-16 w-16 items-center justify-center rounded-lg border bg-muted">
                  <FileImage className="h-5 w-5 text-muted-foreground" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">
                  {newLcLetter
                    ? `New letter selected — ${(newLcLetter.file.size / (1024 * 1024)).toFixed(1)} MB`
                    : existingLcPath
                      ? 'A letter is already on file. Pick a new image only if it must be replaced.'
                      : 'No LC letter on file. Add one if the reviewer asked for it.'}
                </p>
                <div className="mt-1.5 flex items-center gap-2">
                  <label className="cursor-pointer text-xs font-medium text-primary underline">
                    {existingLcPath || newLcLetter ? 'Replace letter' : 'Add letter'}
                    <input type="file" accept="image/jpeg,image/jpg,image/png" className="sr-only" onChange={pickLcLetter} />
                  </label>
                  {newLcLetter && (
                    <button
                      type="button"
                      className="text-xs text-destructive"
                      onClick={() => {
                        URL.revokeObjectURL(newLcLetter.preview);
                        setNewLcLetter(null);
                      }}
                    >
                      Undo
                    </button>
                  )}
                </div>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground">JPG, JPEG or PNG · max 10 MB.</p>
          </div>
        </div>

        <DialogFooter className="sticky bottom-0 -mx-6 px-6 py-4 mt-2 bg-background border-t flex-col-reverse sm:flex-row gap-2 sm:gap-2 sm:space-x-0">
          {formError && (
            <div
              role="alert"
              className="w-full rounded-md border border-destructive/40 bg-destructive/10 p-3 text-left sm:order-first sm:w-auto sm:flex-1"
            >
              <p className="text-xs font-bold uppercase tracking-wide text-destructive">{formError.title}</p>
              {formError.description && (
                <p className="mt-0.5 text-xs text-foreground/90">{formError.description}</p>
              )}
            </div>
          )}
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={submitting}
            className="w-full sm:w-auto gap-2"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {uploadingEvidence ? 'Uploading photos…' : 'Resubmit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
