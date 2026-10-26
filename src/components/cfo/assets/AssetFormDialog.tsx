import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAssetReferenceData, useCreateAsset, useUpdateAsset } from '@/hooks/useAssetRegister';
import { describeAssetRpcError, validateAssetInput } from '@/lib/assetRegister/validation';
import {
  ASSET_CATEGORIES, ASSET_CONDITIONS, ASSET_FIELDS, ASSET_STATUSES, assetCodes,
  type Asset, type AssetField, type AssetInput, type FieldError,
} from '@/lib/assetRegister/types';

type FormState = Record<AssetField, string>;
const NONE = '__none__';

function initialState(asset?: Asset | null): FormState {
  const s = Object.fromEntries(ASSET_FIELDS.map((f) => [f, ''])) as FormState;
  s.condition = 'good';
  s.status = 'in_use';
  s.currency = 'UGX';
  if (!asset) return s;
  for (const f of ASSET_FIELDS) {
    const v = (asset as unknown as Record<string, unknown>)[f];
    s[f] = v === null || v === undefined ? '' : String(v);
  }
  return s;
}

/** Turns the form into the RPC payload: create sends every field; edit sends only changed fields. */
function toPayload(form: FormState, original?: Asset | null): Partial<AssetInput> {
  const out: Partial<AssetInput> = {};
  for (const f of ASSET_FIELDS) {
    const next = form[f].trim() === '' ? null : form[f].trim();
    if (original) {
      const prevRaw = (original as unknown as Record<string, unknown>)[f];
      const prev = prevRaw === null || prevRaw === undefined || String(prevRaw).trim() === '' ? null : String(prevRaw);
      const same = f === 'purchase_cost' ? (prev === null ? next === null : next !== null && Number(prev) === Number(next)) : prev === next;
      if (same) continue;
    }
    (out as Record<string, string | null>)[f] = next;
  }
  return out;
}

