import { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Camera, ShieldCheck, Loader2, X, ScanLine, CheckCircle2, AlertTriangle, ScanFace, Wallet, Save } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  useMyIdentityPhotos,
  useSubmitIdentityPhotos,
  uploadIdentityPhoto,
  setSelfieAsProfilePhoto,
  identityPhotoUrl,
} from '@/hooks/useIdentityPhotos';
import { useIdentityAlreadyVerified } from '@/hooks/useIdentityAlreadyVerified';
import {
  readNationalIdPhoto, idNameVerdict, readingGuidance, EMPTY_ID_DATA, ID_FIELD_LABEL,
  type NationalIdReading, type NationalIdData,
} from '@/lib/nationalIdOcr';
import { runPassportFaceCheck, faceCheckBlocker, type PassportFaceCheck } from '@/lib/passportFaceCheck';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { imageFingerprint } from '@/lib/imageFingerprint';
import { useMyPayoutDestinations, type MyPayoutDestination } from '@/hooks/usePayoutVerification';
import { PayoutDestinationConsentDialog } from '@/components/payments/PayoutDestinationConsentDialog';
import { Smartphone } from 'lucide-react';
import { useOtpVerification } from '@/hooks/useOtpVerification';
import {
  useIdentityBinding,
  useCompleteIdentityBinding,
  maskPayoutNumber,
} from '@/hooks/useIdentityBinding';
import { Lock } from 'lucide-react';
import { useMyNumberChangeRequest } from '@/hooks/usePayoutNumberChange';
import PayoutNumberChangeDialog from './PayoutNumberChangeDialog';


import SelfieCropDialog from './SelfieCropDialog';
import SelfieProfilePreviewDialog from './SelfieProfilePreviewDialog';
import NationalIdLinkFlow from './NationalIdLinkFlow';


const MAX_BYTES = 10 * 1024 * 1024;

interface ShotTileProps {
  label: string;
  hint: string;
  file: File | null;
  onPick: (file: File) => void;
  onClear: () => void;
  disabled?: boolean;
  /** Which camera to open. A selfie must not open the rear camera. */
  facing?: 'user' | 'environment';
}

function ShotTile({ label, hint, file, onPick, onClear, disabled, facing }: ShotTileProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const preview = file ? URL.createObjectURL(file) : null;

  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{label}</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        {file && (
          <Button variant="ghost" size="icon" onClick={onClear} disabled={disabled} aria-label={`Remove ${label}`}>
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {preview && (
        <img src={preview} alt={`${label} preview`} className="h-40 w-full rounded-md object-cover" />
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture={facing ?? 'environment'}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          if (f.size > MAX_BYTES) {
            toast.error('That photo is too large. Please take a smaller one.');
            return;
          }
          onPick(f);
        }}
      />

      <Button
        variant={file ? 'outline' : 'default'}
        className="w-full"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <Camera className="mr-2 h-4 w-4" />
        {file ? 'Retake' : 'Take photo'}
      </Button>
    </div>
  );
}


/** Thumbnail of a photo already archived in the verification history. */
function StoredShot({ path, label, note }: { path: string; label: string; note: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    identityPhotoUrl(path).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [path]);

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3">
      {url ? (
        <img src={url} alt={label} className="h-16 w-16 rounded-md border object-cover" />
      ) : (
        <div className="h-16 w-16 animate-pulse rounded-md bg-muted" />
      )}
      <div className="min-w-0">
        <p className="text-sm font-semibold">{label} already on file</p>
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>
    </div>
  );
}

/**
 * Confirm ownership of the payout number by code (OTP), right here on the
 * identity screen. Sending the code, checking it and correcting the registered
 * name all happen in the shared consent dialog — nothing is decided locally.
 */
type MomoProvider = 'mtn' | 'airtel';

/** Detects MTN / Airtel from the Ugandan operator prefix. */
function detectMomoProvider(raw: string): MomoProvider | null {
  const d = raw.replace(/\D/g, '');
  const local = d.startsWith('256') ? `0${d.slice(3)}` : d.startsWith('0') ? d : `0${d}`;
  const p = local.slice(0, 3);
  if (['077', '078', '076', '039'].includes(p)) return 'mtn';
  if (['075', '070', '074', '020'].includes(p)) return 'airtel';
  return null;
}

