/**
 * One application, read in full, with the two things HR needs to do to it:
 * open the CV, and record a decision with a reason.
 *
 * `expected_salary` is not shown because it is not read — see the note in
 * src/hr/api/applications.ts. Nothing here scores or ranks anybody.
 */
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  APPLICATION_DECISIONS,
  markApplicationContacted,
  recordApplicationDecision,
  type ApplicationDecision,
  type JobApplicationRow,
} from '@/hr/api/applications';
import { getResumeUrl } from '@/hr/api/resumeAccess';

/** Display helper, shared with the list. An em dash beats an empty cell. */
export function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

const DECISION_LABELS: Record<ApplicationDecision, string> = {
  shortlisted: 'Shortlist',
  hold: 'Hold',
  rejected: 'Decline',
};

/** Detects section headers like "WHAT THEY HAVE BUILT OR RUN". */
function isSectionHeader(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 4) return false;
  // All caps (allow spaces); ignore trailing punctuation.
  const letters = trimmed.replace(/[^a-zA-Z]/g, '');
  return letters.length > 0 && letters === letters.toUpperCase();
}

function parseCoverNoteSections(text: string | null): { title: string; body: string }[] {
  if (!text || !text.trim()) return [];
  const lines = text.split('\n');
  const sections: { title: string; body: string }[] = [];
  let current: { title: string; bodyLines: string[] } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r/g, '');
    if (isSectionHeader(line)) {
      if (current) {
        sections.push({ title: current.title, body: current.bodyLines.join('\n').trim() });
      }
      current = { title: line.trim(), bodyLines: [] };
    } else if (current) {
      current.bodyLines.push(line);
    } else {
      // Leading free text before the first header becomes its own untitled section.
      current = { title: '', bodyLines: [line] };
    }
  }

  if (current) {
    sections.push({ title: current.title, body: current.bodyLines.join('\n').trim() });
  }

  return sections;
}

export function CoverNoteSections({ text }: { text: string | null }) {
  const sections = parseCoverNoteSections(text);
  if (sections.length === 0) return <p className="text-sm text-muted-foreground">—</p>;

  return (
    <div className="space-y-6">
      {sections.map((section, index) => (
        <div key={index}>
          {section.title && (
            <p className="mb-1 text-sm font-bold">{section.title}</p>
          )}
          {section.body && (
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{section.body}</p>
          )}
        </div>
      ))}
    </div>
  );
}


function DetailRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="grid grid-cols-3 gap-3 border-b py-2 last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="col-span-2 break-words text-sm">{value || '—'}</span>
    </div>
  );
}

export function ApplicationDetailSheet({
  application,
  onClose,
  onChanged,
}: {
  application: JobApplicationRow | null;
  onClose: () => void;
  onChanged: (row: JobApplicationRow) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setReason('');
    setMessage(null);
    setError(null);
  }

  async function openCv() {
    if (!application) return;
    setError(null);
    try {
      const url = await getResumeUrl(application.resume_url ?? '');
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open that CV.');
    }
  }

  async function decide(decision: ApplicationDecision) {
    if (!application) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const row = await recordApplicationDecision(application.id, decision, reason);
      onChanged(row);
      setReason('');
      setMessage(`Recorded as ${decision}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record that decision.');
    } finally {
      setBusy(false);
    }
  }

  async function contacted() {
    if (!application) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const row = await markApplicationContacted(application.id);
      onChanged(row);
      setMessage('Marked as contacted.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not mark that as contacted.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={!!application}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          onClose();
        }
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{application?.full_name ?? ''}</SheetTitle>
        </SheetHeader>

        {application && (
          <div className="mt-4 space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>{application.status}</Badge>
              <Badge variant="outline">{application.category}</Badge>
              {application.contacted_at && (
                <Badge variant="secondary">
                  Contacted {formatDate(application.contacted_at)}
                </Badge>
              )}
            </div>

            <div>
              <DetailRow label="Applied" value={formatDate(application.created_at)} />
              <DetailRow label="Role interest" value={application.role_interest} />
              <DetailRow label="Phone / WhatsApp" value={application.whatsapp_number} />
              <DetailRow label="Email" value={application.email} />
              <DetailRow label="Location" value={application.location} />
              <DetailRow label="Employment type" value={application.employment_type} />
              <DetailRow label="Experience" value={application.experience_level} />
              <DetailRow label="Current employer" value={application.current_employer} />
              <DetailRow label="Education" value={application.highest_education} />
              <DetailRow
                label="Available from"
                value={formatDate(application.availability_date)}
              />
              <DetailRow label="LinkedIn" value={application.linkedin_url} />
              <DetailRow label="Portfolio" value={application.portfolio_url} />
              <DetailRow label="Came from" value={application.source} />
              <DetailRow label="Campaign" value={application.utm_campaign} />
            </div>

            <div>
              <h4 className="mb-2 text-sm font-medium">In their words</h4>
              <CoverNoteSections text={application.cover_note} />
            </div>


            <div className="space-y-2">
              <h4 className="text-sm font-medium">CV</h4>
              {application.resume_url ? (
                <div className="flex items-center gap-3">
                  <Button variant="outline" onClick={openCv}>
                    Open CV
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    {application.resume_filename || 'attached'}
                  </span>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No CV was attached.</p>
              )}
            </div>

            <div className="space-y-3 border-t pt-4">
              <h4 className="text-sm font-medium">Record a decision</h4>
              {application.decided_at && (
                <p className="text-sm text-muted-foreground">
                  Decided {formatDate(application.decided_at)} —{' '}
                  {application.decision_reason || 'no reason recorded'}
                </p>
              )}
              <Input
                placeholder="Reason — one line, kept with the decision"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                {APPLICATION_DECISIONS.map((decision) => (
                  <Button
                    key={decision}
                    variant="outline"
                    disabled={busy}
                    onClick={() => decide(decision)}
                  >
                    {DECISION_LABELS[decision]}
                  </Button>
                ))}
                <Button variant="secondary" disabled={busy} onClick={contacted}>
                  Mark contacted
                </Button>
              </div>
              {message && <p className="text-sm">{message}</p>}
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
