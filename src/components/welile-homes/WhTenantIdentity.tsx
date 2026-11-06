import { useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle2, IdCard, ImagePlus, Loader2, AlertCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';
import {
  fetchFloatRequestTenantIds, isIdComplete, isValidNin, normalizeNin, saveTenantIdentity,
  tenantPhotoUrl, uploadTenantPhoto, type FloatRequestTenantId, type WhTenantIdentity,
} from '@/lib/welileHomesTenantId';

export function WhTenantIdBadge({ identity }: { identity?: WhTenantIdentity | null }) {
  const ok = isIdComplete(identity);
  return (
    <Badge variant="outline" className={ok
      ? 'gap-1 font-normal border-emerald-500/40 bg-emerald-500/10 text-emerald-600'
      : 'gap-1 font-normal border-destructive/40 bg-destructive/10 text-destructive'}>
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
      {ok ? 'ID complete' : 'ID missing'}
    </Badge>
  );
}

export function WhTenantIdDialog({ open, onOpenChange, agentId, tenantId, tenantName, identity, onSaved }: {
  open: boolean; onOpenChange: (o: boolean) => void; agentId?: string; tenantId: string | null;
  tenantName?: string; identity?: WhTenantIdentity | null; onSaved: () => void;
}) {
  const [nin, setNin] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const camRef = useRef<HTMLInputElement>(null);
  const galRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setNin(identity?.nin ?? '');
    setFile(null);
    setPreview(null);
    if (identity?.photo_path) tenantPhotoUrl(identity.photo_path).then(setPreview);
  }, [open, identity?.nin, identity?.photo_path]);

  const pick = (f?: File | null) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) { toast.error('Choose a photo'); return; }
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  const ninOk = isValidNin(nin);
  const hasPhoto = !!file || !!identity?.photo_path;

  const save = async () => {
    if (!tenantId || !agentId) return;
    if (!ninOk) { toast.error('NIN must be 14 characters and start with CM or CF'); return; }
    if (!hasPhoto) { toast.error('Add the tenant passport photo'); return; }
    setSaving(true);
    try {
      const path = file ? await uploadTenantPhoto(agentId, tenantId, file) : identity!.photo_path;
      await saveTenantIdentity(tenantId, nin, path);
      toast.success('Tenant ID saved');
      onSaved();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e?.message || 'Could not save tenant ID');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><IdCard className="h-5 w-5" /> Tenant ID{tenantName ? ` — ${tenantName}` : ''}</DialogTitle>
          <DialogDescription>Both the NIN and a passport photo are required before this tenant can be in a float request.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="wh-nin">National ID number (NIN)</Label>
            <Input id="wh-nin" value={nin} maxLength={14} autoCapitalize="characters" placeholder="CM0000000000AB"
              onChange={(e) => setNin(normalizeNin(e.target.value).slice(0, 14))} />
            {nin && !ninOk && <p className="text-xs text-destructive">14 characters, starting with CM or CF.</p>}
          </div>
          <div className="space-y-1.5">
            <Label>Passport photo</Label>
            {preview ? (
              <img src={preview} alt="Tenant passport photo" className="h-40 w-32 rounded-lg border object-cover" />
            ) : (
              <div className="flex h-40 w-32 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">No photo</div>
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => camRef.current?.click()}><Camera className="mr-1 h-4 w-4" /> Take photo</Button>
              <Button type="button" variant="outline" size="sm" onClick={() => galRef.current?.click()}><ImagePlus className="mr-1 h-4 w-4" /> From gallery</Button>
            </div>
            <input ref={camRef} type="file" accept="image/*" capture="user" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
            <input ref={galRef} type="file" accept="image/*" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
          </div>
          <Button className="w-full" disabled={saving || !ninOk || !hasPhoto} onClick={save}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save tenant ID
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Agent Ops review: NIN and photo for every tenant in a float request. */
export function WhFloatRequestTenantIds({ requestId }: { requestId: string }) {
  const [rows, setRows] = useState<(FloatRequestTenantId & { url?: string | null })[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    fetchFloatRequestTenantIds(requestId)
      .then(async (r) => {
        const withUrls = await Promise.all(r.map(async (x) => ({ ...x, url: x.photo_path ? await tenantPhotoUrl(x.photo_path) : null })));
        if (live) setRows(withUrls);
      })
      .catch(() => live && setErr(true));
    return () => { live = false; };
  }, [requestId]);

  if (err) return <p className="text-xs text-muted-foreground">Tenant IDs could not be loaded.</p>;
  if (!rows) return <p className="text-xs text-muted-foreground"><Loader2 className="mr-1 inline h-3 w-3 animate-spin" />Loading tenant IDs…</p>;
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold">Tenant IDs</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.subscription_id} className="flex items-center gap-2.5 rounded-lg border bg-card p-2">
            {r.url ? (
              <a href={r.url} target="_blank" rel="noreferrer"><img src={r.url} alt={`${r.tenant_name ?? 'Tenant'} passport photo`} className="h-14 w-11 rounded object-cover border" /></a>
            ) : (
              <div className="flex h-14 w-11 items-center justify-center rounded border border-dashed text-[10px] text-muted-foreground">No photo</div>
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{r.tenant_name ?? 'Tenant'}</p>
              <p className="font-mono text-xs">{r.nin ?? <span className="text-destructive">NIN missing</span>}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