function PayoutNumberVerification({ userId }: { userId: string | null | undefined }) {
  const list = useMyPayoutDestinations(userId);
  const [target, setTarget] = useState<MyPayoutDestination | null>(null);
  const binding = useIdentityBinding(userId ?? undefined);
  const bind = useCompleteIdentityBinding();
  const lockedNumber = binding.data?.locked_payout_number ?? null;
  const changeRequest = useMyNumberChangeRequest();
  const [changeOpen, setChangeOpen] = useState(false);

  const rows = list.data ?? [];
  const existingMomo = rows.find((d) => d.destination_type === 'mobile_money');

  const [number, setNumber] = useState('');
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<MomoProvider>('mtn');
  const [saving, setSaving] = useState(false);
  const [code, setCode] = useState('');
  /* The number the code was actually sent to. The save can only ever use this
     value, so editing the field after the SMS went out cannot slip an
     unverified number through. */
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const otp = useOtpVerification();
  const { user: authUser } = useAuth();

  useEffect(() => {
    if (list.isLoading) return;
    const momo = rows.find((d) => d.destination_type === 'mobile_money');
    setNumber(momo?.momo_number ?? '');
    setName(momo?.account_name ?? '');
    setProvider(
      (momo?.provider?.toLowerCase() as MomoProvider) ??
        detectMomoProvider(momo?.momo_number ?? '') ??
        'mtn',
    );
  }, [list.data, list.isLoading]);

  /** Shared validation for both steps. */
  const validate = () => {
    const trimmedName = name.trim();
    const digits = number.replace(/\D/g, '');
    if (digits.length < 9) {
      toast.error('Enter a valid mobile money number');
      return null;
    }
    if (trimmedName.split(/\s+/).filter(Boolean).length < 2) {
      toast.error('Enter the full name exactly as it shows on mobile money');
      return null;
    }
    return { trimmedName, digits };
  };

  /* Step 1 — prove the person holds the SIM before anything is stored.
     The SMS uses the same payout wording as the owner-consent message, so the
     person reading it sees one consistent sentence whichever route asked. */
  const handleSendCode = async () => {
    const v = validate();
    if (!v) return;
    const requesterName =
      (authUser?.user_metadata?.full_name as string | undefined)?.trim() ||
      (authUser?.user_metadata?.name as string | undefined)?.trim() ||
      v.trimmedName;
    const digitsLast4 = v.digits.length >= 4 ? v.digits.slice(-4) : '';
    const sent = await otp.sendOtp(number.trim(), {
      purpose: 'payout_number',
      subject_name: requesterName,
      recipient_name: v.trimmedName,
      phone_last4: digitsLast4,
    });
    if (sent) {
      setCode('');
      setCodeSentTo(number.trim());
    }
  };

  /* Step 2 — the code must verify against THIS number before the save runs. */
  const handleConfirmAndSave = async () => {
    if (!userId || !codeSentTo) return;
    const v = validate();
    if (!v) return;
    if (code.replace(/\D/g, '').length !== 6) {
      toast.error('Enter the 6-digit code we sent to that number');
      return;
    }
    setSaving(true);
    try {
      const ok = await otp.verifyOtp(codeSentTo, code.replace(/\D/g, ''));
      if (!ok) {
        toast.error(otp.otpError || 'That code is not correct. Check the SMS and try again.');
        return;
      }

      const { data, error } = await supabase.rpc('set_withdrawal_account', {
        p_number: codeSentTo,
        p_name: v.trimmedName,
        p_provider: provider,
      });
      if (error) throw error;
      const saved = (data ?? {}) as Record<string, string>;
      const savedNumber = saved.mobile_money_number ?? codeSentTo;
      const savedName = saved.mobile_money_name ?? v.trimmedName;
      const savedProvider = (saved.mobile_money_provider?.toLowerCase() as MomoProvider) ?? provider;

      const { error: ensureErr } = await supabase.rpc('ensure_payout_destination', {
        p_user_id: userId,
        p_method: 'mobile_money',
        p_momo_number: savedNumber,
        p_momo_name: savedName,
        p_provider: savedProvider,
      });
      if (ensureErr) throw ensureErr;

      /* Record the code confirmation on the destination itself (the code table
         is short-lived) and let the server verify the number straight away when
         the ID number, the selfie face check and this code all passed. Every
         server guard still applies, so this can only ever confirm a case a
         reviewer would have confirmed by hand. */
      const { data: own, error: ownErr } = await supabase.rpc('confirm_payout_number_ownership', {
        p_number: savedNumber,
      });
      if (ownErr) throw ownErr;

      /* Bind the captured identity and lock this number to the account. The
         server decides whether everything needed is on file; it never
         overwrites a binding that already exists. */
      const bound = await bind.tryComplete();

      toast.success(existingMomo ? 'Payout number updated' : 'Payout number added', {
        description:
          bound?.code === 'identity_captured'
            ? 'Your identity details are saved and this number is now locked for your withdrawals.'
            : 'You confirmed the number with the code sent to it.',
      });
      setCode('');
      setCodeSentTo(null);
      otp.resetOtp();
      void list.refetch();
      void binding.refetch();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to save payout number');
    } finally {
      setSaving(false);
    }
  };

  const label = (d: MyPayoutDestination) =>
    d.destination_type === 'mobile_money'
      ? d.momo_number || 'Mobile money number'
      : `${d.bank_name ?? 'Bank'} ${d.bank_account_number ?? ''}`.trim();

  /* Once the identity is captured, the number is locked to the account: it is
     shown masked and read-only. It can only move when Financial Ops approves a
     change request. */
  if (lockedNumber) {
    const pending = changeRequest.data?.status === 'pending';
    const rejected = changeRequest.data?.status === 'rejected';
    return (
      <div className="space-y-3 rounded-lg border p-3">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          Identity details saved
        </p>
        <p className="text-xs text-muted-foreground">
          Your identity details have been securely linked to your account.
        </p>
        <div className="rounded-md border bg-muted/40 p-3 space-y-1">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Withdrawal number
          </p>
          <p className="text-base font-bold tracking-wide">{maskPayoutNumber(lockedNumber)}</p>
          <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
            <Lock className="h-3.5 w-3.5" /> Locked to your identity
          </p>
        </div>
        <p className="text-[11px] text-muted-foreground">
          For your security, withdrawals from this account can only be sent to this number.
        </p>

        {pending ? (
          <p className="rounded-md bg-amber-500/10 p-2 text-xs text-amber-700">
            Your request to change this number is with Financial Ops. They will call you to confirm
            the new number belongs to you.
          </p>
        ) : (
          <>
            {rejected && changeRequest.data?.decision_reason && (
              <p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
                Your last change request was not accepted: {changeRequest.data.decision_reason}
              </p>
            )}
            <Button variant="outline" className="w-full h-11" onClick={() => setChangeOpen(true)}>
              Ask to change this number
            </Button>
          </>
        )}

        <PayoutNumberChangeDialog
          open={changeOpen}
          onOpenChange={setChangeOpen}
          onSubmitted={() => void changeRequest.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <Smartphone className="h-4 w-4 text-primary" />
        Confirm your payout number
      </p>
      <p className="text-xs text-muted-foreground">
        We send a code to the number that will receive your money. Enter the code and the name the
        number is registered in — it is confirmed straight away, with no waiting.
      </p>

      {rows.map((d) => (
        <div key={d.id} className="flex items-center justify-between gap-2 rounded-md bg-muted/40 p-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{label(d)}</p>
            <p className="text-xs text-muted-foreground">
              {d.status === 'verified'
                ? 'Confirmed'
                : d.status === 'rejected'
                  ? 'Not accepted — confirm it again'
                  : 'Not confirmed yet'}
            </p>
          </div>
          {d.status === 'verified' ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          ) : (
            <Button size="sm" variant="outline" onClick={() => setTarget(d)}>
              Send code
            </Button>
          )}
        </div>
      ))}

      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
        <p className="flex items-center gap-2 text-xs font-semibold">
          <Wallet className="h-3.5 w-3.5" />
          {existingMomo ? 'Update payout number' : 'Add payout number'}
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="payout-number" className="text-xs text-muted-foreground">
            Mobile money number
          </Label>
          <Input
            id="payout-number"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="e.g. 0770123456"
            value={number}
            disabled={saving}
            onChange={(e) => {
              const v = e.target.value;
              setNumber(v);
              const d = detectMomoProvider(v);
              if (d) setProvider(d);
              // Editing the number invalidates any code already sent.
              if (codeSentTo && v.trim() !== codeSentTo) {
                setCodeSentTo(null);
                setCode('');
                otp.resetOtp();
              }
            }}
            className="h-10 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Provider</Label>
          <div className="flex gap-2">
            {(['mtn', 'airtel'] as MomoProvider[]).map((p) => (
              <Button
                key={p}
                type="button"
                size="sm"
                variant={provider === p ? 'default' : 'outline'}
                className="flex-1 capitalize"
                disabled={saving}
                onClick={() => setProvider(p)}
              >
                {p}
              </Button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="payout-name" className="text-xs text-muted-foreground">
            Name on the mobile money account
          </Label>
          <Input
            id="payout-name"
            type="text"
            autoComplete="name"
            placeholder="e.g. SSENKALI PIUS LUBEGA"
            value={name}
            disabled={saving}
            onChange={(e) => setName(e.target.value)}
            className="h-10 text-sm"
          />
        </div>
        {!codeSentTo ? (
          <>
            <p className="text-xs text-muted-foreground">
              We send a 6-digit code to this number first. Nothing is saved until you enter it.
            </p>
            <Button
              type="button"
              className="w-full"
              disabled={saving || otp.otpLoading || otp.cooldownSeconds > 0}
              onClick={handleSendCode}
            >
              {otp.otpLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Smartphone className="mr-2 h-4 w-4" />
              )}
              {otp.otpLoading
                ? 'Sending code…'
                : otp.cooldownSeconds > 0
                  ? `Wait ${otp.cooldownSeconds}s`
                  : 'Send code to this number'}
            </Button>
          </>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="payout-code" className="text-xs text-muted-foreground">
                Code sent to {codeSentTo}
              </Label>
              <Input
                id="payout-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                maxLength={6}
                value={code}
                disabled={saving}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="h-10 text-center text-lg tracking-[0.4em]"
              />
            </div>
            {otp.otpError && <p className="text-xs text-destructive">{otp.otpError}</p>}
            <Button
              type="button"
              className="w-full"
              disabled={saving || otp.otpLoading || code.length !== 6}
              onClick={handleConfirmAndSave}
            >
              {saving || otp.otpLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              {saving || otp.otpLoading
                ? 'Confirming…'
                : existingMomo
                  ? 'Confirm code and update number'
                  : 'Confirm code and save number'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full"
              disabled={saving || otp.otpLoading || otp.cooldownSeconds > 0}
              onClick={handleSendCode}
            >
              {otp.cooldownSeconds > 0 ? `Resend in ${otp.cooldownSeconds}s` : 'Resend code'}
            </Button>
          </>
        )}
      </div>

      <PayoutDestinationConsentDialog
        open={!!target}
        onOpenChange={(o) => { if (!o) setTarget(null); }}
        destination={target}
        onVerified={() => {
          setTarget(null);
          void list.refetch();
        }}
      />
    </div>
  );
}

/**
 * Turns whatever came back from the server into one sentence the person can
 * act on. Anything unrecognised keeps its own wording rather than being
 * swallowed, so nothing ever fails silently.
 */
function sendFailureMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const t = raw.toLowerCase();
  if (!raw) return 'Your photos could not be sent. Please check your internet and try again.';
  if (t.includes('three') || t.includes('3 times') || t.includes('rate') || t.includes('limit')) {
    return 'You have already sent your ID and selfie three times this week. Please wait until next week, or call support to look at your case.';
  }
  if (t.includes('already verified')) {
    return 'Your identity is already verified. You do not need to send your National ID or selfie again.';
  }
  if (t.includes('already') && t.includes('national id')) {
    return 'This National ID is already used by another account. One ID can verify one account only.';
  }
  if (t.includes('back')) {
    return 'The back of your National ID is still missing. Take a photo of the back of the card and send again.';
  }
  /* Only genuine wiring faults get this wording. It used to catch any message
     containing "function", which swallowed the backend's real reason (the SDK
     says "Edge Function returned a non-2xx status code") and left people
     retrying a submission that would never succeed. */
  if (t.includes('best candidate') || t.includes('schema cache') || t.includes('non-2xx')) {
    return 'Your photos reached us but the request was incomplete, so nothing was saved. Please tap send once more.';
  }
  if (t.includes('fetch') || t.includes('network') || t.includes('timeout') || t.includes('failed to send')) {
    return 'Your internet dropped while sending. Your photos were not saved — please try again on a better connection.';
  }
  if (t.includes('permission') || t.includes('denied') || t.includes('jwt') || t.includes('auth')) {
    return 'You were signed out while sending. Please sign in again and resend your photos.';
  }
  if (t.includes('storage') || t.includes('upload') || t.includes('size') || t.includes('large')) {
    return 'One of the photos could not be uploaded. Take it again a bit closer and smaller, then send.';
  }
  return raw;
}

interface Props {
  /** Shown on the withdraw gate; hidden once both photos are on file. */
  compact?: boolean;
}

export default function IdentityPhotoCapture({ compact }: Props) {
  const { user } = useAuth();
  const mine = useMyIdentityPhotos();
  // One account, one National ID, one photo: a verified account is never asked again.
  const alreadyVerified = useIdentityAlreadyVerified();
  const submit = useSubmitIdentityPhotos();
  // Binds the captured identity as soon as everything needed is on file.
  const identityBind = useCompleteIdentityBinding();

  // Photos cannot be sent until the payout number is verified with a code.
  const binding = useIdentityBinding(user?.id ?? undefined);
  const lockedNumber = binding.data?.locked_payout_number ?? null;
  const payoutList = useMyPayoutDestinations(user?.id);
  const payoutRows = payoutList.data ?? [];
  // Proof of the number is the code confirmation (or an already-locked number) —
  // Financial Ops approval comes later and must not block sending the photos.
  const hasVerifiedPayoutNumber =
    !!lockedNumber ||
    payoutRows.some(
      (d) =>
        d.destination_type === 'mobile_money' &&
        (d.status === 'verified' || !!d.ownership_code_confirmed_at),
    );

  // The raw camera shot — this is what gets archived for verification.
  const [idPhoto, setIdPhoto] = useState<File | null>(null);
  const [selfieOriginal, setSelfieOriginal] = useState<File | null>(null);
  // The cropped copy — profile picture only.
  const [selfieCropped, setSelfieCropped] = useState<File | null>(null);
  const [pendingSelfie, setPendingSelfie] = useState<File | null>(null);
  const [previewSelfie, setPreviewSelfie] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  // Stays on screen until the person fixes it — a toast alone disappears and
  // people were left thinking nothing happened.
  const [sendError, setSendError] = useState<string | null>(null);
  /* Replacing what is already on file: the stored shots are ignored so both a
     fresh ID photo and a fresh selfie must be taken. Every upload keeps its own
     timestamped file, so Financial Ops still sees the earlier submission next
     to the new one. */
  const [replacing, setReplacing] = useState(false);

  // What we read off the ID card photo.
  const [reading, setReading] = useState(false);
  const [idReading, setIdReading] = useState<NationalIdReading | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [savingDetails, setSavingDetails] = useState(false);
  /* The six fields, prefilled by the reader and editable by the person. What
     they submit is compared against what the reader saw, and the difference is
     what tells Financial Ops where to look. */
  const [form, setForm] = useState<NationalIdData>(EMPTY_ID_DATA);
  const [fieldError, setFieldError] = useState<{ field?: string; message: string } | null>(null);
  /** Set when the ID number is already recorded on another account. */
  const [duplicateNin, setDuplicateNin] = useState<string | null>(null);

  /* Is the selfie a face at all? The server-side checker is the only judge —
     there is no local blur / glare grading, exactly as on tenant onboarding. */
  const [faceCheck, setFaceCheck] = useState<PassportFaceCheck | null>(null);


  const readIdPhoto = async (file: File) => {
    setReading(true);
    setIdReading(null);
    setReadError(null);
    setFieldError(null);
    const res = await readNationalIdPhoto(file);
    if ('error' in res && res.error) {
      setReadError(res.error);
      setReading(false);
      return;
    }
    const r = res as NationalIdReading;
    setIdReading(r);
    // A photo that is not a National ID prefills nothing — there is nothing on
    // it to confirm, and a half-filled form would invite the person to guess.
    if (r.status === 'invalid') setForm(EMPTY_ID_DATA);
    else {
      /* Normalise letter case up front: ID numbers are compared
         case-insensitively everywhere (typed input, duplicate check, link
         requests), so a lowercase read must not reach the form as-is. */
      const d = (r.data ?? {}) as Partial<NationalIdData>;
      setForm({
        ...EMPTY_ID_DATA,
        ...d,
        nin: (d.nin ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
        card_number: (d.card_number ?? '').toUpperCase(),
      });
    }
    setReading(false);
  };

  /** Ask the same checker the rent request uses whether the selfie is a real face. */
  const runFaceCheck = async (file: File) => {
    setFaceCheck({ status: 'checking' });
    const result = await runPassportFaceCheck(file, {
      source: 'identity_verification',
      subjectUserId: user?.id ?? null,
    });
    setFaceCheck(result);
    if (result.status === 'no_face') {
      toast.error('No face found', { description: 'Retake the selfie with your face clearly visible.' });
    }
  };


  /**
   * Send the six confirmed fields. The server re-checks every format and the
   * one-ID-one-account rule, so this call can be refused even when the screen
   * is happy — the refusal names the field at fault.
   */
  const saveDetails = async (): Promise<boolean> => {
    setSavingDetails(true);
    setFieldError(null);
    try {
      const { data, error } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>)(
        'submit_national_id_details',
        {
          p_surname: form.surname,
          p_given_name: form.given_name,
          p_nin: form.nin,
          p_date_of_birth: form.date_of_birth || null,
          p_card_number: form.card_number,
          p_sex: form.sex,
          p_reading: idReading
            ? {
                sha256: idReading.sha256, status: idReading.status,
                confidence: idReading.confidence, data: idReading.data,
                fields: idReading.fields, missing: idReading.missing,
                consistency: idReading.consistency,
                nationality: idReading.nationality,
                date_of_expiry: idReading.date_of_expiry,
                face_verified: faceCheck?.status === 'ok',
              }
            : {},
        },
      );
      if (error) throw new Error(error.message);
      const res = data as
        | { success?: boolean; message?: string; field?: string; duplicate?: boolean }
        | null;
      if (!res?.success) {
        setFieldError({ field: res?.field, message: res?.message || 'Could not save those details.' });
        // An ID already recorded elsewhere is not a mistake to correct: the
        // holder of that ID can allow this account to join it.
        setDuplicateNin(res?.duplicate ? form.nin : null);
        return false;
      }
      setDuplicateNin(null);
      return true;
    } catch (e) {
      setFieldError({ message: e instanceof Error ? e.message : 'Could not save those details.' });
      return false;
    } finally {
      setSavingDetails(false);
    }
  };

  // Whatever is already archived is reused instead of asked for again, so a
  // partial submission (e.g. selfie stored, ID shot missing) only requires the
  // missing half and the stored original selfie stays the verification copy.
  const onFileIdPath = mine.data?.national_id_photo_path ?? null;
  const onFileSelfiePath = mine.data?.selfie_photo_path ?? null;
  // While replacing, nothing on file counts — both shots are taken again.
  const storedIdPath = replacing ? null : onFileIdPath;
  const storedSelfiePath = replacing ? null : onFileSelfiePath;

  const alreadyDone = !replacing && !!storedIdPath && !!storedSelfiePath;
  // Verified once means verified for good — nothing more to send or explain.
  if (alreadyVerified.data === true) return null;

  /* Everything is in and Financial Ops has it. This used to render NOTHING,
     which read as the screen being broken: the upload tiles vanished, the
     withdraw gate still refused, and there was no sentence anywhere saying the
     photos had arrived or what happens next. Waiting is a state, and it has to
     look like one. */
  if (alreadyDone) {
    return (
      <Card className={compact ? 'border-2 border-amber-500/60' : undefined}>
        <CardContent className="space-y-3 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="h-4 w-4 text-amber-600" />
            Your ID and selfie are with Financial Ops
          </p>
          <p className="text-xs text-muted-foreground">
            They were received
            {mine.data?.identity_photos_submitted_at
              ? ` on ${new Date(mine.data.identity_photos_submitted_at).toLocaleString('en-GB', {
                  dateStyle: 'medium', timeStyle: 'short',
                })}`
              : ''}
            . You do not need to send them again. Withdrawals open once your payout number is
            verified against the name on your National ID.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <StoredShot path={storedIdPath!} label="National ID photo" note="Sent for verification." />
            <StoredShot path={storedSelfiePath!} label="Selfie" note="Sent for verification." />
          </div>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => {
              setReplacing(true);
              setSendError(null);
            }}
          >
            <Camera className="mr-2 h-4 w-4" />
            Send new photos instead
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Your earlier photos are kept, so Financial Ops sees both the old and the new ones.
          </p>
          <PayoutNumberVerification userId={user?.id} />
          <a
            href="/verification-history"
            className="block text-center text-xs text-muted-foreground underline"
          >
            See my verification history
          </a>
        </CardContent>
      </Card>
    );
  }

  const haveId = !!idPhoto || !!storedIdPath;
  const haveSelfie = (!!selfieOriginal && !!selfieCropped) || !!storedSelfiePath;

  // Every one of the six must be present before anything is sent — a partly
  // filled ID is exactly the record Financial Ops cannot act on.
  const missingDetails = (Object.keys(EMPTY_ID_DATA) as (keyof NationalIdData)[])
    .filter((k) => !String(form[k] ?? '').trim());
  const detailsComplete = missingDetails.length === 0;
  // A photo the reader says is not a National ID is refused outright.
  const idRejected = idReading?.status === 'invalid';
  const faceProblem = faceCheckBlocker(faceCheck);

  const ready = haveId && haveSelfie && detailsComplete && !idRejected && !faceProblem;

  // Spelled out on screen so nobody stares at a dead button wondering why.
  const blockers = [
    !haveId ? 'Take a photo of your National ID.' : null,
    !storedSelfiePath && !selfieOriginal ? 'Take a selfie.' : null,
    !storedSelfiePath && selfieOriginal && !selfieCropped
      ? 'Finish choosing your profile picture from the selfie you took.'
      : null,
    idRejected ? 'That photo is not a Ugandan National ID. Take a photo of the front of your card.' : null,
    faceProblem,
    !idRejected && !detailsComplete
      ? `Fill in ${missingDetails.map((k) => ID_FIELD_LABEL[k]).join(', ')} from your card.`
      : null,
    !hasVerifiedPayoutNumber ? 'Confirm your payout number with the code.' : null,
  ].filter(Boolean) as string[];


  const verdict = idNameVerdict(idReading?.name_match_score ?? null);


  const handleSave = async () => {
    if (!user?.id) return;
    if (!ready) {
      setSendError(
        blockers.length > 0
          ? `Your photos cannot be sent yet: ${blockers.join(' ')}`
          : 'Your photos cannot be sent yet. Please check both photos above.',
      );
      return;
    }
    setSaving(true);
    setSendError(null);
    try {
      /* The confirmed six go first. `submit_identity_photos` auto-verifies on a
         name match, and it reads the name this call writes — sending the photos
         first would make that check run against a stale or empty name. */
      const detailsOk = await saveDetails();
      if (!detailsOk) {
        setSaving(false);
        return;
      }
      // Archive the ORIGINALS in the private verification bucket; reuse the
      // stored original when the user is only filling in the missing shot.
      const idPath = idPhoto
        ? await uploadIdentityPhoto(user.id, 'national-id', idPhoto)
        : storedIdPath!;
      const selfiePath = selfieOriginal
        ? await uploadIdentityPhoto(user.id, 'selfie', selfieOriginal)
        : storedSelfiePath!;
      // Fingerprints of the face and the ID card, so the same person cannot
      // appear twice in the verification queue under different accounts.
      const [selfieHash, idHash] = await Promise.all([
        imageFingerprint(selfieOriginal),
        imageFingerprint(idPhoto),
      ]);
      const res = await submit.mutateAsync({
        idPhotoPath: idPath,
        selfiePath,
        selfieHash,
        idHash,
      });
      if (res && res.success === false) {
        throw new Error(res.message || 'Could not send your photos. Please try again.');
      }
      // The cropped copy is only the profile picture — best effort.
      const avatar = selfieCropped
        ? await setSelfieAsProfilePhoto(user.id, selfieCropped, selfiePath)
        : null;

      /* Details + ID photo + selfie + a confirmed number is everything the
         binding needs. The server refuses politely when something is still
         missing, so this is safe to attempt on every submission. */
      const bound = await identityBind.tryComplete();

      toast.success(
        bound?.code === 'identity_captured'
          ? 'Identity details saved and linked to your account. Your withdrawal number is now locked.'
          : avatar
            ? 'Photos received. Your original photo is saved and your cropped photo is now your profile picture.'
            : 'Photos received.',
      );
      setIdPhoto(null);
      setSelfieOriginal(null);
      setSelfieCropped(null);
      setSendError(null);
    } catch (e) {
      const message = sendFailureMessage(e);
      setSendError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };


  return (
    <Card className={compact ? 'border-2 border-destructive' : undefined}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4 text-primary" />
          Verify your identity before you withdraw
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Take a clear photo of your National ID and a selfie. Your original selfie is kept in your
          verification history for Financial Ops; the version you crop becomes your profile picture.
        </p>

        {storedIdPath ? (
          <StoredShot
            path={storedIdPath}
            label="National ID photo"
            note="This saved photo will be used for this verification."
          />
        ) : (
          <ShotTile
            label="National ID photo"
            hint="All four corners visible, no glare."
            file={idPhoto}
            onPick={(f) => {
              setIdPhoto(f);
              setIdReading(null);
              setReadError(null);
              void readIdPhoto(f);
            }}
            onClear={() => {
              setIdPhoto(null);
              setIdReading(null);
              setReadError(null);
              setForm(EMPTY_ID_DATA);
              setFieldError(null);
            }}
            disabled={saving}
          />

        )}

        {reading && (
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Reading the names on your ID…
          </div>
        )}

        {!reading && readError && (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700">
            {readError}
          </p>
        )}

        {!reading && idReading && (
          <div className="space-y-3 rounded-lg border p-3">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <ScanLine className="h-4 w-4 text-primary" />
              What we read on your ID
            </p>

            {/* The reader refuses a field it could not read rather than
                guessing, so `incomplete` is the normal failure and it names
                exactly what to fix. `invalid` means it is not an ID at all. */}
            {readingGuidance(idReading) && (
              <p
                className={`rounded-md border p-2 text-xs ${
                  idReading.status === 'invalid'
                    ? 'border-destructive/40 bg-destructive/10 text-destructive'
                    : 'border-amber-500/40 bg-amber-500/10 text-amber-700'
                }`}
              >
                {readingGuidance(idReading)}
              </p>
            )}

            {idReading.status !== 'invalid' && (
              <>
                <p className="text-xs text-muted-foreground">
                  Check every line against your card and correct anything that is wrong.
                </p>

                <div className="grid gap-2 sm:grid-cols-2">
                  {(Object.keys(EMPTY_ID_DATA) as (keyof NationalIdData)[]).map((key) => {
                    const readOk = idReading.fields?.[key]?.valid === true;
                    return (
                      <div key={key} className={key === 'sex' ? '' : 'sm:col-span-1'}>
                        <Label htmlFor={`nid-${key}`} className="text-xs">
                          {ID_FIELD_LABEL[key]}
                          {!readOk && (
                            <span className="ml-1 text-[10px] font-normal text-amber-600">
                              {form[key] ? 'not sure — check it' : 'not read — type it'}
                            </span>
                          )}
                        </Label>
                        <Input
                          id={`nid-${key}`}
                          className="mt-1 h-9 text-sm"
                          type={key === 'date_of_birth' ? 'date' : 'text'}
                          inputMode={key === 'card_number' ? 'numeric' : undefined}
                          maxLength={key === 'sex' ? 1 : undefined}
                          placeholder={key === 'sex' ? 'M or F' : undefined}
                          value={form[key]}
                          disabled={savingDetails || saving}
                          onChange={(e) => {
                            const raw = e.target.value;
                            const next =
                              key === 'date_of_birth' ? raw
                              : key === 'card_number' ? raw.replace(/[^0-9]/g, '')
                              : key === 'sex' ? raw.toUpperCase().replace(/[^MF]/g, '')
                              : key === 'nin' ? raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
                              : raw.toUpperCase();
                            setForm((f) => ({ ...f, [key]: next }));
                            setFieldError(null);
                          }}
                        />
                      </div>
                    );
                  })}
                </div>

                {fieldError && !duplicateNin && (
                  <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                    {fieldError.message}
                  </p>
                )}

                {/* The ID belongs to an account already: ask that account's
                    holder to allow this one instead of simply refusing. */}
                {duplicateNin && (
                  <NationalIdLinkFlow
                    nin={duplicateNin}
                    onLinked={() => {
                      setDuplicateNin(null);
                      setFieldError(null);
                      toast.success('You are now linked to that National ID. Send your photos to continue.');
                    }}
                  />
                )}

                {verdict === 'match' && (
                  <p className="flex items-center gap-2 text-xs text-emerald-600">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    These names match your account name.
                  </p>
                )}
                {(verdict === 'partial' || verdict === 'mismatch') && (
                  <p className="flex items-start gap-2 text-xs text-amber-600">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    These names differ from your account name ({idReading.account_name}). Financial
                    Ops will check this on the call.
                  </p>
                )}

                {/* A failed cross-check is a reason for a person to look, never
                    proof of anything — the NIN's internal layout is inferred. */}
                {(idReading.consistency ?? []).length > 0 && (
                  <p className="flex items-start gap-2 text-xs text-amber-600">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    Some details on the card do not agree with each other. Financial Ops will look
                    at this.
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {storedSelfiePath ? (
          <StoredShot
            path={storedSelfiePath}
            label="Selfie"
            note="Your stored original selfie will be used for this verification."
          />
        ) : (
          <ShotTile
            label="Selfie"
            hint="Face the camera in good light."
            facing="user"
            file={selfieOriginal}
            onPick={(f) => {
              setSelfieOriginal(f);
              setSelfieCropped(null);
              setFaceCheck(null);
              /* Same as the tenant passport photo: the checker on the server is
                 the only judge of the photo. */
              void runFaceCheck(f);
              setPendingSelfie(f);
            }}
            onClear={() => {
              setSelfieOriginal(null); setSelfieCropped(null);
              setFaceCheck(null);
            }}
            disabled={saving}
          />

        )}

        {/* Is the selfie a face? Separate question from "is it sharp". */}
        {faceCheck?.status === 'checking' && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking the selfie for a face…
          </p>
        )}
        {faceCheck?.status === 'no_face' && (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs font-semibold text-destructive">
            <ScanFace className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            No face was found in this selfie. Retake it — you cannot send until a face is
            recognised.
          </p>
        )}
        {faceCheck?.status === 'ok' && (
          <div className="space-y-1 text-xs text-emerald-600">
            <p className="flex items-center gap-2">
              <ScanFace className="h-3.5 w-3.5" />
              Real face recognised
              {faceCheck.isPassportPhoto === false && ' — but this is not passport-style'}
            </p>
            {(faceCheck.failures?.length ?? 0) > 0 && (
              <p className="text-amber-600">
                Worth fixing: {faceCheck.failures!.slice(0, 3).map((f) => f.label).join(', ')}
              </p>
            )}
            {faceCheck.sha256 && (
              <p className="font-mono text-muted-foreground">{faceCheck.sha256.slice(0, 16)}…</p>
            )}
          </div>
        )}

        {faceCheck?.status === 'unavailable' && (
          <p className="flex items-start gap-2 text-xs text-amber-600">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            We could not check the selfie just now. You can still send — Financial Ops will look
            at it.
          </p>
        )}




        {sendError && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive"
          >
            <p className="flex items-start gap-2 font-semibold">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>Your photos were not sent</span>
            </p>
            <p className="mt-1 font-medium">{sendError}</p>
            <p className="mt-1 text-destructive/80">
              Nothing was lost. Fix the point above and tap send again.
            </p>
          </div>
        )}

        {!sendError && blockers.length > 0 && (
          <div className="rounded-lg border bg-muted/40 p-3 text-xs">
            <p className="font-semibold">Before you can send:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        )}

        <PayoutNumberVerification userId={user?.id} />

        {!hasVerifiedPayoutNumber && (
          <p className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
            Confirm your payout number above with the code before you can send your photos.
          </p>
        )}

        <Button
          className="w-full"
          disabled={saving || !hasVerifiedPayoutNumber}
          onClick={handleSave}
        >
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {saving ? 'Sending…' : 'Send my photos for verification'}
        </Button>

        <a
          href="/verification-history"
          className="block text-center text-xs text-muted-foreground underline"
        >
          See my verification history
        </a>


        <SelfieCropDialog
          file={pendingSelfie}
          onCancel={() => setPendingSelfie(null)}
          onConfirm={(cropped) => {
            setPreviewSelfie(cropped);
            setPendingSelfie(null);
          }}
        />

        <SelfieProfilePreviewDialog
          file={previewSelfie}
          onCancel={() => {
            // Discard the whole shot — the person retakes it.
            setPreviewSelfie(null);
            setSelfieOriginal(null);
            setSelfieCropped(null);
          }}
          onConfirm={() => {
            // Lock in: the original for verification, the crop for the avatar.
            setSelfieCropped(previewSelfie);
            setPreviewSelfie(null);
          }}
        />
      </CardContent>
    </Card>
  );
}
