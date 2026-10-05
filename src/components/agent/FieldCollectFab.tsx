import { useEffect, useState } from 'react';
import { Banknote, WifiOff } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { getQueuedEntries } from '@/lib/fieldCollectStore';
import { cn } from '@/lib/utils';

interface FieldCollectFabProps {
  onClick: () => void;
}

/** Floating action button for offline field collection. Shows pending-sync count. */
export function FieldCollectFab({ onClick }: FieldCollectFabProps) {
  const { user } = useAuth();
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true);

  useEffect(() => {
    const refresh = async () => {
      if (!user?.id) return;
      try {
        const q = await getQueuedEntries(user.id);
        setPending(q.length);
      } catch { /* ignore */ }
    };
    refresh();
    const t = setInterval(refresh, 5000);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      clearInterval(t);
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, [user?.id]);

  return (
    <button
      onClick={onClick}
      aria-label="Field collect — record offline payment"
      className={cn(
        'fixed z-40 right-4 md:right-6 fab-shrink-landscape',
        'h-14 px-5 rounded-full shadow-lg shadow-primary/30',
        'bg-primary text-primary-foreground',
        'flex items-center gap-2 font-semibold text-sm',
        'active:scale-[0.96] transition-all touch-manipulation',
        'border-2 border-background'
      )}
      style={{ WebkitTapHighlightColor: 'transparent', bottom: 'var(--fab-bottom)' }}
    >
      <Banknote className="h-5 w-5" />
      <span>Field Collect</span>
      {!online && <WifiOff className="h-3.5 w-3.5 opacity-80" />}
      {pending > 0 && (
        <span className="ml-1 inline-flex items-center justify-center min-w-[22px] h-5 px-1.5 rounded-full bg-amber-500 text-amber-950 text-[10px] font-bold">
          {pending}
        </span>
      )}
    </button>
  );
}

export default FieldCollectFab;