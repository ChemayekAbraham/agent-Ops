import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Share2, Copy, Check, MessageCircle } from 'lucide-react';
import { toast } from 'sonner';
import { QRCodeSVG } from 'qrcode.react';
import { getPublicOrigin } from '@/lib/getPublicOrigin';

interface ShareChatLinkButtonProps {
  variant?: 'default' | 'ghost' | 'outline';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  className?: string;
  showLabel?: boolean;
}

export default function ShareChatLinkButton({ 
  variant = 'ghost', 
  size = 'icon',
  className = '',
  showLabel = false
}: ShareChatLinkButtonProps) {
  const { user } = useAuth();
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);

  if (!user) return null;

  const chatInviteUrl = `${getPublicOrigin()}/chat`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(chatInviteUrl);
      setCopied(true);
      toast.success('Link copied to clipboard!');
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      toast.error('Failed to copy link');
    }
  };

  const handleNativeShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Chat with me on Welile',
          text: 'Click this link to start a chat with me on Welile',
          url: chatInviteUrl,
        });
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          console.error('Error sharing:', error);
        }
      }
    }
  };

  const handleWhatsAppShare = () => {
    const message = encodeURIComponent(`Chat with me on Welile: ${chatInviteUrl}`);
    window.open(`https://wa.me/?text=${message}`, '_blank');
  };

  const canNativeShare = 'share' in navigator;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant} size={size} className={className}>
          <Share2 className="h-4 w-4" />
          {showLabel && <span className="ml-2">Share Chat Link</span>}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5 text-primary" />
            Share Your Chat Link
          </DialogTitle>
          <DialogDescription>
            Anyone with this link can start a conversation with you on Welile.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* QR Code */}
          <div className="flex justify-center p-4 bg-card rounded-lg">
            <QRCodeSVG 
              value={chatInviteUrl} 
              size={160} 
              level="M"
              includeMargin
            />
          </div>

          {/* Link display */}
          <div className="flex items-center gap-2">
            <div className="flex-1 p-3 bg-muted rounded-md text-sm font-mono truncate">
              {chatInviteUrl}
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={handleCopy}
              className="shrink-0"
            >
              {copied ? (
                <Check className="h-4 w-4 text-success" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>

          {/* Share buttons */}
          <div className="flex gap-2">
            {canNativeShare && (
              <Button onClick={handleNativeShare} className="flex-1 gap-2">
                <Share2 className="h-4 w-4" />
                Share
              </Button>
            )}
            <Button 
              onClick={handleWhatsAppShare} 
              variant="outline" 
              className="flex-1 gap-2 text-green-600 border-green-600 hover:bg-green-50"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
              </svg>
              WhatsApp
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
