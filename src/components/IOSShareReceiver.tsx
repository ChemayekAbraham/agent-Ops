import { useEffect, useState, forwardRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useIOSCompatibility } from '@/hooks/useIOSCompatibility';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ExternalLink, Copy, Check, Share2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { hapticSuccess } from '@/lib/haptics';

/**
 * Handles receiving shared content from iOS Share Sheet
 * When users share links TO the Welile PWA
 */
const IOSShareReceiver = forwardRef<HTMLDivElement>(function IOSShareReceiver(_props, _ref) {
  const { isIOS } = useIOSCompatibility();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [sharedContent, setSharedContent] = useState<{
    url?: string;
    text?: string;
    title?: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Check for shared content in URL params (from share_target in manifest)
    const url = searchParams.get('url');
    const text = searchParams.get('text');
    const title = searchParams.get('title');

    if (url || text || title) {
      setSharedContent({ url, text: text || undefined, title: title || undefined });
    }
  }, [searchParams]);

  const handleCopy = async () => {
    const content = sharedContent?.url || sharedContent?.text || '';
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      hapticSuccess();
      toast({
        title: '✓ Copied!',
        description: 'Content copied to clipboard',
      });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: 'Copy failed',
        description: 'Please try again',
        variant: 'destructive',
      });
    }
  };

  const handleOpen = () => {
    if (sharedContent?.url) {
      window.open(sharedContent.url, '_blank');
    }
  };

  const handleClose = () => {
    setSharedContent(null);
    // Clean URL params
    navigate(window.location.pathname, { replace: true });
  };

  if (!sharedContent) return null;

  return (
    <Dialog open={!!sharedContent} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="max-w-sm mx-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-5 w-5 text-primary" />
            Shared Content
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {sharedContent.title && (
            <div>
              <p className="text-sm text-muted-foreground">Title</p>
              <p className="font-medium">{sharedContent.title}</p>
            </div>
          )}

          {sharedContent.text && (
            <div>
              <p className="text-sm text-muted-foreground">Text</p>
              <p className="text-sm bg-muted p-2 rounded-lg">{sharedContent.text}</p>
            </div>
          )}

          {sharedContent.url && (
            <div>
              <p className="text-sm text-muted-foreground">Link</p>
              <p className="text-sm text-primary break-all bg-muted p-2 rounded-lg">
                {sharedContent.url}
              </p>
            </div>
          )}

          <div className="flex gap-2">
            <Button onClick={handleCopy} variant="outline" className="flex-1">
              {copied ? (
                <>
                  <Check className="h-4 w-4 mr-2 text-success" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4 mr-2" />
                  Copy
                </>
              )}
            </Button>
            
            {sharedContent.url && (
              <Button onClick={handleOpen} className="flex-1">
                <ExternalLink className="h-4 w-4 mr-2" />
                Open Link
              </Button>
            )}
          </div>

          <Button onClick={handleClose} variant="ghost" className="w-full">
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
});

export default IOSShareReceiver;

