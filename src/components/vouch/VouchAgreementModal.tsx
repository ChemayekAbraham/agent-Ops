import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Loader2, Shield, ArrowDown, ArrowUp } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  agreementText: string;
  onAccept: () => Promise<boolean>;
  viewOnly?: boolean;
  acceptLabel?: string;
}

/**
 * Reusable scrollable agreement modal with explicit "I have read & agree" checkbox.
 * Used for lender vouch agreement, borrower disclosure, lending agent agreement, etc.
 */
export default function VouchAgreementModal({
  isOpen,
  onClose,
  title,
  subtitle,
  agreementText,
  onAccept,
  viewOnly = false,
  acceptLabel = 'I Agree',
}: Props) {
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pressed, setPressed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  const [atBottom, setAtBottom] = useState(false);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const pct = max > 0 ? Math.min(100, Math.round((el.scrollTop / max) * 100)) : 100;
    setProgress(pct);
    setAtBottom(max <= 0 || el.scrollTop >= max - 24);
  };

  useEffect(() => {
    if (!isOpen) return;
    const t = setTimeout(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
      onScroll();
    }, 60);
    return () => clearTimeout(t);
  }, [isOpen, agreementText]);

  const scrollTo = (dir: 'top' | 'bottom') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: dir === 'top' ? 0 : el.scrollHeight, behavior: 'smooth' });
  };

  const handleAccept = async () => {
    // On mobile, tapping the primary button should record agreement even if
    // the user skipped the checkbox. We check the box first, then submit.
    if (!agreed) setAgreed(true);
    setSubmitting(true);
    try {
      const ok = await onAccept();
      if (ok) {
        setAgreed(false);
        onClose();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl h-[92vh] sm:h-[85vh] max-h-[92vh] flex flex-col p-0 gap-0">
        <DialogHeader className="p-4 sm:p-5 pb-3 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2 text-sm sm:text-base pr-8">
            <Shield className="h-4 w-4 text-primary shrink-0" />
            {title}
          </DialogTitle>
          {subtitle && <DialogDescription className="text-xs">{subtitle}</DialogDescription>}
          <div className="mt-2 h-1 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-150"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-[10px] text-muted-foreground">{progress}% read</p>
        </DialogHeader>

        <div className="relative flex-1 min-h-0">
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="absolute inset-0 overflow-y-auto overscroll-contain px-4 sm:px-5 py-4"
            style={{ WebkitOverflowScrolling: 'touch' }}
          >
            <pre className="whitespace-pre-wrap text-xs sm:text-[13px] leading-relaxed font-sans text-foreground">
              {agreementText}
            </pre>
            <div className="h-6" />
          </div>

          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => scrollTo(atBottom ? 'top' : 'bottom')}
            className="absolute bottom-3 right-3 h-10 rounded-full shadow-md px-3 gap-1.5 text-xs touch-manipulation"
          >
            {atBottom ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
            {atBottom ? 'Top' : 'Skip to end'}
          </Button>
        </div>


        <DialogFooter className="p-4 pt-3 border-t flex-col sm:flex-col gap-3 items-stretch">
          {!viewOnly && (
            <label
              className="flex items-start gap-2.5 text-xs cursor-pointer p-3 rounded-md hover:bg-muted/40 active:bg-muted/60 transition-colors touch-manipulation"
              onClick={() => setAgreed((v) => !v)}
            >
              <Checkbox
                checked={agreed}
                onCheckedChange={(c) => setAgreed(c === true)}
                className="mt-0.5 h-4 w-4"
              />
              <span className="leading-relaxed select-none">
                I have read, understood, and accept the terms above. I confirm I am authorised to accept on my behalf.
              </span>
            </label>
          )}
          <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
            <Button variant="outline" size="sm" onClick={onClose} className="w-full sm:w-auto h-11 sm:h-9 touch-manipulation">
              {viewOnly ? 'Close' : 'Cancel'}
            </Button>
            {!viewOnly && (
              <Button
                size="sm"
                onClick={handleAccept}
                disabled={submitting}
                onMouseDown={() => setPressed(true)}
                onMouseUp={() => setPressed(false)}
                onTouchStart={() => setPressed(true)}
                onTouchEnd={() => setPressed(false)}
                className={`
                  w-full sm:w-auto h-11 sm:h-9 min-w-[140px]
                  touch-manipulation select-none
                  transition-transform duration-100 active:scale-95
                  ${pressed ? 'scale-95' : 'scale-100'}
                `}
              >
                {submitting && <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />}
                {acceptLabel}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
