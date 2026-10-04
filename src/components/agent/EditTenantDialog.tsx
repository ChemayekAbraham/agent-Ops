import { useState, useEffect } from 'react';
import { z } from 'zod';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';
import { Label } from '@/components/ui/label';
import { Loader2, User, Phone, Mail, IdCard, Pencil, UserX, UserCheck, CheckCircle2, ArrowRight, X, ShieldAlert, RefreshCw, MessageSquare, AlertCircle, MapPin, Briefcase, Banknote, Smartphone, Wallet, StickyNote, Globe, Crosshair, Image as ImageIcon, ChevronDown, ChevronUp } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useIdempotentSubmit } from '@/hooks/useIdempotentSubmit';
import UgLocationPicker from '@/components/location/UgLocationPicker';
import PersonNameFields from '@/components/shared/PersonNameFields';
import {
  joinPersonName,
  splitPersonName,
  validatePersonNameParts,
  type PersonNameParts,
} from '@/lib/authValidation';
import { resolveUgVillage, resolveUgVillageByNames, type UgLocationSelection } from '@/hooks/useUgLocations';

interface EditTenantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: {
    id: string;
    full_name: string;
    phone: string;
    email: string | null;
    national_id: string | null;
    tenant_status?: string | null;
    evicted_at?: string | null;
  };
  onSaved?: (updated: Record<string, any>) => void;
}

const normalizePhone = (v: string) => v.replace(/[\s-]/g, '');
const normalizeNationalId = (v: string) => v.replace(/[\s-]/g, '');

const editSchema = z.object({
  full_name: z.string().trim().min(2, 'Full name must be at least 2 characters').max(100, 'Too long'),
  phone: z
    .string()
    .trim()
    .transform(normalizePhone)
    .pipe(
      z.string().regex(
        /^(\+256[7-9]\d{8}|0[7-9]\d{8})$/,
        'Enter a valid Uganda phone (e.g. +256712345678 or 0772123456)'
      )
    ),
  email: z
    .string()
    .trim()
    .max(255, 'Email too long')
    .refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
      message: 'Enter a valid email (e.g. name@domain.com)',
    })
    .optional()
    .or(z.literal('')),
  national_id: z
    .string()
    .trim()
    .toUpperCase()
    .transform(normalizeNationalId)
    .pipe(
      z.string().regex(
        /^[A-Z0-9]{10,14}$/,
        'National ID must be 10–14 letters/numbers (e.g. CM12345678ABCD)'
      )
    )
    .optional()
    .or(z.literal('')),
});

type SavedField = { label: string; oldValue: string; newValue: string; changed: boolean };
type PermissionBlock = {
  scope: 'profile' | 'status';
  message: string;
  fields: { label: string; oldValue: string; attemptedValue: string }[];
  retry: () => void;
};

