import { Fingerprint } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { generateWelileAiId } from '@/lib/welileAiId';

interface Props {
  variant?: 'default' | 'compact' | 'icon';
  className?: string;
}

/**
 * Header button on every dashboard — opens the user's holistic Trust Profile.
 * Tap → /profile/WEL-XXXXXX
 */
export default function AiIdButton({ variant = 'default', className }: Props) {
  const { user } = useAuth();
  const navigate = useNavigate();

  const handleClick = () => {
    if (!user) return;
    const myAiId = generateWelileAiId(user.id);
    navigate(`/profile/${myAiId}`);
  };

  if (variant === 'icon') {
    return (
      <Button
        variant="outline"
        size="icon"
        className={className}
        onClick={handleClick}
        title="My Welile Trust Profile"
      >
        <Fingerprint className="h-4 w-4" />
      </Button>
    );
  }

  if (variant === 'compact') {
    return (
      <button
        onClick={handleClick}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20 text-xs font-medium text-primary hover:bg-primary/20 transition-colors ${className || ''}`}
      >
        <Fingerprint className="h-3.5 w-3.5" />
        AI ID
      </button>
    );
  }

  return (
    <Button
      variant="outline"
      className={`gap-2 ${className || ''}`}
      onClick={handleClick}
    >
      <Fingerprint className="h-4 w-4" />
      Welile AI ID
    </Button>
  );
}
