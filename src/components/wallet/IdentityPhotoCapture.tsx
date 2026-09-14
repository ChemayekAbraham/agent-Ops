/**
 * Identity photo step of the withdrawal gate.
 *
 * The moment someone taps Withdraw, they are asked to prove who they are: one
 * photo of their National ID card and one selfie. Both are required, both go
 * straight to the camera on a phone, and Financial Ops compares the two faces
 * before releasing any money.
 */
import { useRef, useState } from 'react';
import { Camera, Check, IdCard, Loader2, ShieldCheck, SwitchCamera, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import {
  setSelfieAsProfilePhoto,
  uploadIdentityPhoto,
  useMyIdentityPhotos,
  useSubmitIdentityPhotos,
  type IdentityPhotoKind,
} from '@/hooks/useIdentityPhotos';

const MAX_BYTES = 10 * 1024 * 1024;

interface Shot {
  file: File;
  preview: string;
}

function ShotTile({
  label,
  hint,
  icon,
  shot,
  facing,
  onPick,
  onClear,
  disabled,
}: {
  label: string;
  hint: string;
  icon: React.ReactNode;
  shot: Shot | null;
  facing: 'environment' | 'user';
  onPick: (file: File) => void;
  onClear: () => void;
  disabled: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="rounded-2xl border-2 border-border bg-card p-3 space-y-2">
      <div className="flex items-center gap-2">
        <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold text-foreground leading-tight">{label}</p>
          <p className="text-[11px] text-muted-foreground">{hint}</p>
        </div>
        {shot && <Check className="h-4 w-4 text-emerald-600 ml-auto shrink-0" />}
      </div>

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        className="w-full aspect-[4/3] rounded-xl border-2 border-dashed border-primary/40 bg-muted/40 overflow-hidden flex items-center justify-center disabled:opacity-60"
      >
        {shot ? (
          <img
            src={shot.preview}
            alt={label}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <span className="flex flex-col items-center gap-1 text-primary">
            <Camera className="h-7 w-7" />
            <span className="text-xs font-semibold">Open camera</span>
          </span>
        )}
      </button>

      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="flex-1 h-10"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
        >
          {facing === 'user' ? (
            <SwitchCamera className="h-4 w-4 mr-1.5" />
          ) : (
            <Camera className="h-4 w-4 mr-1.5" />
          )}
          {shot ? 'Retake' : 'Take photo'}
        </Button>
        {shot && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-10 px-3 text-destructive"
            onClick={onClear}
            disabled={disabled}
            aria-label={`Remove ${label}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture={facing}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          if (!file.type.startsWith('image/')) {
            toast.error('Please take a photo, not a document file.');
            return;
          }
          if (file.size > MAX_BYTES) {
            toast.error('That photo is too large. Take it again with the camera.');
            return;
          }
          onPick(file);
        }}
      />
    </div>
  );
}

export default function IdentityPhotoCapture({
  className,
  onDone,
}: {
  className?: string;
  onDone?: () => void;
}) {
  const { user } = useAuth();
  const { data, isLoading, refetch } = useMyIdentityPhotos();
  const submit = useSubmitIdentityPhotos();
  const [idShot, setIdShot] = useState<Shot | null>(null);
  const [selfie, setSelfie] = useState<Shot | null>(null);
  const [busy, setBusy] = useState(false);
  // Raw camera shot waiting for the crop/confirm step.
  const [pendingSelfie, setPendingSelfie] = useState<File | null>(null);

  const alreadyDone = !!data?.national_id_photo_path && !!data?.selfie_photo_path;
  if (isLoading || alreadyDone) return null;

  const pick = (setter: (s: Shot | null) => void) => (file: File) =>
    setter({ file, preview: URL.createObjectURL(file) });

  const save = async () => {
    if (!user?.id || !idShot || !selfie) {
      toast.error('Take both photos first — your National ID and a selfie.');
      return;
    }
    setBusy(true);
    try {
      const paths: Record<IdentityPhotoKind, string> = {
        'national-id': await uploadIdentityPhoto(user.id, 'national-id', idShot.file),
        selfie: await uploadIdentityPhoto(user.id, 'selfie', selfie.file),
      };
      await submit.mutateAsync({
        idPhotoPath: paths['national-id'],
        selfiePath: paths.selfie,
      });
      // The selfie becomes their profile picture too (best-effort: a failure
      // here must not undo a successful verification submission).
      const avatarUrl = await setSelfieAsProfilePhoto(user.id, selfie.file);
      toast.success(
        avatarUrl
          ? 'Photos received. Your selfie is now your profile picture.'
          : 'Photos received. Financial Ops will check your identity.',
      );
      await refetch();
      onDone?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send your photos.');
    } finally {
      setBusy(false);
    }
  };

  const working = busy || submit.isPending;

  return (
    <div
      className={`rounded-2xl border-2 border-destructive/50 bg-destructive/5 p-4 space-y-3 ${className ?? ''}`}
    >
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 rounded-xl bg-destructive/15 flex items-center justify-center shrink-0">
          <ShieldCheck className="h-5 w-5 text-destructive" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold text-foreground">Verify your identity to withdraw</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Take a clear photo of your National ID card and a selfie of your face. Financial Ops
            checks that the face on the card is yours before your money is sent. Your selfie also
            becomes your profile picture.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ShotTile
          label="Photo of your National ID"
          hint="All four corners visible, no glare"
          icon={<IdCard className="h-4 w-4 text-primary" />}
          shot={idShot}
          facing="environment"
          onPick={pick(setIdShot)}
          onClear={() => setIdShot(null)}
          disabled={working}
        />
        <ShotTile
          label="Selfie of your face"
          hint="Good light, no hat or sunglasses"
          icon={<Camera className="h-4 w-4 text-primary" />}
          shot={selfie}
          facing="user"
          onPick={(file) => setPendingSelfie(file)}
          onClear={() => setSelfie(null)}
          disabled={working}
        />
      </div>

      <SelfieCropDialog
        file={pendingSelfie}
        open={!!pendingSelfie}
        onCancel={() => setPendingSelfie(null)}
        onConfirm={(cropped) => {
          setPendingSelfie(null);
          setSelfie({ file: cropped, preview: URL.createObjectURL(cropped) });
        }}
      />

      <Button onClick={save} disabled={!idShot || !selfie || working} className="w-full h-12 text-base font-bold">
        {working ? (
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
        ) : (
          <ShieldCheck className="h-5 w-5 mr-2" />
        )}
        Send my photos for verification
      </Button>
    </div>
  );
}
