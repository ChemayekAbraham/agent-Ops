import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type React from 'react';
import { ArrowUp, Calculator, ChevronLeft, Home, MessageCircle, HelpCircle, Check, ChevronDown, Copy, LifeBuoy, MapPin, MoreHorizontal, Sparkles, SquarePen, X } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { PromptInput, PromptInputTextarea, PromptInputFooter, PromptInputSubmit } from '@/components/ai-elements/prompt-input';
import { useAgentAssistant } from '@/hooks/useAgentAssistant';
import { useAuth } from '@/hooks/useAuth';
import { useIsMobile } from '@/hooks/use-mobile';
import { toAuthGatedPath } from '@/lib/nexaSalesEngine';
import { NexaSalesHub } from './NexaSalesHub';
import { NexaInquirySignupBar } from './NexaInquirySignupBar';
import { NexaDeskCards } from './NexaDeskCards';
import { type AiRole } from './roleLanding';
import { RentPlanCalculatorCard } from './RentPlanCalculatorCard';
import { AssistantHomeTab, AssistantMessagesTab, ASSISTANT_NAME, HELP_URL } from './AssistantPanelTabs';

export const PUBLIC_STARTERS = [
  ['Requesting rent here', 'Rent facilitation & +UGX 10,000/day Access Limit growth up to UGX 30M'],
  ['Supporting a tenant', '15% monthly Returns on verified houses + Promissory Notes'],
  ['Anything about Welile', 'Mission, products & services, Wallet, BNPL & financial access'],
  ['Access financial products & services', 'No-collateral credit up to UGX 30M, Wallet, BNPL & 15%/mo rewards'],
  ['What is Welile & how does it work?', 'Mission, values, HQ in Entebbe, and our products & services'],
  ['Support a tenant & earn 15%/mo', 'UGX 100,000 → UGX 15,000/month + Promissory Notes'],
  ['Get rent help (up to UGX 30M)', 'Rent facilitation & +UGX 10,000/day Access Limit growth'],
  ['How does the Welile Wallet work?', 'MTN (090777) & Airtel (4380664), transfers & receipts'],
  ['Become a Field Agent', 'Field opportunities, verified cycles, commissions & bike eligibility'],
  ['List property as a Landlord', 'Upfront rent support & GPS-verified houses'],
];
export const WORK_STARTERS = ['How much did I collect today?', 'What is remaining to collect today?', 'How many tenants am I collecting for?', 'Why is my collection low today?', 'What is my wallet balance?', 'Do I have any advances?'];
const STARTERS = [...PUBLIC_STARTERS.map(([question]) => question), ...WORK_STARTERS];
export const AGENT_DASHBOARD_STARTERS = [
  'How much did I collect today?',
  'How is my team doing this week?',
  'Which of my tenants are overdue?',
  'What is my wallet balance?',
  'How do I renew a tenant who finished paying?',
  'How do I earn more as an agent?',
  'Work out a Rent Plan for UGX 500,000 over 30 days',
];
export const AGENT_GREETING = "Hi, I'm Mukwano. Ask me about your tenants, your team, your wallet, or how things work in the app.";

function Avatar() { return <span className="assistant-emblem flex h-7 w-7 shrink-0 items-center justify-center rounded-full" aria-hidden="true"><Sparkles className="h-4 w-4" /></span>; }

export interface AssistantChatSurfaceProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialRole?: AiRole;
  signupSource?: string | null;
  referralCode?: string | null;
}

