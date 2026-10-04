import { Button } from '@/components/ui/button';
import { Phone } from 'lucide-react';
import { WhatsAppRequestButton } from './WhatsAppRequestButton';
import { cn } from '@/lib/utils';

interface ContactActionsBarProps {
  userId: string;
  userName?: string;
  userPhone?: string;
  showLabels?: boolean;
  className?: string;
  compact?: boolean;
}

export function ContactActionsBar({
  userId,
  userName,
  userPhone,
  showLabels = false,
  className,
  compact = false
}: ContactActionsBarProps) {

  if (compact) {
    return (
      <div className={cn("flex items-center gap-1", className)}>
        {/* WhatsApp Request */}
        <WhatsAppRequestButton
          targetUserId={userId}
          targetName={userName}
          targetPhone={userPhone}
          size="icon"
          variant="outline"
          className="h-9 w-9"
        />

        {/* Phone Call */}
        {userPhone && (
          <Button
            variant="outline"
            size="icon"
            onClick={() => window.open(`tel:${userPhone}`, '_self')}
            className="h-9 w-9"
            title="Call"
          >
            <Phone className="h-4 w-4" />
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {/* WhatsApp Request */}
      <WhatsAppRequestButton
        targetUserId={userId}
        targetName={userName}
        targetPhone={userPhone}
        size={showLabels ? "default" : "icon"}
        variant="outline"
        showLabel={showLabels}
      />

      {/* Phone Call */}
      {userPhone && (
        <Button
          variant="outline"
          size={showLabels ? "default" : "icon"}
          onClick={() => window.open(`tel:${userPhone}`, '_self')}
          title="Call"
        >
          <Phone className="h-4 w-4" />
          {showLabels && <span className="ml-2">Call</span>}
        </Button>
      )}
    </div>
  );
}
