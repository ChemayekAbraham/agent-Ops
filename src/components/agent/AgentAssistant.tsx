import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AssistantChatSurface } from '@/components/ai-chat/AssistantChatSurface';

/** Mounted once by FloatingToolbar; every page can open it without creating another chat. */
export function AgentAssistant({ hideLauncher = false }: { hideLauncher?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener('open-welile-assistant', show);
    return () => window.removeEventListener('open-welile-assistant', show);
  }, []);
  return <>
    {!open && !hideLauncher && createPortal(<Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="Chat with Welile Assistant" title="Chat with Welile Assistant" aria-haspopup="dialog" className="gradient-assistant fixed bottom-[max(var(--fab-bottom-stacked),10rem)] right-4 z-[60] h-14 w-14 rounded-full border-2 border-background shadow-lg"><Sparkles className="h-6 w-6" /></Button>, document.body)}
    <AssistantChatSurface open={open} onOpenChange={setOpen} />
  </>;
}
