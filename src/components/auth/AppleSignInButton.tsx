import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

const AppleIcon = () => (
  <svg className="h-7 w-7" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M17.569 12.6229c-.0244-2.4655 2.0122-3.6485 2.1035-3.7052-1.1451-1.6741-2.9285-1.9037-3.5646-1.9296-1.5178-.1533-2.9617.8927-3.7307.8927-.7685 0-1.9569-.8703-3.2178-.8461-1.6552.0243-3.1817.9623-4.0333 2.4426-1.7196 2.9814-.4402 7.3939 1.2331 9.8123.8177 1.1842 1.7929 2.5145 3.0729 2.4674 1.2329-.0491 1.6981-.7982 3.1875-.7982 1.4894 0 1.9083.7982 3.2178.7739 1.3288-.0243 2.1704-1.2071 2.9827-2.3961.9394-1.3746 1.3257-2.7066 1.35-2.7756-.0296-.0136-2.5943-.9962-2.6188-3.9535zM15.106 5.4922c.6797-.8246 1.1385-1.9702.9131-3.1103-.8814.0355-1.9483.5872-2.6508 1.411-.6304.7307-1.1826 1.8966-1.0338 3.0146.9832.0764 1.9878-.4997 2.7715-1.3153z"/>
  </svg>
);

interface AppleSignInButtonProps {
  onClick: () => void;
  disabled: boolean;
  isLoading: boolean;
  variant?: 'standard' | 'icon';
}

export function AppleSignInButton({ onClick, disabled, isLoading, variant = 'standard' }: AppleSignInButtonProps) {
  if (variant === 'icon') {
    return (
      <Button
        type="button"
        size="icon"
        aria-label="Continue with Apple"
        title="Continue with Apple"
        className="h-16 w-16 shrink-0 rounded-full bg-black text-white hover:bg-black/90 hover:text-white border-2 border-black shadow-sm touch-manipulation active:scale-[0.95] transition-all [&_svg]:!size-7"
        onClick={onClick}
        disabled={disabled}
        style={{ WebkitTapHighlightColor: 'transparent' }}
      >
        {isLoading ? (
          <Loader2 className="h-7 w-7 animate-spin" />
        ) : (
          <AppleIcon />
        )}
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      className="w-full gap-3 h-14 text-base rounded-xl touch-manipulation active:scale-[0.98] bg-black text-white hover:bg-black/90 hover:text-white border-black"
      onClick={onClick}
      disabled={disabled}
      style={{ fontSize: '16px' }}
    >
      {isLoading ? (
        <Loader2 className="h-5 w-5 animate-spin" />
      ) : (
        <AppleIcon />
      )}
      Continue with Apple
    </Button>
  );
}
