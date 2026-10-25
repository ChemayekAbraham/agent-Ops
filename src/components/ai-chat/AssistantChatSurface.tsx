import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Calculator, Check, ChevronDown, Copy, LifeBuoy, MapPin, MoreHorizontal, Sparkles, SquarePen, X } from 'lucide-react';
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
import { ROLE_LANDINGS, buildRoleSignupHref, type AiRole } from './roleLanding';

const PUBLIC_STARTERS = [
  ['Access financial products & services', 'No-collateral credit up to UGX 30M, Wallet, BNPL & 15%/mo rewards'],
  ['What is Welile & how does it work?', 'Mission, values, HQ in Entebbe, and our products & services'],
  ['Support a tenant & earn 15%/mo', 'UGX 100,000 → UGX 15,000/month + Promissory Notes'],
  ['Get rent help (up to UGX 30M)', 'Rent facilitation & +UGX 10,000/day Access Limit growth'],
  ['How does the Welile Wallet work?', 'MTN (090777) & Airtel (4380664), transfers & receipts'],
  ['Become a Field Agent', 'Field opportunities, verified cycles, commissions & bike eligibility'],
  ['List property as a Landlord', 'Upfront rent support & GPS-verified houses'],
];
const WORK_STARTERS = ['How much did I collect today?', 'What is remaining to collect today?', 'How many tenants am I collecting for?', 'Why is my collection low today?', 'What is my wallet balance?', 'Do I have any advances?'];

function Avatar() { return <span className="assistant-emblem flex h-7 w-7 shrink-0 items-center justify-center rounded-full" aria-hidden="true"><Sparkles className="h-4 w-4" /></span>; }

export interface AssistantChatSurfaceProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialRole?: AiRole;
  signupSource?: string | null;
  referralCode?: string | null;
}

