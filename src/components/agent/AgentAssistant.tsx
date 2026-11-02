import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import claraAvatar from '@/assets/clara-avatar.png';
import { Button } from '@/components/ui/button';
import { AssistantChatSurface } from '@/components/ai-chat/AssistantChatSurface';

/**
 * Mounted once by FloatingToolbar; every page can open it without creating another chat.
 * `dockAboveNav` sits the launcher just above the bottom nav (pages with no other right-hand button stack).
 */
export function AgentAssistant({ hideLauncher = false, dockAboveNav = false }: { hideLauncher?: boolean; dockAboveNav?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener('open-welile-assistant', show);
    return () => window.removeEventListener('open-welile-assistant', show);
  }, []);
  return <>
    {!open && !hideLauncher && createPortal(<Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="Chat with Welile Assistant" title="Chat with Clara" aria-haspopup="dialog" className={`gradient-assistant fixed ${dockAboveNav ? 'bottom-[var(--fab-bottom)]' : 'bottom-[max(var(--fab-bottom-stacked),9.25rem)]'} right-4 z-[60] h-14 w-14 overflow-hidden rounded-full border-2 border-background p-0 shadow-lg`}><img src={claraAvatar} alt="" width={192} height={192} className="h-full w-full object-cover" /></Button>, document.body)}
    <AssistantChatSurface open={open} onOpenChange={setOpen} />
  </>;
}
