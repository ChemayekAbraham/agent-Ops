import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { MessageCircle } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface WhatsAppRequestButtonProps {
  targetUserId: string;
  targetName?: string;
  targetPhone?: string;
  size?: 'default' | 'sm' | 'icon';
  variant?: 'default' | 'outline' | 'ghost';
  className?: string;
  showLabel?: boolean;
}

// whatsapp_requests table removed - simplified button
export function WhatsAppRequestButton({
  targetUserId,
  targetName,
  targetPhone,
  size = 'icon',
  variant = 'ghost',
  className,
  showLabel = false
}: WhatsAppRequestButtonProps) {
  const handleClick = () => {
    toast.info('WhatsApp contact requests are currently unavailable.');
  };

  return (
    <Button
      variant={variant}
      size={size}
      onClick={handleClick}
      className={cn(className)}
      title="WhatsApp contact (unavailable)"
    >
      <MessageCircle className="h-4 w-4" />
      {showLabel && <span className="ml-2">WhatsApp</span>}
    </Button>
  );
}
