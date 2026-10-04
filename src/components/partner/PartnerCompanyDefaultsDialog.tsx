import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Upload, Building2, CheckCircle2 } from 'lucide-react';

// Manager-only settings for the stored Welile counter-signature. These values
// are applied automatically when an admin counter-signs an agreement — the
// admin never re-types them per partner.
export default function PartnerCompanyDefaultsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rowId, setRowId] = useState<string | null>(null);
  const [repName, setRepName] = useState('');
  const [repPosition, setRepPosition] = useState('');
  const [repContact, setRepContact] = useState('');
  const [signaturePath, setSignaturePath] = useState<string | null>(null);
  const [sigPreview, setSigPreview] = useState<string | undefined>();
  const [newSigFile, setNewSigFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setNewSigFile(null);
    (async () => {
      try {
        const { data } = await supabase
          .from('partner_agreement_company_defaults')
          .select('*')
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle();
        if (cancelled) return;
        setRowId(data?.id || null);
        setRepName(data?.rep_name || '');
        setRepPosition(data?.rep_position || '');
        setRepContact(data?.rep_contact || '');
        setSignaturePath(data?.signature_path || null);
        if (data?.signature_path) {
          const { data: sig } = await supabase.storage
            .from('partner-agreements')
            .createSignedUrl(data.signature_path, 60 * 60);
          if (!cancelled) setSigPreview(sig?.signedUrl || undefined);
        } else {
          setSigPreview(undefined);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  const onPick = (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast({ title: 'Invalid file', description: 'Upload a PNG/JPG signature image.', variant: 'destructive' });
      return;
    }
    setNewSigFile(file);
    setSigPreview(URL.createObjectURL(file));
  };

  const handleSave = async () => {
    if (!repName.trim()) {
      toast({ title: 'Representative name required', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      let path = signaturePath;
      if (newSigFile) {
        const ext = newSigFile.name.split('.').pop() || 'png';
        path = `company-defaults/welile-signature-${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('partner-agreements')
          .upload(path, newSigFile, { contentType: newSigFile.type, upsert: true });
        if (upErr) throw upErr;
      }
      const patch = {
        rep_name: repName.trim(),
        rep_position: repPosition.trim() || null,
        rep_contact: repContact.trim() || null,
        signature_path: path,
      };
      if (rowId) {
        const { error } = await supabase
          .from('partner_agreement_company_defaults')
          .update(patch)
          .eq('id', rowId);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('partner_agreement_company_defaults')
          .insert(patch);
        if (error) throw error;
      }
      toast({ title: 'Company defaults saved', description: 'These will be used when counter-signing agreements.' });
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: 'Could not save', description: e?.message || 'Try again.', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Building2 className="h-4 w-4 text-primary" /> Company Counter-signature Defaults
          </DialogTitle>
          <DialogDescription className="text-xs">
            Stored once and applied automatically every time a partner agreement is counter-signed.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground inline-flex items-center justify-center gap-1">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Representative name *</Label>
              <Input value={repName} onChange={(e) => setRepName(e.target.value)} placeholder="Full name" />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Position</Label>
              <Input value={repPosition} onChange={(e) => setRepPosition(e.target.value)} placeholder="e.g. Chief Operating Officer" />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Contact</Label>
              <Input value={repContact} onChange={(e) => setRepContact(e.target.value)} placeholder="Phone / email" />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Signature image</Label>
              <div className="flex items-center gap-3">
                <div className="h-16 w-32 rounded-md border bg-muted/30 flex items-center justify-center overflow-hidden">
                  {sigPreview ? (
                    <img src={sigPreview} alt="Signature" className="max-h-full max-w-full object-contain" />
                  ) : (
                    <span className="text-[10px] text-muted-foreground">No signature</span>
                  )}
                </div>
                <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => fileRef.current?.click()}>
                  <Upload className="h-3.5 w-3.5" /> {sigPreview ? 'Replace' : 'Upload'}
                </Button>
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => onPick(e.target.files?.[0])} />
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || loading} className="gap-1.5">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Save defaults
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
