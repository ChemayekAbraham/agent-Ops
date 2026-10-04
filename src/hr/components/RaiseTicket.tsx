import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/hr/api/client';
import TicketEvidence from '@/hr/components/TicketEvidence';

interface Surface {
  id: string;
  key: string;
  label: string;
}

type Severity = 'critical' | 'high' | 'normal';
type Origin = 'internal' | 'external';
type Channel = 'phone' | 'whatsapp' | 'email' | 'in_person' | 'in_app';

const SEVERITY_OPTIONS: { value: Severity; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'normal', label: 'Normal' },
];

const CHANNEL_OPTIONS: { value: Channel; label: string }[] = [
  { value: 'phone', label: 'Phone' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'email', label: 'Email' },
  { value: 'in_person', label: 'In person' },
  { value: 'in_app', label: 'In the app' },
];

const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring';

interface RaiseTicketProps {
  staffId: string | null;
}

export default function RaiseTicket({ staffId }: RaiseTicketProps) {
  const [surfaces, setSurfaces] = useState<Surface[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [surfaceId, setSurfaceId] = useState('');
  const [severity, setSeverity] = useState<Severity>('normal');
  const [severityBasis, setSeverityBasis] = useState('');
  const [origin, setOrigin] = useState<Origin>('internal');
  const [reporterName, setReporterName] = useState('');
  const [reporterContact, setReporterContact] = useState('');
  const [reporterChannel, setReporterChannel] = useState<Channel>('phone');
  const [reportedAt, setReportedAt] = useState('');
  const [reporterWords, setReporterWords] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState('');
  const [failure, setFailure] = useState('');

  useEffect(() => {
    if (!staffId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('hr_ticket_surfaces')
        .select('id, key, label')
        .eq('active', true)
        .order('sort_order', { ascending: true });
      if (!cancelled) setSurfaces((data ?? []) as unknown as Surface[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [staffId]);

  if (!staffId) return null;

  const validate = () => {
    const next: Record<string, string> = {};
    if (title.trim().length < 10) next.title = 'Please write at least 10 characters.';
    if (body.trim().length < 20) next.body = 'Please write at least 20 characters.';
    if (!surfaceId) next.surfaceId = 'Please choose an area.';
    if (severity === 'critical' && severityBasis.trim().length < 10) {
      next.severityBasis = 'Please write at least 10 characters.';
    }
    if (origin === 'external') {
      if (!reporterName.trim()) next.reporterName = 'Please give a name.';
      if (!reporterContact.trim()) next.reporterContact = 'Please give a way to reach them.';
      if (!reporterChannel) next.reporterChannel = 'Please choose how they reached you.';
      if (!reportedAt) next.reportedAt = 'Please give the date and time.';
      if (reporterWords.trim().length < 20) {
        next.reporterWords = 'Please write at least 20 characters.';
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async () => {
    setSuccess('');
    setFailure('');
    if (!validate()) return;
    setSubmitting(true);
    const external = origin === 'external';
    const payload = {
      title: title.trim(),
      body: body.trim(),
      severity,
      surface_id: surfaceId,
      origin,
      raised_by: staffId,
      severity_basis: severity === 'critical' ? severityBasis.trim() : null,
      reporter_name: external ? reporterName.trim() : null,
      reporter_contact: external ? reporterContact.trim() : null,
      reporter_channel: external ? reporterChannel : null,
      reported_at: external ? new Date(reportedAt).toISOString() : null,
      reporter_words: external ? reporterWords.trim() : null,
    };
    const { data, error } = await supabase
      .from('hr_tickets')
      .insert(payload as never)
      .select('id, ref')
      .single();
    if (error) {
      setSubmitting(false);
      setFailure(error.message);
      return;
    }

    const created = data as { id?: string; ref?: string } | null;
    const ticketId = created?.id;
    const uploadProblems: string[] = [];

    if (ticketId && files.length > 0) {
      const deleteAfter = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

      for (const file of files) {
        const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
        const path = `tickets/${ticketId}/${crypto.randomUUID()}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from('task-evidence')
          .upload(path, file, { upsert: false, contentType: file.type });
        if (uploadError) {
          console.error(`${file.name} upload failed:`, uploadError);
          uploadProblems.push(`${file.name} could not be attached: ${uploadError.message}`);
          continue;
        }
        const { error: rowError } = await supabase.from('hr_task_attachments').insert({
          ticket_id: ticketId,
          kind: 'evidence',
          storage_path: path,
          mime_type: file.type,
          size_bytes: file.size,
          file_name: file.name,
          delete_after: deleteAfter,
        } as never);
        if (rowError) {
          console.error(`${file.name} attachment row failed:`, rowError);
          uploadProblems.push(`${file.name} could not be attached: ${rowError.message}`);
          try {
            const { error: removeError } = await supabase.storage
              .from('task-evidence')
              .remove([path]);
            if (removeError) {
              uploadProblems.push(`${file.name} could not be cleaned up.`);
            }
          } catch {
            uploadProblems.push(`${file.name} could not be cleaned up.`);
          }
        }
      }
    }

    setSubmitting(false);
    setTitle('');
    setBody('');
    setSurfaceId('');
    setSeverity('normal');
    setSeverityBasis('');
    setOrigin('internal');
    setReporterName('');
    setReporterContact('');
    setReporterChannel('phone');
    setReportedAt('');
    setReporterWords('');
    setFiles([]);
    setErrors({});
    setSuccess(`Ticket ${created?.ref ?? ''} was raised.`);
    if (uploadProblems.length > 0) setFailure(uploadProblems.join(' '));
  };

  const fieldError = (key: string) =>
    errors[key] ? <p className="mt-1 text-xs text-destructive">{errors[key]}</p> : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Raise a ticket</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label htmlFor="ticket-title">Title</Label>
            <Input
              id="ticket-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short summary"
            />
            {fieldError('title')}
          </div>

          <div>
            <Label htmlFor="ticket-body">What happened</Label>
            <Textarea
              id="ticket-body"
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Describe what you saw"
            />
            {fieldError('body')}
          </div>

          <div>
            <Label htmlFor="ticket-area">Area</Label>
            <select
              id="ticket-area"
              className={selectClass}
              value={surfaceId}
              onChange={(e) => setSurfaceId(e.target.value)}
            >
              <option value="">Choose an area</option>
              {surfaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            {fieldError('surfaceId')}
          </div>

          <div>
            <Label htmlFor="ticket-severity">How bad is it</Label>
            <select
              id="ticket-severity"
              className={selectClass}
              value={severity}
              onChange={(e) => setSeverity(e.target.value as Severity)}
            >
              {SEVERITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {severity === 'critical' && (
            <div>
              <Label htmlFor="ticket-basis">Why is this critical</Label>
              <Input
                id="ticket-basis"
                value={severityBasis}
                onChange={(e) => setSeverityBasis(e.target.value)}
              />
              {fieldError('severityBasis')}
            </div>
          )}

          <div>
            <Label htmlFor="ticket-origin">Did someone report this to you</Label>
            <select
              id="ticket-origin"
              className={selectClass}
              value={origin}
              onChange={(e) => setOrigin(e.target.value as Origin)}
            >
              <option value="internal">No, I found it myself</option>
              <option value="external">Yes, someone reported it</option>
            </select>
          </div>

          {origin === 'external' && (
            <div className="space-y-3 rounded-md border border-border p-3">
              <div>
                <Label htmlFor="ticket-reporter-name">Who reported it</Label>
                <Input
                  id="ticket-reporter-name"
                  value={reporterName}
                  onChange={(e) => setReporterName(e.target.value)}
                />
                {fieldError('reporterName')}
              </div>
              <div>
                <Label htmlFor="ticket-reporter-contact">How to reach them</Label>
                <Input
                  id="ticket-reporter-contact"
                  value={reporterContact}
                  onChange={(e) => setReporterContact(e.target.value)}
                />
                {fieldError('reporterContact')}
              </div>
              <div>
                <Label htmlFor="ticket-reporter-channel">How did they reach you</Label>
                <select
                  id="ticket-reporter-channel"
                  className={selectClass}
                  value={reporterChannel}
                  onChange={(e) => setReporterChannel(e.target.value as Channel)}
                >
                  {CHANNEL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {fieldError('reporterChannel')}
              </div>
              <div>
                <Label htmlFor="ticket-reported-at">When did they report it</Label>
                <Input
                  id="ticket-reported-at"
                  type="datetime-local"
                  value={reportedAt}
                  onChange={(e) => setReportedAt(e.target.value)}
                />
                {fieldError('reportedAt')}
              </div>
              <div>
                <Label htmlFor="ticket-reporter-words">What did they say</Label>
                <Textarea
                  id="ticket-reporter-words"
                  rows={3}
                  value={reporterWords}
                  onChange={(e) => setReporterWords(e.target.value)}
                />
                {fieldError('reporterWords')}
              </div>
            </div>
          )}

          {success && <p className="text-sm text-emerald-600">{success}</p>}
          {failure && <p className="text-sm text-destructive">{failure}</p>}

          <TicketEvidence files={files} onChange={setFiles} disabled={submitting} />

          <Button onClick={submit} disabled={submitting}>
            Raise ticket
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