export function AssistantChatSurface({ open, onOpenChange, initialRole }: AssistantChatSurfaceProps) {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const { messages, isLoading, send, reset, stop, escalate, escalated, locationStatus, requestLocation } = useAgentAssistant();
  const [text, setText] = useState('');
  const [hubOpen, setHubOpen] = useState(false);
  const [starterIndex, setStarterIndex] = useState(0);
  const [view, setView] = useState<'home' | 'messages' | 'chat'>('home');
  const [calcCards, setCalcCards] = useState<string[]>([]);
  const firstName = String(user?.user_metadata?.full_name ?? '').trim().split(/\s+/)[0] || 'there';
  const [copied, setCopied] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { pathname } = useLocation();
  const onAgentDashboard = pathname.startsWith('/dashboard/agent');
  const starters = onAgentDashboard ? AGENT_DASHBOARD_STARTERS : STARTERS;
  const pageSize = onAgentDashboard && isMobile ? 4 : 3;
  const start = starterIndex % starters.length;
  const visibleStarters = [...starters, ...starters].slice(start, start + Math.min(pageSize, starters.length));
  useEffect(() => {
    if (!open || isLoading || view !== 'chat') return;
    const timer = setTimeout(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && (active.closest('[role="menu"], [role="combobox"]') || (active.matches('input,textarea') && active !== inputRef.current))) return;
      inputRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [open, isLoading, view]);
  const submit = (value: string) => { if (!value.trim() || isLoading) return; setText(''); void send(value); inputRef.current?.focus(); };
  const resetConversation = () => { reset(); setText(''); setCalcCards([]); inputRef.current?.focus(); };
  const actionHref = (href?: string) => {
    if (!href) return undefined;
    try {
      const url = new URL(href, window.location.origin);
      if (!['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol)) return undefined;
      if (!user && (url.origin === window.location.origin || url.hostname === 'welileapp.com' || url.hostname === 'www.welileapp.com')) return toAuthGatedPath(url.pathname + url.search + url.hash);
      return href;
    } catch { return undefined; }
  };
  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent side={isMobile ? 'bottom' : 'right'} onOpenAutoFocus={event => { event.preventDefault(); if (view === 'chat') inputRef.current?.focus(); }} className={`assistant-chat flex flex-col gap-0 overflow-hidden p-0 [&>button:last-child]:hidden ${isMobile ? 'h-[100dvh] rounded-none pt-safe pb-safe' : 'inset-y-auto bottom-6 right-4 h-[min(820px,calc(100dvh-3rem))] w-[calc(100vw-2rem)] sm:max-w-[600px] rounded-2xl'}`}>
      {view === 'chat' ? <>
      <SheetHeader className="flex flex-row items-center gap-0.5 space-y-0 border-b border-border px-3 py-2 text-left [&>button:first-child]:hidden">
        <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Back" onClick={() => setView('home')}><ChevronLeft /></Button>
        <div className="min-w-0 flex-1">
          <Button variant="ghost" className="h-auto min-h-0 justify-start gap-1 px-1 py-1 text-[15px]" onClick={() => setStarterIndex(index => (index + pageSize) % starters.length)}>
            <SheetTitle className="text-[15px] font-semibold">{ASSISTANT_NAME}</SheetTitle><ChevronDown className="h-3 w-3" />
          </Button>
          <SheetDescription className="sr-only">{ASSISTANT_NAME} assistant</SheetDescription>
        </div>
        <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="New chat" title="New chat" onClick={resetConversation}><SquarePen /></Button>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Assistant options"><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
          <DropdownMenuItem onClick={resetConversation}><SquarePen />New conversation</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setHubOpen(!hubOpen)}><Calculator />Calculators & Sign-Up Hub</DropdownMenuItem>
          <DropdownMenuItem disabled={!messages.length || isLoading || escalated} onClick={() => void escalate()}><LifeBuoy />Send conversation to support</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
        <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Close assistant" onClick={() => onOpenChange(false)}><X /></Button>
      </SheetHeader>
      <Conversation initial={false} resize="instant" className="min-h-0 flex-1" aria-live="polite">
        <ConversationContent className={`gap-5 px-4 py-5 ${messages.length === 0 && !hubOpen ? 'min-h-full justify-center' : ''}`}>
          {messages.length === 0 && !hubOpen && <div className="flex min-h-full flex-col items-center justify-center py-8 text-center">
            {onAgentDashboard ? <h2 className="max-w-md text-lg font-semibold">{AGENT_GREETING}</h2> : <h2 className="text-xl font-semibold">What can I help you with?</h2>}
            <div className="mt-5 flex flex-col items-center gap-2.5 sm:flex-row sm:flex-wrap sm:justify-center">
              {visibleStarters.map(starter => <Button key={starter} type="button" variant="outline" disabled={isLoading} onClick={() => submit(starter)} className="assistant-starter h-auto min-h-10 max-w-full whitespace-normal rounded-full border-border px-4 py-2 text-sm font-normal shadow-none">
                {starter}
              </Button>)}
            </div>
          </div>}
          {hubOpen && <div><NexaSalesHub onAsk={submit} />{!user && <NexaInquirySignupBar result={null} initialRole={initialRole} />}</div>}
          {messages.length > 0 && !hubOpen && !user && <details className="border-b border-border pb-2"><summary className="cursor-pointer py-2 text-sm font-medium">Free signup + Welile Wallet</summary><NexaInquirySignupBar result={null} initialRole={initialRole} /></details>}
          {messages.map((message, index) => <Message key={message.id} from={message.role} className="max-w-full">
            {message.role === 'user' ? <MessageContent className="assistant-user max-w-[82%] rounded-3xl px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">{message.content}</MessageContent> : <div className="flex w-full items-start gap-3"><Avatar /><div className="min-w-0 flex-1">
              <MessageResponse className="break-words text-[15px] leading-relaxed [&_a]:underline [&_a]:underline-offset-2" components={{ a: ({ href, children }) => <a href={actionHref(href)}>{children}</a> }}>{message.content}</MessageResponse>
              <div className="mt-2 flex items-center gap-1 text-muted-foreground"><Button variant="ghost" size="icon-sm" aria-label="Copy reply" title="Copy reply" onClick={async () => { try { await navigator.clipboard.writeText(message.content); setCopied(message.id); } catch { setCopied(null); } }}>{copied === message.id ? <Check /> : <Copy />}</Button>{message.escalationOffered && <Button variant="ghost" size="sm" disabled={isLoading || escalated} onClick={() => void escalate()}><LifeBuoy />{escalated ? 'Sent to support' : 'Send to support'}</Button>}</div>
              {index === messages.length - 1 && message.quickReplies && <div className="mt-2 flex flex-wrap gap-2">{message.quickReplies.map(reply => <Button key={reply} variant="outline" size="sm" className="h-auto min-h-11 whitespace-normal rounded-full" disabled={isLoading} onClick={() => submit(reply)}>{reply}</Button>)}</div>}
            </div></div>}
          </Message>)}
          {calcCards.map(key => <RentPlanCalculatorCard key={key} />)}
          {isLoading && <div className="flex items-center gap-3" aria-label="Assistant is thinking"><Avatar /><span className="assistant-emblem h-3 w-3 animate-pulse rounded-full motion-reduce:animate-none" /></div>}
          {user && (messages.length > 0 || hubOpen) && <NexaDeskCards open={open} />}
        </ConversationContent>
        {messages.length > 0 && <ConversationScrollButton aria-label="Scroll to latest" />}
      </Conversation>
      <div className="shrink-0 px-3 pb-3 pt-2">
        <div className="mb-2 flex"><Button type="button" variant="outline" size="sm" className="h-8 rounded-full text-xs" onClick={() => setCalcCards(cards => [...cards, `calc-${Date.now()}`])}><Calculator />Rent Plan calculator</Button></div>
        <PromptInput onSubmit={({ text: value }) => submit(value)} className="assistant-composer">
          <PromptInputTextarea ref={inputRef} value={text} onChange={event => { setText(event.target.value); event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 128)}px`; }} maxLength={500} rows={1} placeholder="Ask anything" aria-label="Message the assistant" className="min-h-12 px-12 py-3 text-base leading-6 md:text-[15px]" />
          <PromptInputFooter className="justify-between px-2 pb-2 pt-0">
            <Button type="button" variant="ghost" size="icon-sm" className="rounded-full" aria-label="Share my location (optional)" title={locationStatus === 'granted' ? 'Location shared' : 'Share my location (optional)'} disabled={locationStatus === 'requesting'} onClick={() => void requestLocation()}>{locationStatus === 'granted' ? <Check className="text-success" /> : <MapPin />}</Button>
            <PromptInputSubmit status={isLoading ? 'submitted' : 'ready'} onStop={stop} disabled={!isLoading && !text.trim()} className="assistant-send h-9 w-9 min-h-9 min-w-9 rounded-full p-0" aria-label={isLoading ? 'Stop response' : 'Send message'}>{!isLoading && <ArrowUp />}</PromptInputSubmit>
          </PromptInputFooter>
        </PromptInput>
        {(locationStatus === 'denied' || locationStatus === 'unavailable') && <p role="status" className="mt-1 text-center text-xs text-muted-foreground">Location not shared. You can still chat.</p>}
      </div>
      </> : <>
        <SheetTitle className="sr-only">{ASSISTANT_NAME}</SheetTitle>
        <SheetDescription className="sr-only">{ASSISTANT_NAME} help panel</SheetDescription>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {view === 'home' && <AssistantHomeTab firstName={firstName} onAsk={() => setView('chat')} onClose={() => onOpenChange(false)} />}
          {view === 'messages' && <AssistantMessagesTab active={open && view === 'messages'} onStart={() => { resetConversation(); setView('chat'); }} onClose={() => onOpenChange(false)} />}
        </div>
        <nav className="grid shrink-0 grid-cols-3 border-t border-border bg-background" aria-label="Assistant sections">
          <TabButton icon={<Home />} label="Home" active={view === 'home'} onClick={() => setView('home')} />
          <TabButton icon={<MessageCircle />} label="Messages" active={view === 'messages'} onClick={() => setView('messages')} />
          <a href={HELP_URL} target="_blank" rel="noopener" className="flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"><HelpCircle className="h-5 w-5" />Help</a>
        </nav>
      </>}
    </SheetContent>
  </Sheet>;
}

function TabButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return <button type="button" onClick={onClick} aria-current={active ? 'page' : undefined} className={`flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs [&_svg]:h-5 [&_svg]:w-5 ${active ? 'font-semibold text-primary' : 'text-muted-foreground hover:text-foreground'}`}>{icon}{label}</button>;
}
