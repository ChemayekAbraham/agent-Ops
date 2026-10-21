import { useEffect, useRef, useState } from 'react';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { ArrowLeft, Facebook, Globe, Instagram, Loader2, Mail, MessageSquare, RefreshCw, Search, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useBackGestureClose } from '@/hooks/useBackGestureClose';
import { useIsMobile } from '@/hooks/use-mobile';
import { useNeexaInbox, canSendNeexaReply, whatsappWindowClosed, NEEXA_MESSAGE_LIMIT, type NeexaPlatform } from '@/hooks/useNeexaInbox';
import { NeexaTemplateDialog } from './NeexaTemplateDialog';

// Staff replies are hidden for now. Flip to true to bring back the "Write a reply…" box and Send button.
const REPLY_COMPOSER_ENABLED = false;

const platforms: { value: NeexaPlatform; label: string; icon: typeof MessageSquare }[] = [
  { value: 'whatsapp', label: 'WhatsApp', icon: MessageSquare }, { value: 'email', label: 'Email', icon: Mail },
  { value: 'facebook', label: 'Facebook', icon: Facebook }, { value: 'instagram', label: 'Instagram', icon: Instagram },
  { value: 'widget', label: 'Website chat', icon: Globe }, { value: 'website', label: 'Website', icon: Globe },
  { value: 'portal', label: 'Portal', icon: Globe },
];
function PlatformBadge({ platform }: { platform: NeexaPlatform }) {
  const item = platforms.find(row => row.value === platform);
  const Icon = item?.icon || MessageSquare;
  return <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><Icon className="h-3.5 w-3.5" />{item?.label || platform}</span>;
}
function relativeTime(time: string | null) {
  return time && Number.isFinite(Date.parse(time)) ? formatDistanceToNowStrict(new Date(time), { addSuffix: true }) : '';
}
function messageTime(time: string | null) {
  return time && Number.isFinite(Date.parse(time)) ? format(new Date(time), 'dd MMM, HH:mm') : '';
}
export default function NeexaInbox() {
  const inbox = useNeexaInbox();
  const mobile = useIsMobile();
  const [search, setSearch] = useState('');
  const [platform, setPlatform] = useState('all');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templatePhone, setTemplatePhone] = useState('');
  const [now, setNow] = useState(Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const previousThread = useRef<string | null>(null);
  const nearBottom = useRef(true);
  const earlierAnchor = useRef<{ height: number; top: number } | null>(null);
  useBackGestureClose(mobile && !!inbox.selectedId, () => inbox.openConversation(null));
  // Local clock only, not network polling: close a WhatsApp reply window while it is open.
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    const viewport = scrollRef.current;
    if (earlierAnchor.current && viewport) {
      viewport.scrollTop = earlierAnchor.current.top + viewport.scrollHeight - earlierAnchor.current.height;
      earlierAnchor.current = null;
    } else if (previousThread.current !== inbox.selectedId || nearBottom.current) bottomRef.current?.scrollIntoView({ block: 'end' });
    previousThread.current = inbox.selectedId;
  }, [inbox.messages, inbox.selectedId]);
  const query = search.trim().toLowerCase();
  const filtered = inbox.conversations.filter(row => (platform === 'all' || row.platform === platform) &&
    [row.title, row.customer_address, row.last_message_preview].some(value => value?.toLowerCase().includes(query)));
  const selected = inbox.selected;
  const draft = inbox.selectedId ? drafts[inbox.selectedId] || '' : '';
  const closed = selected ? whatsappWindowClosed(selected, now) : false;
  const canSend = selected && canSendNeexaReply(draft, selected, now) && !inbox.sending;
  const send = async () => {
    const id = inbox.selectedId;
    const text = draft;
    if (!id || !canSend) return;
    if (await inbox.sendMessage(text)) setDrafts(old => old[id] === text ? { ...old, [id]: '' } : old);
  };
  const openTemplate = (phone = '') => { setTemplatePhone(phone); setTemplateOpen(true); };
  const loadEarlier = async () => {
    const viewport = scrollRef.current;
    if (viewport) earlierAnchor.current = { height: viewport.scrollHeight, top: viewport.scrollTop };
    await inbox.loadEarlier();
    earlierAnchor.current = null;
  };
  return <section className="min-w-0 space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="flex items-center gap-2 text-xl font-semibold"><MessageSquare className="h-5 w-5 text-primary" /> Inbox</h1>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={inbox.syncing} onClick={() => void inbox.syncConversations()}><RefreshCw className={cn(inbox.syncing && 'animate-spin')} />{inbox.syncing ? 'Syncing…' : 'Sync from Neexa'}</Button>
        <Button size="sm" onClick={() => openTemplate()}><MessageSquare />New WhatsApp message</Button>
      </div>
    </header>
    {inbox.syncResult && <p role="status" className="text-xs text-muted-foreground">{inbox.syncResult}</p>}
    {inbox.pendingConversation && <p role="status" className="text-sm text-muted-foreground">Template sent. Waiting for the conversation to appear…</p>}
    {!selected && inbox.actionError && <p role="alert" className="text-sm text-destructive">{inbox.actionError}</p>}
    <div className="grid h-[calc(100dvh-15rem)] min-h-[420px] min-w-0 overflow-hidden rounded-lg border border-border bg-background md:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]">
      <aside aria-label="Conversations" className={cn('flex min-h-0 min-w-0 flex-col md:border-r md:border-border', inbox.selectedId && 'hidden md:flex')}>
        <div className="space-y-2 border-b border-border p-3">
          <div className="relative"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input aria-label="Search conversations" placeholder="Search conversations" className="h-10 pl-9" value={search} onChange={event => setSearch(event.target.value)} /></div>
          <Select value={platform} onValueChange={setPlatform}><SelectTrigger aria-label="Filter by platform" className="h-10"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All platforms</SelectItem>{platforms.map(row => <SelectItem key={row.value} value={row.value}>{row.label}</SelectItem>)}</SelectContent></Select>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {inbox.loading ? <div role="status" className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading conversations…</div> : inbox.listError ? <div className="space-y-3 p-4"><p role="alert" className="text-sm text-destructive">{inbox.listError}</p><Button variant="outline" size="sm" disabled={inbox.syncing} onClick={() => void inbox.syncConversations()}>Retry</Button></div> : !filtered.length ? <div className="flex flex-col items-center gap-3 p-8 text-center"><MessageSquare className="h-8 w-8 text-muted-foreground" /><p className="text-sm">{inbox.conversations.length ? 'No matching conversations' : 'No conversations yet'}</p>{!inbox.conversations.length && <Button variant="outline" size="sm" disabled={inbox.syncing} onClick={() => void inbox.syncConversations()}><RefreshCw />Sync</Button>}</div> : filtered.map(row =>
            <Button key={row.id} variant="ghost" aria-pressed={row.id === inbox.selectedId} onClick={() => inbox.openConversation(row.id)}
              className={cn('h-auto min-h-[112px] w-full justify-start rounded-none border-b border-border px-4 py-3 text-left font-normal whitespace-normal', row.id === inbox.selectedId && 'bg-primary/10')}>
              <span className="block w-full min-w-0 space-y-1.5">
                <span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm font-semibold">{row.title || row.customer_address || 'Customer'}</span>
                  <span title={row.sentiment || 'Unknown sentiment'} aria-label={`Sentiment: ${row.sentiment || 'unknown'}`} className={cn('h-1.5 w-1.5 shrink-0 rounded-full', row.sentiment === 'positive' ? 'bg-success' : row.sentiment === 'negative' ? 'bg-destructive' : 'bg-muted-foreground/40')} />
                </span>
                <span className="flex flex-wrap items-center gap-2"><PlatformBadge platform={row.platform} />{row.label && <Badge size="sm" variant={row.label === 'escalated-to-human' ? 'warning' : 'muted'} className="max-w-full truncate tracking-normal">{row.label.replace(/[_-]/g, ' ')}</Badge>}</span>
                <span className="block truncate text-xs text-muted-foreground">{row.last_message_preview || '—'}</span>
                <span className="block text-[11px] text-muted-foreground">{relativeTime(row.last_message_at)}</span>
              </span>
            </Button>)}
        </div>
      </aside>
      <div className={cn('min-h-0 min-w-0 flex-col', inbox.selectedId ? 'fixed inset-0 z-[130] flex bg-background md:static md:z-auto' : 'hidden md:flex')}>
        {selected ? <>
          <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <Button variant="ghost" size="icon" aria-label="Back to conversations" className="md:hidden" onClick={() => inbox.openConversation(null)}><ArrowLeft /></Button>
            <div className="min-w-0 flex-1"><h2 className="truncate text-base font-semibold">{selected.title || selected.customer_address || 'Customer'}</h2><p className="truncate text-xs text-muted-foreground">{selected.customer_address || '—'}</p><PlatformBadge platform={selected.platform} /></div>
          </header>
          <div ref={scrollRef} onScroll={() => { const node = scrollRef.current; if (node) nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }} className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-muted/20 p-4" aria-label="Message history">
            {(inbox.hasEarlier || inbox.historyError) && <div className="text-center"><Button variant="outline" size="sm" disabled={inbox.historyBusy} onClick={() => void loadEarlier()}>{inbox.historyBusy && <Loader2 className="animate-spin" />}{inbox.historyError ? 'Retry history' : 'Load earlier'}</Button></div>}
            {(inbox.messagesError || inbox.historyError) && <p role="alert" className="text-sm text-destructive">{inbox.messagesError || inbox.historyError}</p>}
            {(inbox.messagesLoading || inbox.historyBusy) && !inbox.messages.length && <p role="status" className="text-center text-sm text-muted-foreground">Loading messages…</p>}
            {!inbox.messagesLoading && !inbox.historyBusy && !inbox.messages.length && <p className="text-center text-sm text-muted-foreground">No messages yet</p>}
            {inbox.messages.map(message => {
              const outbound = message.direction === 'outbound';
              const caption = message.source === 'echo' ? 'Neexa AI / Neexa dashboard' : message.source === 'api' ? 'Sent from Welile' : message.source === 'sync' ? 'Synced from Neexa' : '';
              return <div key={message.id} className={cn('flex', outbound ? 'justify-end' : 'justify-start')}><div className="max-w-[90%] space-y-1 md:max-w-[80%]">
                <div className={cn('rounded-lg border px-3 py-2.5 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]', outbound ? 'border-primary/20 bg-primary/10 text-foreground' : 'border-border bg-background text-foreground')}>{message.body || (message.template_public_id ? 'WhatsApp template' : 'Attachment')}</div>
                <div className={cn('flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-muted-foreground', outbound && 'justify-end')}>
                  {outbound && caption && <span>{caption}</span>}<time dateTime={message.sent_at || undefined}>{messageTime(message.sent_at)}</time>
                  {outbound && message.status && <span>{message.status.replace(/_/g, ' ')}</span>}
                </div>
              </div></div>;
            })}
            <div ref={bottomRef} />
          </div>
          {(REPLY_COMPOSER_ENABLED || closed || inbox.actionError) && <div className="shrink-0 space-y-3 border-t border-border bg-background p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {closed && <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3"><p className="text-xs">The 24-hour reply window has closed. Send an approved template instead.</p><Button variant="outline" size="sm" onClick={() => openTemplate(selected.customer_address || '')}>Send approved template</Button></div>}
            {inbox.actionError && <p role="alert" className="text-sm text-destructive">{inbox.actionError}</p>}
            {REPLY_COMPOSER_ENABLED && <>
              <Textarea aria-label="Reply message" placeholder="Write a reply…" rows={3} className="min-h-[76px] max-h-40 resize-none" disabled={closed || inbox.sending} value={draft}
                onChange={event => { const id = inbox.selectedId; if (id) setDrafts(old => ({ ...old, [id]: event.target.value })); }}
                onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
              <div className="flex items-center justify-between gap-3"><span className={cn('text-xs', draft.length > NEEXA_MESSAGE_LIMIT ? 'text-destructive' : 'text-muted-foreground')}>{draft.length.toLocaleString()} / {NEEXA_MESSAGE_LIMIT.toLocaleString()}</span><Button size="sm" disabled={!canSend} onClick={() => void send()}>{inbox.sending ? <Loader2 className="animate-spin" /> : <Send />}{inbox.sending ? 'Sending…' : 'Send'}</Button></div>
            </>}
          </div>}
        </> : <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground"><MessageSquare className="h-10 w-10" /><p className="text-sm">Select a conversation</p>{inbox.selectedId && <Button variant="outline" className="md:hidden" onClick={() => inbox.openConversation(null)}>Back to conversations</Button>}</div>}
      </div>
    </div>
    <NeexaTemplateDialog open={templateOpen} onOpenChange={setTemplateOpen} initialPhone={templatePhone}
      templates={inbox.templates} loading={inbox.templatesBusy} error={inbox.templateError} sending={inbox.templateSending}
      loadTemplates={inbox.loadTemplates} sendTemplate={inbox.sendTemplate} />
  </section>;
}
