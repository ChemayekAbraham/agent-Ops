import { useState, useEffect, useCallback } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function useManagerPWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  useEffect(() => {
    // Detect iOS
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
    setIsIOS(ios);

    // Check if already installed as standalone
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches 
      || (navigator as any).standalone === true;
    setIsInstalled(isStandalone);

    // Swap manifest to manager version
    const manifestLink = document.querySelector('link[rel="manifest"]');
    const originalHref = manifestLink?.getAttribute('href');
    if (manifestLink) {
      manifestLink.setAttribute('href', '/manager-manifest.json');
    }

    // Update iOS meta tags for manager branding
    const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (appleTitle) appleTitle.setAttribute('content', 'Welile.com');

    // Listen for Android install prompt
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);

    // Listen for successful install
    const installedHandler = () => setIsInstalled(true);
    window.addEventListener('appinstalled', installedHandler);

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
      window.removeEventListener('appinstalled', installedHandler);
      // Restore original manifest
      if (manifestLink && originalHref) {
        manifestLink.setAttribute('href', originalHref);
      }
      if (appleTitle) appleTitle.setAttribute('content', 'Welile.com');
    };
  }, []);

  const installApp = useCallback(async () => {
    if (isIOS) {
      setShowIOSGuide(true);
      return false;
    }

    if (!deferredPrompt) return false;
    
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    
    if (outcome === 'accepted') {
      setIsInstalled(true);
      setDeferredPrompt(null);
      return true;
    }
    return false;
  }, [deferredPrompt, isIOS]);

  return {
    canInstall: !isInstalled && (!!deferredPrompt || isIOS),
    isInstalled,
    isIOS,
    showIOSGuide,
    setShowIOSGuide,
    installApp,
  };
}
