import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { MessageCircle, Mail, History, Loader2, Trash2, Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import { waLink } from '@/lib/whatsapp';
import { format } from 'date-fns';
import { toast } from 'sonner';

export interface CommEntry {
  id: string;
  application_id: string;
  channel: 'whatsapp' | 'email';
  message: string | null;
  logged_by: string | null;
  created_at: string;
}

interface Props {
  applicationId: string;
  whatsappNumber: string;
  email: string | null;
  /** Applicant name, used to personalise the prefilled email. */
  applicantName?: string;
  /** Role the applicant is interested in, used in the email subject/body. */
  roleInterest?: string | null;
  /** Called after the first contact is logged so the parent can bump status. */
  onFirstContact?: () => void;
}

export default function ApplicantCommsLog({ applicationId, whatsappNumber, email, applicantName, roleInterest, onFirstContact }: Props) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<CommEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [count, setCount] = useState<number | null>(null);

  const fetchCount = useCallback(async () => {
    const { count: c } = await (supabase.from('job_application_communications' as any) as any)
      .select('id', { count: 'exact', head: true })
      .eq('application_id', applicationId);
    setCount(c ?? 0);
  }, [applicationId]);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    const { data, error } = await (supabase.from('job_application_communications' as any) as any)
      .select('*')
      .eq('application_id', applicationId)
      .order('created_at', { ascending: false });
    if (error) {
      toast.error('Could not load communication log', { description: error.message });
    } else {
      setEntries((data || []) as CommEntry[]);
      setCount((data || []).length);
    }
    setLoading(false);
  }, [applicationId]);

  useEffect(() => { fetchCount(); }, [fetchCount]);
  useEffect(() => { if (open) fetchEntries(); }, [open, fetchEntries]);

  const logComm = useCallback(async (channel: 'whatsapp' | 'email', message: string | null) => {
    const wasEmpty = (count ?? 0) === 0;
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await (supabase.from('job_application_communications' as any) as any)
      .insert({
        application_id: applicationId,
        channel,
        message: message && message.trim() ? message.trim() : null,
        logged_by: user?.id ?? null,
      })
      .select('*')
      .single();
    if (error) {
      toast.error('Could not record contact', { description: error.message });
      return;
    }
    const entry = data as CommEntry;
    setEntries(prev => [entry, ...prev]);
    setCount(prev => (prev ?? 0) + 1);
    if (wasEmpty) onFirstContact?.();
  }, [applicationId, count, onFirstContact]);

  const contactWhatsApp = () => {
    window.open(waLink(whatsappNumber), '_blank', 'noopener,noreferrer');
    logComm('whatsapp', 'Opened WhatsApp chat');
  };

  const contactEmail = () => {
    if (!email) return;
    const name = (applicantName || '').trim().split(' ')[0] || 'there';
    const role = (roleInterest || '').trim();
    const subject = role
      ? `Your Welile application — ${role}`
      : 'Your Welile job application';
    const body =
      `Hi ${name},\n\n` +
      `Thank you for applying to join the Welile team${role ? ` for the ${role} role` : ''}. ` +
      `We've reviewed your application and would love to talk with you about the next steps.\n\n` +
      `Please reply to this email or let us know a good time to reach you on WhatsApp.\n\n` +
      `Warm regards,\n` +
      `The Welile Hiring Team\n` +
      `info@welile.com`;
    const href =
      `mailto:${email}?cc=info@welile.com` +
      `&subject=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(body)}`;
    window.location.href = href;
    logComm('email', `Opened prefilled hiring email (cc info@welile.com) — subject: ${subject}`);
  };

  const addNote = async (channel: 'whatsapp' | 'email') => {
    if (!note.trim()) return;
    setSaving(true);
    await logComm(channel, note);
    setNote('');
    setSaving(false);
    toast.success('Communication logged');
  };

  const removeEntry = async (id: string) => {
    const { error } = await (supabase.from('job_application_communications' as any) as any)
      .delete().eq('id', id);
    if (error) {
      toast.error('Could not delete entry', { description: error.message });
      return;
    }
    setEntries(prev => prev.filter(e => e.id !== id));
    setCount(prev => Math.max(0, (prev ?? 1) - 1));
  };

  return (
    <div className="pt-1">
      {/* Contact buttons — clicking records the contact automatically */}
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm" variant="outline"
          onClick={contactWhatsApp}
          className="h-8 gap-1.5 border-emerald-500/40 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10"
        >
          <MessageCircle className="h-3.5 w-3.5" /> {whatsappNumber}
        </Button>
        {email && (
          <Button size="sm" variant="outline" onClick={contactEmail} className="h-8 gap-1.5">
            <Mail className="h-3.5 w-3.5" /> Email
          </Button>
        )}
        <Button
          size="sm" variant="ghost"
          onClick={() => setOpen(o => !o)}
          className="h-8 gap-1.5 text-muted-foreground"
        >
          <History className="h-3.5 w-3.5" />
          Log{count ? ` (${count})` : ''}
        </Button>
      </div>

      {open && (
        <div className="mt-2 rounded-lg border border-border bg-muted/30 p-2 space-y-2">
          {/* Manual note entry */}
          <Textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Log what you discussed (message, call notes, outcome)…"
            className="min-h-[52px] text-xs bg-card"
          />
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm" variant="outline"
              disabled={!note.trim() || saving}
              onClick={() => addNote('whatsapp')}
              className="h-7 gap-1.5 text-[11px] border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              Log WhatsApp note
            </Button>
            <Button
              size="sm" variant="outline"
              disabled={!note.trim() || saving}
              onClick={() => addNote('email')}
              className="h-7 gap-1.5 text-[11px]"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              Log email note
            </Button>
          </div>

          {/* History */}
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading history…
            </div>
          ) : entries.length === 0 ? (
            <p className="text-[11px] text-muted-foreground py-1">No contact recorded yet.</p>
          ) : (
            <ul className="space-y-1.5 max-h-56 overflow-y-auto">
              {entries.map(e => (
                <li key={e.id} className="rounded-md bg-card border border-border/60 p-2 text-[11px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className={cn(
                      'inline-flex items-center gap-1 font-medium',
                      e.channel === 'whatsapp' ? 'text-emerald-600 dark:text-emerald-400' : 'text-primary'
                    )}>
                      {e.channel === 'whatsapp'
                        ? <MessageCircle className="h-3 w-3" />
                        : <Mail className="h-3 w-3" />}
                      {e.channel === 'whatsapp' ? 'WhatsApp' : 'Email'}
                    </span>
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      {format(new Date(e.created_at), 'dd MMM, HH:mm')}
                      <button
                        onClick={() => removeEntry(e.id)}
                        className="p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                        aria-label="Delete log entry"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </span>
                  </div>
                  {e.message && <p className="mt-1 text-foreground/80 leading-snug whitespace-pre-wrap">{e.message}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
