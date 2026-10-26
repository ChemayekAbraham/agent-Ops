import { useRef, useState } from 'react';
import { Camera, FileText, History, Loader2, Pencil, Paperclip, ExternalLink, QrCode } from 'lucide-react';
import { toast } from 'sonner';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { formatUGX } from '@/lib/rentCalculations';
import { useAssetDetail, useAssetEvidenceUrl, useAttachAssetEvidence, evidenceFileProblem } from '@/hooks/useAssetRegister';
import { describeAssetRpcError } from '@/lib/assetRegister/validation';
import {
  ASSET_EVIDENCE_MIME, categoryLabel, conditionLabel, statusLabel, type Asset, type AssetEvent,
} from '@/lib/assetRegister/types';
import { AssetFormDialog } from './AssetFormDialog';
import { AssetQrDialog } from './AssetQrDialog';

const FIELD_LABELS: Record<string, string> = {
  name: 'Name', category: 'Category', brand: 'Brand', model: 'Model', serial_number: 'Serial number',
  purchase_date: 'Purchase date', supplier: 'Supplier', purchase_cost: 'Purchase cost', currency: 'Currency',
  invoice_reference: 'Invoice / evidence ref.', department_key: 'Department', location: 'Location',
  custodian_user_id: 'Custodian account', custodian_name: 'Custodian name', condition: 'Condition', status: 'Status',
  notes: 'Notes', photo_paths: 'Photos', evidence_paths: 'Evidence',
};

const fmtDateTime = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

function costText(a: Asset) {
  if (a.purchase_cost === null) return '—';
  return a.currency === 'UGX' ? formatUGX(a.purchase_cost) : `${a.currency} ${Number(a.purchase_cost).toLocaleString()}`;
}

export function AssetDetailSheet({ assetId, onOpenChange }: { assetId: string | null; onOpenChange: (open: boolean) => void }) {
  const q = useAssetDetail(assetId);
  const [editing, setEditing] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const a = q.data?.asset;

  return (
    <Sheet open={!!assetId} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader className="text-left">
          <SheetTitle className="flex flex-wrap items-center gap-2">
            {a ? <><span className="font-mono text-sm text-primary">{a.asset_code}</span><span>{a.name}</span></> : 'Asset'}
          </SheetTitle>
          <SheetDescription>
            {a ? `${categoryLabel(a.category)} · ${statusLabel(a.status)} · ${conditionLabel(a.condition)}` : 'Loading asset…'}
          </SheetDescription>
        </SheetHeader>

        {q.isLoading && <p className="py-10 text-center text-xs text-muted-foreground">Loading asset…</p>}
        {q.isError && <p role="alert" className="py-10 text-center text-xs text-destructive">Could not load this asset.</p>}

        {a && (
          <div className="mt-5 space-y-6">
            <div className="flex justify-end gap-2">
              <Button id="asset-detail-qr" size="sm" variant="outline" onClick={() => setShowQr(true)}>
                <QrCode className="mr-1.5 h-3.5 w-3.5" /> View QR
              </Button>
              <Button id="asset-detail-edit" size="sm" variant="outline" onClick={() => setEditing(true)}>
                <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit
              </Button>
            </div>
            <AssetDetailBody asset={a} events={q.data?.events ?? []} />
          </div>
        )}

        <AssetFormDialog open={editing} onOpenChange={setEditing} asset={a ?? null} />
        <AssetQrDialog open={showQr} onOpenChange={setShowQr} asset={a ?? null} />
      </SheetContent>
    </Sheet>
  );
}

/** Asset fields, photos/evidence and history. `readOnly` hides the evidence upload actions (QR deep-link page). */
export function AssetDetailBody({ asset: a, events, readOnly = false }: { asset: Asset; events: AssetEvent[]; readOnly?: boolean }) {
  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
        <Item label="Brand" value={a.brand} />
        <Item label="Model" value={a.model} />
        <Item label="Serial number" value={a.serial_number} mono />
        <Item label="Purchase date" value={a.purchase_date} />
        <Item label="Supplier" value={a.supplier} />
        <Item label="Purchase cost" value={costText(a)} hint="Register information only — not posted to the ledger" />
        <Item label="Invoice / evidence reference" value={a.invoice_reference} />
        <Item label="Department" value={a.department_name ?? a.department_key} />
        <Item label="Location" value={a.location} />
        <Item label="Custodian" value={a.custodian_display} />
        <Item label="Condition" value={conditionLabel(a.condition)} />
        <Item label="Status" value={statusLabel(a.status)} />
        {a.notes && <Item label="Notes" value={a.notes} wide />}
        <Item label="Registered" value={`${fmtDateTime(a.created_at)}${a.created_by_name ? ` by ${a.created_by_name}` : ''}`} />
        <Item label="Last changed" value={`${fmtDateTime(a.updated_at)}${a.updated_by_name ? ` by ${a.updated_by_name}` : ''}`} />
      </dl>

      <EvidenceSection asset={a} readOnly={readOnly} />
      <Timeline events={events} />
    </div>
  );
}

