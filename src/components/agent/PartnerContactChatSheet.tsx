import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, isToday, isYesterday } from 'date-fns';
import { toast } from 'sonner';
import { Loader2, Phone, MessageCircle, Send, StickyNote, PhoneCall } from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { hapticTap } from '@/lib/haptics';
import { formatDynamic } from '@/lib/currencyFormat';
import { useProxyNoteList } from '@/hooks/useProxyAgentCommandCenter';

export interface PartnerContact {
  partnerUserId?: string | null;
  name: string;
  phone?: string | null;
  subtitle?: string | null;
}

interface ContactLogRow {
  id: string;
  channel: 'whatsapp' | 'call' | 'note';
  body: string;
  created_at: string;
}

/** Normalise a Ugandan number to bare E.164 digits for wa.me / tel links. */
export function toIntlDigits(raw?: string | null): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (!digits) return '';
  const national = digits.startsWith('0') ? digits.slice(1) : digits;
  return national.startsWith('256') ? national : `256${national}`;
}

export function hasDialablePhone(raw?: string | null): boolean {
  return toIntlDigits(raw).length >= 11;
}

export function initialsOf(name: string): string {
  return (name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (isToday(d)) return 'Today';
  if (isYesterday(d)) return 'Yesterday';
  return format(d, 'dd MMM yyyy');
}

const channelMeta: Record<ContactLogRow['channel'], { label: string; icon: typeof StickyNote }> = {
  whatsapp: { label: 'WhatsApp sent', icon: MessageCircle },
  call: { label: 'Called', icon: PhoneCall },
  note: { label: 'Note', icon: StickyNote },
};

export function useLogPartnerContact(agentId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      contact: PartnerContact;
      channel: ContactLogRow['channel'];
      body: string;
      noteId?: string | null;
    }) => {
      if (!agentId) throw new Error('Not signed in');
      const { error } = await supabase.from('proxy_partner_contact_logs').insert({
        agent_id: agentId,
        partner_user_id: input.contact.partnerUserId ?? null,
        partner_name: input.contact.name,
        partner_phone: input.contact.phone ?? null,
        note_id: input.noteId ?? null,
        channel: input.channel,
        body: input.body.trim(),
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['proxy-contact-logs'] });
    },
  });
}

