import { MoreHorizontal, Compass, ExternalLink } from 'lucide-react';
import { useEffect } from 'react';
import { isWhatsAppIOS } from '@/hooks/useIOSCompatibility';
import { trackInstallEvent } from '@/lib/installTracking';

interface WhatsAppInstallBannerProps {
  /** When true, skip the iOS + WhatsApp UA gate (for use inside contexts that already confirmed detection). */
  force?: boolean;
  className?: string;
}

/**
 * iPhone + WhatsApp specific banner. WhatsApp's in-app WebView on iOS does
 * NOT expose "Add to Home Screen" in the Share sheet — users must first tap
 * the ⋯ menu and choose "Open in Safari". This banner surfaces that exact
 * instruction with a matching icon strip so it's unmistakable.
 */
export default function WhatsAppInstallBanner({ force, className }: WhatsAppInstallBannerProps) {
  const isIphone =
    typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  const show = force || (isIphone && isWhatsAppIOS());

  useEffect(() => {
    if (show) {
      trackInstallEvent('whatsapp_banner_shown', { platform: 'ios' });
    }
  }, [show]);

  if (!show) return null;

  return (
    <div
      role="alert"
      className={
        'rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm shadow-sm ' +
        (className ?? '')
      }
    >
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-9 h-9 rounded-full bg-emerald-500/20 flex items-center justify-center">
          {/* WhatsApp-style speech bubble */}
          <svg viewBox="0 0 24 24" className="h-5 w-5 fill-emerald-600" aria-hidden="true">
            <path d="M20.5 3.5A11.9 11.9 0 0 0 12 0C5.4 0 0 5.4 0 12c0 2.1.6 4.2 1.6 6L0 24l6.2-1.6a12 12 0 0 0 5.8 1.5h.001c6.6 0 12-5.4 12-12 0-3.2-1.2-6.2-3.5-8.4Zm-8.5 18.4a10 10 0 0 1-5-1.4l-.4-.2-3.7 1 1-3.6-.2-.4a10 10 0 0 1 15.5-12.3 10 10 0 0 1-7.2 16.9Z"/>
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-emerald-900 dark:text-emerald-100">
            You're inside WhatsApp — you can't install from here
          </p>
          <p className="mt-1 text-emerald-900/80 dark:text-emerald-100/80">
            iPhone only lets you add apps to your Home Screen from{' '}
            <span className="font-semibold">Safari</span>. Follow these two taps:
          </p>

          <ol className="mt-3 space-y-2 text-emerald-900 dark:text-emerald-100">
            <li className="flex items-center gap-2">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-600 text-white flex items-center justify-center text-xs font-bold">
                1
              </span>
              <span className="flex items-center gap-1.5">
                Tap
                <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-card dark:bg-black/40 border border-emerald-500/40 shadow-sm">
                  <MoreHorizontal className="h-4 w-4" />
                </span>
                at the bottom-right of WhatsApp
              </span>
            </li>
            <li className="flex items-center gap-2">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-600 text-white flex items-center justify-center text-xs font-bold">
                2
              </span>
              <span className="flex items-center gap-1.5">
                Choose
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-card dark:bg-black/40 border border-emerald-500/40 shadow-sm font-medium">
                  <Compass className="h-3.5 w-3.5" />
                  Open in Safari
                </span>
              </span>
            </li>
          </ol>

          <p className="mt-3 text-xs text-emerald-900/70 dark:text-emerald-100/70 flex items-center gap-1">
            <ExternalLink className="h-3 w-3" />
            Once Safari opens, tap Share → <span className="font-semibold">Add to Home Screen</span>.
          </p>
        </div>
      </div>
    </div>
  );
}