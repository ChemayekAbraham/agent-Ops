import { useState } from 'react';
import BoringAvatar from 'boring-avatars';
import { MARBLE_COLORS } from '@/components/UserAvatar';
import { cn } from '@/lib/utils';

interface AgentAvatarProps {
  src?: string | null;
  name?: string | null;
  className?: string;
}

/**
 * Agent avatar: shows the real photo when one exists and loads successfully;
 * otherwise renders a per-person generated avatar (same look as the rest of
 * the app) instead of a generic silhouette.
 */
export function AgentAvatar({ src, name, className }: AgentAvatarProps) {
  const [failed, setFailed] = useState(false);
  const showImage = !!src && !failed;

  return (
    <div
      className={cn(
        'rounded-full bg-muted flex items-center justify-center overflow-hidden shrink-0 text-muted-foreground',
        className,
      )}
    >
      {showImage ? (
        <img
          src={src as string}
          alt={name ? `${name}` : 'Agent'}
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <BoringAvatar size="100%" name={name || 'agent'} variant="marble" colors={MARBLE_COLORS} />
      )}
    </div>
  );
}