export function AssistantChatSurface({ open, onOpenChange, initialRole, signupSource, referralCode }: AssistantChatSurfaceProps) {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const { messages, isLoading, send, reset, stop, escalate, escalated, locationStatus, requestLocation } = useAgentAssistant();
  const [text, setText] = useState('');
  const [hubOpen, setHubOpen] = useState(false);
  const [starterTab, setStarterTab] = useState<'public' | 'work'>('public');
  const [copied, setCopied] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const landing = initialRole ? ROLE_LANDINGS[initialRole] : null;
  useEffect(() => {
    if (!open || isLoading) return;
    const timer = setTimeout(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && (active.closest('[role="menu"], [role="combobox"]') || (active.matches('input,textarea') && active !== inputRef.current))) return;
      inputRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [open, isLoading]);
  const submit = (value: string) => { if (!value.trim() || isLoading) return; setText(''); void send(value); inputRef.current?.focus(); };
  const resetConversation = () => { reset(); setText(''); inputRef.current?.focus(); };
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
    <SheetContent side={isMobile ? 'bottom' : 'right'} onOpenAutoFocus={event => { event.preventDefault(); inputRef.current?.focus(); }} className={`assistant-chat flex flex-col gap-0 overflow-hidden p-0 [&>button:last-child]:hidden ${isMobile ? 'h-[100dvh] rounded-none pt-safe pb-safe' : 'inset-y-auto bottom-6 right-4 h-[min(820px,calc(100dvh-3rem))] w-[calc(100vw-2rem)] sm:max-w-[600px] rounded-2xl'}`}>
      <SheetHeader className="flex flex-row items-center gap-0.5 space-y-0 border-b border-border px-3 py-2 text-left [&>button:first-child]:hidden">
        <div className="min-w-0 flex-1">
          <Button variant="ghost" className="h-auto min-h-0 justify-start gap-1 px-1 py-1 text-[15px]" onClick={() => setStarterTab(tab => tab === 'public' ? 'work' : 'public')}>
            <SheetTitle className="text-[15px] font-semibold">Welile Assistant</SheetTitle><ChevronDown className="h-3 w-3" /><span className="h-1.5 w-1.5 rounded-full bg-success" />
          </Button>
          <SheetDescription className="px-1 text-[10px] leading-snug">{user ? 'Public Guide & Work Assistant' : 'Welile AI · Public & Product Guide'}</SheetDescription>
        </div>
        <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="New chat" title="New chat" onClick={resetConversation}><SquarePen /></Button>
        <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Calculators & Instant Sign-Up" title="Calculators & Instant Sign-Up" aria-pressed={hubOpen} onClick={() => setHubOpen(!hubOpen)}><Calculator /></Button>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Assistant options"><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
          <DropdownMenuItem onClick={resetConversation}><SquarePen />New conversation</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setHubOpen(!hubOpen)}><Calculator />Calculators & Sign-Up Hub</DropdownMenuItem>
          <DropdownMenuItem disabled={!messages.length || isLoading || escalated} onClick={() => void escalate()}><LifeBuoy />Send conversation to support</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
        <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Close assistant" onClick={() => onOpenChange(false)}><X /></Button>
      </SheetHeader>
      <Conversation initial={false} resize="instant" className="min-h-0 flex-1" aria-live="polite">
        <ConversationContent className="gap-5 px-4 py-5">
          {messages.length === 0 && <div className="flex flex-col items-center py-5 text-center">
            <span className="assistant-emblem mb-3 flex h-11 w-11 items-center justify-center rounded-full"><Sparkles className="h-6 w-6" /></span>
            <h2 className="text-xl font-semibold">What can I help with?</h2>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">Ask anything about Welile (welile.com & welileapp.com), our products & services, or your own collections, tenants, wallet, and advances.</p>
            {landing && <Button asChild variant="outline" className="mt-4 h-auto min-h-11 whitespace-normal"><a href={buildRoleSignupHref(landing.role, { authenticated: !!user, source: signupSource, ref: referralCode })}>{landing.cta}</a></Button>}
            <div className="mt-5 flex w-full gap-1 border-b border-border" role="tablist" aria-label="Starter questions">
              <Button variant="ghost" className="h-auto min-h-11 flex-1 whitespace-normal rounded-none px-2 text-xs" role="tab" aria-selected={starterTab === 'public'} onClick={() => setStarterTab('public')}>About Welile & Products</Button>
              <Button variant="ghost" className="h-auto min-h-11 flex-1 whitespace-normal rounded-none px-2 text-xs" role="tab" aria-selected={starterTab === 'work'} onClick={() => setStarterTab('work')}>My Work & Account</Button>
            </div>
            <div className="mt-4 grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
              {(starterTab === 'public' ? PUBLIC_STARTERS : WORK_STARTERS.map(question => [question, ''])).map(([question, detail]) => <Button key={question} variant="outline" disabled={isLoading} onClick={() => submit(question)} className="assistant-starter h-auto min-h-14 flex-col items-start gap-1 whitespace-normal rounded-2xl px-3.5 py-2.5 text-left text-sm font-medium"><span>{question}</span>{detail && <span className="text-xs font-normal leading-relaxed text-muted-foreground">{detail}</span>}</Button>)}
            </div>
          </div>}
          {hubOpen && <div><NexaSalesHub onAsk={submit} />{!user && <NexaInquirySignupBar result={null} initialRole={initialRole} />}</div>}
          {!hubOpen && !user && <details className="border-b border-border pb-2"><summary className="cursor-pointer py-2 text-sm font-medium">Free signup + Welile Wallet</summary><NexaInquirySignupBar result={null} initialRole={initialRole} /></details>}
          {messages.map((message, index) => <Message key={message.id} from={message.role} className="max-w-full">
            {message.role === 'user' ? <MessageContent className="assistant-user max-w-[82%] rounded-3xl px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">{message.content}</MessageContent> : <div className="flex w-full items-start gap-3"><Avatar /><div className="min-w-0 flex-1">
              <MessageResponse className="break-words text-[15px] leading-relaxed [&_a]:underline [&_a]:underline-offset-2" components={{ a: ({ href, children }) => <a href={actionHref(href)}>{children}</a> }}>{message.content}</MessageResponse>
              <div className="mt-2 flex items-center gap-1 text-muted-foreground"><Button variant="ghost" size="icon-sm" aria-label="Copy reply" title="Copy reply" onClick={async () => { try { await navigator.clipboard.writeText(message.content); setCopied(message.id); } catch { setCopied(null); } }}>{copied === message.id ? <Check /> : <Copy />}</Button>{message.escalationOffered && <Button variant="ghost" size="sm" disabled={isLoading || escalated} onClick={() => void escalate()}><LifeBuoy />{escalated ? 'Sent to support' : 'Send to support'}</Button>}</div>
              {index === messages.length - 1 && message.quickReplies && <div className="mt-2 flex flex-wrap gap-2">{message.quickReplies.map(reply => <Button key={reply} variant="outline" size="sm" className="h-auto min-h-11 whitespace-normal rounded-full" disabled={isLoading} onClick={() => submit(reply)}>{reply}</Button>)}</div>}
            </div></div>}
          </Message>)}
          {isLoading && <div className="flex items-center gap-3" aria-label="Assistant is thinking"><Avatar /><span className="assistant-emblem h-3 w-3 animate-pulse rounded-full motion-reduce:animate-none" /></div>}
          {user && <NexaDeskCards open={open} />}
        </ConversationContent>
        <ConversationScrollButton aria-label="Scroll to latest" />
      </Conversation>
      <div className="shrink-0 px-3 pb-3 pt-2">
        <PromptInput onSubmit={({ text: value }) => submit(value)} className="assistant-composer">
          <PromptInputTextarea ref={inputRef} value={text} onChange={event => { setText(event.target.value); event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 128)}px`; }} maxLength={500} rows={1} placeholder="Ask anything about Welile or your work..." aria-label="Message the assistant" className="min-h-11 px-4 py-3 text-base md:text-[15px]" />
          <PromptInputFooter className="justify-between px-2 pb-2 pt-0">
            <Button type="button" variant="ghost" size="icon-sm" className="rounded-full" aria-label="Share my location (optional)" title={locationStatus === 'granted' ? 'Location shared' : 'Share my location (optional)'} disabled={locationStatus === 'requesting'} onClick={() => void requestLocation()}>{locationStatus === 'granted' ? <Check className="text-success" /> : <MapPin />}</Button>
            <PromptInputSubmit status={isLoading ? 'submitted' : 'ready'} onStop={stop} disabled={!isLoading && !text.trim()} className="assistant-send h-9 w-9 min-h-9 min-w-9 rounded-full p-0" aria-label={isLoading ? 'Stop response' : 'Send message'}>{!isLoading && <ArrowUp />}</PromptInputSubmit>
          </PromptInputFooter>
        </PromptInput>
        {(locationStatus === 'denied' || locationStatus === 'unavailable') && <p role="status" className="mt-1 text-center text-xs text-muted-foreground">Location not shared. You can still chat.</p>}
        <p className="mt-2 text-center text-[10px] leading-relaxed text-muted-foreground">Welile Assistant · Public Knowledge (welile.com & welileapp.com) + Personal Work Assistant</p>
      </div>
    </SheetContent>
  </Sheet>;
}
