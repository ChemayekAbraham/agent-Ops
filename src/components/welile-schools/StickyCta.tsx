import { cn } from '@/lib/utils';

/**
 * App-style bottom action bar: stays on screen while the page scrolls, like a
 * phone app's primary button. Sits inside the page's padded column (-mx-3 undoes it).
 */
export default function StickyCta({ children, note, className }: { children: React.ReactNode; note?: React.ReactNode; className?: string }) {
  return (
    <div className={cn(
      'sticky bottom-0 z-10 -mx-3 mt-2 space-y-1.5 border-t border-border/60 bg-background/95 px-3 pt-3 backdrop-blur',
      'pb-[max(0.75rem,env(safe-area-inset-bottom))]',
      className,
    )}>
      {children}
      {note ? <p className="text-center text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}
