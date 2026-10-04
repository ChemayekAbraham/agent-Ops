import { useState, useRef, useEffect, lazy, Suspense, useCallback } from 'react';
import { useDrawerTransition } from '@/hooks/useDrawerTransition';
import { X, Send, RotateCcw, Bot, ChevronDown, Sparkles, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWelileAI } from '@/hooks/useWelileAI';
import ReactMarkdown from 'react-markdown';
import ShareWelileAIBanner from './ShareWelileAIBanner';
import { ROLE_LANDINGS, buildRoleSignupHref, type AiRole } from './roleLanding';

const EarningPredictionCard = lazy(() => import('@/components/ai-chat/EarningPredictionCard'));

const SUGGESTIONS = [
  { icon: "💰", text: "How do I start earning?" },
  { icon: "🔥", text: "How much can agents make?" },
  { icon: "🏠", text: "What's the Supporter thing?" },
  { icon: "🚀", text: "What is Welile?" },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Deep-link role scope (from /ai?role=...). Tailors onboarding content. */
  initialRole?: AiRole;
  /** Attribution source carried from the deep link (signup_source). */
  signupSource?: string | null;
  /** Referral code carried from the deep link (ref). */
  referralCode?: string | null;
}

export default function WelileAIChatDrawer({ open, onOpenChange, initialRole, signupSource, referralCode }: Props) {
  const { messages, isLoading, sendMessage, clearHistory, cancelStream } = useWelileAI();
  const landing = initialRole ? ROLE_LANDINGS[initialRole] : null;
  const roleSuggestions = landing?.suggestions ?? SUGGESTIONS;
  const roleSignupHref = landing
    ? buildRoleSignupHref(landing.role, { source: signupSource, ref: referralCode })
    : null;
  const [input, setInput] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // Scroll to bottom whenever messages change
  const scrollToBottom = useCallback((smooth = false) => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }, []);

  useEffect(() => {
    if (messages.length > 0) scrollToBottom();
  }, [messages, isLoading, scrollToBottom]);

  // Focus input when drawer opens
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 400);
    }
  }, [open]);

  // Detect virtual keyboard on mobile using visualViewport
  useEffect(() => {
    if (!open) return;

    const vv = window.visualViewport;
    if (!vv) return;

    const onResize = () => {
      const diff = window.innerHeight - vv.height;
      setKeyboardHeight(diff > 50 ? diff : 0);
      // Scroll to bottom when keyboard opens
      setTimeout(() => scrollToBottom(), 100);
    };

    vv.addEventListener('resize', onResize);
    vv.addEventListener('scroll', onResize);
    return () => {
      vv.removeEventListener('resize', onResize);
      vv.removeEventListener('scroll', onResize);
    };
  }, [open, scrollToBottom]);

  // Reset keyboard height when drawer closes
  useEffect(() => {
    if (!open) setKeyboardHeight(0);
  }, [open]);

  const { mounted, visible } = useDrawerTransition(open);

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onOpenChange(false); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  };

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setShowScrollDown(scrollHeight - scrollTop - clientHeight > 80);
  };

  const handleSend = () => {
    if (!input.trim() || isLoading) return;
    sendMessage(input.trim());
    setInput('');
    if (inputRef.current) {
      inputRef.current.style.height = '44px';
    }
    // Scroll to bottom after send
    setTimeout(() => scrollToBottom(), 50);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleClear = () => {
    if (confirmClear) {
      clearHistory();
      setConfirmClear(false);
    } else {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
    }
  };

  const hasMessages = messages.length > 0;

  return (
    <>
    {mounted && (
        <>
          {/* Backdrop */}
          <div
            className={cn(
              "fixed inset-0 bg-black/60 backdrop-blur-sm z-[70] transition-opacity duration-200",
              visible ? "opacity-100" : "opacity-0",
            )}
            onClick={() => onOpenChange(false)}
          />

          {/* Chat panel */}
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Welile AI chat"
            style={{
              // Push panel up when keyboard is open on mobile
              bottom: keyboardHeight > 0 ? keyboardHeight : undefined,
            }}
            className={cn(
              // Mobile: full-screen sheet; Desktop: floating panel
              "fixed inset-x-0 bottom-0 md:inset-auto md:bottom-5 md:right-5",
              "md:w-[460px] md:h-[660px]",
              // On mobile, use a tall but not full-height to leave room at top
              "h-[92dvh] md:h-[660px]",
              "rounded-t-3xl md:rounded-3xl",
              "bg-background z-[71] flex flex-col",
              "shadow-2xl border border-border/40 overflow-hidden",
              "transition-transform duration-300 ease-out will-change-transform",
              visible ? "translate-y-0" : "translate-y-full",
            )}
          >
            {/* Header */}
            <div className="relative flex items-center justify-between px-4 py-3.5 border-b border-border/40 bg-background/95 backdrop-blur-md flex-shrink-0">
              {/* Drag handle — mobile only */}
              <div className="absolute top-2 left-1/2 -translate-x-1/2 w-10 h-1 rounded-full bg-muted-foreground/25 md:hidden" />

              <div className="flex items-center gap-2.5 mt-2 md:mt-0">
                <div className="h-9 w-9 rounded-2xl bg-gradient-to-br from-primary/25 to-primary/5 border border-primary/20 flex items-center justify-center shadow-sm">
                  <Sparkles className="h-4.5 w-4.5 text-primary" />
                </div>
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-bold text-foreground tracking-tight">Welile AI</span>
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-semibold uppercase tracking-wide">Beta</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground leading-none mt-0.5">Your earnings assistant</p>
                </div>
              </div>

              <div className="flex items-center gap-1 mt-2 md:mt-0">
                {hasMessages && (
                    <button
                      key="clear"
                      onClick={handleClear}
                      className={cn(
                        "h-9 px-3 rounded-xl text-[11px] font-semibold transition-all flex items-center gap-1.5 min-w-[36px] justify-center animate-fade-in",
                        confirmClear
                          ? "bg-destructive/15 text-destructive border border-destructive/30"
                          : "hover:bg-muted text-muted-foreground"
                      )}
                      title="Clear chat"
                    >
                      {confirmClear ? (
                        <><RotateCcw className="h-3 w-3" /><span>Confirm?</span></>
                      ) : (
                        <RotateCcw className="h-4 w-4" />
                      )}
                    </button>
                )}
                <button
                  onClick={() => onOpenChange(false)}
                  className="h-9 w-9 rounded-xl hover:bg-muted flex items-center justify-center transition-colors"
                >
                  <X className="h-4.5 w-4.5 text-muted-foreground" />
                </button>
              </div>
            </div>

            {/* Messages area — fills all remaining space */}
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="flex-1 overflow-y-auto overscroll-contain"
              style={{ WebkitOverflowScrolling: 'touch' } as React.CSSProperties}
            >
              <>
                {!hasMessages && !isLoading ? (
                  /* ─── Empty state ─── */
                  <div
                    key="empty"
                    className="flex flex-col items-center justify-center min-h-full px-5 py-8 animate-fade-in"
                  >
                    <div
                      className="h-16 w-16 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/20 flex items-center justify-center mb-4 shadow-lg shadow-primary/10 animate-scale-in"
                    >
                      <Sparkles className="h-8 w-8 text-primary" />
                    </div>

                    <div className="text-center mb-5 animate-fade-in">
                      <h2 className="text-lg font-bold text-foreground mb-1">
                        {landing ? landing.headline : 'Hey! 👋 Ask me anything'}
                      </h2>
                      <p className="text-sm text-muted-foreground max-w-[260px] leading-relaxed">
                        {landing ? landing.subtitle : 'Tap a question below or just type 💬'}
                      </p>
                    </div>

                    {/* Role-scoped signup CTA (deep-link onboarding) */}
                    {landing && roleSignupHref && (
                      <a
                        href={roleSignupHref}
                        className="w-full max-w-[340px] mb-4 flex items-center justify-center gap-2 rounded-2xl bg-primary text-primary-foreground font-semibold text-sm py-3 px-4 shadow-lg shadow-primary/20 hover:bg-primary/90 active:scale-95 transition-all animate-fade-in"
                      >
                        <span>{landing.emoji}</span>
                        <span>{landing.cta}</span>
                      </a>
                    )}

                    {/* Earning prediction */}
                    <Suspense fallback={null}>
                      <div className="w-full max-w-[340px] mb-4 animate-fade-in">
                        <EarningPredictionCard />
                      </div>
                    </Suspense>

                    {/* Suggestion pills */}
                    <div className="grid grid-cols-2 gap-1.5 sm:gap-2 w-full max-w-[340px] animate-fade-in">
                      {roleSuggestions.map((s) => (
                        <button
                          key={s.text}
                          onClick={() => sendMessage(s.text)}
                          className="flex items-start gap-1.5 sm:gap-2 p-2.5 sm:p-3 rounded-2xl border border-border/60 bg-card hover:bg-accent/30 hover:border-border active:scale-95 transition-all text-left group min-h-[48px] sm:min-h-[56px] touch-manipulation"
                        >
                          <span className="text-sm sm:text-base leading-none mt-0.5 flex-shrink-0">{s.icon}</span>
                          <span className="text-[11px] sm:text-xs text-foreground/75 group-hover:text-foreground leading-snug font-medium">{s.text}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  /* ─── Messages list ─── */
                  <div key="messages" className="py-4 space-y-1 animate-fade-in">
                    {messages.map((msg, idx) => (
                      <div key={msg.id} className="animate-fade-in">
                        {/* Message bubble */}
                        <div className={cn(
                          "px-4 py-1.5",
                          msg.role === 'user' ? 'flex justify-end' : ''
                        )}>
                          {msg.role === 'user' ? (
                            <div className="max-w-[85%] px-3 sm:px-4 py-2.5 sm:py-3 rounded-2xl rounded-br-sm bg-primary text-primary-foreground shadow-sm">
                              <p className="text-[13px] sm:text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                            </div>
                          ) : (
                            <div className="flex gap-2.5 max-w-full">
                              <div className="h-7 w-7 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5 shadow-sm">
                                <Bot className="h-3.5 w-3.5 text-primary" />
                              </div>
                              <div className="flex-1 min-w-0 pt-0.5">
                                <div className="prose prose-sm dark:prose-invert max-w-none text-[13px] sm:text-sm leading-relaxed
                                  [&>p]:mb-2 [&>p:last-child]:mb-0
                                  [&>ul]:mb-2 [&>ol]:mb-2 [&>ul]:pl-4 [&>ol]:pl-4 [&_li]:mb-0.5
                                  [&>h1]:text-base [&>h2]:text-sm [&>h3]:text-sm
                                  [&>strong]:font-semibold [&>code]:bg-muted [&>code]:px-1 [&>code]:rounded
                                ">
                                  <ReactMarkdown
                                    components={{
                                      a: ({ href, children }) => (
                                        <a
                                          href={href}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-primary underline underline-offset-2 hover:text-primary/80 font-medium"
                                          onClick={(e) => e.stopPropagation()}
                                        >
                                          {children}
                                        </a>
                                      ),
                                    }}
                                  >
                                    {msg.content}
                                  </ReactMarkdown>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Share banner after last AI message */}
                        {msg.role === 'assistant' && msg.id !== 'streaming' && idx === messages.length - 1 && (
                          <div className="px-4 pt-2 pb-2 ml-[38px] animate-fade-in">
                            <ShareWelileAIBanner />
                          </div>
                        )}
                      </div>
                    ))}

                    {/* Typing indicator */}
                    {isLoading && messages[messages.length - 1]?.role !== 'assistant' && (
                      <div className="px-4 py-2 animate-fade-in">
                        <div className="flex gap-2.5">
                          <div className="h-7 w-7 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/20 flex items-center justify-center flex-shrink-0 shadow-sm">
                            <Bot className="h-3.5 w-3.5 text-primary" />
                          </div>
                          <div className="flex items-center gap-1.5 py-2.5 px-4 rounded-2xl rounded-bl-sm bg-muted/60">
                            {[0, 150, 300].map((delay) => (
                              <span
                                key={delay}
                                className="h-2 w-2 rounded-full bg-foreground/40 animate-bounce"
                                style={{ animationDelay: `${delay}ms` }}
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="h-2" />
                  </div>
                )}
              </>
            </div>

            {/* Scroll to bottom button */}
            {showScrollDown && (
                <button
                  onClick={() => scrollToBottom(true)}
                  aria-label="Scroll to latest"
                  className="absolute bottom-24 right-4 h-9 w-9 rounded-full bg-background border border-border shadow-lg flex items-center justify-center z-10 animate-scale-in"
                >
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                </button>
            )}

            {/* Input area — always pinned to bottom */}
            <div
              className="px-3 pt-2 bg-background/95 backdrop-blur-sm border-t border-border/40 flex-shrink-0"
              style={{
                paddingBottom: keyboardHeight > 0
                  ? '8px'
                  : 'max(16px, env(safe-area-inset-bottom, 16px))',
              }}
            >
              <div className={cn(
                "relative flex items-end gap-2 rounded-2xl border bg-muted/30 transition-all duration-200",
                "focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10 focus-within:bg-background",
                "border-border/60"
              )}>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  placeholder="Message Welile AI..."
                  rows={1}
                  className={cn(
                    "flex-1 resize-none bg-transparent px-4 py-3 pr-2",
                    // 16px font prevents iOS auto-zoom
                    "text-[16px] md:text-sm placeholder:text-muted-foreground/50",
                    "focus:outline-none leading-relaxed",
                    "touch-manipulation"
                  )}
                  style={{ minHeight: '48px', maxHeight: '120px' }}
                />
                <button
                  onClick={isLoading ? cancelStream : handleSend}
                  disabled={!isLoading && !input.trim()}
                  className={cn(
                    "flex-shrink-0 mr-2 mb-2 h-10 w-10 rounded-xl flex items-center justify-center transition-all duration-200 active:scale-90",
                    (isLoading || input.trim())
                      ? "bg-primary text-primary-foreground shadow-md shadow-primary/25 hover:bg-primary/90"
                      : "bg-muted text-muted-foreground/50 cursor-not-allowed"
                  )}
                >
                  {isLoading ? (
                    <Square className="h-4 w-4 fill-current" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </button>
              </div>
              <p className="text-[10px] text-center text-muted-foreground/40 mt-1.5 leading-none pb-0.5">
                Welile AI can make mistakes. Verify important info.
              </p>
            </div>
          </div>
        </>
    )}
    </>
  );
}
