import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Camera, ShieldCheck, Loader2, X, ScanLine, CheckCircle2, AlertTriangle, ScanFace, Wallet, Save, ChevronRight, ChevronDown, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
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
  readNationalIdPhotoOriented, readNationalIdBackPhoto, orientationMessage,
  inspectIdPhotoOrientation, rotateImageFile,
  idNameVerdict, readingGuidance, EMPTY_ID_DATA, ID_FIELD_LABEL,
  ID_POSITION_TIPS, ID_BACK_TIPS,
  type NationalIdReading, type NationalIdData, type IdRotation,
  type NationalIdBackReading,
} from '@/lib/nationalIdOcr';
import { runPassportFaceCheck, faceCheckBlocker, type PassportFaceCheck } from '@/lib/passportFaceCheck';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { imageFingerprint } from '@/lib/imageFingerprint';
import { useMyPayoutDestinations, type MyPayoutDestination } from '@/hooks/usePayoutVerification';
import { PayoutDestinationConsentDialog } from '@/components/payments/PayoutDestinationConsentDialog';
import { armAuthCriticalSection, disarmAuthCriticalSection } from '@/lib/staleSessionDetector';
import { Smartphone } from 'lucide-react';
import { useOtpVerification } from '@/hooks/useOtpVerification';
import mtnLogo from '@/assets/mtn-logo-uploaded.png.asset.json';
import airtelLogo from '@/assets/airtel-logo.png.asset.json';
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
import CardCameraCapture from './CardCameraCapture';
import SelfieCameraCapture from './SelfieCameraCapture';
import IdentityVerificationChecklist from './IdentityVerificationChecklist';


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
  /** When set, "Take photo" opens this instead of the native file/camera picker
   *  (used for the in-page portrait scanner). The native picker stays wired up
   *  underneath as a fallback — see `openFilePicker` on the ref. */
  onCustomCapture?: () => void;
}

export interface ShotTileHandle {
  /** Opens the plain native file/camera picker, bypassing any custom capture flow. */
  openFilePicker: () => void;
}

