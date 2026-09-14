import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FolderOpen, Camera, FileImage, Loader2, ExternalLink, AlertTriangle, Upload, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { optimizeImage } from '@/lib/imageOptimizer';

type DocRow = {
  id: string;
  doc_type: string;
  bucket: string;
  path: string | null;
  public_url: string | null;
  version: number;
  created_at: string;
};

const REQUIRED_HOUSE_IMAGES = 4;
const MAX_MB = 10;

/**
 * Tenant document custody panel — passport photo, house photos and LC letter on
 * file, with re-upload. A re-upload writes a new version into
 * `tenant_documents`; older versions are retired, never deleted.
 */
export function TenantDocumentsSection({
  tenantId,
  tenantName,
}: {
  tenantId: string;
  tenantName: string;
}) {
  const { user } = useAuth();
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [signed, setSigned] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('tenant_documents')
        .select('id, doc_type, bucket, path, public_url, version, created_at')
        .eq('tenant_id', tenantId)
        .eq('is_current', true)
        .order('version', { ascending: false });
      if (error) throw error;
      const rows = (data || []) as DocRow[];
      setDocs(rows);

      // Private buckets (LC letters) need a short-lived signed link.
      const priv = rows.filter((r) => !r.public_url && r.path);
      const map: Record<string, string> = {};
      for (const r of priv) {
        const { data: s } = await supabase.storage.from(r.bucket).createSignedUrl(r.path as string, 600);
        if (s?.signedUrl) map[r.id] = s.signedUrl;
      }
      setSigned(map);
    } catch (err: any) {
      console.error('Failed to load tenant documents:', err);
      toast.error(err?.message ?? 'Could not load documents');
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  const passport = docs.find((d) => d.doc_type === 'tenant_passport');
  const houseImages = docs.filter((d) => d.doc_type === 'house_image');
  const lcLetter = docs.find((d) => d.doc_type === 'lc_letter');
  const urlOf = (d?: DocRow) => (d ? d.public_url || signed[d.id] || '' : '');

  const nextVersion = (docType: string) =>
    Math.max(0, ...docs.filter((d) => d.doc_type === docType).map((d) => d.version)) + 1;

  /** Uploads one file and records it as the current version of that doc type. */
  const upload = async (docType: string, file: File, existing?: DocRow) => {
    if (!user?.id) { toast.error('Not signed in'); return; }
    if (file.size > MAX_MB * 1024 * 1024) { toast.error(`File must be ${MAX_MB} MB or smaller`); return; }
    setBusy(docType + (existing?.id ?? ''));
    try {
      const stamp = `reupload-${Date.now()}`;
      const isLetter = docType === 'lc_letter';
      const bucket = isLetter ? 'lc-letters' : 'house-images';
      let path: string;
      let publicUrl: string | null = null;

      if (isLetter) {
        const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
        path = `${user.id}/${stamp}/lc_letter.${ext}`;
        const { error } = await supabase.storage
          .from(bucket)
          .upload(path, file, { cacheControl: '86400', upsert: true, contentType: file.type });
        if (error) throw error;
      } else {
        const opt = await optimizeImage(file, { maxWidth: 1200, quality: docType === 'tenant_passport' ? 0.85 : 0.8 });
        const name = docType === 'tenant_passport' ? 'tenant_passport' : `photo_${Date.now()}`;
        path = `${user.id}/${stamp}/${name}.${opt.file.name.split('.').pop() || 'webp'}`;
        const { error } = await supabase.storage
          .from(bucket)
          .upload(path, opt.file, { cacheControl: '86400', upsert: true });
        if (error) throw error;
        publicUrl = supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
      }

      const { error: insErr } = await supabase.from('tenant_documents').insert({
        tenant_id: tenantId,
        doc_type: docType,
        bucket,
        path,
        public_url: publicUrl,
        version: nextVersion(docType),
        is_current: true,
        uploaded_by: user.id,
      } as any);
      if (insErr) throw insErr;

      // Retire the version being replaced. Goes through the secure helper so a
      // photo first uploaded by another agent is retired too (history kept).
      if (existing) {
        const { error: retErr } = await (supabase.rpc as any)('retire_tenant_document', { p_doc_id: existing.id });
        if (retErr) throw retErr;
      }


      // Keep the tenant's profile photo in step with the passport on file.
      if (docType === 'tenant_passport' && publicUrl) {
        await supabase.from('profiles').update({ avatar_url: publicUrl }).eq('id', tenantId);
        publishAvatarUpdate(tenantId, publicUrl);
      }

      toast.success(existing ? 'Document replaced' : 'Document uploaded');
      await load();
    } catch (err: any) {
      console.error('Document upload failed:', err);
      toast.error(err?.message ?? 'Upload failed');
    } finally {
      setBusy(null);
    }
  };

  const pick = (docType: string, existing?: DocRow) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void upload(docType, file, existing);
  };

  /** Retires a document (kept in history, hidden from the profile). */
  const removeDoc = async (doc: DocRow) => {
    setBusy(doc.doc_type + doc.id);
    try {
      const { error } = await (supabase.rpc as any)('retire_tenant_document', { p_doc_id: doc.id });
      if (error) throw error;

      toast.success('Photo removed');
      await load();
    } catch (err: any) {
      console.error('Document removal failed:', err);
      toast.error(err?.message ?? 'Could not remove the photo');
    } finally {
      setBusy(null);
    }
  };

  const missing = [
    !passport && 'passport photo',
    houseImages.length < REQUIRED_HOUSE_IMAGES && `house photos (${houseImages.length} of ${REQUIRED_HOUSE_IMAGES})`,
    !lcLetter && 'LC letter',
  ].filter(Boolean) as string[];

  return (
    <section className="rounded-2xl border border-border/60 bg-card p-4 sm:p-5 space-y-4">
      <header className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-bold text-foreground">
          <FolderOpen className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          Documents
        </h3>
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : missing.length === 0 ? (
          <Badge className="bg-success/10 text-success border-0">Complete</Badge>
        ) : (
          <Badge variant="outline" className="border-warning/50 text-warning">{missing.length} missing</Badge>
        )}
      </header>

      {!loading && missing.length > 0 && (
        <div className="rounded-lg border border-warning/50 bg-warning/10 p-2.5 text-xs text-muted-foreground">
          <p className="font-semibold text-warning inline-flex items-center gap-1">
            <AlertTriangle className="h-3.5 w-3.5" /> Missing for {tenantName}
          </p>
          <p className="mt-0.5 capitalize">{missing.join(' · ')}</p>
        </div>
      )}

      {/* Tenant photo */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Tenant photo</p>
        <div className="flex items-center gap-3">
          {passport && urlOf(passport) ? (
            <a href={urlOf(passport)} target="_blank" rel="noopener noreferrer">
              <img src={urlOf(passport)} alt={`${tenantName} passport photo`} loading="lazy"
                className="h-20 w-20 rounded-xl object-cover border border-border" />
            </a>
          ) : (
            <div className="h-20 w-20 rounded-xl border-2 border-dashed border-border flex items-center justify-center text-muted-foreground">
              <Camera className="h-5 w-5" />
            </div>
          )}
          <label>
            <Button asChild variant="outline" size="sm" disabled={!!busy}>
              <span className="cursor-pointer inline-flex items-center gap-1.5">
                {busy?.startsWith('tenant_passport') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
                {passport ? 'Re-upload' : 'Upload'}
              </span>
            </Button>
            <input type="file" accept="image/*" capture="environment" className="hidden"
              onChange={pick('tenant_passport', passport)} disabled={!!busy} />
          </label>
        </div>
      </div>

      {/* House images */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          House photos · {houseImages.length} on file
        </p>
        <div className="grid grid-cols-4 gap-2">
          {houseImages.map((d) => (
            <div key={d.id} className="relative group">
              <a href={urlOf(d)} target="_blank" rel="noopener noreferrer" className="block">
                <img src={urlOf(d)} alt="House photo" loading="lazy"
                  className="h-20 w-full rounded-lg object-cover border border-border" />
              </a>
              {busy === 'house_image' + d.id ? (
                <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/70">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="absolute inset-x-0 bottom-0 flex items-stretch rounded-b-lg overflow-hidden bg-background/85 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <label className="flex-1 cursor-pointer inline-flex items-center justify-center gap-1 py-1 text-[10px] font-medium text-foreground hover:bg-muted"
                    title="Take a new photo">
                    <Camera className="h-3 w-3" />
                    <input type="file" accept="image/*" capture="environment" className="hidden"
                      onChange={pick('house_image', d)} disabled={!!busy} />
                  </label>
                  <label className="flex-1 cursor-pointer inline-flex items-center justify-center gap-1 py-1 text-[10px] font-medium text-foreground hover:bg-muted"
                    title="Upload from gallery">
                    <Upload className="h-3 w-3" />
                    <input type="file" accept="image/*" className="hidden"
                      onChange={pick('house_image', d)} disabled={!!busy} />
                  </label>
                  <button type="button" title="Remove photo" disabled={!!busy}
                    onClick={() => void removeDoc(d)}
                    className="flex-1 inline-flex items-center justify-center py-1 text-destructive hover:bg-destructive/10">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>
          ))}
          <div className="flex h-20 flex-col overflow-hidden rounded-lg border-2 border-dashed border-border text-muted-foreground">
            <label className="flex flex-1 cursor-pointer items-center justify-center gap-1 text-[10px] hover:bg-muted/50">
              {busy === 'house_image' ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Camera className="h-3.5 w-3.5" /> Camera</>}
              <input type="file" accept="image/*" capture="environment" className="hidden"
                onChange={pick('house_image')} disabled={!!busy} />
            </label>
            <label className="flex flex-1 cursor-pointer items-center justify-center gap-1 border-t border-dashed border-border text-[10px] hover:bg-muted/50">
              <Upload className="h-3.5 w-3.5" /> Upload
              <input type="file" accept="image/*" className="hidden"
                onChange={pick('house_image')} disabled={!!busy} />
            </label>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Hover a photo to retake, replace or remove it. Replaced photos are versioned, never lost.
        </p>
      </div>


      {/* LC letter */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">LC letter</p>
        <div className="flex items-center gap-3">
          {lcLetter && urlOf(lcLetter) ? (
            <a href={urlOf(lcLetter)} target="_blank" rel="noopener noreferrer">
              <img src={urlOf(lcLetter)} alt="LC letter" loading="lazy"
                className="h-20 w-20 rounded-xl object-cover border border-border" />
            </a>
          ) : (
            <div className="h-20 w-20 rounded-xl border-2 border-dashed border-border flex items-center justify-center text-muted-foreground">
              <FileImage className="h-5 w-5" />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <label>
              <Button asChild variant="outline" size="sm" disabled={!!busy}>
                <span className="cursor-pointer inline-flex items-center gap-1.5">
                  {busy?.startsWith('lc_letter') ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileImage className="h-4 w-4" />}
                  {lcLetter ? 'Re-upload' : 'Upload'}
                </span>
              </Button>
              <input type="file" accept="image/jpeg,image/jpg,image/png" className="hidden"
                onChange={pick('lc_letter', lcLetter)} disabled={!!busy} />
            </label>
            {lcLetter && urlOf(lcLetter) && (
              <a href={urlOf(lcLetter)} target="_blank" rel="noopener noreferrer"
                className="text-xs text-primary inline-flex items-center gap-1">
                <ExternalLink className="h-3 w-3" /> Open letter
              </a>
            )}
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">JPG, JPEG or PNG · max {MAX_MB} MB</p>
      </div>
    </section>
  );
}
