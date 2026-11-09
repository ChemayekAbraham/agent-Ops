import { useEffect, useState } from 'react';
import { Camera, MapPin } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SIGNAGE_PROMPT_REPEAT_MS, SignagePhoto } from '@/lib/welileSignages';
import { prepareSignagePhoto } from '@/lib/signagePhoto';
import { useMySignageInstallationsDue, useMyProfileName, useSubmitSignageInstallation } from '@/hooks/useWelileSignages';

/** Full-screen reminder for the applying agent until installation photos are submitted. */
export function SignageInstallationPrompt() {
  const { data: due = [] } = useMySignageInstallationsDue();
  const { data: profileName = '' } = useMyProfileName();
  const submit = useSubmitSignageInstallation();
  const [snoozedUntil, setSnoozedUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [installedAt, setInstalledAt] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<SignagePhoto | null>(null);
  const [preparing, setPreparing] = useState(false);

  const current = due[0];
  const declineKey = current?.installation_decline_reason ?? '';

  useEffect(() => { setSnoozedUntil(0); }, [current?.id, declineKey]);
  useEffect(() => {
    if (!snoozedUntil) return;
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, snoozedUntil - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [snoozedUntil]);

  const open = !!current && now >= snoozedUntil;
  const later = () => { const t = Date.now(); setNow(t); setSnoozedUntil(t + SIGNAGE_PROMPT_REPEAT_MS); };

  const handleSubmit = async () => {
    if (!current) return;
    if (!photo) { toast.error('Add a photo of the installed board.'); return; }
    try {
      await submit.mutateAsync({ signageId: current.id, installedAt, photoUrl: photo.url, note });
      setPhoto(null); setNote('');
    } catch { /* toast shown by the hook */ }
  };

  if (!current) return null;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) later(); }}>
      <DialogContent className="w-screen h-[100dvh] max-w-none sm:max-w-none rounded-none sm:rounded-none overflow-y-auto flex flex-col justify-center">
        <div className="mx-auto w-full max-w-md space-y-4">
          <DialogHeader>
            <div className="flex items-center gap-2"><MapPin className="h-5 w-5 text-primary" />
              <DialogTitle>Submit installation photos</DialogTitle></div>
            <DialogDescription>
              {current.property_name} ({current.reference_no}). The CFO has paid for this signage. Install the board and send a photo to Agent Ops.
            </DialogDescription>
          </DialogHeader>
          {current.installation_decline_reason && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
              <p className="font-semibold text-destructive">Agent Ops declined your last photos</p>
              <p>{current.installation_decline_reason}</p>
            </div>
          )}
          {due.length > 1 && <p className="text-xs text-muted-foreground">{due.length} signages are waiting for photos.</p>}
          <div>
            <Label htmlFor="sig-installer">Installer Name / Field Officer</Label>
            <Input id="sig-installer" value={profileName || 'Your profile name'} readOnly disabled className="mt-1" />
            <p className="mt-1 text-xs text-muted-foreground">Your profile name. It cannot be changed here.</p>
          </div>
          <div>
            <Label htmlFor="sig-date">Date installed</Label>
            <Input id="sig-date" type="date" value={installedAt} onChange={(e) => setInstalledAt(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label htmlFor="sig-photo">Installed board photo *</Label>
            <Input id="sig-photo" type="file" accept="image/*" capture="environment" disabled={preparing} className="mt-1"
              onChange={async (e) => {
                const file = e.target.files?.[0]; e.target.value = '';
                if (!file) return;
                setPreparing(true);
                try { setPhoto(await prepareSignagePhoto(file, 'installed_signage')); }
                catch (err) { toast.error(err instanceof Error ? err.message : 'Could not use this photo'); }
                finally { setPreparing(false); }
              }} />
            {photo && <img src={photo.url} alt="Installed board" className="mt-2 max-h-48 rounded-lg object-cover" />}
          </div>
          <div>
            <Label htmlFor="sig-note">Note (optional)</Label>
            <Textarea id="sig-note" value={note} onChange={(e) => setNote(e.target.value)} className="mt-1" />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={later}>Later</Button>
            <Button className="flex-1 gap-2" disabled={!photo || preparing || submit.isPending || !profileName} onClick={handleSubmit}>
              <Camera className="h-4 w-4" />{submit.isPending ? 'Sending...' : 'Send to Agent Ops'}
            </Button>
          </div>
          {!profileName && <p className="text-xs text-destructive">Add your name to your profile before submitting.</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
