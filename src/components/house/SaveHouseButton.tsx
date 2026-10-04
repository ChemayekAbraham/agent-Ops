import { Heart, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSavedHouse } from '@/hooks/useSavedHouse';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';

interface SaveHouseButtonProps {
  houseId: string;
  variant?: 'icon' | 'full';
}

export default function SaveHouseButton({ houseId, variant = 'full' }: SaveHouseButtonProps) {
  const { user } = useAuth();
  const { saved, loading, saveCount, toggle } = useSavedHouse(houseId);

  const handleClick = () => {
    if (!user) {
      toast.error('Sign in to save houses');
      return;
    }
    toggle();
  };

  if (variant === 'icon') {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); handleClick(); }}
        disabled={loading}
        className="p-1.5 rounded-full bg-black/40 backdrop-blur-sm hover:bg-black/60 transition-colors"
      >
        {loading ? (
          <Loader2 className="h-4 w-4 text-white animate-spin" />
        ) : (
          <Heart className={`h-4 w-4 ${saved ? 'fill-red-500 text-red-500' : 'text-white'}`} />
        )}
      </button>
    );
  }

  return (
    <Button
      variant={saved ? 'default' : 'outline'}
      size="sm"
      onClick={handleClick}
      disabled={loading}
      className="gap-1.5"
    >
      {loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Heart className={`h-3.5 w-3.5 ${saved ? 'fill-current' : ''}`} />
      )}
      {saved ? 'Saved' : 'Save'}
      {saveCount > 0 && <span className="text-xs opacity-70">· {saveCount}</span>}
    </Button>
  );
}