const ShotTile = forwardRef<ShotTileHandle, ShotTileProps>(function ShotTile(
  { label, hint, file, onPick, onClear, disabled, facing, onCustomCapture }, ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ openFilePicker: () => inputRef.current?.click() }));
  const preview = file ? URL.createObjectURL(file) : null;

  const acceptPicked = (f: File | undefined, fromUpload: boolean) => {
    if (!f) { if (!fromUpload) disarmAuthCriticalSection(); return; }
    if (f.size > MAX_BYTES) {
      if (!fromUpload) disarmAuthCriticalSection();
      toast.error('That photo is too large. Please choose a smaller one.');
      return;
    }
    if (!fromUpload) disarmAuthCriticalSection();
    onPick(f);
  };

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
        onClick={() => {
          // The phone's camera app is about to take over the screen (the
          // selfie has no in-page fallback, so this is its only capture path).
          // Android in particular can discard this page while the camera is
          // open and resume it with a momentarily stale token — arm sign-out
          // suppression NOW, before that handoff, not in onChange, which may
          // never fire if the page is torn down and rebuilt from scratch.
          armAuthCriticalSection(180_000);
        }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          acceptPicked(f, false);
        }}
      />

      {/* A plain file picker, no `capture` hint — lets someone choose an
          existing photo (gallery/Files/Downloads) instead of shooting a new
          one, e.g. a scan already on their phone. Same size check and the
          same onPick as every other capture path. */}
      <input
        ref={uploadInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          acceptPicked(f, true);
        }}
      />

      <div className="flex gap-2">
        <Button
          variant={file ? 'outline' : 'default'}
          className="flex-1"
          disabled={disabled}
          onClick={() => (onCustomCapture ? onCustomCapture() : inputRef.current?.click())}
        >
          <Camera className="mr-2 h-4 w-4" />
          {file ? 'Retake' : 'Take photo'}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="flex-1"
          disabled={disabled}
          onClick={() => uploadInputRef.current?.click()}
        >
          <Upload className="mr-2 h-4 w-4" />
          Upload
        </Button>
      </div>
    </div>
  );
});


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
      const ok = await otp.verifyOtp(codeSentTo, code.replace(/\D/g, ''), { category: 'payout_number' });
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
                className="flex-1 px-5 py-2.5"
                disabled={saving}
                onClick={() => setProvider(p)}
                aria-label={p === 'mtn' ? 'MTN' : 'Airtel'}
              >
                <img
                  src={p === 'mtn' ? mtnLogo.url : airtelLogo.url}
                  alt={p === 'mtn' ? 'MTN' : 'Airtel'}
                  className="h-5 w-auto object-contain"
                />
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
  const navigate = useNavigate();
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
  /* The back of the card. Required: the two lines of code and the card number
     live there, and Financial Ops cannot check a card from its front alone. */
  const [idBackPhoto, setIdBackPhoto] = useState<File | null>(null);
  /* Which shot the in-page camera is currently open for, if any. */
  const [cameraTarget, setCameraTarget] = useState<'front' | 'back' | 'selfie' | null>(null);
  const frontShotRef = useRef<ShotTileHandle>(null);
  const backShotRef = useRef<ShotTileHandle>(null);
  const selfieShotRef = useRef<ShotTileHandle>(null);
  const [showFrontTips, setShowFrontTips] = useState(false);
  const [showBackTips, setShowBackTips] = useState(false);
  const [showBlockers, setShowBlockers] = useState(false);

  /* Shared by the "Take photo" button and the in-page camera — same effect
     either way a fresh front photo arrives. */
  const handleFrontPick = (f: File) => {
    setIdPhoto(null);
    setIdReading(null);
    setReadError(null);
    setIdRotation(0);
    setDetailsConfirmed(false);
    setIdPhoto(f);
    void readIdPhoto(f);
  };

  const handleBackPick = (f: File) => {
    setIdBackPhoto(f);
    setBackReading(null);
    setBackReadError(null);
    void readBackPhoto(f);
  };

  /* Shared by the "Take photo" button and the in-page camera — same effect
     either way a fresh selfie arrives. */
  const handleSelfiePick = (f: File) => {
    setSelfieOriginal(f);
    setSelfieCropped(null);
    setFaceCheck(null);
    // Same as the tenant passport photo: the checker on the server is the
    // only judge of the photo.
    void runFaceCheck(f);
    setPendingSelfie(f);
  };
  const [backReading, setBackReading] = useState<NationalIdBackReading | null>(null);
  /* The back-of-ID reading is editable: the reader can misread the small
     print, so every line is an input and "Save" applies the corrections to
     the reading (and fills any matching front-of-ID field still empty, since
     the front form is what is actually submitted). */
  const [backEdits, setBackEdits] = useState<Record<string, string>>({});
  const backDirty =
    !!backReading &&
    backReading.details.some((d) => (backEdits[d.label] ?? d.value) !== d.value);

  useEffect(() => {
    setBackEdits({});
  }, [backReading]);

  const handleSaveBackDetails = () => {
    if (!backReading) return;
    const details = backReading.details
      .map((d) => ({ ...d, value: (backEdits[d.label] ?? d.value).trim() }))
      .filter((d) => d.value);
    const get = (label: string) => details.find((d) => d.label === label)?.value ?? null;
    const back: NationalIdBackReading['back'] = {
      ...backReading.back,
      card_number: get('Card number'),
      date_of_issue: get('Date of issue'),
      date_of_expiry: get('Date of expiry'),
      residence: {
        district: get('District'),
        county: get('County'),
        subcounty: get('Subcounty'),
        parish: get('Parish'),
        village: get('Village'),
      },
      mrz: {
        ...backReading.back.mrz,
        nin: get('NIN'),
        date_of_birth: get('Date of birth'),
        sex: get('Sex'),
        nationality: get('Nationality'),
      },
    };
    setBackReading({ ...backReading, details, back });
    /* Fill only front-of-ID fields still empty — anything the person already
       typed or confirmed on the front form stays untouched. */
    setForm((prev) => ({
      ...prev,
      card_number: prev.card_number || get('Card number') || '',
      nin: prev.nin || get('NIN') || '',
      date_of_birth: prev.date_of_birth || get('Date of birth') || '',
      sex: prev.sex || get('Sex') || '',
    }));
    setBackEdits({});
    toast.success('Saved — your corrections will be submitted with your ID.');
  };
  const [backReadError, setBackReadError] = useState<string | null>(null);
  const [readingBack, setReadingBack] = useState(false);
  /** Set when the photo had to be turned to be readable — front and back. */
  const [idRotation, setIdRotation] = useState<IdRotation>(0);
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
  /* Nothing is sent until the person has looked at what the reader saw and said
     it matches their card. Any edit, retake or fresh read clears this. */
  const [detailsConfirmed, setDetailsConfirmed] = useState(false);
  const [savingDetails, setSavingDetails] = useState(false);
  /* The six fields, prefilled by the reader and editable by the person. What
     they submit is compared against what the reader saw, and the difference is
     what tells Financial Ops where to look. */
  const [form, setForm] = useState<NationalIdData>(EMPTY_ID_DATA);
  const [fieldError, setFieldError] = useState<{ field?: string; message: string } | null>(null);
  // Set when the names typed already belong to another account's National ID.
  const [nameTaken, setNameTaken] = useState(false);
  /** Set when the ID number is already recorded on another account. */
  const [duplicateNin, setDuplicateNin] = useState<string | null>(null);
  /* What the ID number typed says about itself, checked as it is typed rather
     than only when everything else is ready. The duplicate rule used to be
     applied on send alone, so somebody typing an ID that already belongs to
     another account saw nothing at all until both photos and the payout code
     were done — it read as the screen ignoring them. */
  const [ninHint, setNinHint] = useState<
    { holder_first_name: string | null; accounts_on_id: number | null; limit_reached: boolean } | null
  >(null);

  /* Is the selfie a face at all? The server-side checker is the only judge —
     there is no local blur / glare grading, exactly as on tenant onboarding. */
  const [faceCheck, setFaceCheck] = useState<PassportFaceCheck | null>(null);

  /* The front photo is already on file, so it is not retaken — but the six
     fields used to live only in this screen's memory, so a return visit sent
     an empty form and the person was told to "fill in Surname, NIN…" with no
     boxes on screen to fill. The details saved last time are read back and
     shown for checking (A); if nothing is saved, the empty boxes still appear
     so they can be typed in without retaking the photo (B). */
  const [savedDetailsChecked, setSavedDetailsChecked] = useState(false);

  useEffect(() => {
    const hasStoredFront = !!mine.data?.national_id_photo_path;
    if (replacing || !hasStoredFront || !user?.id || idPhoto || savedDetailsChecked) return;
    setSavedDetailsChecked(true);
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from('profiles')
        .select('national_id, national_id_surname, national_id_given_name, national_id_card_number, date_of_birth, sex')
        .eq('id', user.id)
        .maybeSingle();
      if (cancelled || !data) return;
      const row = data as Record<string, string | null>;
      const saved: NationalIdData = {
        ...EMPTY_ID_DATA,
        surname: (row.national_id_surname ?? '').toUpperCase(),
        given_name: (row.national_id_given_name ?? '').toUpperCase(),
        nin: (row.national_id ?? '').toUpperCase(),
        card_number: (row.national_id_card_number ?? '').toUpperCase(),
        date_of_birth: (row.date_of_birth ?? '').slice(0, 10),
        sex: (row.sex ?? '').toUpperCase(),
      };
      // Only fill what is still empty — nothing typed on screen is overwritten.
      setForm((prev) => {
        const next = { ...prev };
        (Object.keys(EMPTY_ID_DATA) as (keyof NationalIdData)[]).forEach((k) => {
          if (!String(next[k] ?? '').trim()) next[k] = saved[k];
        });
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [mine.data, replacing, user?.id, idPhoto, savedDetailsChecked]);

  /* As soon as a complete ID number is on screen, ask the server whose it is.
     Only the holder's first name and how many accounts already sit on the ID
     come back — never a surname, number or anything else. */
  useEffect(() => {
    const nin = String(form.nin ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!/^[A-Z0-9]{12,16}$/.test(nin)) {
      setNinHint(null);
      setDuplicateNin(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const { data } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>)(
        'national_id_holder_hint', { p_nin: nin },
      );
      if (cancelled) return;
      const hint = (data ?? {}) as {
        found?: boolean; holder_first_name?: string | null;
        accounts_on_id?: number | null; limit_reached?: boolean;
      };
      if (hint.found) {
        setNinHint({
          holder_first_name: hint.holder_first_name ?? null,
          accounts_on_id: hint.accounts_on_id ?? null,
          limit_reached: !!hint.limit_reached,
        });
        setDuplicateNin(hint.limit_reached ? null : nin);
      } else {
        setNinHint(null);
        setDuplicateNin(null);
      }
    }, 500);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [form.nin]);

  /* The names are checked live too: nobody may carry the names already held on
     another account's National ID, so we say so before they try to submit. */
  useEffect(() => {
    const full = `${String(form.given_name ?? '').trim()} ${String(form.surname ?? '').trim()}`.trim();
    if (full.split(/\s+/).filter(Boolean).length < 2) {
      setNameTaken(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const { data } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>)(
        'national_id_name_taken', { p_name: full, p_nin: form.nin || null },
      );
      if (cancelled) return;
      const res = (data ?? {}) as { taken?: boolean };
      setNameTaken(!!res.taken);
      if (res.taken) {
        setFieldError({
          field: 'surname',
          message: 'These names are already taken on another account holding a different National ID. '
            + 'Enter your own real names exactly as printed on your own card.',
        });
      }
    }, 500);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [form.given_name, form.surname, form.nin]);




  const readIdPhoto = async (file: File) => {
    setReading(true);
    setDetailsConfirmed(false);
    setIdReading(null);
    setReadError(null);
    setFieldError(null);
    setIdRotation(0);
    const photoOrientation = await inspectIdPhotoOrientation(file);
    if (photoOrientation === 'unreadable') {
      setIdPhoto(null);
      setReadError('We could not open that ID photo. Retake it with the phone sideways so the photo is wide.');
      setReading(false);
      return;
    }
    /* A sideways photo (card held at 90°/-90°) is turned upright for the
       person instead of refused — the goal is a straight landscape card in
       the preview box, and we can get there ourselves. */
    if (photoOrientation === 'sideways') {
      file = await rotateImageFile(file, 90);
      setIdPhoto(file);
    }
    /* A card photographed upside down or sideways used to come back as "not a
       National ID", so a perfectly good photo was rejected. The reader now
       retries the same photo turned, keeps whichever way round read best, and
       the straightened copy is what gets archived. */
    const res = await readNationalIdPhotoOriented(file);
    if ('error' in res && res.error) {
      setReadError(res.error);
      /* The reader could not be reached at all (network/edge-function
         failure) — a different case from "read it, but couldn't make out
         every field" (status: 'incomplete'). Both must leave the person able
         to type the six fields in by hand: without this fallback, idReading
         stayed null and the manual-entry form (which only renders when
         idReading is set) never appeared, so a transient reader outage left
         no way to proceed at all except retaking the photo forever. */
      setIdReading({
        status: 'incomplete',
        is_national_id: true,
        confidence: null,
        sha256: null,
        full_name: '',
        data: { ...EMPTY_ID_DATA },
        fields: {},
        missing: Object.keys(EMPTY_ID_DATA),
        consistency: [],
        message: null,
        nationality: null,
        date_of_expiry: null,
        account_name: '',
        account_national_id: null,
        name_match_score: null,
      });
      setForm(EMPTY_ID_DATA);
      setReading(false);
      return;
    }
    const oriented = res as { reading: NationalIdReading; rotation: IdRotation; file: File; corrected: boolean };
    const r = oriented.reading;
    setIdRotation(oriented.rotation);
    if (oriented.corrected) setIdPhoto(oriented.file);
    setIdReading(r);
    // A photo that is not a National ID prefills nothing — there is nothing on
    // it to confirm, and a half-filled form would invite the person to guess.
    if (r.status === 'invalid') setForm(EMPTY_ID_DATA);
    else {
      /* Normalise letter case up front: ID numbers are compared
         case-insensitively everywhere (typed input, duplicate check, link
         requests), so a lowercase read must not reach the form as-is. */
      const d = (r.data ?? {}) as Partial<NationalIdData>;
      const readNin = (d.nin ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      /* Linking an ID that already belongs to another account: never prefill
         the names — the person must type the names printed on the card
         themselves, so a wrong card cannot silently overwrite the existing
         holder's names. Only a brand-new ID gets the reader's prefill. */
      let idAlreadyKnown = false;
      if (/^[A-Z0-9]{12,16}$/.test(readNin)) {
        const { data: hintRaw } = await (supabase.rpc as unknown as (
          fn: string, args: Record<string, unknown>,
        ) => Promise<{ data: unknown; error: { message: string } | null }>)(
          'national_id_holder_hint', { p_nin: readNin },
        );
        idAlreadyKnown = !!(hintRaw as { found?: boolean } | null)?.found;
      }
      setForm({
        ...EMPTY_ID_DATA,
        ...d,
        surname: idAlreadyKnown ? '' : (d.surname ?? ''),
        given_name: idAlreadyKnown ? '' : (d.given_name ?? ''),
        nin: readNin,
        card_number: (d.card_number ?? '').toUpperCase(),
      });
      if (idAlreadyKnown) {
        setFieldError({
          field: 'surname',
          message: 'This National ID is already recorded. Type the names exactly as printed on the card — they were not filled in for you.',
        });
      }
    }
    setReading(false);
  };

  /**
   * Reads the back of the card. Same orientation correction as the front. The
   * back is archived either way — an unreadable back is reported, never used to
   * refuse the submission — but photographing the FRONT twice is caught here.
   */
  const readBackPhoto = async (file: File) => {
    setReadingBack(true);
    setBackReading(null);
    setBackReadError(null);
    const photoOrientation = await inspectIdPhotoOrientation(file);
    if (photoOrientation === 'unreadable') {
      setIdBackPhoto(null);
      setBackReadError('We could not open that ID photo. Retake it with the phone sideways so the photo is wide.');
      setReadingBack(false);
      return;
    }
    // Same courtesy as the front: turn a sideways photo upright ourselves.
    if (photoOrientation === 'sideways') {
      file = await rotateImageFile(file, 90);
      setIdBackPhoto(file);
    }
    const res = await readNationalIdBackPhoto(file);
    if ('error' in res && res.error) {
      setBackReadError((res as { error: string }).error);
      setReadingBack(false);
      return;
    }
    const b = res as NationalIdBackReading;
    if (b.corrected) setIdBackPhoto(b.file);
    setBackReading(b);
    setReadingBack(false);
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
  /* Returns the failure message directly rather than making the caller re-read
     `fieldError` afterwards — that state update from setFieldError() below is
     not visible in this same function's closure until the next render, so a
     caller reading `fieldError` right after `await saveDetails()` would still
     see whatever it held BEFORE this call (stale-closure bug: this is exactly
     what left Ssemanda's retry silent — saveDetails() failed, set fieldError,
     returned false, and the caller had nothing fresh to show near the button). */
  const saveDetails = async (): Promise<{ ok: boolean; message?: string }> => {
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
        | { success?: boolean; message?: string; field?: string; duplicate?: boolean; name_taken?: boolean }
        | null;
      if (!res?.success) {
        const message = res?.message || 'Could not save those details.';
        setFieldError({ field: res?.field, message });
        setNameTaken(!!res?.name_taken);
        // An ID already recorded elsewhere is not a mistake to correct: the
        // holder of that ID can allow this account to join it.
        setDuplicateNin(res?.duplicate ? form.nin : null);
        return { ok: false, message };
      }
      setNameTaken(false);
      setDuplicateNin(null);
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not save those details.';
      setFieldError({ message });
      return { ok: false, message };
    } finally {
      setSavingDetails(false);
    }
  };

  // Whatever is already archived is reused instead of asked for again, so a
  // partial submission (e.g. selfie stored, ID shot missing) only requires the
  // missing half and the stored original selfie stays the verification copy.
  const onFileIdPath = mine.data?.national_id_photo_path ?? null;
  const onFileIdBackPath = mine.data?.national_id_back_photo_path ?? null;
  const onFileSelfiePath = mine.data?.selfie_photo_path ?? null;
  // While replacing, nothing on file counts — both shots are taken again.
  const storedIdPath = replacing ? null : onFileIdPath;
  const storedIdBackPath = replacing ? null : onFileIdBackPath;
  const storedSelfiePath = replacing ? null : onFileSelfiePath;
  /* Front photo on file and no fresh one taken: the six fields are still shown
     (prefilled from what was saved, empty if nothing was saved) so they can be
     checked or typed without retaking the photo. */
  const showSavedDetailsForm = !idPhoto && !!storedIdPath;

  const alreadyDone = !replacing && !!storedIdPath && !!storedIdBackPath && !!storedSelfiePath;
  const isVerified = alreadyVerified.data === true;

  /* A verified account still needs this screen: it's the only place to see
     what's on file and the only path to request a change (new photos, a
     different payout number). This used to return null here for a verified
     user, which read as the screen being broken — no confirmation, no way to
     see or change anything. Waiting-for-review and already-verified are both
     states, and both have to look like one. */
  if (alreadyDone) {
    return (
      <Card className={compact ? 'border border-border shadow-sm' : undefined}>
        <CardContent className="space-y-3 p-4">
          <IdentityVerificationChecklist
            payoutDone={hasVerifiedPayoutNumber}
            payoutRejected={payoutRows.some((d) => d.status === 'rejected')}
            idFrontDone={true}
            idBackDone={true}
            selfieDone={true}
            variant="compact"
            className="mb-2"
          />
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary shrink-0" />
            <p className="text-sm font-semibold text-foreground">
              {isVerified ? 'Your identity is verified' : 'Your details are with Financial Ops'}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            {isVerified
              ? 'You do not need to send these again. Use the options below if anything needs to change.'
              : <>
                  Received
                  {mine.data?.identity_photos_submitted_at
                    ? ` on ${new Date(mine.data.identity_photos_submitted_at).toLocaleString('en-GB', {
                        dateStyle: 'medium', timeStyle: 'short',
                      })}`
                    : ''}
                  . You do not need to send them again.
                </>}
          </p>

          <div className="grid gap-2 sm:grid-cols-2">
            <StoredShot path={storedIdPath!} label="National ID front" note="Sent for verification." />
            <StoredShot path={storedIdBackPath!} label="National ID back" note="Sent for verification." />
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
  /* The back is demanded, not optional: the card number and the two lines of
     code at the bottom are only there, and a front-only submission cannot be
     checked. */
  const haveIdBack = !!idBackPhoto || !!storedIdBackPath;
  const haveSelfie = (!!selfieOriginal && !!selfieCropped) || !!storedSelfiePath;

  // Every one of the six must be present before anything is sent — a partly
  // filled ID is exactly the record Financial Ops cannot act on.
  const missingDetails = (Object.keys(EMPTY_ID_DATA) as (keyof NationalIdData)[])
    .filter((k) => !String(form[k] ?? '').trim());
  const detailsComplete = missingDetails.length === 0;
  // A photo the reader says is not a National ID is refused outright.
  const idRejected = idReading?.status === 'invalid';
  const faceProblem = faceCheckBlocker(faceCheck);

  /* A freshly read card must be confirmed line by line by its owner before it
     is sent. A stored photo already on file was confirmed when it was sent. */
  const needsConfirm = !!idPhoto && !!idReading && idReading.status !== 'invalid';
  const confirmDone = !needsConfirm || detailsConfirmed;

  /* The back photographed as the front again: caught here rather than by
     Financial Ops days later. */
  const backIsFront = backReading?.looksLikeFront === true;

  const ready =
    haveId && haveIdBack && haveSelfie && detailsComplete && !idRejected && !faceProblem
    && confirmDone && !backIsFront;

  // Spelled out on screen so nobody stares at a dead button wondering why.
  const blockers = [
    !haveId ? 'Take a photo of the FRONT of your National ID.' : null,
    !haveIdBack ? 'Turn the card over and take a photo of the BACK of your National ID.' : null,
    backIsFront ? 'The second photo is the front again. Turn the card over and photograph the back.' : null,
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
    needsConfirm && !detailsConfirmed && detailsComplete
      ? 'Confirm the details we read from your ID are exactly as on your card.'
      : null,
  ].filter(Boolean) as string[];


  const verdict = idNameVerdict(idReading?.name_match_score ?? null);


  const handleSave = async () => {
    if (!user?.id) return;
    // A name already held on another account's National ID can never be sent.
    if (nameTaken) {
      const message = 'These names are already taken on another account holding a different '
        + 'National ID. Enter your own real names exactly as printed on your own card.';
      setSendError(message);
      toast.error(message);
      return;
    }
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
      const detailsResult = await saveDetails();
      if (!detailsResult.ok) {
        /* fieldError (set inside saveDetails) renders far up the page next to
           the six fields — surface the same message here too, next to the
           button that was just tapped, or the ring-spins-then-nothing
           silence reported on Ssemanda's account repeats every retry. */
        const message = detailsResult.message || 'Could not save your ID details. Please try again.';
        setSendError(message);
        toast.error(message);
        setSaving(false);
        return;
      }
      // Archive the ORIGINALS in the private verification bucket; reuse the
      // stored original when the user is only filling in the missing shot.
      const idPath = idPhoto
        ? await uploadIdentityPhoto(user.id, 'national-id', idPhoto)
        : storedIdPath!;
      const idBackPath = idBackPhoto
        ? await uploadIdentityPhoto(user.id, 'national-id-back', idBackPhoto)
        : storedIdBackPath!;
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
        idBackPhotoPath: idBackPath,
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
      setIdBackPhoto(null);
      setBackReading(null);
      setBackReadError(null);
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


  /* In the withdraw flow we send people to Settings to complete verification in
     the dedicated "Withdrawal & Identity" tab, then they return to continue the
     withdrawal. The full inline form stays available on the Settings page. */
  if (compact) {
    return (
      <div className="rounded-xl border border-border bg-card p-4 space-y-3 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            <span className="font-semibold text-sm">Identity verification</span>
          </div>
          <span className="text-[11px] text-muted-foreground font-medium">4 items required</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Confirm your payout number, National ID photos, and selfie to unlock withdrawals.
        </p>
        <IdentityVerificationChecklist
          payoutDone={hasVerifiedPayoutNumber}
          payoutRejected={payoutRows.some((d) => d.status === 'rejected')}
          idFrontDone={haveId}
          idBackDone={haveIdBack}
          selfieDone={haveSelfie}
          variant="compact"
        />
        <Button
          type="button"
          className="w-full h-10 font-medium text-xs gap-1.5"
          onClick={() => navigate('/settings?section=account&tab=withdrawal')}
        >
          Complete verification in Settings
          <ChevronRight className="h-4 w-4 ml-auto" />
        </Button>
      </div>
    );
  }

  return (
    <Card className="border border-border shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4 text-primary" />
          Verify your identity before you withdraw
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Complete the 4 steps below so Financial Ops can verify your account.
        </p>

        {/* Persistent verification checklist */}
        <IdentityVerificationChecklist
          payoutDone={hasVerifiedPayoutNumber}
          payoutRejected={payoutRows.some((d) => d.status === 'rejected')}
          idFrontDone={haveId}
          idBackDone={haveIdBack}
          selfieDone={haveSelfie}
          variant="compact"
          className="mb-1"
        />

        {/* Step 1: Payout number verification */}
        <PayoutNumberVerification userId={user?.id} />

        {/* Step 2: How to hold card — short caption + optional Tips toggle */}
        <div className="rounded-lg border bg-muted/20 p-3 text-xs space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-muted-foreground font-medium">
              Position your card upright within the frame with all four corners visible.
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground shrink-0 gap-1"
              onClick={() => setShowFrontTips((v) => !v)}
              aria-expanded={showFrontTips}
            >
              <span>{showFrontTips ? 'Hide tips' : 'Tips'}</span>
              <ChevronDown className={cn('h-3 w-3 transition-transform', showFrontTips && 'rotate-180')} />
            </Button>
          </div>
          {showFrontTips && (
            <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground pt-1 border-t border-border/40">
              {ID_POSITION_TIPS.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          )}
        </div>

        {storedIdPath ? (
          <StoredShot
            path={storedIdPath}
            label="National ID front"
            note="This saved photo will be used for this verification."
          />
        ) : (
          <ShotTile
            ref={frontShotRef}
            label="National ID — FRONT"
            hint="Hold your phone upright. Line the card up inside the frame — we'll find the edges for you."
            file={idPhoto}
            onCustomCapture={() => setCameraTarget('front')}
            onPick={handleFrontPick}
            onClear={() => {
              setIdPhoto(null);
              setIdReading(null);
              setReadError(null);
              setIdRotation(0);
              setForm(EMPTY_ID_DATA);
              setFieldError(null);
              setDetailsConfirmed(false);
            }}
            disabled={saving}
          />

        )}

        {reading && (
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Reading your ID, and checking which way round it is…
          </div>
        )}

        {/* The photo was upside down or sideways: say so, straighten it, and let
            the person check the lines rather than sending them back for nothing. */}
        {!reading && idRotation !== 0 && orientationMessage(idRotation) && (
          <div className="rounded-lg border-2 border-amber-500/60 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
            <p className="flex items-start gap-2 font-bold">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{orientationMessage(idRotation)}</span>
            </p>
            <ul className="mt-2 list-disc space-y-0.5 pl-4">
              {ID_POSITION_TIPS.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Nothing readable in any of the four positions: this is a positioning
            problem far more often than a wrong document. */}
        {!reading && idPhoto && idReading?.status === 'invalid' && (
          <div className="rounded-lg border-2 border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
            <p className="font-bold">We could not read this card in any position.</p>
            <p className="mt-1">
              We tried your photo upright, upside down and sideways. Take it again with the card
              lying flat and the writing the right way up.
            </p>
            <ul className="mt-2 list-disc space-y-0.5 pl-4">
              {ID_POSITION_TIPS.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        )}

        {!reading && readError && (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700">
            {readError}
          </p>
        )}

        {!reading && (idReading || showSavedDetailsForm) && (
          <div className="space-y-3 rounded-lg border p-3">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <ScanLine className="h-4 w-4 text-primary" />
              {idReading ? 'What we read on your ID' : 'The details on your National ID'}
            </p>

            {!idReading && (
              <p className="text-xs text-muted-foreground">
                Your ID photo is already on file, so you do not need to take it again. Check the
                details below against your card, fill in anything missing, and send.
              </p>
            )}

            {/* The reader refuses a field it could not read rather than
                guessing, so `incomplete` is the normal failure and it names
                exactly what to fix. `invalid` means it is not an ID at all. */}
            {idReading && readingGuidance(idReading) && (
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

            {idReading?.status !== 'invalid' && (
              <>
                <p className="text-xs text-muted-foreground">
                  Check every line against your card and correct anything that is wrong.
                </p>

                <div className="grid gap-2 sm:grid-cols-2">
                  {(Object.keys(EMPTY_ID_DATA) as (keyof NationalIdData)[]).map((key) => {
                    const readOk = idReading ? idReading.fields?.[key]?.valid === true : true;
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
                          maxLength={key === 'sex' ? 1 : undefined}
                          placeholder={key === 'sex' ? 'M or F' : undefined}
                          value={form[key]}
                          disabled={savingDetails || saving}
                          onChange={(e) => {
                            const raw = e.target.value;
                            const next =
                              key === 'date_of_birth' ? raw
                              : key === 'card_number' ? raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
                              : key === 'sex' ? raw.toUpperCase().replace(/[^MF]/g, '')
                              : key === 'nin' ? raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
                              : raw.toUpperCase();
                            setForm((f) => ({ ...f, [key]: next }));
                            setFieldError(null);
                            setDetailsConfirmed(false);
                          }}
                        />
                      </div>
                    );
                  })}
                </div>

                {fieldError && !duplicateNin && (
                  nameTaken ? (
                    <div className="rounded-md border-2 border-destructive bg-destructive/10 p-3 text-destructive">
                      <p className="text-sm font-bold uppercase">This name is already taken</p>
                      <p className="mt-1 text-xs">
                        Someone else's account already carries these exact names with a different
                        National ID. Enter your own real names, exactly as printed on your own card,
                        to continue.
                      </p>
                    </div>
                  ) : (
                    <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                      {fieldError.message}
                    </p>
                  )
                )}

                {/* Answered while the number is still being typed, so nobody
                    fills in a whole form before being told the ID is taken. */}
                {ninHint?.limit_reached && (
                  <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                    This National ID has reached its limit of 20 accounts. No more accounts can be
                    added to it.
                  </p>
                )}
                {ninHint && !ninHint.limit_reached && (
                  <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700">
                    {ninHint.holder_first_name
                      ? `This National ID is already on ${ninHint.holder_first_name}'s Welile account. You can be added under ${ninHint.holder_first_name}, but they must agree first.`
                      : 'This National ID is already recorded on another account. Ask the person who holds it to confirm you.'}
                    {typeof ninHint.accounts_on_id === 'number'
                      ? ` ${ninHint.accounts_on_id} of 20 accounts are on it.`
                      : ''}
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
                    These names differ from your account name ({idReading?.account_name}). Financial
                    Ops will check this on the call.
                  </p>
                )}

                {/* A failed cross-check is a reason for a person to look, never
                    proof of anything — the NIN's internal layout is inferred. */}
                {(idReading?.consistency ?? []).length > 0 && (
                  <p className="flex items-start gap-2 text-xs text-amber-600">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    Some details on the card do not agree with each other. Financial Ops will look
                    at this.
                  </p>
                )}

                {/* Confirm or retake: the owner of the card decides whether what
                    we read is exactly what is printed on it, before anything is
                    sent for verification. */}
                {needsConfirm && detailsComplete && (
                  detailsConfirmed ? (
                    <div className="flex items-start justify-between gap-3 rounded-lg border-2 border-emerald-500/60 bg-emerald-500/10 p-3">
                      <p className="flex items-start gap-2 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                        You confirmed these details match your card. You can send now.
                      </p>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 shrink-0 text-xs"
                        disabled={saving || savingDetails}
                        onClick={() => setDetailsConfirmed(false)}
                      >
                        Change
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-3 rounded-lg border-2 border-primary/50 bg-primary/5 p-3">
                      <p className="text-sm font-bold">Is this exactly what is on your card?</p>
                      <ul className="space-y-1">
                        {(Object.keys(EMPTY_ID_DATA) as (keyof NationalIdData)[]).map((key) => (
                          <li key={key} className="flex justify-between gap-3 text-xs">
                            <span className="text-muted-foreground">{ID_FIELD_LABEL[key]}</span>
                            <span className="text-right font-bold">{String(form[key] ?? '') || '—'}</span>
                          </li>
                        ))}
                      </ul>
                      <p className="text-xs text-muted-foreground">
                        Compare every line with your card. If anything is wrong, correct it above or
                        take the photo again.
                      </p>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Button
                          className="h-11 flex-1"
                          disabled={saving || savingDetails}
                          onClick={() => setDetailsConfirmed(true)}
                        >
                          <CheckCircle2 className="mr-2 h-4 w-4" />
                          Yes, these are correct
                        </Button>
                        <Button
                          variant="outline"
                          className="h-11 flex-1"
                          disabled={saving || savingDetails}
                          onClick={() => {
                            setIdPhoto(null);
                            setIdReading(null);
                            setReadError(null);
                            setForm(EMPTY_ID_DATA);
                            setFieldError(null);
                            setDetailsConfirmed(false);
                          }}
                        >
                          No, retake the photo
                        </Button>
                      </div>
                    </div>
                  )
                )}
              </>
            )}
          </div>
        )}

        {/* THE BACK OF THE CARD — demanded, not optional. */}
        {storedIdBackPath ? (
          <StoredShot
            path={storedIdBackPath}
            label="National ID back"
            note="This saved photo of the back will be used for this verification."
          />
        ) : (
          <ShotTile
            ref={backShotRef}
            label="National ID — BACK (required)"
            hint="Hold your phone upright. Line the back of the card up inside the frame so the small print can be read."
            file={idBackPhoto}
            onCustomCapture={() => setCameraTarget('back')}
            onPick={handleBackPick}
            onClear={() => {
              setIdBackPhoto(null);
              setBackReading(null);
              setBackReadError(null);
            }}
            disabled={saving}
          />
        )}

        {!storedIdBackPath && !idBackPhoto && (
          <div className="rounded-lg border bg-muted/20 p-3 text-xs space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-muted-foreground font-medium">
                Ensure the card number and barcode lines are sharp and glare-free.
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground shrink-0 gap-1"
                onClick={() => setShowBackTips((v) => !v)}
                aria-expanded={showBackTips}
              >
                <span>{showBackTips ? 'Hide tips' : 'Tips'}</span>
                <ChevronDown className={cn('h-3 w-3 transition-transform', showBackTips && 'rotate-180')} />
              </Button>
            </div>
            {showBackTips && (
              <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground pt-1 border-t border-border/40">
                {ID_BACK_TIPS.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {readingBack && (
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Reading the back of your ID…
          </div>
        )}

        {!readingBack && backReadError && (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700">
            {backReadError}
          </p>
        )}

        {!readingBack && backReading && (
          <div className="space-y-2 rounded-lg border p-3">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <ScanLine className="h-4 w-4 text-primary" />
              What we read on the back of your ID
            </p>

            {backReading.looksLikeFront ? (
              <p className="rounded-md border-2 border-destructive/50 bg-destructive/10 p-2 text-xs font-bold text-destructive">
                This is the FRONT of your card again. Turn the card over and photograph the back —
                the side with the two lines of code at the bottom.
              </p>
            ) : backReading.corrected && orientationMessage(backReading.rotation) ? (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700">
                {orientationMessage(backReading.rotation)}
              </p>
            ) : null}

            {backReading.details.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Check every line against your card and correct anything that is wrong.
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {backReading.details.map((d) => (
                    <div key={d.label} className="space-y-1">
                      <Label htmlFor={`nid-back-${d.label}`} className="text-xs">
                        {d.label}
                      </Label>
                      <Input
                        id={`nid-back-${d.label}`}
                        value={backEdits[d.label] ?? d.value}
                        onChange={(e) =>
                          setBackEdits((prev) => ({ ...prev, [d.label]: e.target.value }))
                        }
                        className="h-9 text-sm"
                      />
                    </div>
                  ))}
                </div>
                {backDirty && (
                  <Button size="sm" className="w-full" onClick={handleSaveBackDetails}>
                    <Save className="mr-2 h-4 w-4" />
                    Save corrections
                  </Button>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                We could not read the small print on the back. Your photo is still saved and
                Financial Ops will check it — retake it closer if the print looks blurred.
              </p>
            )}

            {/* The card number is printed on both sides, so the two must agree.
                A mismatch is a reason to look again, never proof of anything. */}
            {backReading.back?.card_number &&
              idReading?.data?.card_number &&
              backReading.back.card_number.replace(/[^A-Za-z0-9]/g, '').toUpperCase() !==
                idReading.data.card_number.replace(/[^A-Za-z0-9]/g, '').toUpperCase() && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700">
                  The card number on the back does not match the front. Check both photos are of the
                  same card.
                </p>
              )}

            {backReading.back?.mrz?.present === false && backReading.details.length > 0 && (
              <p className="text-xs text-muted-foreground">
                The two lines of code at the bottom were not readable. Lay the card flat and keep the
                bottom edge inside the frame if you retake it.
              </p>
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
            ref={selfieShotRef}
            label="Selfie"
            hint="Face the camera in good light."
            facing="user"
            file={selfieOriginal}
            onCustomCapture={() => setCameraTarget('selfie')}
            onPick={handleSelfiePick}
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




        {/* Repeated right above the button rather than only higher up the page —
            a disabled "Send" button with its explanation scrolled out of view
            reads as broken/silent, which is exactly what was reported. */}
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
          <div className="rounded-lg border bg-muted/20 p-3 text-xs space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-muted-foreground font-medium">
                All 4 checklist items must be complete before sending.
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground shrink-0 gap-1"
                onClick={() => setShowBlockers((v) => !v)}
                aria-expanded={showBlockers}
              >
                <span>{showBlockers ? 'Hide' : 'Details'}</span>
                <ChevronDown className={cn('h-3 w-3 transition-transform', showBlockers && 'rotate-180')} />
              </Button>
            </div>
            {showBlockers && (
              <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground pt-1 border-t border-border/40">
                {blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <Button
          className="w-full"
          disabled={saving || !hasVerifiedPayoutNumber || !confirmDone || nameTaken}
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

        <CardCameraCapture
          open={cameraTarget === 'front'}
          onOpenChange={(o) => { if (!o) setCameraTarget(null); }}
          title="National ID — FRONT"
          instruction="Line the front of the card up inside the box."
          fileLabel="national-id-front"
          onCapture={handleFrontPick}
          onFallback={() => frontShotRef.current?.openFilePicker()}
        />
        <CardCameraCapture
          open={cameraTarget === 'back'}
          onOpenChange={(o) => { if (!o) setCameraTarget(null); }}
          title="National ID — BACK"
          instruction="Turn the card over and line the back up inside the box."
          fileLabel="national-id-back"
          onCapture={handleBackPick}
          onFallback={() => backShotRef.current?.openFilePicker()}
        />
        <SelfieCameraCapture
          open={cameraTarget === 'selfie'}
          onOpenChange={(o) => { if (!o) setCameraTarget(null); }}
          onCapture={handleSelfiePick}
          onFallback={() => selfieShotRef.current?.openFilePicker()}
        />
      </CardContent>
    </Card>
  );
}
