/**
 * A contract is a legal record, so there is no delete control on this screen.
 * A contract that has ended is marked `expired` or `terminated`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  createContract,
  listContracts,
  listDocTypes,
  listDocuments,
  listExpiring,
  updateContractStatus,
  uploadDocument,
  type ContractRow,
  type DocTypeRow,
  type DocumentRow,
} from './api';
import { getStaffDirectory } from '@/hr/api/people';
import { supabase } from '@/hr/api/client';
import DocumentViewer from '@/components/documents/DocumentViewer';

const CONTRACT_TYPES = [
  { value: 'employment', label: 'Employment' },
  { value: 'mou', label: 'MOU' },
  { value: 'service', label: 'Service' },
  { value: 'nda', label: 'NDA' },
  { value: 'lease', label: 'Lease' },
  { value: 'other', label: 'Other' },
] as const;

const SIGNATURE_STATUSES = [
  { value: 'unsigned', label: 'Unsigned' },
  { value: 'partially_signed', label: 'Partially signed' },
  { value: 'signed', label: 'Signed' },
  { value: 'expired', label: 'Expired' },
  { value: 'terminated', label: 'Terminated' },
] as const;

const NO_STAFF = '__none__';

type StaffOption = { id: string; label: string };

function typeLabel(value: string): string {
  return CONTRACT_TYPES.find((t) => t.value === value)?.label ?? value;
}

function statusLabel(value: string): string {
  return SIGNATURE_STATUSES.find((s) => s.value === value)?.label ?? value;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(`${value}T00:00:00Z`).toLocaleDateString('en-UG', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatMoney(amount: number | null, currency: string): string {
  if (amount === null) return '—';
  return `${currency} ${new Intl.NumberFormat('en-UG', { maximumFractionDigits: 0 }).format(amount)}`;
}

/** Red under 30 days, amber under 60, otherwise plain. */
function daysToneClass(days: number | null): string {
  if (days === null) return 'text-muted-foreground';
  if (days < 30) return 'text-destructive font-semibold';
  if (days < 60) return 'text-amber-600 font-medium';
  return '';
}

function daysText(days: number | null): string {
  if (days === null) return '—';
  if (days < 0) return `${Math.abs(days)} overdue`;
  return String(days);
}

