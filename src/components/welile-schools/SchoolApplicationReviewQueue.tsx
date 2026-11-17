import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Loader2, MapPin, Search, UserCheck } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { withUuidIds } from '@/lib/isUuid';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { mapLink } from '@/lib/welileSchools';
import {
  OFFERS_OPTIONS, OPS_STATUS_LABEL, applicationErrorMessage, fetchAllApplications, isOpenApplication, reviewApplication,
  searchAgentsForApplication, type AgentCandidate, type ApplicationRow, type ApplicationStatus,
} from '@/lib/welileSchoolsApplications';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const TONE: Record<ApplicationStatus, string> = {
  submitted: 'bg-primary text-primary-foreground',
  agent_assigned: 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200',
  inspecting: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200',
  declined: 'bg-destructive/10 text-destructive',
  withdrawn: 'bg-muted text-muted-foreground',
};

const QUERY_KEY = ['welile-school-applications-ops'];

/**
 * Agent Ops: school owners' partnership applications. Assign a Welile agent to inspect the school
 * (they then set up the partnership, which comes back through the Partnerships tab), or decline.
 */
export default function SchoolApplicationReviewQueue() {
  const { data, isLoading, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const rows = await fetchAllApplications();
      const ids = [...new Set(rows.map((r) => r.assigned_agent_id).filter(Boolean))] as string[];
      const names: Record<string, { name: string; phone: string | null }> = {};
      if (ids.length) {
        const { data: ps } = await withUuidIds(ids, (valid) => db.from('profiles').select('id, full_name, phone').in('id', valid));
        (ps ?? []).forEach((p: { id: string; full_name: string | null; phone: string | null }) => { names[p.id] = { name: p.full_name ?? '—', phone: p.phone }; });
      }
      return { rows, names };
    },
    staleTime: 30_000,
  });
  const [filter, setFilter] = useState<'open' | 'all'>('open');

  if (isLoading) return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>;
  if (error) return <p className="rounded-xl bg-muted/60 p-3 text-sm text-muted-foreground">{applicationErrorMessage(error)}</p>;

  const rows = data?.rows ?? [];
  const open = rows.filter((r) => isOpenApplication(r.status));
  const shown = filter === 'open' ? open : rows;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={filter === 'open' ? 'default' : 'outline'} onClick={() => setFilter('open')}>Needs action ({open.length})</Button>
        <Button size="sm" variant={filter === 'all' ? 'default' : 'outline'} onClick={() => setFilter('all')}>All ({rows.length})</Button>
        <p className="text-xs text-muted-foreground">Once the agent starts the inspection, the partnership comes back to you in the Partnerships tab.</p>
      </div>
      {shown.length === 0 ? (
        <p className="rounded-xl bg-muted/50 p-3 text-sm text-muted-foreground">{filter === 'open' ? 'No applications waiting.' : 'No applications yet.'}</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {shown.map((a) => <ApplicationCard key={a.id} a={a} agent={a.assigned_agent_id ? data?.names[a.assigned_agent_id] : undefined} />)}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === '') return null;
  return (
    <div className="flex justify-between gap-3 border-b border-border/40 py-1 text-sm last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

function ApplicationCard({ a, agent }: { a: ApplicationRow; agent?: { name: string; phone: string | null } }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'view' | 'assign' | 'decline'>('view');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const map = mapLink(a.latitude, a.longitude);
  const open = isOpenApplication(a.status);

  const act = async (decision: 'assign' | 'decline', agentId: string | null) => {
    setBusy(true);
    try {
      await reviewApplication(a.id, decision, agentId, note);
      toast.success(decision === 'assign' ? 'Agent assigned' : 'Application declined');
      setMode('view'); setNote('');
      qc.invalidateQueries({ queryKey: QUERY_KEY });
    } catch (e) {
      toast.error('Could not save', { description: applicationErrorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-3 p-3">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><Building2 className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{a.school_name}</p>
          <p className="text-xs text-muted-foreground">{[a.village, a.town, a.district, a.region].filter(Boolean).join(', ')}</p>
          <p className="text-xs text-muted-foreground">Applied {new Date(a.created_at).toLocaleDateString()}</p>
        </div>
        <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', TONE[a.status])}>{OPS_STATUS_LABEL[a.status]}</span>
      </div>

      <dl>
        <Row label="Level" value={a.school_level} />
        <Row label="Ownership" value={a.ownership} />
        <Row label="Day / boarding" value={OFFERS_OPTIONS.find((o) => o.value === a.offers)?.label} />
        <Row label="Students" value={a.estimated_enrollment} />
        <Row label="Registration no." value={a.registration_number} />
        <Row label="Founded" value={a.year_founded} />
        <Row label="Contact" value={<>{a.contact_name}{a.contact_role ? ` (${a.contact_role})` : ''}<br /><a className="underline" href={`tel:${a.contact_phone}`}>{a.contact_phone}</a>{a.contact_email ? <><br />{a.contact_email}</> : null}</>} />
        <Row label="Head teacher" value={[a.head_name, a.head_phone].filter(Boolean).join(' · ')} />
        <Row label="Bursar" value={[a.bursar_name, a.bursar_phone].filter(Boolean).join(' · ')} />
        <Row label="Directions" value={a.directions} />
        <Row label="Location" value={map ? <a className="inline-flex items-center gap-1 underline" href={map} target="_blank" rel="noreferrer"><MapPin className="h-3 w-3" />Open map (±{a.gps_accuracy_m ?? '?'} m)</a> : null} />
        <Row label="School's note" value={a.note} />
        <Row label="Assigned agent" value={agent ? <>{agent.name}{agent.phone ? <><br /><a className="underline" href={`tel:${agent.phone}`}>{agent.phone}</a></> : null}</> : null} />
        <Row label="Ops note" value={a.ops_note} />
      </dl>

      {open && mode === 'view' && (
        <div className="flex gap-2">
          <Button className="flex-1 gap-1.5" onClick={() => setMode('assign')}><UserCheck className="h-4 w-4" />{a.assigned_agent_id ? 'Reassign agent' : 'Assign agent'}</Button>
          <Button variant="outline" className="text-destructive" onClick={() => setMode('decline')}>Decline</Button>
        </div>
      )}

      {open && mode === 'assign' && (
        <AgentPicker
          district={a.district}
          busy={busy}
          note={note}
          onNote={setNote}
          onCancel={() => { setMode('view'); setNote(''); }}
          onPick={(agentId) => void act('assign', agentId)}
        />
      )}

      {open && mode === 'decline' && (
        <div className="space-y-2">
          <Input autoFocus placeholder="Reason the school will see (at least 5 characters)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex gap-2">
            <Button variant="ghost" className="flex-1" onClick={() => { setMode('view'); setNote(''); }}>Back</Button>
            <Button variant="destructive" className="flex-1" disabled={busy || note.trim().length < 5} onClick={() => void act('decline', null)}>Decline</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function AgentPicker({ district, busy, note, onNote, onCancel, onPick }: {
  district: string; busy: boolean; note: string; onNote: (v: string) => void; onCancel: () => void; onPick: (agentId: string) => void;
}) {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [chosen, setChosen] = useState<AgentCandidate | null>(null);
  const results = useQuery({
    queryKey: ['welile-school-application-agents', term, district],
    queryFn: () => searchAgentsForApplication(term, district),
    staleTime: 60_000,
  });

  return (
    <div className="space-y-2 rounded-xl border border-border/70 p-2">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }}>
        <Input autoFocus placeholder="Agent name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" variant="outline" size="icon" aria-label="Search agents"><Search className="h-4 w-4" /></Button>
      </form>
      <p className="text-xs text-muted-foreground">{term ? `Agents matching "${term}"` : `Agents who have registered schools in ${district}`}</p>
      {results.isLoading ? (
        <div className="flex justify-center py-3"><Loader2 className="h-4 w-4 animate-spin" /></div>
      ) : results.error ? (
        <p className="text-xs text-destructive">{applicationErrorMessage(results.error)}</p>
      ) : !results.data?.length ? (
        <p className="text-xs text-muted-foreground">{term ? 'No active agent found.' : 'None yet. Search by name or phone.'}</p>
      ) : (
        <div className="max-h-56 space-y-1 overflow-y-auto">
          {results.data.map((c) => (
            <button key={c.id} type="button" onClick={() => setChosen(c)}
              className={cn('flex w-full items-center gap-2 rounded-lg border p-2 text-left text-sm', chosen?.id === c.id ? 'border-primary bg-primary/5' : 'border-border/60')}>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{c.full_name ?? 'Unnamed agent'}</span>
                <span className="block truncate text-xs text-muted-foreground">{c.phone ?? 'No phone'}</span>
              </span>
              {c.schools_in_district > 0 && <Badge variant="secondary">{c.schools_in_district} in {district}</Badge>}
              <Badge variant="outline">{c.schools_total} schools</Badge>
            </button>
          ))}
        </div>
      )}
      <Input placeholder="Note for the agent (optional)" value={note} onChange={(e) => onNote(e.target.value)} />
      <div className="flex gap-2">
        <Button variant="ghost" className="flex-1" onClick={onCancel}>Back</Button>
        <Button className="flex-1 gap-1.5" disabled={busy || !chosen} onClick={() => chosen && onPick(chosen.id)}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {chosen ? `Assign ${chosen.full_name?.split(' ')[0] ?? 'agent'}` : 'Choose an agent'}
        </Button>
      </div>
    </div>
  );
}
