import { useEffect, useState } from 'react';
import { ArrowLeft, Calculator, ChevronRight, MessageCircle, Search, Sparkles, X } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { supabase } from '@/integrations/supabase/client';
import WelileLogo from '@/components/WelileLogo';
import { RentPlanCalculatorCard } from './RentPlanCalculatorCard';

/** The assistant's display name — change it here only. */
export const ASSISTANT_NAME = 'Mukwano';
export const HELP_URL = 'https://help.welileapp.com';
export const WHATSAPP_URL = 'https://wa.me/256777607640';
const CALC_ID = 'assistant-home-calculator';

function WhatsAppIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true"><path d="M17.5 14.4c-.3-.1-1.7-.8-2-.9-.3-.1-.5-.1-.7.1-.2.3-.8.9-.9 1.1-.2.2-.3.2-.6.1-.3-.1-1.2-.5-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6l.4-.5c.2-.2.2-.3.3-.5.1-.2 0-.4 0-.5l-.9-2.2c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.4s1 2.8 1.2 3c.1.2 2 3.1 4.9 4.3 2.4.9 2.9.8 3.4.7.6-.1 1.7-.7 2-1.4.2-.7.2-1.3.2-1.4-.1-.1-.3-.2-.6-.3zM12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2c-1.5 0-3-.4-4.3-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2z" /></svg>;
}

function ActionCard({ title, sub, icon, onClick, href }: { title: string; sub: string; icon: React.ReactNode; onClick?: () => void; href?: string }) {
  const inner = <><div className="min-w-0 flex-1"><p className="text-sm font-semibold">{title}</p><p className="text-xs text-muted-foreground">{sub}</p></div><span className="text-primary">{icon}</span></>;
  const cls = 'flex w-full items-center gap-3 rounded-2xl border border-border bg-card p-4 text-left text-card-foreground shadow-sm transition-colors hover:bg-accent';
  return href ? <a href={href} target="_blank" rel="noopener" className={cls}>{inner}</a> : <button type="button" onClick={onClick} className={cls}>{inner}</button>;
}

export function AssistantHomeTab({ firstName, onAsk, onClose }: { firstName: string; onAsk: () => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  return <div className="space-y-3 px-4 pb-6 pt-3">
    <div className="flex items-center justify-between">
      <WelileLogo size="sm" />
      <div className="flex gap-1">
        <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Rent Plan calculator" onClick={() => document.getElementById(CALC_ID)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}><Calculator /></Button>
        <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Close" onClick={onClose}><X /></Button>
      </div>
    </div>
    <div className="pb-2 pt-4">
      <p className="text-lg text-muted-foreground">Hi {firstName} 👋</p>
      <h2 className="text-2xl font-bold tracking-tight">How can we help?</h2>
    </div>
    <ActionCard title={`Ask ${ASSISTANT_NAME}`} sub="Instant answers, day or night" icon={<ChevronRight className="h-5 w-5" />} onClick={onAsk} />
    <ActionCard title="Talk to a person" sub="Chat with us on WhatsApp" icon={<WhatsAppIcon />} href={WHATSAPP_URL} />
    <RentPlanCalculatorCard id={CALC_ID} />
    <form onSubmit={e => { e.preventDefault(); window.open(HELP_URL, '_blank', 'noopener'); }} className="relative">
      <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search for help" aria-label="Search for help" className="h-12 rounded-2xl pr-11" />
      <button type="submit" aria-label="Search" className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"><Search className="h-5 w-5" /></button>
    </form>
  </div>;
}

interface PastMessage { id: string; conversation_id: string; role: 'user' | 'assistant'; content: string; created_at: string }

export function AssistantMessagesTab({ active, onStart, onClose }: { active: boolean; onStart: () => void; onClose: () => void }) {
  const [rows, setRows] = useState<PastMessage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    setFailed(false);
    void (supabase.rpc as unknown as (fn: string, args: object) => Promise<{ data: { messages?: PastMessage[] } | null; error: unknown }>)('assistant_my_messages', { p_limit: 50 })
      .then(({ data, error }) => { if (!live) return; if (error) { setFailed(true); setRows([]); } else setRows(data?.messages ?? []); });
    return () => { live = false; };
  }, [active]);

  const groups: { id: string; items: PastMessage[] }[] = [];
  for (const m of rows ?? []) {
    const g = groups.find(x => x.id === m.conversation_id);
    if (g) g.items.push(m); else groups.push({ id: m.conversation_id, items: [m] });
  }
  const opened = groups.find(g => g.id === openId);

  if (opened) return <div className="px-4 pb-6 pt-3">
    <div className="mb-3 flex items-center gap-2"><Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Back to messages" onClick={() => setOpenId(null)}><ArrowLeft /></Button><p className="text-sm font-semibold">Past chat</p></div>
    <div className="space-y-2">{[...opened.items].reverse().map(m => <div key={m.id} className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${m.role === 'user' ? 'ml-auto bg-primary text-primary-foreground' : 'bg-muted'}`}>{m.content}</div>)}</div>
    <Button className="mt-4 w-full rounded-full" onClick={onStart}>Start a new chat</Button>
  </div>;

  return <div className="flex min-h-full flex-col px-4 pb-4 pt-3">
    <div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-bold">Messages</h2><Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Close" onClick={onClose}><X /></Button></div>
    <div className="flex-1">
      {rows === null ? <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
        : groups.length === 0 ? <div className="flex flex-col items-center gap-3 py-12 text-center">
          <p className="text-sm text-muted-foreground">{failed ? "Couldn't load your chats right now." : `No chats yet — ${ASSISTANT_NAME} is ready when you are.`}</p>
          <Button className="rounded-full" onClick={onStart}><Sparkles />Start chatting</Button>
        </div>
        : <ul className="divide-y divide-border">{groups.map(g => <li key={g.id}>
          <button type="button" onClick={() => setOpenId(g.id)} className="flex w-full items-center gap-3 py-3 text-left">
            <span className="assistant-emblem flex h-9 w-9 shrink-0 items-center justify-center rounded-full"><MessageCircle className="h-4 w-4" /></span>
            <div className="min-w-0 flex-1"><p className="truncate text-sm">{g.items[0].content}</p><p className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(g.items[0].created_at), { addSuffix: true })}</p></div>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </button>
        </li>)}</ul>}
    </div>
    <a href={WHATSAPP_URL} target="_blank" rel="noopener" className="mt-4 flex items-center gap-3 rounded-2xl border border-border bg-card p-3 text-sm font-medium hover:bg-accent"><WhatsAppIcon className="h-5 w-5 text-primary" /><span className="flex-1">Talk to a person on WhatsApp</span><ChevronRight className="h-4 w-4 text-muted-foreground" /></a>
  </div>;
}
