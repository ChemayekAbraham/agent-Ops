import { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Camera, ShieldCheck, Loader2, X, ScanLine, CheckCircle2, AlertTriangle, ScanFace } from 'lucide-react';
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
  /* The six fields, prefilled by the reader and editable by the person. What
     they submit is compared against what the reader saw, and the difference is
     what tells Financial Ops where to look. */
  const [form, setForm] = useState<NationalIdData>(EMPTY_ID_DATA);
  const [fieldError, setFieldError] = useState<{ field?: string; message: string } | null>(null);

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
    else setForm({ ...EMPTY_ID_DATA, ...(r.data ?? {}) });
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
      const res = data as { success?: boolean; message?: string; field?: string } | null;
      if (!res?.success) {
        setFieldError({ field: res?.field, message: res?.message || 'Could not save those details.' });
        return false;
      }
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
  const storedIdPath = mine.data?.national_id_photo_path ?? null;
  const storedSelfiePath = mine.data?.selfie_photo_path ?? null;

  const alreadyDone = !!storedIdPath && !!storedSelfiePath;
  if (alreadyDone) return null;
  // Verified once means verified for good — nothing more to send.
  if (alreadyVerified.data === true) return null;

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

                {fieldError && (
                  <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                    {fieldError.message}
                  </p>
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
