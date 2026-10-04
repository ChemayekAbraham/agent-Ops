/**
 * HR contracts and MOUs data access (hr_contracts, hr_doc_types).
 *
 * Nothing here deletes. Contracts are a legal record: a contract that has
 * ended is marked `expired` or `terminated`, never removed.
 */
import { supabase, unwrap } from '../api/client';

export interface ContractRow {
  id: string;
  title: string;
  contract_type: string;
  staff_id: string | null;
  counterparty: string | null;
  start_date: string;
  end_date: string | null;
  notice_period_days: number | null;
  renewal_terms: string | null;
  value_amount: number | null;
  currency: string;
  signature_status: string;
  owner_staff_id: string | null;
  document_id: string | null;
  notes: string | null;
  created_at: string;
  /** Derived for display. */
  staff_ref: string | null;
  staff_name: string | null;
  owner_ref: string | null;
  owner_name: string | null;
  doc_type_name: string | null;
  party: string;
  days_remaining: number | null;
}

export interface ExpiringRow {
  contract_id: string;
  title: string;
  party: string | null;
  contract_type: string;
  end_date: string | null;
  days_remaining: number | null;
  signature_status: string;
  band: string | null;
}

export interface DocTypeRow {
  id: string;
  code: string;
  name: string;
  requires_signature: boolean;
  requires_expiry: boolean;
}

export interface DocumentRow {
  id: string;
  title: string;
  doc_type_id: string;
  doc_type_name: string | null;
  staff_id: string | null;
  counterparty: string | null;
  storage_path: string;
  version: number;
  uploaded_at: string;
}

const DOCUMENTS_BUCKET = 'hr-documents';
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/**
 * Uploads one file to the private `hr-documents` bucket and records it in
 * `hr_documents`. A superseding version is a new row, never a replacement.
 */
export async function uploadDocument(
  file: File,
  docTypeId: string,
  title: string,
  staffId: string | null,
  counterparty: string | null,
): Promise<DocumentRow> {
  // Size gate runs before any network call.
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new Error(
      'Files over 10 MB cannot be stored here. Use a link to shared storage instead.',
    );
  }

  const safeName = file.name.replace(/[^\w.\-]+/g, '_');
  const storagePath = `${staffId ?? 'counterparty'}/${Date.now()}-${safeName}`;

  const upload = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(storagePath, file, { contentType: file.type || undefined, upsert: false });
  if (upload.error) throw new Error(upload.error.message);

  const res = await supabase
    .from('hr_documents')
    .insert({
      staff_id: staffId,
      counterparty: staffId ? null : counterparty,
      doc_type_id: docTypeId,
      title,
      storage_path: storagePath,
      version: 1,
    })
    .select('id, title, doc_type_id, staff_id, counterparty, storage_path, version, uploaded_at')
    .single();
  const row = unwrap(res) as Omit<DocumentRow, 'doc_type_name'>;
  return { ...row, doc_type_name: null };
}

/** Documents belonging to one owner, newest first. */
export async function listDocuments(
  staffId: string | null,
  counterparty: string | null,
): Promise<DocumentRow[]> {
  let query = supabase
    .from('hr_documents')
    .select(
      'id, title, doc_type_id, staff_id, counterparty, storage_path, version, uploaded_at, doc_type:hr_doc_types!doc_type_id(name)',
    )
    .order('uploaded_at', { ascending: false });

  if (staffId) query = query.eq('staff_id', staffId);
  else if (counterparty) query = query.eq('counterparty', counterparty);
  else return [];

  const raw = ((unwrap(await query) ?? []) as unknown) as (Omit<DocumentRow, 'doc_type_name'> & {
    doc_type: { name: string } | null;
  })[];

  return raw.map(({ doc_type, ...rest }) => ({
    ...rest,
    doc_type_name: doc_type?.name ?? null,
  }));
}

/** Short-lived signed URL. The bucket is private, so never a public URL. */
export async function getDocumentUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUrl(storagePath, 60);
  if (error) throw new Error(error.message);
  if (!data?.signedUrl) throw new Error('Could not sign that document link.');
  return data.signedUrl;
}

export interface NewContractFields {
  contractType: string;
  title: string;
  staffId: string | null;
  counterparty: string | null;
  startDate: string;
  endDate: string | null;
  noticePeriodDays: number | null;
  renewalTerms: string | null;
  valueAmount: number | null;
  currency: string;
  ownerStaffId: string | null;
}

const CONTRACT_SELECT =
  'id, title, contract_type, staff_id, counterparty, start_date, end_date, notice_period_days, renewal_terms, value_amount, currency, signature_status, owner_staff_id, document_id, notes, created_at, staff:hr_staff!staff_id(id, staff_ref, user_id), owner:hr_staff!owner_staff_id(id, staff_ref, user_id), document:hr_documents!document_id(id, doc_type:hr_doc_types!doc_type_id(name))';

