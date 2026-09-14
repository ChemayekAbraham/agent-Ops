import { useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Camera, ShieldCheck, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  useMyIdentityPhotos,
  useSubmitIdentityPhotos,
  uploadIdentityPhoto,
  setSelfieAsProfilePhoto,
} from '@/hooks/useIdentityPhotos';
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

interface Props {
  /** Shown on the withdraw gate; hidden once both photos are on file. */
  compact?: boolean;
}

export default function IdentityPhotoCapture({ compact }: Props) {
  const { user } = useAuth();
  const mine = useMyIdentityPhotos();
  const submit = useSubmitIdentityPhotos();

  // The raw camera shot — this is what gets archived for verification.
  const [idPhoto, setIdPhoto] = useState<File | null>(null);
  const [selfieOriginal, setSelfieOriginal] = useState<File | null>(null);
  // The cropped copy — profile picture only.
  const [selfieCropped, setSelfieCropped] = useState<File | null>(null);
  const [pendingSelfie, setPendingSelfie] = useState<File | null>(null);
  const [previewSelfie, setPreviewSelfie] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  const alreadyDone = !!mine.data?.national_id_photo_path && !!mine.data?.selfie_photo_path;
  if (alreadyDone) return null;

  const ready = !!idPhoto && !!selfieOriginal && !!selfieCropped;

  const handleSave = async () => {
    if (!user?.id || !idPhoto || !selfieOriginal || !selfieCropped) return;
    setSaving(true);
    try {
      // Archive the ORIGINALS in the private verification bucket.
      const idPath = await uploadIdentityPhoto(user.id, 'national-id', idPhoto);
      const selfiePath = await uploadIdentityPhoto(user.id, 'selfie', selfieOriginal);
      await submit.mutateAsync({ idPhotoPath: idPath, selfiePath });
      // The cropped copy is only the profile picture — best effort.
      const avatar = await setSelfieAsProfilePhoto(user.id, selfieCropped);
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

        <ShotTile
          label="National ID photo"
          hint="All four corners visible, no glare."
          file={idPhoto}
          onPick={setIdPhoto}
          onClear={() => setIdPhoto(null)}
          disabled={saving}
        />

        <ShotTile
          label="Selfie"
          hint="Face the camera in good light."
          file={selfieOriginal}
          onPick={(f) => { setSelfieOriginal(f); setSelfieCropped(null); setPendingSelfie(f); }}
          onClear={() => { setSelfieOriginal(null); setSelfieCropped(null); }}
          disabled={saving}
        />

        <Button className="w-full" disabled={!ready || saving} onClick={handleSave}>
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {saving ? 'Sending…' : 'Send my photos for verification'}
        </Button>

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
