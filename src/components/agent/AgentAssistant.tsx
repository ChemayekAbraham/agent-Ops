import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import claraAvatar from '@/assets/clara-avatar.png';
import { Button } from '@/components/ui/button';
import { AssistantChatSurface } from '@/components/ai-chat/AssistantChatSurface';
import { AuthContext } from '@/hooks/useAuth';
import { FLOATING_NAV_Z } from '@/components/ui/floating-nav';

/**
 * The launcher and its hello bubble draw in front of the bottom role nav
 * (FLOATING_NAV_Z) and behind the chat sheet's backdrop (z-[110]), so the nav
 * can never cover the assistant while an open chat still covers the assistant.
 */
const LAUNCHER_Z = FLOATING_NAV_Z + 5;
const BUBBLE_Z = LAUNCHER_Z + 1;

/** How long the hello bubble stays up before it starts fading away. */
const GREETING_MS = 20_000;
/** The fade itself; the node is taken out only once this has run. */
const GREETING_FADE_MS = 600;

/**
 * Mounted once by FloatingToolbar; every page can open it without creating another chat.
 * The launcher sits just above the bottom nav (`--fab-above-nav`); nothing else stacks on that side now.
 */
export function AgentAssistant({ hideLauncher = false }: { hideLauncher?: boolean }) {
  const [open, setOpen] = useState(false);
  // The session is read straight from the context: this component is also
  // mounted by tests with no provider, where useAuth() would throw.
  const user = useContext(AuthContext)?.user ?? null;
  const [phase, setPhase] = useState<'in' | 'out' | 'done'>('in');
  const greetedRef = useRef(false);

  useEffect(() => {
    // The chat holds personal account history, so a page with no active
    // session cannot open it — not even from a stray launcher button.
    const show = () => { if (user) setOpen(true); };
    window.addEventListener('open-welile-assistant', show);
    return () => window.removeEventListener('open-welile-assistant', show);
  }, [user]);

  // One hello per page load: it appears beside the launcher, then fades away
  // on its own. It is never re-shown after a route change or a modal closing.
  // While the launcher is hidden (a dialog is open) the countdown has not
  // started yet, so the greeting is not spent on a screen that cannot show it.
  useEffect(() => {
    if (greetedRef.current || !user || hideLauncher) return;
    greetedRef.current = true;
    const fadeAt = setTimeout(() => setPhase('out'), GREETING_MS);
    const offAt = setTimeout(() => setPhase('done'), GREETING_MS + GREETING_FADE_MS);
    return () => { clearTimeout(fadeAt); clearTimeout(offAt); };
  }, [user, hideLauncher]);

  const fullName = String(user?.user_metadata?.full_name ?? '').trim();
  const firstName = fullName.split(/\s+/)[0] || (user?.email ?? '').split('@')[0] || 'there';

  // The bubble sits directly above the launcher and follows whichever dock
  // offset the launcher itself uses, so the two never drift apart.
  const bubbleBottom = 'calc(var(--fab-above-nav) + 4.25rem)';

  return <>
    {!open && !hideLauncher && createPortal(<Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="Chat with Welile Assistant" title="Chat with Clara" aria-haspopup="dialog" style={{ zIndex: LAUNCHER_Z }} className={`gradient-assistant fixed bottom-[var(--fab-above-nav)] right-4 h-14 w-14 overflow-hidden rounded-full border-2 border-background p-0 shadow-lg`}><img src={claraAvatar} alt="" width={192} height={192} className="h-full w-full object-cover" /></Button>, document.body)}
    {!open && !hideLauncher && !!user && phase !== 'done' && createPortal(
      <AnimatePresence>
        {phase === 'in' && (
          <motion.div
            key="assistant-greeting"
            role="status"
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
            className="fixed right-4"
            style={{ bottom: bubbleBottom, maxWidth: 'min(19rem, calc(100vw - 5rem))', zIndex: BUBBLE_Z }}
          >
            <button
              type="button"
              onClick={() => { setPhase('done'); setOpen(true); }}
              className="relative block w-full rounded-2xl border border-border bg-card px-3.5 py-2 text-left text-sm font-medium text-card-foreground shadow-lg"
            >
              Hi 👋 {firstName}, need help?
              <span aria-hidden className="absolute right-7 h-2.5 w-2.5 rotate-45 border-b border-r border-border bg-card" style={{ bottom: -5 }} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>,
      document.body,
    )}
    <AssistantChatSurface open={open} onOpenChange={setOpen} />
  </>;
}
