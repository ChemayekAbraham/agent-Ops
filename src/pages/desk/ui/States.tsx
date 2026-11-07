import type { ReactNode } from 'react';
import { statusText } from '../deskTheme';
import { Skeleton } from '../Skeleton';
import { stackLayout } from './layout';

/**
 * The three states every desk section can be in besides "has data".
 *
 *   LoadingRows — shimmer bars in the shape of what is coming
 *   ErrorLine   — one red sentence: what failed, then the server's words
 *   EmptyState  — one grey sentence that says what would be here
 */

export function LoadingRows({ rows = 3, height = 40, label = 'Loading' }: { rows?: number; height?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} style={stackLayout(8)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ height, width: i === rows - 1 && rows > 1 ? '75%' : '100%' }}>
          <Skeleton className="h-full w-full" />
        </div>
      ))}
    </div>
  );
}

export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className={`text-sm ${statusText.bad}`} style={{ margin: 0 }}>
      {children}
    </p>
  );
}

export function EmptyState({ children, board = false }: { children: ReactNode; board?: boolean }) {
  return (
    <p className={`${board ? 'text-base' : 'text-sm'} leading-snug text-muted-foreground`} style={{ margin: 0, paddingTop: 4, paddingBottom: 4 }}>
      {children}
    </p>
  );
}