export function EditTenantDialog({ open, onOpenChange, tenant, onSaved }: EditTenantDialogProps) {
  // Captured in parts, stored as the same single `full_name` string.
  const [nameParts, setNameParts] = useState<PersonNameParts>(splitPersonName(tenant.full_name));
  const fullName = joinPersonName(nameParts);
  const setFullName = (next: string) => setNameParts(splitPersonName(next));
  const [phone, setPhone] = useState(tenant.phone);
  const [email, setEmail] = useState(tenant.email || '');
  const [nationalId, setNationalId] = useState(tenant.national_id || '');
  // Extended editable fields (location + occupation + monthly rent)
  const [city, setCity] = useState('');
  const [district, setDistrict] = useState('');
  const [village, setVillage] = useState('');
  const [town, setTown] = useState('');
  const [occupation, setOccupation] = useState('');
  const [monthlyRent, setMonthlyRent] = useState<string>('');
  const [region, setRegion] = useState('');
  const [subCounty, setSubCounty] = useState('');
  const [parish, setParish] = useState('');
  const [landmark, setLandmark] = useState('');
  const [country, setCountry] = useState('');
  const [mmNumber, setMmNumber] = useState('');
  const [mmProvider, setMmProvider] = useState('');
  const [hasSmartphone, setHasSmartphone] = useState<boolean>(true);
  const [opsNote, setOpsNote] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [residenceLat, setResidenceLat] = useState<number | null>(null);
  const [residenceLng, setResidenceLng] = useState<number | null>(null);
  // Official Uganda village pick (shared picker). Replaces the old free-text
  // region / district / sub-county / parish / village inputs.
  const [ugVillageId, setUgVillageId] = useState<number | null>(null);
  const [ugSelection, setUgSelection] = useState<UgLocationSelection | null>(null);
  const [ugResolving, setUgResolving] = useState(false);
  // Legacy free-text address kept as read-only context when it can't be
  // matched to an official village.
  const legacyLocationLabel = [village, parish, subCounty, district, region]
    .map((v) => (v || '').trim())
    .filter(Boolean)
    .join(', ');
  const [pinningGps, setPinningGps] = useState(false);
  const [extendedLoading, setExtendedLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [statusBusy, setStatusBusy] = useState(false);
  const { submit: doSave, isSubmitting: saveSubmitting, reset: resetSave } = useIdempotentSubmit({ cooldownMs: 2000 });
  const [currentStatus, setCurrentStatus] = useState<string | null | undefined>(tenant.tenant_status);
  const [savedSummary, setSavedSummary] = useState<SavedField[] | null>(null);
  const [statusSummary, setStatusSummary] = useState<{ oldStatus: string; newStatus: string } | null>(null);
  const [permissionBlock, setPermissionBlock] = useState<PermissionBlock | null>(null);
  // Simple-first: only Name + Phone show by default. Everything else hides
  // behind a single "More" toggle so an agent who doesn't like reading sees
  // almost nothing on screen.
  const [showMore, setShowMore] = useState(false);
  // Snapshot of the values loaded from the DB so we can save ONLY changed fields.
  // Sending the whole profile on every edit dragged unchanged identity fields
  // (phone, national_id, monthly_rent…) through uniqueness/restriction triggers
  // and made simple name edits fail. Diffing keeps a name-only edit name-only.
  const [original, setOriginal] = useState<Record<string, any>>({});

  useEffect(() => {
    if (open) {
      setNameParts(splitPersonName(tenant.full_name));
      setPhone(tenant.phone);
      setEmail(tenant.email || '');
      setNationalId(tenant.national_id || '');
      setErrors({});
      setCurrentStatus(tenant.tenant_status);
      setSavedSummary(null);
      setStatusSummary(null);
      setPermissionBlock(null);
      setShowMore(false);
      resetSave();
      // Lazy-load extended profile fields so we never overwrite values we
      // didn't fetch when the agent saves.
      setExtendedLoading(true);
      (async () => {
        let data: Record<string, any> | null = null;
        try {
          const res = await supabase
            .from('profiles')
            .select('city, district, village, town, occupation, monthly_rent, region, sub_county, parish, landmark, country, mobile_money_number, mobile_money_provider, has_smartphone, ops_note, avatar_url, residence_lat, residence_lng, ug_village_id')
            .eq('id', tenant.id)
            .maybeSingle();
          data = res.data ?? null;
        } catch (e) {
          // Network/transient failure — don't leave the Save button stuck
          // disabled. Fall through with null data so the form stays usable;
          // the save diff still works for the always-loaded identity fields.
          console.warn('[EditTenantDialog] failed to load extended profile fields', e);
          toast.error('Failed to load tenant details', {
            description: 'Some fields may be unavailable until the connection improves. You can still save changes to name, phone, email, and ID.',
            duration: 6000,
          });
        }
        setCity(data?.city || '');
        setDistrict(data?.district || '');
        setVillage(data?.village || '');
        setTown(data?.town || '');
        setOccupation(data?.occupation || '');
        setMonthlyRent(data?.monthly_rent != null ? String(data.monthly_rent) : '');
        setRegion(data?.region || '');
        setSubCounty(data?.sub_county || '');
        setParish(data?.parish || '');
        setLandmark(data?.landmark || '');
        setCountry(data?.country || '');
        setMmNumber(data?.mobile_money_number || '');
        setMmProvider(data?.mobile_money_provider || '');
        setHasSmartphone(data?.has_smartphone ?? true);
        setOpsNote(data?.ops_note || '');
        setAvatarUrl(data?.avatar_url || '');
        setResidenceLat(data?.residence_lat ?? null);
        setResidenceLng(data?.residence_lng ?? null);
        const savedVillageId = (data as any)?.ug_village_id ?? null;
        setUgVillageId(savedVillageId);
        setUgSelection(null);
        // Pre-fill the picker: stored village id first, then a best-effort
        // upgrade of the legacy typed names. If neither resolves we keep the
        // old text as read-only context and require a fresh pick.
        setUgResolving(true);
        (async () => {
          try {
            const sel = savedVillageId
              ? await resolveUgVillage(savedVillageId)
              : await resolveUgVillageByNames(data?.village, data?.district);
            if (sel) setUgSelection(sel);
          } catch {
            /* keep the stored names as read-only context */
          } finally {
            setUgResolving(false);
          }
        })();
        setOriginal({
          full_name: tenant.full_name,
          phone: tenant.phone,
          email: tenant.email || '',
          national_id: tenant.national_id || '',
          city: data?.city || '',
          district: data?.district || '',
          village: data?.village || '',
          town: data?.town || '',
          occupation: data?.occupation || '',
          monthly_rent: data?.monthly_rent != null ? String(data.monthly_rent) : '',
          region: data?.region || '',
          sub_county: data?.sub_county || '',
          parish: data?.parish || '',
          landmark: data?.landmark || '',
          country: data?.country || '',
          mobile_money_number: data?.mobile_money_number || '',
          mobile_money_provider: data?.mobile_money_provider || '',
          has_smartphone: data?.has_smartphone ?? true,
          ops_note: data?.ops_note || '',
          avatar_url: data?.avatar_url || '',
          residence_lat: data?.residence_lat ?? null,
          residence_lng: data?.residence_lng ?? null,
          ug_village_id: savedVillageId,
        });
        setExtendedLoading(false);
      })().catch(() => setExtendedLoading(false));
    }
  }, [open, tenant, resetSave]);

  // Live re-validate so the Save button (and error text) never stays in a stale "invalid" state
  // once the user has corrected a previously-flagged field.
  useEffect(() => {
    if (!open) return;
    const parsed = editSchema.safeParse({
      full_name: fullName,
      phone,
      email: email || undefined,
      national_id: nationalId || undefined,
    });
    if (parsed.success) {
      setErrors((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    const validNow = new Set(['full_name', 'phone', 'email', 'national_id']);
    for (const issue of parsed.error.issues) {
      validNow.delete(issue.path[0] as string);
    }
    setErrors((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const f of validNow) {
        if (next[f]) {
          delete next[f];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [open, fullName, phone, email, nationalId]);

  const isPermissionError = (err: any, rowsReturned: number | null) => {
    if (rowsReturned === 0) return true;
    const code = err?.code || '';
    const msg = (err?.message || '').toLowerCase();
    return (
      code === '42501' ||
      code === 'PGRST301' ||
      msg.includes('row-level security') ||
      msg.includes('permission') ||
      msg.includes("don't have permission")
    );
  };

  const writeAuditLog = async (
    actionType: 'tenant_profile_edit' | 'tenant_status_change',
    changedFields: { field: string; old_value: string | null; new_value: string | null }[],
    reason: string,
  ) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: actionType,
        table_name: 'profiles',
        record_id: tenant.id,
        metadata: {
          tenant_id: tenant.id,
          tenant_name: tenant.full_name,
          editor_id: user.id,
          editor_email: user.email,
          edited_at: new Date().toISOString(),
          changed_fields: changedFields,
          reason,
        },
      });
    } catch (e) {
      console.warn('[audit_logs] failed to write tenant edit audit', e);
    }
  };

  const validateField = (field: 'full_name' | 'phone' | 'email' | 'national_id') => {
    const raw = {
      full_name: fullName,
      phone,
      email: email || undefined,
      national_id: nationalId || undefined,
    };
    const result = editSchema.safeParse(raw);
    if (result.success) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
      return;
    }
    const issue = result.error.issues.find((i) => i.path[0] === field);
    if (issue) {
      setErrors((prev) => ({ ...prev, [field]: issue.message }));
    }
  };

  const handleSave = async () => {
    const nameCheck = validatePersonNameParts(nameParts);
    if (!nameCheck.valid) {
      setErrors((prev) => ({ ...prev, full_name: nameCheck.error || 'Full name is required' }));
      return;
    }
    const parsed = editSchema.safeParse({
      full_name: fullName,
      phone,
      email: email || undefined,
      national_id: nationalId || undefined,
    });

    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const k = issue.path[0] as string;
        if (!fieldErrors[k]) fieldErrors[k] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }

    await doSave(async () => {
      const cleanRent = monthlyRent.replace(/[^\d]/g, '');
      // Full candidate (normalized) — what the form currently holds.
      const candidate: Record<string, any> = {
        full_name: parsed.data.full_name,
        phone: parsed.data.phone,
        email: parsed.data.email || null,
        national_id: parsed.data.national_id || null,
        city: city.trim() || null,
        district: ugSelection ? ugSelection.district : district.trim() || null,
        village: ugSelection ? ugSelection.village : village.trim() || null,
        town: town.trim() || null,
        occupation: occupation.trim() || null,
        monthly_rent: cleanRent ? Number(cleanRent) : null,
        region: ugSelection ? ugSelection.region : region.trim() || null,
        sub_county: ugSelection ? ugSelection.subcounty : subCounty.trim() || null,
        parish: ugSelection ? ugSelection.parish : parish.trim() || null,
        ug_village_id: ugSelection ? ugSelection.villageId : ugVillageId,
        landmark: landmark.trim() || null,
        country: country.trim() || null,
        mobile_money_number: mmNumber.trim() || null,
        mobile_money_provider: mmProvider.trim() || null,
        has_smartphone: hasSmartphone,
        ops_note: opsNote.trim() || null,
        avatar_url: avatarUrl.trim() || null,
        residence_lat: residenceLat,
        residence_lng: residenceLng,
      };

      // Same normalization applied to the originally-loaded values, so we can
      // send ONLY the fields the agent actually changed. A name-only edit then
      // produces { full_name } and never touches phone/national_id triggers.
      const origRent = String(original.monthly_rent || '').replace(/[^\d]/g, '');
      const origCandidate: Record<string, any> = {
        full_name: (original.full_name || '').trim(),
        phone: normalizePhone(original.phone || ''),
        email: (original.email || '').trim() || null,
        national_id: normalizeNationalId((original.national_id || '').toUpperCase()).trim() || null,
        city: (original.city || '').trim() || null,
        district: (original.district || '').trim() || null,
        village: (original.village || '').trim() || null,
        town: (original.town || '').trim() || null,
        occupation: (original.occupation || '').trim() || null,
        monthly_rent: origRent ? Number(origRent) : null,
        region: (original.region || '').trim() || null,
        sub_county: (original.sub_county || '').trim() || null,
        parish: (original.parish || '').trim() || null,
        landmark: (original.landmark || '').trim() || null,
        country: (original.country || '').trim() || null,
        mobile_money_number: (original.mobile_money_number || '').trim() || null,
        mobile_money_provider: (original.mobile_money_provider || '').trim() || null,
        has_smartphone: original.has_smartphone ?? true,
        ops_note: (original.ops_note || '').trim() || null,
        avatar_url: (original.avatar_url || '').trim() || null,
        residence_lat: original.residence_lat ?? null,
        residence_lng: original.residence_lng ?? null,
        ug_village_id: original.ug_village_id ?? null,
      };

      const payload: Record<string, any> = {};
      for (const key of Object.keys(candidate)) {
        if (candidate[key] !== origCandidate[key]) payload[key] = candidate[key];
      }

      try {
        // Nothing changed — short-circuit so we never round-trip an empty update.
        if (Object.keys(payload).length === 0) {
          setSavedSummary([
            { label: 'Full Name', oldValue: tenant.full_name, newValue: parsed.data.full_name, changed: false },
            { label: 'Phone Number', oldValue: tenant.phone, newValue: parsed.data.phone, changed: false },
            { label: 'Email', oldValue: tenant.email || '—', newValue: parsed.data.email || '—', changed: false },
            { label: 'National ID', oldValue: tenant.national_id || '—', newValue: parsed.data.national_id || '—', changed: false },
          ]);
          toast.success('No changes to save');
          return;
        }

        const { data, error } = await supabase
          .from('profiles')
          .update(payload)
          .eq('id', tenant.id)
          .select('id, full_name, phone, email, national_id');
        let rowsReturned = data?.length ?? 0;

        // RLS can allow the UPDATE but withhold the returned row (the SELECT-on-
        // returning policy is narrower). That is NOT a permission failure. When
        // there's no error but no row came back, verify by re-reading the row;
        // if our changes landed, treat it as a success instead of falsely
        // showing "Manager Approval Required".
        if (!error && rowsReturned === 0) {
          const { data: verify } = await supabase
            .from('profiles')
            .select('full_name, phone, email, national_id')
            .eq('id', tenant.id)
            .maybeSingle();
          if (
            verify &&
            (!('full_name' in payload) || verify.full_name === payload.full_name) &&
            (!('phone' in payload) || verify.phone === payload.phone) &&
            (!('national_id' in payload) || (verify.national_id || null) === payload.national_id)
          ) {
            rowsReturned = 1;
          }
        }

        if (error || rowsReturned === 0) {
          if (isPermissionError(error, rowsReturned)) {
            const attempted = {
              'Full Name': parsed.data.full_name,
              'Phone Number': parsed.data.phone,
              'Email': parsed.data.email || '—',
              'National ID': parsed.data.national_id || '—',
            };
            const original = {
              'Full Name': tenant.full_name,
              'Phone Number': tenant.phone,
              'Email': tenant.email || '—',
              'National ID': tenant.national_id || '—',
            };
            const blockedFields = (Object.keys(attempted) as (keyof typeof attempted)[])
              .filter((k) => attempted[k] !== original[k])
              .map((k) => ({ label: k, oldValue: original[k], attemptedValue: attempted[k] }));
            setPermissionBlock({
              scope: 'profile',
              message:
                error?.message ||
                "Your role doesn't allow editing this tenant's identity fields. A manager must approve or apply these changes.",
              fields: blockedFields.length
                ? blockedFields
                : [{ label: 'Tenant profile', oldValue: '—', attemptedValue: '—' }],
              retry: () => {
                setPermissionBlock(null);
                void handleSave();
              },
            });
            toast.error('Permission blocked', { description: 'Escalate to a manager to save these changes.' });
            return;
          }
          throw error || new Error('Update did not return any rows.');
        }

        const oldVals = {
          'Full Name': tenant.full_name,
          'Phone Number': tenant.phone,
          'Email': tenant.email || '—',
          'National ID': tenant.national_id || '—',
        };
        const newVals = {
          'Full Name': parsed.data.full_name,
          'Phone Number': parsed.data.phone,
          'Email': parsed.data.email || '—',
          'National ID': parsed.data.national_id || '—',
        };
        const summary: SavedField[] = [
          { label: 'Full Name', oldValue: oldVals['Full Name'], newValue: newVals['Full Name'], changed: oldVals['Full Name'] !== newVals['Full Name'] },
          { label: 'Phone Number', oldValue: oldVals['Phone Number'], newValue: newVals['Phone Number'], changed: oldVals['Phone Number'] !== newVals['Phone Number'] },
          { label: 'Email', oldValue: oldVals['Email'], newValue: newVals['Email'], changed: oldVals['Email'] !== newVals['Email'] },
          { label: 'National ID', oldValue: oldVals['National ID'], newValue: newVals['National ID'], changed: oldVals['National ID'] !== newVals['National ID'] },
        ];
        setSavedSummary(summary);
        const changedFields = summary
          .filter((f) => f.changed)
          .map((f) => ({ field: f.label, old_value: f.oldValue, new_value: f.newValue }));
        if (changedFields.length > 0) {
          await writeAuditLog(
            'tenant_profile_edit',
            changedFields,
            `Agent edited tenant identity fields (${changedFields.map((f) => f.field).join(', ')})`,
          );
        }
        toast.success('Tenant details saved', { description: parsed.data.full_name });
        onSaved?.(payload);
      } catch (err: any) {
        toast.error('Failed to update', { description: err.message || 'Please try again' });
      }
    });
  };

  const isInactive = currentStatus === 'inactive';
  const isEvicted = currentStatus === 'evicted';

  const handleToggleActive = async () => {
    if (isEvicted) return;
    const nextStatus = isInactive ? 'active' : 'inactive';
    if (nextStatus === 'inactive') {
      const reason = window.prompt(
        'Why is this tenant no longer active? (e.g. moved out, defaulted, wrong number)\nThis will be visible to Tenant Ops.',
        '',
      );
      if (reason === null) return; // user cancelled
      if (reason.trim().length < 4) {
        toast.error('Please give a short reason (4+ characters).');
        return;
      }
    } else {
      const ok = window.confirm('Reactivate this tenant? They will be counted as active again.');
      if (!ok) return;
    }
    setStatusBusy(true);
    try {
      const { data, error } = await supabase
        .from('profiles')
        .update({ tenant_status: nextStatus })
        .eq('id', tenant.id)
        .select('id');
      const rowsReturned = data?.length ?? 0;
      if (error || rowsReturned === 0) {
        if (isPermissionError(error, rowsReturned)) {
          const prev = currentStatus || 'active';
          setPermissionBlock({
            scope: 'status',
            message:
              error?.message ||
              "Your role doesn't allow changing tenant status. Ask a manager to approve this change.",
            fields: [{ label: 'Tenant Status', oldValue: prev, attemptedValue: nextStatus }],
            retry: () => {
              setPermissionBlock(null);
              void handleToggleActive();
            },
          });
          toast.error('Permission blocked', { description: 'Escalate to a manager to change status.' });
          return;
        }
        throw error || new Error('Status update did not return any rows.');
      }
      const prev = currentStatus || 'active';
      setCurrentStatus(nextStatus);
      setStatusSummary({ oldStatus: prev, newStatus: nextStatus });
      await writeAuditLog(
        'tenant_status_change',
        [{ field: 'tenant_status', old_value: prev, new_value: nextStatus }],
        `Agent changed tenant status from ${prev} to ${nextStatus}`,
      );
      onSaved?.({
        full_name: fullName,
        phone,
        email: email || null,
        national_id: nationalId || null,
        tenant_status: nextStatus,
      });
      toast.success(nextStatus === 'inactive' ? 'Tenant marked as not active' : 'Tenant reactivated');
    } catch (err: any) {
      toast.error('Could not update status', { description: err?.message || 'Please try again' });
    } finally {
      setStatusBusy(false);
    }
  };

  const handleCloseConfirmation = () => {
    // no-op
    setSavedSummary(null);
    setStatusSummary(null);
    setPermissionBlock(null);
    onOpenChange(false);
  };

  const captureGps = () => {
    if (!('geolocation' in navigator)) {
      toast.error('GPS not available on this device');
      return;
    }
    setPinningGps(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setResidenceLat(Number(pos.coords.latitude.toFixed(6)));
        setResidenceLng(Number(pos.coords.longitude.toFixed(6)));
        setPinningGps(false);
        toast.success('GPS captured');
      },
      (err) => {
        setPinningGps(false);
        toast.error(err.message || 'Failed to capture GPS');
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const showingConfirmation = savedSummary !== null || statusSummary !== null;
  const showingPermissionBlock = permissionBlock !== null;

  const notifyManager = () => {
    if (!permissionBlock) return;
    const lines = [
      `Manager approval needed for tenant ${tenant.full_name} (${tenant.phone}).`,
      permissionBlock.scope === 'profile'
        ? 'Requested profile edits:'
        : 'Requested status change:',
      ...permissionBlock.fields.map(
        (f) => `• ${f.label}: "${f.oldValue}" → "${f.attemptedValue}"`,
      ),
      '',
      'Reason from system: ' + permissionBlock.message,
    ];
    const text = lines.join('\n');
    const wa = `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(wa, '_blank');
    toast.success('Manager notification drafted', { description: 'Send it via WhatsApp to your manager.' });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        {showingPermissionBlock && permissionBlock ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <ShieldAlert className="h-5 w-5" />
                Manager Approval Required
              </DialogTitle>
              <DialogDescription>
                Your role isn't allowed to save these changes directly. Escalate to a manager or retry.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 pt-2">
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-2">
                <p className="text-xs font-semibold text-destructive uppercase tracking-wide">
                  {permissionBlock.scope === 'profile' ? 'Blocked Field Changes' : 'Blocked Status Change'}
                </p>
                {permissionBlock.fields.map((field) => (
                  <div key={field.label} className="flex flex-col gap-0.5">
                    <span className="text-[11px] text-muted-foreground">{field.label}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-sm flex-1 line-through text-muted-foreground">
                        {field.oldValue}
                      </span>
                      <ArrowRight className="h-3 w-3 text-destructive shrink-0" />
                      <span className="text-sm font-semibold text-destructive flex-1 capitalize">
                        {field.attemptedValue}
                      </span>
                      <span className="text-[10px] font-bold text-destructive bg-destructive/10 px-1.5 py-0.5 rounded">
                        BLOCKED
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-md border bg-muted/40 p-2.5 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Reason:</span> {permissionBlock.message}
              </div>

              <div className="flex flex-col gap-2 pt-1">
                <Button onClick={notifyManager} className="w-full">
                  <MessageSquare className="h-4 w-4 mr-2" />
                  Notify manager via WhatsApp
                </Button>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => setPermissionBlock(null)}
                    disabled={saveSubmitting || statusBusy}
                  >
                    <X className="h-4 w-4 mr-2" />
                    Back
                  </Button>
                  <Button
                    variant="secondary"
                    className="flex-1"
                    onClick={permissionBlock.retry}
                    disabled={saveSubmitting || statusBusy}
                  >
                    {(saveSubmitting || statusBusy) ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <RefreshCw className="h-4 w-4 mr-2" />
                    )}
                    Retry save
                  </Button>
                </div>
              </div>
            </div>
          </>
        ) : showingConfirmation ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-emerald-600">
                <CheckCircle2 className="h-5 w-5" />
                Changes Saved
              </DialogTitle>
              <DialogDescription>
                Here is exactly what was updated for this tenant.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 pt-2">
              {savedSummary && (
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-2">
                  <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-300 uppercase tracking-wide">
                    Updated Fields
                  </p>
                  {savedSummary.map((field) => (
                    <div key={field.label} className="flex flex-col gap-0.5">
                      <span className="text-[11px] text-muted-foreground">{field.label}</span>
                      <div className="flex items-center gap-2">
                        <span className={`text-sm flex-1 ${field.changed ? 'line-through text-muted-foreground' : ''}`}>
                          {field.oldValue}
                        </span>
                        {field.changed && (
                          <>
                            <ArrowRight className="h-3 w-3 text-emerald-500 shrink-0" />
                            <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400 flex-1">
                              {field.newValue}
                            </span>
                            <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-900/40 px-1.5 py-0.5 rounded">
                              CHANGED
                            </span>
                          </>
                        )}
                        {!field.changed && (
                          <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                            UNCHANGED
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {statusSummary && (
                <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 space-y-2">
                  <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 uppercase tracking-wide">
                    Status Change
                  </p>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground capitalize">{statusSummary.oldStatus}</span>
                    <ArrowRight className="h-3 w-3 text-blue-500 shrink-0" />
                    <span className="text-sm font-semibold text-blue-600 dark:text-blue-400 capitalize">
                      {statusSummary.newStatus}
                    </span>
                    <span className="text-[10px] font-bold text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/40 px-1.5 py-0.5 rounded">
                      CHANGED
                    </span>
                  </div>
                </div>
              )}

              <Button className="w-full mt-2" onClick={handleCloseConfirmation}>
                <CheckCircle2 className="h-4 w-4 mr-2" />
                Done
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Pencil className="h-5 w-5 text-primary" />
                Edit tenant
              </DialogTitle>
              <DialogDescription className="sr-only">
                Edit the tenant name and phone number.
              </DialogDescription>
            </DialogHeader>

            {isEvicted && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 shrink-0" /> Locked
              </div>
            )}

            <fieldset disabled={isEvicted} className="space-y-4 pt-2 disabled:opacity-60">
              {/* ===== ALWAYS VISIBLE: name + phone, big and icon-led ===== */}
              <div className="space-y-1.5">
                <Label className="flex items-center gap-2 text-sm font-semibold">
                  <User className="h-5 w-5 text-primary" /> Name
                </Label>
                <PersonNameFields
                  idPrefix="edit-tenant"
                  value={nameParts}
                  onChange={setNameParts}
                />
                {errors.full_name && (
                  <p className="text-xs text-destructive mt-1 flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" /> {errors.full_name}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label className="flex items-center gap-2 text-sm font-semibold">
                  <Phone className="h-5 w-5 text-primary" /> Phone
                </Label>
                <PhoneInput
                  value={phone}
                  onChange={(v) => setPhone(v)}
                  onBlur={() => validateField('phone')}
                  onContactPicked={({ name }) => {
                    if (name && !fullName.trim()) setFullName(name);
                  }}
                  placeholder="+256712345678"
                />
                {errors.phone && (
                  <p className="text-xs text-destructive mt-1 flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" /> {errors.phone}
                  </p>
                )}
              </div>

              {/* Big, obvious Save */}
              <Button
                className="w-full h-12 text-base font-semibold"
                onClick={handleSave}
                disabled={saveSubmitting || extendedLoading}
              >
                {saveSubmitting ? <Loader2 className="h-5 w-5 animate-spin mr-2" /> : <CheckCircle2 className="h-5 w-5 mr-2" />}
                Save
              </Button>

              {/* Single low-reading toggle to reveal everything else */}
              <button
                type="button"
                onClick={() => setShowMore((s) => !s)}
                className="w-full flex items-center justify-center gap-1.5 text-xs font-medium text-muted-foreground py-1.5"
              >
                {showMore ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                {showMore ? 'Less' : 'More'}
              </button>

              {showMore && (
              <div className="space-y-3 border-t pt-3">
              <div>
                <Label className="text-xs flex items-center gap-1.5">
                  <Mail className="h-3 w-3" /> Email <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={() => validateField('email')}
                  placeholder="jane@example.com"
                  maxLength={255}
                />
                {errors.email && <p className="text-xs text-destructive mt-1">{errors.email}</p>}
              </div>

              <div>
                <Label className="text-xs flex items-center gap-1.5">
                  <IdCard className="h-3 w-3" /> National ID <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  value={nationalId}
                  onChange={(e) => setNationalId(normalizeNationalId(e.target.value.toUpperCase()))}
                  onBlur={() => validateField('national_id')}
                  placeholder="CM12345678ABCD"
                  maxLength={18}
                />
                {errors.national_id && <p className="text-xs text-destructive mt-1">{errors.national_id}</p>}
              </div>

              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-primary" />
                  <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                    Location & Property
                  </span>
                  {extendedLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">Town</Label>
                    <Input value={town} onChange={(e) => setTown(e.target.value)} placeholder="e.g. Wandegeya" maxLength={80} />
                  </div>
                  <div>
                    <Label className="text-xs">City</Label>
                    <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. Kampala" maxLength={80} />
                  </div>
                </div>

                {ugResolving ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading saved location…
                  </div>
                ) : (
                  <>
                    <UgLocationPicker
                      label="Official location (village / LC1)"
                      value={ugSelection}
                      onChange={(sel) => setUgSelection(sel)}
                    />
                    {!ugSelection && legacyLocationLabel && (
                      <p className="text-[11px] text-muted-foreground">
                        Saved (unmatched) address:{' '}
                        <span className="font-medium text-foreground">{legacyLocationLabel}</span> — pick the official
                        village above to update it.
                      </p>
                    )}
                  </>
                )}

                <div>
                  <Label className="text-xs flex items-center gap-1.5">
                    <Briefcase className="h-3 w-3" /> Occupation
                  </Label>
                  <Input value={occupation} onChange={(e) => setOccupation(e.target.value)} placeholder="e.g. Boda rider, shopkeeper" maxLength={120} />
                </div>

                <div>
                  <Label className="text-xs flex items-center gap-1.5">
                    <Banknote className="h-3 w-3" /> Monthly Rent (UGX)
                  </Label>
                  <Input
                    inputMode="numeric"
                    value={monthlyRent ? Number(monthlyRent.replace(/[^\d]/g,'')).toLocaleString('en-UG') : ''}
                    onChange={(e) => setMonthlyRent(e.target.value.replace(/[^\d]/g, ''))}
                    placeholder="e.g. 250,000"
                  />
                </div>

                <div>
                  <Label className="text-xs flex items-center gap-1.5"><Globe className="h-3 w-3" /> Country</Label>
                  <Input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="e.g. Uganda" maxLength={80} />
                </div>

                <div>
                  <Label className="text-xs">Landmark</Label>
                  <Input value={landmark} onChange={(e) => setLandmark(e.target.value)} placeholder="e.g. near SDA Church" maxLength={160} />
                </div>

                <div className="space-y-2 p-3 rounded-lg bg-muted/30 border border-border/50">
                  <div className="flex items-center justify-between">
                    <Label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">GPS Pin (optional)</Label>
                    <Button type="button" size="sm" variant="outline" onClick={captureGps} disabled={pinningGps} className="rounded-lg gap-1.5 text-xs h-8">
                      {pinningGps ? <Loader2 className="h-3 w-3 animate-spin" /> : <Crosshair className="h-3 w-3" />}
                      {residenceLat ? 'Re-capture' : 'Capture GPS'}
                    </Button>
                  </div>
                  {residenceLat != null && residenceLng != null ? (
                    <p className="text-xs text-muted-foreground font-mono">
                      {residenceLat.toFixed(5)}, {residenceLng.toFixed(5)}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">No pin saved</p>
                  )}
                </div>
              </div>

              <div className="border-t pt-3 mt-1 space-y-3">
                <div className="flex items-center gap-2">
                  <Wallet className="h-4 w-4 text-primary" />
                  <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                    Mobile Money & Device
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">MoMo Number</Label>
                    <Input value={mmNumber} onChange={(e) => setMmNumber(e.target.value)} placeholder="e.g. 0772123456" maxLength={20} />
                  </div>
                  <div>
                    <Label className="text-xs">MoMo Provider</Label>
                    <Input value={mmProvider} onChange={(e) => setMmProvider(e.target.value)} placeholder="MTN / Airtel" maxLength={40} />
                  </div>
                </div>

                <label className="flex items-center gap-2 text-xs cursor-pointer p-2 rounded-md hover:bg-muted/50">
                  <input
                    type="checkbox"
                    checked={hasSmartphone}
                    onChange={(e) => setHasSmartphone(e.target.checked)}
                    className="h-4 w-4"
                  />
                  <Smartphone className="h-3.5 w-3.5 text-primary" />
                  <span>Tenant has a smartphone</span>
                </label>

                <div>
                  <Label className="text-xs flex items-center gap-1.5">
                    <ImageIcon className="h-3 w-3" /> Avatar URL <span className="text-muted-foreground">(optional)</span>
                  </Label>
                  <Input value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder="https://..." maxLength={500} />
                </div>

                <div>
                  <Label className="text-xs flex items-center gap-1.5">
                    <StickyNote className="h-3 w-3" /> Ops Note <span className="text-muted-foreground">(internal)</span>
                  </Label>
                  <Textarea
                    value={opsNote}
                    onChange={(e) => setOpsNote(e.target.value)}
                    placeholder="Notes for Tenant Ops about this tenant (visible internally)"
                    rows={3}
                    maxLength={1000}
                  />
                </div>
              </div>

              {!isEvicted && (
                <div className="border-t pt-3 mt-1">
                  <Button
                    type="button"
                    variant={isInactive ? 'default' : 'outline'}
                    className={`w-full ${isInactive ? '' : 'text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive'}`}
                    onClick={handleToggleActive}
                    disabled={statusBusy}
                  >
                    {statusBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : isInactive ? (
                      <UserCheck className="h-4 w-4 mr-2" />
                    ) : (
                      <UserX className="h-4 w-4 mr-2" />
                    )}
                    {isInactive ? 'Reactivate tenant' : 'Mark as not active'}
                  </Button>
                </div>
              )}
              </div>
              )}
            </fieldset>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
