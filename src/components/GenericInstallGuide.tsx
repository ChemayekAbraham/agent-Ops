import { X, MoreVertical, Copy, Check } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

interface GenericInstallGuideProps {
  onClose: () => void;
}

function detectBrowserSteps(): { name: string; steps: string[]; note?: string } {
  const ua = navigator.userAgent || '';
  const inApp = /FBAN|FBAV|FB_IAB|Instagram|WhatsApp|Telegram|LinkedInApp|musical_ly|BytedanceWebview|Snapchat|MicroMessenger/i.test(ua);

  if (inApp) {
    return {
      name: 'in-app browser',
      steps: [
        'Tap the menu (⋮ or ···) in the top corner of this screen.',
        'Choose "Open in browser" or "Open in Chrome".',
        'Once the page reopens in your browser, tap the menu again and choose "Install app" or "Add to Home screen".',
      ],
      note: 'Apps cannot be installed from inside WhatsApp, Facebook or Instagram browsers. Open this page in your normal browser first.',
    };
  }

  if (/SamsungBrowser/i.test(ua)) {
    return {
      name: 'Samsung Internet',
      steps: [
        'Tap the menu (☰) at the bottom right.',
        'Tap "Add page to".',
        'Choose "Home screen", then confirm.',
      ],
    };
  }

  if (/Firefox|FxiOS/i.test(ua)) {
    return {
      name: 'Firefox',
      steps: [
        'Tap the menu (⋮) in the top right.',
        'Tap "Install" or "Add to Home screen".',
        'Confirm to place Welile on your home screen.',
      ],
    };
  }

  if (/OPR|Opera/i.test(ua)) {
    return {
      name: 'Opera',
      steps: [
        'Tap the Opera menu.',
        'Choose "Add to…" then "Home screen".',
      ],
    };
  }

  return {
    name: 'your browser',
    steps: [
      'Tap the browser menu (⋮ or ···).',
      'Look for "Install app", "Add to Home screen" or "Add to phone".',
      'Confirm — Welile will appear with your other apps.',
    ],
  };
}

export default function GenericInstallGuide({ onClose }: GenericInstallGuideProps) {
  const info = detectBrowserSteps();
  const [copied, setCopied] = useState(false);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.origin);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — user can still type the address */
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-background/80 backdrop-blur-sm p-0 sm:p-4">
      <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-border bg-card p-5 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Install Welile</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Steps for {info.name}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close install instructions"
            className="w-8 h-8 rounded-full hover:bg-muted flex items-center justify-center"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        {info.note && (
          <p className="mt-3 rounded-xl bg-muted/60 p-3 text-sm text-foreground">
            {info.note}
          </p>
        )}

        <ol className="mt-4 space-y-3">
          {info.steps.map((step, i) => (
            <li key={i} className="flex gap-3 text-sm text-foreground">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-semibold">
                {i + 1}
              </span>
              <span className="leading-relaxed">{step}</span>
            </li>
          ))}
        </ol>

        <div className="mt-5 flex items-center gap-2">
          <Button onClick={copyLink} variant="outline" size="sm" className="gap-1.5">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Link copied' : 'Copy link'}
          </Button>
          <Button onClick={onClose} size="sm" className="gap-1.5">
            <MoreVertical className="h-4 w-4" />
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}