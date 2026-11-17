import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Building2, ClipboardCheck, Loader2, MapPin, MessageCircle, Phone } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { mapLink, toIntlDigits, writeLockedSchool } from '@/lib/welileSchools';
import { OFFERS_OPTIONS, applicationErrorMessage, fetchAgentApplications, startInspection, type ApplicationRow } from '@/lib/welileSchoolsApplications';

/**
 * Schools Agent Ops sent this agent to inspect. "Start inspection" creates the school record from the
 * owner's application and opens the partnership set-up for it (terms, fees, payout, agreement).
 */
export default function AgentSchoolInspections({ agentId }: { agentId: string }) {
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery({
    queryKey: ['welile-agent-school-applications', agentId],
    queryFn: () => fetchAgentApplications(agentId),
    staleTime: 30_000,
    retry: 1,
  });
  const [busy, setBusy] = useState<string | null>(null);

  // Not switched on yet (migration not applied) or nothing assigned: stay out of the way.
  if (error || (!isLoading && !data?.length)) return null;

  const rows = data ?? [];

  const start = async (a: ApplicationRow) => {
    setBusy(a.id);
    try {
      const school = await startInspection(a.id);
      writeLockedSchool(school);
      navigate('/agent/welile-schools?mode=partner');
    } catch (e) {
      toast.error('Could not start the inspection', { description: applicationErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="ws-school-inspections">
      <h2 id="ws-school-inspections" className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Schools to inspect{rows.length ? ` (${rows.length})` : ''}
      </h2>
      {isLoading ? (
        <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
      ) : (
        <div className="divide-y divide-border/60 overflow-hidden rounded-3xl border border-border/70 bg-card">
          {rows.map((a) => {
            const intl = toIntlDigits(a.contact_phone);
            const map = mapLink(a.latitude, a.longitude);
            const offers = OFFERS_OPTIONS.find((o) => o.value === a.offers)?.label;
            const started = a.status === 'inspecting';
            return (
              <article key={a.id} aria-label={a.school_name} className="space-y-2.5 p-3">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><Building2 className="h-4 w-4" aria-hidden /></span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{a.school_name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[a.school_level, offers, a.estimated_enrollment ? `${a.estimated_enrollment} students` : null].filter(Boolean).join(' · ')}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{[a.village, a.town, a.district].filter(Boolean).join(', ')}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      Contact: {a.contact_name}{a.contact_role ? ` (${a.contact_role})` : ''} · {a.contact_phone}
                    </p>
                  </div>
                  <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                    started ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300' : 'bg-primary text-primary-foreground')}>
                    {started ? 'In progress' : 'Visit needed'}
                  </span>
                </div>
                {a.directions && <p className="rounded-xl bg-muted/60 px-3 py-2 text-xs"><span className="font-semibold">Directions: </span>{a.directions}</p>}
                {a.ops_note && <p className="rounded-xl bg-muted/60 px-3 py-2 text-xs"><span className="font-semibold">From Agent Ops: </span>{a.ops_note}</p>}
                {a.note && <p className="text-xs text-muted-foreground">School's note: {a.note}</p>}
                <div className={cn('grid gap-2', map ? 'grid-cols-3' : 'grid-cols-2')}>
                  <Button asChild variant="outline" className="min-h-[44px] gap-1.5 rounded-xl">
                    <a href={`tel:${a.contact_phone}`}><Phone className="h-4 w-4" />Call</a>
                  </Button>
                  <Button asChild variant="outline" className="min-h-[44px] gap-1.5 rounded-xl">
                    <a href={`https://wa.me/${intl}`} target="_blank" rel="noreferrer"><MessageCircle className="h-4 w-4" />WhatsApp</a>
                  </Button>
                  {map && (
                    <Button asChild variant="outline" className="min-h-[44px] gap-1.5 rounded-xl">
                      <a href={map} target="_blank" rel="noreferrer"><MapPin className="h-4 w-4" />Map</a>
                    </Button>
                  )}
                </div>
                <Button className="min-h-[48px] w-full gap-2 rounded-xl" disabled={busy === a.id} onClick={() => void start(a)}>
                  {busy === a.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardCheck className="h-4 w-4" />}
                  {started ? 'Continue the partnership set-up' : "I'm at the school: start inspection"}
                </Button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