export function AssetFormDialog({ open, onOpenChange, asset, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided the dialog edits this asset; otherwise it registers a new one. */
  asset?: Asset | null;
  onSaved?: (asset: Asset) => void;
}) {
  const editing = !!asset;
  const [form, setForm] = useState<FormState>(() => initialState(asset));
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const ref = useAssetReferenceData(open);
  const create = useCreateAsset();
  const update = useUpdateAsset();
  const saving = create.isPending || update.isPending;

  useEffect(() => {
    if (open) { setForm(initialState(asset)); setReason(''); setErrors([]); }
  }, [open, asset]);

  const errorFor = useMemo(() => {
    const m = new Map<string, string>();
    errors.forEach((e) => { if (!m.has(e.field)) m.set(e.field, e.message); });
    return m;
  }, [errors]);

  const set = (f: AssetField, v: string) => setForm((s) => ({ ...s, [f]: v }));

  const submit = async () => {
    const payload = toPayload(form, asset);
    if (editing && Object.keys(payload).length === 0) {
      toast.info('Nothing was changed.');
      return;
    }
    const preview = validateAssetInput(payload, { partial: editing });
    if (preview.errors.length) { setErrors(preview.errors); return; }
    setErrors([]);
    try {
      const saved = editing && asset
        ? await update.mutateAsync({ id: asset.id, expectedUpdatedAt: asset.updated_at, changes: preview.value, reason: reason.trim() || null })
        : await create.mutateAsync(preview.value);
      toast.success(editing ? `${assetCodes(saved).primary} updated` : `${assetCodes(saved).primary} registered`);
      onSaved?.(saved);
      onOpenChange(false);
    } catch (err) {
      const { message, fieldErrors } = describeAssetRpcError(err);
      setErrors(fieldErrors);
      toast.error(message);
    }
  };

  const custodianOptions = ref.data?.custodians ?? [];

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o); }}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing && asset ? `Edit ${assetCodes(asset).primary}` : 'Register an asset'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Only changed fields are saved. Every change is recorded in the asset history.'
              : 'The asset ID and asset tag are created automatically from the category and site. Purchase cost is register information only and is not posted to the ledger.'}
          </DialogDescription>
        </DialogHeader>

        <form
          id="asset-form"
          className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2"
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
          noValidate
        >
          <Field id="asset-name" label="Asset name" required error={errorFor.get('name')} className="sm:col-span-2">
            <Input id="asset-name" value={form.name} maxLength={200} onChange={(e) => set('name', e.target.value)} />
          </Field>

          <Field id="asset-category" label="Category" required error={errorFor.get('category')}>
            <ListSelect id="asset-category" value={form.category} options={ASSET_CATEGORIES} placeholder="Choose a category" onChange={(v) => set('category', v)} />
          </Field>
          <Field id="asset-serial" label="Serial number" error={errorFor.get('serial_number')}>
            <Input id="asset-serial" value={form.serial_number} maxLength={120} onChange={(e) => set('serial_number', e.target.value)} />
          </Field>

          <Field id="asset-brand" label="Brand" error={errorFor.get('brand')}>
            <Input id="asset-brand" value={form.brand} maxLength={120} onChange={(e) => set('brand', e.target.value)} />
          </Field>
          <Field id="asset-model" label="Model" error={errorFor.get('model')}>
            <Input id="asset-model" value={form.model} maxLength={120} onChange={(e) => set('model', e.target.value)} />
          </Field>

          <Field id="asset-purchase-date" label="Purchase date" error={errorFor.get('purchase_date')}>
            <Input id="asset-purchase-date" type="date" value={form.purchase_date} onChange={(e) => set('purchase_date', e.target.value)} />
          </Field>
          <Field id="asset-supplier" label="Supplier" error={errorFor.get('supplier')}>
            <Input id="asset-supplier" value={form.supplier} maxLength={200} onChange={(e) => set('supplier', e.target.value)} />
          </Field>

          <Field id="asset-cost" label="Purchase cost (UGX)" error={errorFor.get('purchase_cost') ?? errorFor.get('currency')}>
            <Input id="asset-cost" inputMode="decimal" placeholder="e.g. 3500000" value={form.purchase_cost} onChange={(e) => set('purchase_cost', e.target.value)} />
          </Field>
          <Field id="asset-invoice" label="Invoice / evidence reference" error={errorFor.get('invoice_reference')}>
            <Input id="asset-invoice" value={form.invoice_reference} maxLength={120} onChange={(e) => set('invoice_reference', e.target.value)} />
          </Field>

          <Field id="asset-site" label="Site" required error={errorFor.get('site_key')}
            hint={editing && asset?.asset_tag ? `Asset tag ${asset.asset_tag} stays the same if the site changes.` : undefined}>
            <ListSelect
              id="asset-site" value={form.site_key} placeholder="Choose a site"
              options={(ref.data?.sites ?? []).map((s) => ({ key: s.key, label: `${s.name} (${s.tag_code})` }))}
              onChange={(v) => set('site_key', v)}
            />
          </Field>
          <Field id="asset-location" label="Location (room / floor)" error={errorFor.get('location')}>
            <Input id="asset-location" placeholder="e.g. 2nd floor, finance office" value={form.location} maxLength={200} onChange={(e) => set('location', e.target.value)} />
          </Field>

          <Field id="asset-department" label="Department" error={errorFor.get('department_key')}>
            <ListSelect
              id="asset-department" value={form.department_key} allowNone placeholder="No department"
              options={(ref.data?.departments ?? []).map((d) => ({ key: d.key, label: d.name }))}
              onChange={(v) => set('department_key', v)}
            />
          </Field>

          <Field id="asset-custodian" label="Custodian (staff account)" error={errorFor.get('custodian_user_id')}>
            <ListSelect
              id="asset-custodian" value={form.custodian_user_id} allowNone placeholder="Not linked to an account"
              options={custodianOptions.map((c) => ({ key: c.user_id, label: `${c.name}${c.employee_id ? ` · ${c.employee_id}` : ''}` }))}
              onChange={(v) => set('custodian_user_id', v)}
            />
          </Field>
          <Field id="asset-custodian-name" label="Custodian name (if no account)" error={errorFor.get('custodian_name')}>
            <Input id="asset-custodian-name" value={form.custodian_name} maxLength={200} onChange={(e) => set('custodian_name', e.target.value)} />
          </Field>

          <Field id="asset-condition" label="Condition" required error={errorFor.get('condition')}>
            <ListSelect id="asset-condition" value={form.condition} options={ASSET_CONDITIONS} onChange={(v) => set('condition', v)} />
          </Field>
          <Field id="asset-status" label="Status" required error={errorFor.get('status')}>
            <ListSelect id="asset-status" value={form.status} options={ASSET_STATUSES} onChange={(v) => set('status', v)} />
          </Field>

          <Field id="asset-notes" label="Notes" error={errorFor.get('notes')} className="sm:col-span-2">
            <Textarea id="asset-notes" rows={2} value={form.notes} maxLength={2000} onChange={(e) => set('notes', e.target.value)} />
          </Field>

          {editing && (
            <Field id="asset-change-reason" label="Reason for change (optional)" className="sm:col-span-2">
              <Input id="asset-change-reason" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
            </Field>
          )}

          {errorFor.get('_') && <p role="alert" className="text-xs text-destructive sm:col-span-2">{errorFor.get('_')}</p>}
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button id="asset-form-submit" type="submit" form="asset-form" disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {editing ? 'Save changes' : 'Register asset'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ id, label, required, error, hint, className, children }: {
  id: string; label: string; required?: boolean; error?: string; hint?: string; className?: string; children: React.ReactNode;
}) {
  return (
    <div className={`space-y-1.5 ${className ?? ''}`}>
      <Label htmlFor={id} className="text-xs font-medium">
        {label}{required && <span className="text-destructive"> *</span>}
      </Label>
      {children}
      {hint && !error && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      {error && <p id={`${id}-error`} className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}

function ListSelect({ id, value, options, onChange, placeholder, allowNone }: {
  id: string; value: string; options: ReadonlyArray<{ key: string; label: string }>;
  onChange: (v: string) => void; placeholder?: string; allowNone?: boolean;
}) {
  return (
    <Select value={value || (allowNone ? NONE : undefined)} onValueChange={(v) => onChange(v === NONE ? '' : v)}>
      <SelectTrigger id={id} className="h-10 text-sm"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        {allowNone && <SelectItem value={NONE}>{placeholder ?? 'None'}</SelectItem>}
        {options.map((o) => <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
