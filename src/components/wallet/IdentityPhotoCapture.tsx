import { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Camera, ShieldCheck, Loader2, X, ScanLine, CheckCircle2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  useMyIdentityPhotos,
  useSubmitIdentityPhotos,
  uploadIdentityPhoto,
  setSelfieAsProfilePhoto,
  identityPhotoUrl,
} from '@/hooks/useIdentityPhotos';
import { useSubmitNationalId } from '@/hooks/usePayoutVerification';
import { readNationalIdPhoto, idNameVerdict, type NationalIdReading } from '@/lib/nationalIdOcr';
import { checkPhotoQuality, retakeMessage, type PhotoQualityResult } from '@/lib/imageQuality';
import { imageFingerprint } from '@/lib/imageFingerprint';

import SelfieCropDialog from './SelfieCropDialog';
import SelfieProfilePreviewDialog from './SelfieProfilePreviewDialog';


const MAX_BYTES = 10 * 1024 * 1024;

interface ShotTileProps {
  label: string;
  hint: string;
  file: File | null;
  onPick: (file: File) => void;
  onClear: () => void;
  disabled?: boolean;
  /** Result of the automatic blur / glare / contrast check on this photo. */
  quality?: PhotoQualityResult | null;
  checking?: boolean;
}

function ShotTile({ label, hint, file, onPick, onClear, disabled, quality, checking }: ShotTileProps) {
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
        capture="environment"
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
      {checking && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Checking this photo…
        </p>
      )}

      {!checking && file && quality && !quality.ok && (
        <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{retakeMessage(label, quality)}</span>
        </p>
      )}

      {!checking && file && quality?.ok && (
        <p className="flex items-center gap-2 text-xs text-emerald-600">
          <CheckCircle2 className="h-3.5 w-3.5" />
          This photo is clear.
        </p>
      )}

      <Button
        variant={file && quality?.ok ? 'outline' : 'default'}
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
  if (t.includes('best candidate') || t.includes('function') || t.includes('schema')) {
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
  const submit = useSubmitIdentityPhotos();
  const submitNid = useSubmitNationalId();

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

  // What we read off the ID card photo.
  const [reading, setReading] = useState(false);
  const [idReading, setIdReading] = useState<NationalIdReading | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [savingDetails, setSavingDetails] = useState(false);

  // Automatic blur / glare / contrast check, per photo.
  const [idQuality, setIdQuality] = useState<PhotoQualityResult | null>(null);
  const [selfieQuality, setSelfieQuality] = useState<PhotoQualityResult | null>(null);
  const [checkingId, setCheckingId] = useState(false);
  const [checkingSelfie, setCheckingSelfie] = useState(false);

  /** Scores the shot; a failed photo is announced so the person retakes it. */
  const gradePhoto = async (
    file: File,
    label: string,
    setChecking: (v: boolean) => void,
    setQuality: (r: PhotoQualityResult) => void,
  ): Promise<PhotoQualityResult> => {
    setChecking(true);
    const result = await checkPhotoQuality(file);
    setQuality(result);
    setChecking(false);
    if (!result.ok) toast.error(retakeMessage(label, result));
    return result;
  };

  const readIdPhoto = async (file: File) => {
    setReading(true);
    setIdReading(null);
    setReadError(null);
    const res = await readNationalIdPhoto(file);
    if ('error' in res && res.error) setReadError(res.error);
    else setIdReading(res as NationalIdReading);
    setReading(false);
  };

  const saveDetectedDetails = async () => {
    if (!idReading?.full_name) return;
    setSavingDetails(true);
    try {
      await submitNid.mutateAsync({
        nationalId: idReading.id_number || '',
        idName: idReading.full_name,
      });
      toast.success('Saved the names and number we read from your ID.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save those details.');
    } finally {
      setSavingDetails(false);
    }
  };

  // Whatever is already archived is reused instead of asked for again, so a
  // partial submission (e.g. selfie stored, ID shot missing) only requires the
  // missing half and the stored original selfie stays the verification copy.
  const storedIdPath = mine.data?.national_id_photo_path ?? null;
  const storedSelfiePath = mine.data?.selfie_photo_path ?? null;

  const alreadyDone = !!storedIdPath && !!storedSelfiePath;
  if (alreadyDone) return null;

  const haveId = !!idPhoto || !!storedIdPath;
  const haveSelfie = (!!selfieOriginal && !!selfieCropped) || !!storedSelfiePath;
  // A freshly taken photo must pass the automatic quality check first.
  const idQualityOk = !idPhoto || idQuality?.ok === true;
  const selfieQualityOk = !selfieOriginal || selfieQuality?.ok === true;
  const failedShots = [
    idPhoto && idQuality && !idQuality.ok ? 'National ID photo' : null,
    selfieOriginal && selfieQuality && !selfieQuality.ok ? 'Selfie' : null,
  ].filter(Boolean) as string[];
  const checkingPhotos = checkingId || checkingSelfie;
  const ready = haveId && haveSelfie && idQualityOk && selfieQualityOk && !checkingPhotos;

  // Spelled out on screen so nobody stares at a dead button wondering why.
  const blockers = [
    !haveId ? 'Take a photo of your National ID.' : null,
    !storedSelfiePath && !selfieOriginal ? 'Take a selfie.' : null,
    !storedSelfiePath && selfieOriginal && !selfieCropped
      ? 'Finish choosing your profile picture from the selfie you took.'
      : null,
    idPhoto && idQuality && !idQuality.ok ? 'Retake the National ID photo — it did not pass the photo check.' : null,
    selfieOriginal && selfieQuality && !selfieQuality.ok ? 'Retake the selfie — it did not pass the photo check.' : null,
    checkingPhotos ? 'Checking your photos — this takes a moment.' : null,
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

      toast.success(
        avatar
          ? 'Photos received. Your original photo is saved for verification and your cropped photo is now your profile picture.'
          : 'Photos received. Financial Ops will verify them shortly.',
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
            quality={idQuality}
            checking={checkingId}
            onPick={(f) => {
              setIdPhoto(f);
              setIdReading(null);
              setReadError(null);
              void gradePhoto(f, 'National ID photo', setCheckingId, setIdQuality).then((r) => {
                if (r.ok) void readIdPhoto(f);
              });
            }}
            onClear={() => {
              setIdPhoto(null);
              setIdReading(null);
              setReadError(null);
              setIdQuality(null);
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
          <div className="space-y-2 rounded-lg border p-3">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <ScanLine className="h-4 w-4 text-primary" />
              What we read on your ID
            </p>
            {idReading.readable ? (
              <>
                <p className="text-sm">
                  Names: <span className="font-semibold">{idReading.full_name}</span>
                </p>
                {idReading.id_number && (
                  <p className="text-sm">
                    ID number: <span className="font-semibold">{idReading.id_number}</span>
                  </p>
                )}
                {verdict === 'match' && (
                  <p className="flex items-center gap-2 text-xs text-emerald-600">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    These names match your account name.
                  </p>
                )}
                {(verdict === 'partial' || verdict === 'mismatch') && (
                  <p className="flex items-center gap-2 text-xs text-amber-600">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    These names differ from your account name ({idReading.account_name}). Financial
                    Ops will check this on the call.
                  </p>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={savingDetails || !idReading.full_name}
                  onClick={saveDetectedDetails}
                >
                  {savingDetails ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Use these details
                </Button>
              </>
            ) : (
              <p className="text-xs text-amber-600">
                The card was hard to read. Retake the photo in better light, or type your details.
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
            label="Selfie"
            hint="Face the camera in good light."
            file={selfieOriginal}
            quality={selfieQuality}
            checking={checkingSelfie}
            onPick={(f) => {
              setSelfieOriginal(f);
              setSelfieCropped(null);
              void gradePhoto(f, 'Selfie', setCheckingSelfie, setSelfieQuality).then((r) => {
                if (r.ok) setPendingSelfie(f);
              });
            }}
            onClear={() => { setSelfieOriginal(null); setSelfieCropped(null); setSelfieQuality(null); }}
            disabled={saving}
          />
        )}

        {failedShots.length > 0 && (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Please retake: {failedShots.join(' and ')}. We cannot send photos that are blurry, shiny
              or too dark — Financial Ops would only reject them.
            </span>
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

        <Button className="w-full" disabled={saving} onClick={handleSave}>
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
