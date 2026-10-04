import { Fingerprint } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { generateWelileAiId, isValidAiId, normalizeAiId } from '@/lib/welileAiId';
import { cn } from '@/lib/utils';

interface Props {
  /** Either pass userId (UUID) OR aiId (WEL-XXXXXX). One is required. */
  userId?: string;
  aiId?: string;
  variant?: 'chip' | 'inline' | 'mono';
  size?: 'xs' | 'sm' | 'md';
  className?: string;
  /** If true, clicking does nothing — used in PDFs/static contexts */
  staticMode?: boolean;
}

/**
 * Universal Welile AI ID badge — replaces raw UUID displays everywhere.
 * Tap → opens the holistic trust profile.
 */
export function AiIdBadge({
  userId,
  aiId,
  variant = 'chip',
  size = 'sm',
  className,
  staticMode = false,
}: Props) {
  const navigate = useNavigate();

  const resolvedAiId = aiId
    ? normalizeAiId(aiId)
    : userId
      ? generateWelileAiId(userId)
      : null;

  if (!resolvedAiId || !isValidAiId(resolvedAiId)) return null;

  const handleClick = (e: React.MouseEvent) => {
    if (staticMode) return;
    e.stopPropagation();
    navigate(`/profile/${resolvedAiId}`);
  };

  const sizeClasses = {
    xs: 'text-[10px] px-1.5 py-0.5 gap-1',
    sm: 'text-xs px-2 py-1 gap-1.5',
    md: 'text-sm px-3 py-1.5 gap-2',
  };

  const iconSize = {
    xs: 'h-2.5 w-2.5',
    sm: 'h-3 w-3',
    md: 'h-4 w-4',
  };

  if (variant === 'mono') {
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={staticMode}
        className={cn(
          'font-mono font-semibold text-primary hover:underline disabled:no-underline disabled:cursor-default',
          sizeClasses[size].split(' ')[0],
          className,
        )}
      >
        {resolvedAiId}
      </button>
    );
  }

  if (variant === 'inline') {
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={staticMode}
        className={cn(
          'inline-flex items-center font-mono font-medium text-primary hover:text-primary/80 hover:underline transition-colors disabled:no-underline disabled:cursor-default',
          sizeClasses[size],
          className,
        )}
      >
        <Fingerprint className={iconSize[size]} />
        {resolvedAiId}
      </button>
    );
  }

  // chip (default)
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={staticMode}
      className={cn(
        'inline-flex items-center rounded-full font-mono font-medium bg-primary/10 border border-primary/20 text-primary hover:bg-primary/20 transition-colors disabled:cursor-default disabled:hover:bg-primary/10',
        sizeClasses[size],
        className,
      )}
      title="View Welile Trust Profile"
    >
      <Fingerprint className={iconSize[size]} />
      {resolvedAiId}
    </button>
  );
}

export default AiIdBadge;