function ExpiryStrip({
  within30,
  within60,
  within90,
  expired,
  loading,
}: {
  within30: number;
  within60: number;
  within90: number;
  expired: number;
  loading: boolean;
}) {
  const items = [
    { label: 'Expiring within 30 days', value: within30, tone: 'text-destructive' },
    { label: 'Expiring within 60 days', value: within60, tone: 'text-amber-600' },
    { label: 'Expiring within 90 days', value: within90, tone: 'text-muted-foreground' },
    { label: 'Already expired', value: expired, tone: 'text-foreground' },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-4">
      {items.map((item) => (
        <Card key={item.label}>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">{item.label}</p>
            <p className={`mt-1 text-2xl font-semibold tabular-nums ${item.tone}`}>
              {loading ? '—' : item.value}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function NewContractDialog({
  open,
  onOpenChange,
  staff,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  staff: StaffOption[];
  onCreated: () => void;
}) {
  const [contractType, setContractType] = useState<string>('employment');
  const [title, setTitle] = useState('');
  const [partyMode, setPartyMode] = useState<'staff' | 'external'>('staff');
  const [staffId, setStaffId] = useState<string>('');
  const [counterparty, setCounterparty] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [noticeDays, setNoticeDays] = useState('');
  const [renewalTerms, setRenewalTerms] = useState('');
  const [valueAmount, setValueAmount] = useState('');
  const [currency, setCurrency] = useState('UGX');
  const [ownerStaffId, setOwnerStaffId] = useState<string>(NO_STAFF);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setContractType('employment');
    setTitle('');
    setPartyMode('staff');
    setStaffId('');
    setCounterparty('');
    setStartDate('');
    setEndDate('');
    setNoticeDays('');
    setRenewalTerms('');
    setValueAmount('');
    setCurrency('UGX');
    setOwnerStaffId(NO_STAFF);
    setError(null);
  };

  const save = async () => {
    if (!title.trim()) {
      setError('A title is required.');
      return;
    }
    if (!startDate) {
      setError('A start date is required.');
      return;
    }
    if (partyMode === 'staff' && !staffId) {
      setError('Choose the staff member this contract is with.');
      return;
    }
    if (partyMode === 'external' && !counterparty.trim()) {
      setError('Enter the counterparty name.');
      return;
    }
    if (endDate && endDate < startDate) {
      setError('The end date cannot fall before the start date.');
      return;
    }
    const notice = noticeDays.trim() === '' ? null : Number(noticeDays);
    if (notice !== null && (!Number.isFinite(notice) || notice < 0)) {
      setError('The notice period must be a whole number of days.');
      return;
    }
    const value = valueAmount.trim() === '' ? null : Number(valueAmount);
    if (value !== null && !Number.isFinite(value)) {
      setError('The value must be a number.');
      return;
    }

    setError(null);
    setSaving(true);
    try {
      await createContract({
        contractType,
        title: title.trim(),
        staffId: partyMode === 'staff' ? staffId : null,
        counterparty: partyMode === 'external' ? counterparty.trim() : null,
        startDate,
        endDate: endDate || null,
        noticePeriodDays: notice,
        renewalTerms: renewalTerms.trim() || null,
        valueAmount: value,
        currency: currency.trim() || 'UGX',
        ownerStaffId: ownerStaffId === NO_STAFF ? null : ownerStaffId,
      });
      toast.success('Contract recorded');
      onOpenChange(false);
      reset();
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New contract</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="contract-type">Type</Label>
            <Select value={contractType} onValueChange={setContractType}>
              <SelectTrigger id="contract-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTRACT_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="contract-title">Title</Label>
            <Input
              id="contract-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Employment contract — field agent"
            />
          </div>

          <div className="space-y-2">
            <Label>Party</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={partyMode === 'staff' ? 'default' : 'outline'}
                onClick={() => setPartyMode('staff')}
              >
                Staff member
              </Button>
              <Button
                type="button"
                size="sm"
                variant={partyMode === 'external' ? 'default' : 'outline'}
                onClick={() => setPartyMode('external')}
              >
                External counterparty
              </Button>
            </div>
            {partyMode === 'staff' ? (
              <Select value={staffId} onValueChange={setStaffId}>
                <SelectTrigger aria-label="Staff member">
                  <SelectValue placeholder="Choose a staff member" />
                </SelectTrigger>
                <SelectContent>
                  {staff.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                aria-label="Counterparty name"
                value={counterparty}
                onChange={(e) => setCounterparty(e.target.value)}
                placeholder="Counterparty name"
              />
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="contract-start">Start date</Label>
              <Input
                id="contract-start"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="contract-end">End date (optional)</Label>
              <Input
                id="contract-end"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="contract-notice">Notice period in days (optional)</Label>
            <Input
              id="contract-notice"
              inputMode="numeric"
              value={noticeDays}
              onChange={(e) => setNoticeDays(e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="contract-renewal">Renewal terms (optional)</Label>
            <Textarea
              id="contract-renewal"
              rows={2}
              value={renewalTerms}
              onChange={(e) => setRenewalTerms(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="contract-value">Value (optional)</Label>
              <Input
                id="contract-value"
                inputMode="numeric"
                value={valueAmount}
                onChange={(e) => setValueAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="contract-currency">Currency</Label>
              <Input
                id="contract-currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="contract-owner">Owner</Label>
            <Select value={ownerStaffId} onValueChange={setOwnerStaffId}>
              <SelectTrigger id="contract-owner">
                <SelectValue placeholder="Choose the owner" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_STAFF}>No owner yet</SelectItem>
                {staff.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <p className="text-xs text-muted-foreground">
            Document upload arrives in the next change.
          </p>

          {error && (
            <p role="alert" className="text-xs font-medium text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Save contract
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-2 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-words">{value}</span>
    </div>
  );
}

/**
 * Documents attached to a contract owner. Nothing here deletes: a newer
 * version is an extra row, and the contract keeps pointing at the original.
 */
function ContractDocuments({
  contract,
  onLinked,
}: {
  contract: ContractRow;
  onLinked: () => void;
}) {
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [docTypes, setDocTypes] = useState<DocTypeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [docTypeId, setDocTypeId] = useState('');
  const [title, setTitle] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewerDoc, setViewerDoc] = useState<DocumentRow | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, types] = await Promise.all([
        listDocuments(contract.staff_id, contract.counterparty),
        listDocTypes(),
      ]);
      setDocs(list);
      setDocTypes(types);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [contract.staff_id, contract.counterparty]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const view = (doc: DocumentRow) => {
    setViewerDoc(doc);
  };

  const attach = async () => {
    if (!file) {
      setError('Choose a file first.');
      return;
    }
    if (!docTypeId) {
      setError('Choose a document type.');
      return;
    }
    if (!title.trim()) {
      setError('Give the document a title.');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const row = await uploadDocument(
        file,
        docTypeId,
        title.trim(),
        contract.staff_id,
        contract.counterparty,
      );
      if (!contract.document_id) {
        const res = await supabase
          .from('hr_contracts')
          .update({ document_id: row.id })
          .eq('id', contract.id)
          .select('id')
          .single();
        if (res.error) throw new Error(res.error.message);
        onLinked();
        toast.success('Document attached to this contract');
      } else {
        toast.success('New version stored. The contract still points at the original.');
      }
      setFile(null);
      setTitle('');
      setDocTypeId('');
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-3 border-t pt-3">
      <p className="text-sm font-medium">Documents</p>

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading documents…</p>
      ) : docs.length === 0 ? (
        <p className="text-xs text-muted-foreground">No documents attached yet.</p>
      ) : (
        <ul className="space-y-1">
          {docs.map((d) => (
            <li
              key={d.id}
              className="flex items-center justify-between gap-2 rounded border px-2 py-1.5 text-sm"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{d.title}</span>
                <span className="block text-xs text-muted-foreground">
                  {(d.doc_type_name ?? 'Document') +
                    ' · ' +
                    new Date(d.uploaded_at).toLocaleDateString('en-UG', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                    })}
                  {d.id === contract.document_id ? ' · linked' : ''}
                </span>
              </span>
              <Button size="sm" variant="outline" onClick={() => view(d)}>
                View
              </Button>
            </li>
          ))}
        </ul>
      )}

      <DocumentViewer
        open={viewerDoc !== null}
        onClose={() => setViewerDoc(null)}
        bucket="hr-documents"
        path={viewerDoc?.storage_path?.replace(/^\/+/,'') ?? ''}
        title={viewerDoc?.title ?? 'Document'}
      />

      <div className="space-y-2 rounded border p-2">
        <Label htmlFor="doc-file" className="text-xs">
          Attach document
        </Label>
        <Input
          id="doc-file"
          type="file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <Select value={docTypeId} onValueChange={setDocTypeId}>
          <SelectTrigger id="doc-type">
            <SelectValue placeholder="Document type" />
          </SelectTrigger>
          <SelectContent>
            {docTypes.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          id="doc-title"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Button size="sm" onClick={attach} disabled={uploading}>
          {uploading && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          Save document
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Documents are never deleted. Upload a new version instead.
      </p>

      {error && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function ContractDetailDialog({
  contract,
  onOpenChange,
  onSaved,
}: {
  contract: ContractRow | null;
  onOpenChange: (next: boolean) => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState('unsigned');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (contract) {
      setStatus(contract.signature_status);
      setNotes(contract.notes ?? '');
      setError(null);
    }
  }, [contract]);

  const save = async () => {
    if (!contract) return;
    setSaving(true);
    setError(null);
    try {
      await updateContractStatus(contract.id, status, notes.trim() || null);
      toast.success('Contract updated');
      onOpenChange(false);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={Boolean(contract)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{contract?.title ?? 'Contract'}</DialogTitle>
        </DialogHeader>
        {contract && (
          <div className="space-y-4">
            <div className="divide-y">
              <DetailRow label="Type" value={typeLabel(contract.contract_type)} />
              <DetailRow label="Party" value={contract.party} />
              <DetailRow label="Staff reference" value={contract.staff_ref ?? '—'} />
              <DetailRow label="External counterparty" value={contract.counterparty ?? '—'} />
              <DetailRow label="Start date" value={formatDate(contract.start_date)} />
              <DetailRow label="End date" value={formatDate(contract.end_date)} />
              <DetailRow label="Days remaining" value={daysText(contract.days_remaining)} />
              <DetailRow
                label="Notice period"
                value={
                  contract.notice_period_days === null
                    ? '—'
                    : `${contract.notice_period_days} days`
                }
              />
              <DetailRow label="Renewal terms" value={contract.renewal_terms ?? '—'} />
              <DetailRow
                label="Value"
                value={formatMoney(contract.value_amount, contract.currency)}
              />
              <DetailRow label="Currency" value={contract.currency} />
              <DetailRow
                label="Owner"
                value={contract.owner_name || contract.owner_ref || '—'}
              />
              <DetailRow label="Document type" value={contract.doc_type_name ?? '—'} />
              <DetailRow
                label="Recorded"
                value={new Date(contract.created_at).toLocaleString('en-UG')}
              />
            </div>

            <ContractDocuments contract={contract} onLinked={onSaved} />

            <div className="space-y-1 border-t pt-3">
              <Label htmlFor="detail-status">Signature status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger id="detail-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SIGNATURE_STATUSES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="detail-notes">Notes</Label>
              <Textarea
                id="detail-notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            {error && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {error}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Contracts() {
  const [rows, setRows] = useState<ContractRow[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [expiring, setExpiring] = useState<{ days_remaining: number | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selected, setSelected] = useState<ContractRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [contracts, expiringRows, directory] = await Promise.all([
        listContracts(),
        listExpiring(90),
        getStaffDirectory(),
      ]);
      setRows(contracts);
      setExpiring(expiringRows);
      setStaff(
        directory
          .filter((e) => e.status === 'active')
          .map((e) => ({
            id: e.id,
            label: `${e.full_name || 'Unnamed'} · ${e.staff_number}`,
          })),
      );
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    let within30 = 0;
    let within60 = 0;
    let within90 = 0;
    let expired = 0;
    for (const r of expiring) {
      const d = r.days_remaining;
      if (d === null) continue;
      if (d < 0) expired += 1;
      else if (d <= 30) within30 += 1;
      else if (d <= 60) within60 += 1;
      else if (d <= 90) within90 += 1;
    }
    return { within30, within60, within90, expired };
  }, [expiring]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div />
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          New contract
        </Button>
      </div>

      <ExpiryStrip
        within30={counts.within30}
        within60={counts.within60}
        within90={counts.within90}
        expired={counts.expired}
        loading={loading}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All contracts</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              No contracts recorded yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Party</TableHead>
                    <TableHead>Start</TableHead>
                    <TableHead>End</TableHead>
                    <TableHead className="text-right">Days remaining</TableHead>
                    <TableHead>Signature status</TableHead>
                    <TableHead>Owner</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow
                      key={r.id}
                      className="cursor-pointer"
                      onClick={() => setSelected(r)}
                    >
                      <TableCell className="font-medium">{r.title}</TableCell>
                      <TableCell>{typeLabel(r.contract_type)}</TableCell>
                      <TableCell>{r.party}</TableCell>
                      <TableCell>{formatDate(r.start_date)}</TableCell>
                      <TableCell>{formatDate(r.end_date)}</TableCell>
                      <TableCell
                        className={`text-right tabular-nums ${daysToneClass(r.days_remaining)}`}
                      >
                        {daysText(r.days_remaining)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{statusLabel(r.signature_status)}</Badge>
                      </TableCell>
                      <TableCell>{r.owner_name || r.owner_ref || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <NewContractDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        staff={staff}
        onCreated={() => void load()}
      />

      <ContractDetailDialog
        contract={selected}
        onOpenChange={(next) => {
          if (!next) setSelected(null);
        }}
        onSaved={() => void load()}
      />
    </div>
  );
}
