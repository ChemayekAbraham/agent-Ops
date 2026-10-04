import { useState } from 'react';
import { parsePhoneNumber, PhoneInfo } from '@/lib/phoneUtils';
import { MessageCircle, CheckCircle, HelpCircle, ExternalLink, Check, X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface WhatsAppPhoneLinkProps {
  phone: string | null | undefined;
  className?: string;
  showFlag?: boolean;
  showIcon?: boolean;
  size?: 'sm' | 'md';
  whatsappVerified?: boolean;
  showVerificationStatus?: boolean;
  onVerifyClick?: () => void;
}

export default function WhatsAppPhoneLink({ 
  phone, 
  className = '', 
  showFlag = true,
  showIcon = true,
  size = 'md',
  whatsappVerified = false,
  showVerificationStatus = false,
  onVerifyClick
}: WhatsAppPhoneLinkProps) {
  const textSize = size === 'sm' ? 'text-xs' : 'text-sm';

  // Email-only / imported accounts may have no phone — render a muted
  // placeholder instead of crashing on a null phone string.
  const hasPhone = typeof phone === 'string' && phone.trim().length > 0;
  if (!hasPhone) {
    return (
      <span className={`inline-flex items-center text-muted-foreground ${textSize} ${className}`}>
        No phone
      </span>
    );
  }

  const phoneInfo = parsePhoneNumber(phone);
  const iconSize = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5';
  
  return (
    <TooltipProvider>
      <div className="inline-flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={phoneInfo.whatsappLink}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className={`inline-flex items-center gap-1.5 text-foreground hover:text-[#25D366] transition-colors group ${textSize} ${className}`}
            >
              {showFlag && !phoneInfo.isUgandan && (
                <span className="text-xs" title={phoneInfo.countryName}>
                  {phoneInfo.countryFlag}
                </span>
              )}
              <span className="group-hover:underline">{phone}</span>
              {showIcon && (
                <MessageCircle className={`${iconSize} text-[#25D366] opacity-0 group-hover:opacity-100 transition-opacity`} />
              )}
            </a>
          </TooltipTrigger>
          <TooltipContent side="top" className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4 text-[#25D366]" />
            <span>
              Chat on WhatsApp
              {!phoneInfo.isUgandan && (
                <span className="text-muted-foreground ml-1">
                  ({phoneInfo.countryFlag} {phoneInfo.countryName})
                </span>
              )}
            </span>
          </TooltipContent>
        </Tooltip>
        
        {showVerificationStatus && (
          <Tooltip>
            <TooltipTrigger asChild>
              {whatsappVerified ? (
                <span className="inline-flex items-center gap-1 text-[#25D366]">
                  <CheckCircle className="h-4 w-4" />
                </span>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    // Open WhatsApp to verify manually
                    window.open(phoneInfo.whatsappLink, '_blank');
                    onVerifyClick?.();
                  }}
                  className="h-6 px-2 text-xs gap-1 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                >
                  <HelpCircle className="h-3 w-3" />
                  Verify
                </Button>
              )}
            </TooltipTrigger>
            <TooltipContent side="top">
              {whatsappVerified ? (
                <span className="text-[#25D366]">✓ Verified on WhatsApp</span>
              ) : (
                <span>Click to verify if this number is on WhatsApp</span>
              )}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  );
}

// Compact verification badge for lists with confirmation flow
export function WhatsAppVerificationBadge({ 
  verified, 
  phone,
  onVerify,
  onMarkVerified
}: { 
  verified: boolean; 
  phone: string | null | undefined;
  onVerify?: () => void;
  onMarkVerified?: () => void;
}) {
  const [showConfirm, setShowConfirm] = useState(false);
  const phoneInfo = parsePhoneNumber(phone);
  const hasPhone = typeof phone === 'string' && phone.trim().length > 0;
  if (!verified && !hasPhone) return null;
  
  if (verified) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#25D366]/10 text-[#25D366] text-xs font-medium">
              <CheckCircle className="h-3 w-3" />
              WhatsApp
            </span>
          </TooltipTrigger>
          <TooltipContent>Number verified on WhatsApp</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  
  // Show confirmation buttons after checking
  if (showConfirm) {
    return (
      <div className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <span className="text-xs text-muted-foreground mr-1">On WA?</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-[#25D366] hover:bg-[#25D366]/10"
          onClick={(e) => {
            e.stopPropagation();
            onMarkVerified?.();
            setShowConfirm(false);
          }}
          title="Yes, verified on WhatsApp"
        >
          <Check className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-destructive hover:bg-destructive/10"
          onClick={(e) => {
            e.stopPropagation();
            setShowConfirm(false);
          }}
          title="No, not on WhatsApp"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    );
  }
  
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs gap-1 text-amber-600 hover:text-amber-700 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-900/20"
            onClick={(e) => {
              e.stopPropagation();
              // Open WhatsApp chat to verify
              window.open(phoneInfo.whatsappLink, '_blank');
              onVerify?.();
              // Show confirmation after 1 second (give time for WA to open)
              setTimeout(() => setShowConfirm(true), 1000);
            }}
          >
            <ExternalLink className="h-3 w-3" />
            Check WA
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[200px] text-center">
          <p className="text-xs">Click to open WhatsApp. If chat opens, mark as verified.</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}