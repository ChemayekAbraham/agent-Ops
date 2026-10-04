import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useSignedUrl } from '@/hooks/useSignedUrl';

interface StorageImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  /** The source URL - will be auto-signed if it's a Supabase storage URL */
  src?: string | null;
  /** Fallback content to show while loading or if no src */
  fallback?: React.ReactNode;
  /** Allow click-to-expand fullscreen preview. Defaults to true. */
  expandable?: boolean;
}

/**
 * Drop-in replacement for <img> that automatically signs Supabase storage URLs.
 * Use this for product images, review images, and any other storage-backed images.
 */
export function StorageImage({ src, fallback, alt, expandable = true, onClick, className, ...props }: StorageImageProps) {
  const signedSrc = useSignedUrl(src);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!signedSrc) {
    if (fallback) return <>{fallback}</>;
    return null;
  }

  const handleClick = (e: React.MouseEvent<HTMLImageElement>) => {
    onClick?.(e);
    if (expandable && !e.defaultPrevented) {
      // Don't let the tap also trigger an ancestor card/button handler —
      // otherwise a product image opens the buy dialog AND the preview.
      e.stopPropagation();
      setOpen(true);
    }
  };

  return (
    <>
      <img
        src={signedSrc}
        alt={alt}
        onClick={handleClick}
        className={[className, expandable ? 'cursor-zoom-in' : ''].filter(Boolean).join(' ')}
        {...props}
      />
      {expandable && open && typeof document !== 'undefined' && createPortal(
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[9999] bg-background/95 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(false);
          }}
        >
          <button
            type="button"
            aria-label="Close preview"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
            className="absolute top-4 right-4 h-10 w-10 rounded-full bg-background border border-border shadow-lg flex items-center justify-center text-foreground hover:bg-muted transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={signedSrc}
            alt={alt}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[92vh] max-w-[96vw] object-contain rounded-lg shadow-2xl cursor-zoom-out"
          />
        </div>,
        document.body
      )}
    </>
  );
}
