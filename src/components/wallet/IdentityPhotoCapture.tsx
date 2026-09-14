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
}

function ShotTile({ label, hint, file, onPick, onClear, disabled }: ShotTileProps) {
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

  // What we read off the ID card photo.
  const [reading, setReading] = useState(false);
  const [idReading, setIdReading] = useState<NationalIdReading | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [savingDetails, setSavingDetails] = useState(false);

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
  const ready = haveId && haveSelfie;

  const verdict = idNameVerdict(idReading?.name_match_score ?? null);


  const handleSave = async () => {
    if (!user?.id || !ready) return;
    setSaving(true);
    try {
      // Archive the ORIGINALS in the private verification bucket; reuse the
      // stored original when the user is only filling in the missing shot.
      const idPath = idPhoto
        ? await uploadIdentityPhoto(user.id, 'national-id', idPhoto)
        : storedIdPath!;
      const selfiePath = selfieOriginal
        ? await uploadIdentityPhoto(user.id, 'selfie', selfieOriginal)
        : storedSelfiePath!;
      const res = await submit.mutateAsync({ idPhotoPath: idPath, selfiePath });
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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send your photos. Please try again.');
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
            onPick={(f) => { setIdPhoto(f); void readIdPhoto(f); }}
            onClear={() => { setIdPhoto(null); setIdReading(null); setReadError(null); }}

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
            onPick={(f) => { setSelfieOriginal(f); setSelfieCropped(null); setPendingSelfie(f); }}
            onClear={() => { setSelfieOriginal(null); setSelfieCropped(null); }}
            disabled={saving}
          />
        )}


        <Button className="w-full" disabled={!ready || saving} onClick={handleSave}>
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