export function PartnerContactChatSheet({
  open,
  onOpenChange,
  contact,
  agentId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contact: PartnerContact | null;
  agentId?: string | null;
}) {
  const [draft, setDraft] = useState('');
  const phone = contact?.phone ?? '';
  const dialable = hasDialablePhone(phone);
  const intl = toIntlDigits(phone);

  const logsQ = useQuery({
    queryKey: ['proxy-contact-logs', agentId ?? 'self', contact?.partnerUserId ?? phone],
    enabled: !!agentId && !!contact && open,
    queryFn: async (): Promise<ContactLogRow[]> => {
      let q = supabase
        .from('proxy_partner_contact_logs')
        .select('id, channel, body, created_at')
        .eq('agent_id', agentId!)
        .order('created_at', { ascending: true })
        .limit(200);
      q = contact!.partnerUserId
        ? q.eq('partner_user_id', contact!.partnerUserId)
        : q.eq('partner_phone', phone);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as ContactLogRow[];
    },
  });

  const notesQ = useProxyNoteList({
    agentId: open && contact ? agentId : null,
    search: phone || contact?.name || '',
    status: 'all',
    sort: 'created_at',
    dir: 'asc',
    page: 0,
    pageSize: 20,
  });

  const logMutation = useLogPartnerContact(agentId);

  const timeline = useMemo(() => {
    const items: Array<{
      key: string;
      at: string;
      kind: 'log' | 'note';
      channel?: ContactLogRow['channel'];
      body: string;
      meta?: string;
    }> = [];
    for (const l of logsQ.data ?? []) {
      items.push({ key: `l-${l.id}`, at: l.created_at, kind: 'log', channel: l.channel, body: l.body });
    }
    for (const n of notesQ.data?.rows ?? []) {
      items.push({
        key: `n-${n.id}`,
        at: n.created_at,
        kind: 'note',
        body: `Promissory note ${formatDynamic(Number(n.amount ?? 0))}`,
        meta: `${n.status === 'activated' ? 'Activated' : 'Pending'} · collected ${formatDynamic(Number(n.total_collected ?? 0))}`,
      });
    }
    return items.sort((a, b) => +new Date(a.at) - +new Date(b.at));
  }, [logsQ.data, notesQ.data]);

  const saveNote = useCallback(
    async (channel: ContactLogRow['channel'], body: string) => {
      if (!contact) return;
      try {
        await logMutation.mutateAsync({ contact, channel, body });
        setDraft('');
      } catch (e) {
        toast.error((e as Error).message);
      }
    },
    [contact, logMutation],
  );

  const openWhatsApp = () => {
    if (!contact || !dialable) return;
    hapticTap();
    const text = encodeURIComponent(
      `Hello ${contact.name.split(' ')[0]}, this is your Welile partner agent. I wanted to follow up on your support commitment.`,
    );
    window.open(`https://wa.me/${intl}?text=${text}`, '_blank', 'noopener,noreferrer');
    void saveNote('whatsapp', 'Opened WhatsApp to follow up on the commitment.');
  };

  const openCall = () => {
    if (!contact || !dialable) return;
    hapticTap();
    window.location.href = `tel:+${intl}`;
    void saveNote('call', 'Called the partner.');
  };

  let lastDay = '';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[92vh] p-0 flex flex-col gap-0">
        <SheetHeader className="px-4 py-3 border-b bg-muted/30 text-left">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 shrink-0 rounded-full bg-primary/15 text-primary grid place-items-center text-sm font-black">
              {initialsOf(contact?.name ?? '')}
            </div>
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-sm font-black truncate">{contact?.name ?? 'Partner'}</SheetTitle>
              <SheetDescription className="text-[11px] truncate">
                {phone || 'No phone on file'}
                {contact?.subtitle ? ` · ${contact.subtitle}` : ''}
              </SheetDescription>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Button
                size="icon"
                variant="outline"
                className="h-9 w-9"
                disabled={!dialable}
                onClick={openCall}
                aria-label="Call partner"
              >
                <Phone className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                className="h-9 w-9 bg-[hsl(142,70%,45%)] hover:bg-[hsl(142,70%,40%)] text-white"
                disabled={!dialable}
                onClick={openWhatsApp}
                aria-label="Send WhatsApp"
              >
                <MessageCircle className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2 bg-muted/20">
          {logsQ.isLoading || notesQ.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-2xl" />)}
            </div>
          ) : timeline.length === 0 ? (
            <div className="py-10 text-center text-xs text-muted-foreground">
              No history yet. Call or send a WhatsApp, then keep a note here.
            </div>
          ) : (
            timeline.map((item) => {
              const day = dayLabel(item.at);
              const showDay = day !== lastDay;
              lastDay = day;
              const Icon = item.kind === 'log' ? channelMeta[item.channel!].icon : StickyNote;
              const mine = item.kind === 'log';
              return (
                <div key={item.key} className="space-y-2">
                  {showDay && (
                    <div className="flex justify-center">
                      <span className="rounded-full bg-background border px-2.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                        {day}
                      </span>
                    </div>
                  )}
                  <div className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
                    <div
                      className={cn(
                        'max-w-[85%] rounded-2xl px-3 py-2 shadow-sm',
                        mine
                          ? 'bg-[hsl(142,70%,45%)]/15 border border-[hsl(142,70%,45%)]/30 rounded-br-sm'
                          : 'bg-card border rounded-bl-sm',
                      )}
                    >
                      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                        <Icon className="h-3 w-3" />
                        {item.kind === 'log' ? channelMeta[item.channel!].label : 'Commitment'}
                      </div>
                      <p className="mt-0.5 text-xs leading-snug whitespace-pre-wrap break-words">{item.body}</p>
                      {item.meta && <p className="mt-0.5 text-[10px] text-muted-foreground">{item.meta}</p>}
                      <p className="mt-1 text-[10px] text-muted-foreground text-right">
                        {format(new Date(item.at), 'HH:mm')}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="border-t bg-background px-3 py-2.5">
          <div className="flex items-end gap-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Write a note about this partner"
              rows={1}
              className="min-h-[42px] max-h-28 resize-none text-sm"
            />
            <Button
              size="icon"
              className="h-[42px] w-[42px] shrink-0"
              disabled={!draft.trim() || logMutation.isPending}
              onClick={() => void saveNote('note', draft)}
              aria-label="Save note"
            >
              {logMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Notes are private to you and kept as this partner's history.
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