function Item({ label, value, mono, wide, hint }: { label: string; value: string | null | undefined; mono?: boolean; wide?: boolean; hint?: string }) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 break-words text-foreground ${mono ? 'font-mono text-[11px]' : 'font-medium'}`}>{value || '—'}</dd>
      {hint && <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function EvidenceSection({ asset, readOnly }: { asset: Asset; readOnly: boolean }) {
  const attach = useAttachAssetEvidence();
  const photoInput = useRef<HTMLInputElement>(null);
  const docInput = useRef<HTMLInputElement>(null);

  const onPick = async (kind: 'photo' | 'evidence', file: File | undefined, input: HTMLInputElement | null) => {
    if (input) input.value = '';
    if (!file) return;
    const problem = evidenceFileProblem(file);
    if (problem) { toast.error(problem); return; }
    try {
      await attach.mutateAsync({ assetId: asset.id, kind, file });
      toast.success(kind === 'photo' ? 'Photo attached' : 'Evidence attached');
    } catch (err) {
      toast.error(err instanceof Error && !('code' in err) ? err.message : describeAssetRpcError(err).message);
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-sm font-semibold"><Paperclip className="h-4 w-4 text-primary" /> Photos & evidence</h4>
        {!readOnly && <div className="flex gap-2">
          <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
            onChange={(e) => void onPick('photo', e.target.files?.[0], photoInput.current)} />
          <input ref={docInput} type="file" accept={ASSET_EVIDENCE_MIME.join(',')} className="hidden"
            onChange={(e) => void onPick('evidence', e.target.files?.[0], docInput.current)} />
          <Button id="asset-attach-photo" size="sm" variant="outline" className="h-8 text-xs" disabled={attach.isPending} onClick={() => photoInput.current?.click()}>
            {attach.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Camera className="mr-1 h-3.5 w-3.5" />} Photo
          </Button>
          <Button id="asset-attach-evidence" size="sm" variant="outline" className="h-8 text-xs" disabled={attach.isPending} onClick={() => docInput.current?.click()}>
            <FileText className="mr-1 h-3.5 w-3.5" /> Evidence
          </Button>
        </div>}
      </div>
      {asset.photo_paths.length + asset.evidence_paths.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
          No photos or evidence attached yet. Files are private and open through a link that expires after 5 minutes.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {asset.photo_paths.map((p) => <EvidenceThumb key={p} path={p} kind="photo" />)}
          {asset.evidence_paths.map((p) => <EvidenceThumb key={p} path={p} kind="evidence" />)}
        </div>
      )}
    </section>
  );
}

function EvidenceThumb({ path, kind }: { path: string; kind: 'photo' | 'evidence' }) {
  const url = useAssetEvidenceUrl(path);
  const isPdf = path.endsWith('.pdf');
  return (
    <a
      href={url.data ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${kind}`}
      className="group relative flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/40 transition hover:border-primary/50"
    >
      {url.isLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        : url.isError ? <span className="px-1 text-center text-[10px] text-destructive">Unavailable</span>
        : isPdf ? <FileText className="h-6 w-6 text-muted-foreground" />
        : <img src={url.data} alt="" loading="lazy" className="h-full w-full object-cover" />}
      <ExternalLink className="absolute right-1 top-1 h-3 w-3 text-foreground/70 opacity-0 transition group-hover:opacity-100" />
    </a>
  );
}

const EVENT_TEXT: Record<AssetEvent['event_type'], string> = {
  created: 'Registered', imported: 'Imported from Excel', updated: 'Updated', evidence_added: 'Evidence attached',
};

function Timeline({ events }: { events: AssetEvent[] }) {
  return (
    <section className="space-y-3">
      <h4 className="flex items-center gap-2 text-sm font-semibold"><History className="h-4 w-4 text-primary" /> History</h4>
      {events.length === 0 ? <p className="text-xs text-muted-foreground">No history recorded.</p> : (
        <ol className="relative space-y-3 border-l border-border pl-4">
          {events.map((e) => (
            <li key={e.id} className="relative text-xs">
              <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-background bg-primary" />
              <p className="font-medium text-foreground">
                {EVENT_TEXT[e.event_type]}
                <span className="font-normal text-muted-foreground"> · {fmtDateTime(e.created_at)}{e.actor_name ? ` · ${e.actor_name}` : ''}</span>
              </p>
              {e.event_type === 'updated' && e.changed_fields.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
                  {e.changed_fields.map((f) => (
                    <li key={f}>
                      <span className="text-foreground">{FIELD_LABELS[f] ?? f}</span>: {show(e.old_values?.[f])} → {show(e.new_values?.[f])}
                    </li>
                  ))}
                </ul>
              )}
              {e.reason && <p className="mt-1 text-[11px] italic text-muted-foreground">“{e.reason}”</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function show(v: unknown) {
  if (v === null || v === undefined || v === '') return '—';
  return String(v).replace(/_/g, ' ');
}
