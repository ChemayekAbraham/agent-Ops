import { useRef, useState } from 'react';
import { Camera, CheckCircle2, Loader2, MapPin } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { usePostSignageInstallation } from '@/hooks/useWelileSignages';
import { prepareSignagePhoto } from '@/lib/signagePhoto';
import { SIGNAGE_RATES, type SignageListRecord } from '@/lib/welileSignages';

interface Props {
  signage: SignageListRecord | null;
  onClose: () => void;
}

interface Fix { latitude: number; longitude: number; accuracy: number }

/**
 * The agent posts the installed board: a photo plus live GPS taken at the spot.
 * The server checks the GPS is within 100 m of the registered spot; the CFO then
 * reviews it and pays the agent's one-time reward, which makes the signage Active.
 */
export function PostInstallationDialog({ signage, onClose }: Props) {
  const post = usePostSignageInstallation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [fix, setFix] = useState<Fix | null>(null);
  const [locating, setLocating] = useState(false);
  const [note, setNote] = useState('');

  const reset = () => { setPhotoUrl(null); setFix(null); setNote(''); };
  const close = () => { if (!post.isPending) { reset(); onClose(); } };

  const onPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setPreparing(true);
    try { setPhotoUrl((await prepareSignagePhoto(file, 'installed_signage')).url); }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Could not add the photo.'); }
    finally { setPreparing(false); }
  };

  const capture = () => {
    if (!navigator.geolocation) { toast.error('Device GPS is unavailable.'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => { setFix({ latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy }); setLocating(false); },
      () => { setLocating(false); toast.error('Could not get your location. Switch on GPS and try again in the open.'); },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  };

  const submit = async () => {
    if (!signage || !photoUrl || !fix) return;
    try {
      await post.mutateAsync({ signageId: signage.id, photoUrl, latitude: fix.latitude, longitude: fix.longitude, accuracy: fix.accuracy, note });
      reset();
      onClose();
    } catch { /* toast shown by the hook */ }
  };

  return (
    <Dialog open={!!signage} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-md rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-base font-bold">Post installation · {signage?.reference_no}</DialogTitle>
          <DialogDescription className="text-xs">
            Stand at {signage?.property_name || 'the property'}, photograph the installed board and capture your live location.
            The CFO reviews it and pays your one-time UGX {SIGNAGE_RATES.AGENT_REWARD_UGX.toLocaleString()} reward to your wallet.
          </DialogDescription>
        </DialogHeader>
        {signage?.installation_decline_reason && (
          <p className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive"><strong>Sent back by the CFO:</strong> {signage.installation_decline_reason}</p>
        )}
        <div className="space-y-3">
          <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onPhoto} />
          <Button type="button" variant="outline" className="w-full justify-start gap-2 rounded-xl" disabled={preparing || post.isPending} onClick={() => fileRef.current?.click()}>
            {preparing ? <Loader2 className="h-4 w-4 animate-spin" /> : photoUrl ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Camera className="h-4 w-4" />}
            {photoUrl ? 'Board photo added (tap to retake)' : 'Take photo of the installed board'}
          </Button>
          {photoUrl && <img src={photoUrl} alt="Installed board" className="max-h-40 w-full rounded-xl object-cover" />}
          <Button type="button" variant="outline" className="w-full justify-start gap-2 rounded-xl" disabled={locating || post.isPending} onClick={capture}>
            {locating ? <Loader2 className="h-4 w-4 animate-spin" /> : fix ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <MapPin className="h-4 w-4" />}
            {fix ? `Location captured (±${Math.round(fix.accuracy)} m) · tap to recapture` : 'Capture live location at the spot'}
          </Button>
          {fix && fix.accuracy > 50 && (
            <p className="text-xs text-amber-700">Accuracy must be 50 m or better. Move into the open and capture again.</p>
          )}
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the CFO (optional)" className="rounded-xl text-sm" maxLength={300} />
        </div>
        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" onClick={close} disabled={post.isPending}>Cancel</Button>
          <Button type="button" onClick={submit} disabled={!photoUrl || !fix || fix.accuracy > 50 || post.isPending} className="rounded-xl">
            {post.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Post installation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
