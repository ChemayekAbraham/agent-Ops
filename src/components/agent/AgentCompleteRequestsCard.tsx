import { useState } from 'react';
import { ClipboardList, ImagePlus, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { supabase } from '@/integrations/supabase/client';
import { EditTenantDialog } from '@/components/agent/EditTenantDialog';
import { useAgentRequestsMissingDetails } from '@/hooks/useAgentRequestsMissingDetails';
import {
  ASK_FULL_NAME,
  attachLc1Letter,
  familySizeProblem,
  parseFamilySize,
  saveIntakeDetails,
  workProblem,
  type RequestMissingDetails,
} from '@/lib/agentIntakeDetails';
import { uploadLcLetter } from '@/lib/rentRequestAssistantSubmit';
import { formatUGX } from '@/lib/rentCalculations';

/**
 * Agent home: "Complete your requests (n)". Lists the agent's rent requests
 * that still lack intake details, with inline inputs only for what is missing.
 * Every save refetches, so a request drops off once it is complete. Renders
 * nothing when n = 0 (or while the list cannot be loaded).
 */
export function AgentCompleteRequestsCard({ agentId }: { agentId: string }) {
  const { data, error, refetch } = useAgentRequestsMissingDetails(agentId);
  if (error) console.warn('[AgentCompleteRequestsCard] could not load requests missing details', error);
  const rows = data ?? [];
  if (rows.length === 0) return null;

  return (
    <section aria-labelledby="complete-requests-title" className="rounded-2xl border border-warning/30 bg-warning/5 p-3">
      <h2 id="complete-requests-title" className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <ClipboardList className="h-4 w-4 shrink-0 text-warning" />
        Complete your requests ({rows.length})
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">These rent requests are missing details the team needs.</p>
      <ul className="mt-2.5 flex flex-col gap-2.5">
        {rows.map((row) => (
          <CompleteRequestRow key={row.id} agentId={agentId} row={row} onSaved={() => { void refetch(); }} />
        ))}
      </ul>
    </section>
  );
}

const MISSING_LABEL: Record<RequestMissingDetails['missing'][number], string> = {
  family_size: 'family size',
  work_business: 'work',
  lc1_letter: 'LC1 letter',
  tenant_full_name: 'full name',
};

type TenantForEdit = { id: string; full_name: string; phone: string; email: string | null; national_id: string | null; tenant_status?: string | null };

export function CompleteRequestRow({ agentId, row, onSaved }: { agentId: string; row: RequestMissingDetails; onSaved: () => void }) {
  const needsFamily = row.missing.includes('family_size');
  const needsWork = row.missing.includes('work_business');
  const needsLetter = row.missing.includes('lc1_letter');
  const needsName = row.missing.includes('tenant_full_name');

  const [familySize, setFamilySize] = useState('');
  const [work, setWork] = useState('');
  const [workLocation, setWorkLocation] = useState('');
  const [detailsBusy, setDetailsBusy] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [letterBusy, setLetterBusy] = useState(false);
  const [letterError, setLetterError] = useState<string | null>(null);
  const [nameLoading, setNameLoading] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [tenantForEdit, setTenantForEdit] = useState<TenantForEdit | null>(null);

  const saveDetails = async () => {
    const problem = (needsFamily && familySizeProblem(familySize)) || (needsWork && workProblem(work)) || null;
    if (problem) { setDetailsError(problem); return; }
    setDetailsBusy(true);
    setDetailsError(null);
    // Only the missing fields are asked for; the other one is sent as null.
    const res = await saveIntakeDetails(row.id, {
      familySize: needsFamily ? parseFamilySize(familySize) : null,
      workBusiness: needsWork ? work : null,
      workLocation: needsWork ? workLocation : null,
    });
    setDetailsBusy(false);
    if (!res.ok) { setDetailsError(res.message); return; }
    onSaved();
  };

  const addLetter = async (file: File | undefined) => {
    if (!file) return;
    if (!['image/jpeg', 'image/jpg', 'image/png'].includes(file.type.toLowerCase())) { setLetterError('The LC letter must be a JPG or PNG photo.'); return; }
    if (file.size > 10 * 1024 * 1024) { setLetterError('The LC letter must be 10 MB or smaller.'); return; }
    setLetterBusy(true);
    setLetterError(null);
    const uploaded = await uploadLcLetter(agentId, row.id, file);
    if (!uploaded) {
      setLetterBusy(false);
      setLetterError('Couldn’t upload the LC1 letter photo. Check your connection and try again.');
      return;
    }
    const res = await attachLc1Letter(row.id, uploaded.path);
    setLetterBusy(false);
    if (!res.ok) { setLetterError(res.message); return; }
    onSaved();
  };

  /** Opens the existing tenant edit (the one in the tenant's profile) for this request's tenant. */
  const openNameEdit = async () => {
    setNameLoading(true);
    setNameError(null);
    try {
      const { data: req, error: reqErr } = await supabase.from('rent_requests').select('tenant_id').eq('id', row.id).maybeSingle();
      if (reqErr) throw reqErr;
      const tenantId = (req as { tenant_id?: string | null } | null)?.tenant_id;
      if (!tenantId) throw new Error('This request has no tenant on file.');
      const { data: p, error: pErr } = await supabase
        .from('profiles')
        .select('id, full_name, phone, email, national_id, tenant_status')
        .eq('id', tenantId)
        .maybeSingle();
      if (pErr) throw pErr;
      if (!p) throw new Error('Couldn’t open the tenant’s profile.');
      const prof = p as { id: string; full_name: string | null; phone: string | null; email: string | null; national_id: string | null; tenant_status?: string | null };
      setTenantForEdit({
        id: prof.id,
        full_name: prof.full_name ?? '',
        phone: prof.phone ?? '',
        email: prof.email,
        national_id: prof.national_id,
        tenant_status: prof.tenant_status ?? null,
      });
    } catch (e) {
      setNameError(e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e));
    } finally {
      setNameLoading(false);
    }
  };

  const meta = [row.req, row.rent != null ? formatUGX(row.rent) : null, row.status].filter(Boolean).join(' · ');

  return (
    <li className="rounded-xl border border-border bg-card p-3" data-testid={`complete-request-${row.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{row.tenant || 'Tenant'}</p>
          {meta && <p className="truncate text-xs text-muted-foreground">{meta}</p>}
        </div>
        <p className="shrink-0 text-[11px] text-muted-foreground">Missing: {row.missing.map((m) => MISSING_LABEL[m]).join(', ')}</p>
      </div>

      {(needsFamily || needsWork) && (
        <div className="mt-2.5 flex flex-col gap-2">
          {needsFamily && (
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Family size
              <Input
                inputMode="numeric"
                value={familySize}
                onChange={(e) => { setFamilySize(e.target.value.replace(/\D/g, '').slice(0, 2)); setDetailsError(null); }}
                placeholder="e.g. 4"
                className="h-10"
              />
            </label>
          )}
          {needsWork && (
            <>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                Tenant’s work or business
                <Input value={work} onChange={(e) => { setWork(e.target.value); setDetailsError(null); }} placeholder="e.g. Boda boda rider" className="h-10" />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                Work location (optional)
                <Input value={workLocation} onChange={(e) => setWorkLocation(e.target.value)} placeholder="e.g. Owino market" className="h-10" />
              </label>
            </>
          )}
          {detailsError && <p role="alert" className="text-xs text-destructive">{detailsError}</p>}
          <Button type="button" size="sm" className="self-start" disabled={detailsBusy} onClick={() => void saveDetails()}>
            {detailsBusy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Save details
          </Button>
        </div>
      )}

      {needsLetter && (
        <div className="mt-2.5 flex flex-col gap-1">
          <label className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 self-start rounded-full border border-primary/30 bg-card px-3.5 text-sm font-semibold text-primary">
            {letterBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
            {letterBusy ? 'Uploading…' : 'Add LC1 letter photo'}
            <input
              type="file"
              accept="image/jpeg,image/png"
              aria-label="LC1 letter photo"
              className="sr-only"
              disabled={letterBusy}
              onChange={(e) => { void addLetter(e.target.files?.[0]); e.target.value = ''; }}
            />
          </label>
          {letterError && <p role="alert" className="text-xs text-destructive">{letterError}</p>}
        </div>
      )}

      {needsName && (
        <div className="mt-2.5 flex flex-col gap-1">
          <p className="text-sm text-foreground">{ASK_FULL_NAME}.</p>
          <Button type="button" size="sm" variant="outline" className="self-start" disabled={nameLoading} onClick={() => void openNameEdit()}>
            {nameLoading && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Edit name
          </Button>
          {nameError && <p role="alert" className="text-xs text-destructive">{nameError}</p>}
        </div>
      )}

      {tenantForEdit && (
        <EditTenantDialog
          open
          onOpenChange={(o) => { if (!o) setTenantForEdit(null); }}
          tenant={tenantForEdit}
          onSaved={() => onSaved()}
        />
      )}
    </li>
  );
}