type RawContract = Omit<
  ContractRow,
  'staff_ref' | 'staff_name' | 'owner_ref' | 'owner_name' | 'doc_type_name' | 'party' | 'days_remaining'
> & {
  staff: { id: string; staff_ref: string; user_id: string } | null;
  owner: { id: string; staff_ref: string; user_id: string } | null;
  document: { id: string; doc_type: { name: string } | null } | null;
};

/** Whole days from today until `endDate`. Negative once the date has passed. */
function daysUntil(endDate: string | null): number | null {
  if (!endDate) return null;
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  const today = new Date();
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((end - start) / 86400000);
}

/**
 * Every contract, joined to the staff member (for the staff reference) and to
 * the document type where a document is linked. Ordered by end date, soonest
 * first, with open-ended contracts last.
 */
export async function listContracts(): Promise<ContractRow[]> {
  const raw = ((unwrap(
    await supabase.from('hr_contracts').select(CONTRACT_SELECT),
  ) ?? []) as unknown) as RawContract[];

  const userIds = Array.from(
    new Set(
      raw
        .flatMap((r) => [r.staff?.user_id, r.owner?.user_id])
        .filter((v): v is string => Boolean(v)),
    ),
  );

  const nameByUser = new Map<string, string>();
  if (userIds.length > 0) {
    const profiles = ((unwrap(
      await supabase.from('profiles').select('id, full_name').in('id', userIds),
    ) ?? []) as { id: string; full_name: string | null }[]);
    profiles.forEach((p) => nameByUser.set(p.id, p.full_name ?? ''));
  }

  const rows: ContractRow[] = raw.map((r) => {
    const staffName = r.staff ? nameByUser.get(r.staff.user_id) || null : null;
    const ownerName = r.owner ? nameByUser.get(r.owner.user_id) || null : null;
    return {
      id: r.id,
      title: r.title,
      contract_type: r.contract_type,
      staff_id: r.staff_id,
      counterparty: r.counterparty,
      start_date: r.start_date,
      end_date: r.end_date,
      notice_period_days: r.notice_period_days,
      renewal_terms: r.renewal_terms,
      value_amount: r.value_amount === null ? null : Number(r.value_amount),
      currency: r.currency,
      signature_status: r.signature_status,
      owner_staff_id: r.owner_staff_id,
      document_id: r.document_id,
      notes: r.notes,
      created_at: r.created_at,
      staff_ref: r.staff?.staff_ref ?? null,
      staff_name: staffName,
      owner_ref: r.owner?.staff_ref ?? null,
      owner_name: ownerName,
      doc_type_name: r.document?.doc_type?.name ?? null,
      party: staffName || r.staff?.staff_ref || r.counterparty || '—',
      days_remaining: daysUntil(r.end_date),
    };
  });

  // End date ascending, nulls last.
  rows.sort((a, b) => {
    if (a.end_date === b.end_date) return a.title.localeCompare(b.title);
    if (!a.end_date) return 1;
    if (!b.end_date) return -1;
    return a.end_date < b.end_date ? -1 : 1;
  });

  return rows;
}

/** Inserts one contract. `created_by` is filled by the column default. */
export async function createContract(fields: NewContractFields): Promise<{ id: string }> {
  const res = await supabase
    .from('hr_contracts')
    .insert({
      contract_type: fields.contractType,
      title: fields.title,
      staff_id: fields.staffId,
      counterparty: fields.counterparty,
      start_date: fields.startDate,
      end_date: fields.endDate,
      notice_period_days: fields.noticePeriodDays,
      renewal_terms: fields.renewalTerms,
      value_amount: fields.valueAmount,
      currency: fields.currency,
      owner_staff_id: fields.ownerStaffId,
    })
    .select('id')
    .single();
  return unwrap(res) as { id: string };
}

/** Updates the signature status and notes only. No other column is touched. */
export async function updateContractStatus(
  id: string,
  signatureStatus: string,
  notes: string | null,
): Promise<void> {
  const res = await supabase
    .from('hr_contracts')
    .update({ signature_status: signatureStatus, notes })
    .eq('id', id)
    .select('id')
    .single();
  unwrap(res);
}

/** Contracts whose end date falls within the next `days` days, plus overdue ones. */
export async function listExpiring(days: number): Promise<ExpiringRow[]> {
  const res = await supabase.rpc('hr_contracts_expiring', { _days: days });
  return ((unwrap(res) ?? []) as unknown) as ExpiringRow[];
}

/** Active document types, for labelling attached documents. */
export async function listDocTypes(): Promise<DocTypeRow[]> {
  const res = await supabase
    .from('hr_doc_types')
    .select('id, code, name, requires_signature, requires_expiry')
    .eq('active', true)
    .order('name');
  return ((unwrap(res) ?? []) as unknown) as DocTypeRow[];
}
