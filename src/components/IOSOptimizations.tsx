import { useEffect } from 'react';
import { useIOSCompatibility } from '@/hooks/useIOSCompatibility';

/**
 * Component that handles mobile-specific setup and optimizations
 * Works on both iOS and Android PWAs
 * Should be mounted once at the app root level
 * 
 * NOTE: The mobile input font-size fix is now in index.css (static CSS)
 * to avoid runtime style injection overhead.
 */
export default function IOSOptimizations() {
  const { isIOS, isStandalone, isMobile } = useIOSCompatibility();

  // Mobile-specific optimizations
  useEffect(() => {
    if (!isMobile) return;

    // Handle keyboard events (works for both iOS and Android)
    const handleVisualViewportResize = () => {
      if (window.visualViewport) {
        document.documentElement.style.setProperty(
          '--keyboard-inset-height',
          `${window.innerHeight - window.visualViewport.height}px`
        );
      }
    };

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleVisualViewportResize);
    }

    // Fix scroll restoration
    if ('scrollRestoration' in history) {
      history.scrollRestoration = 'manual';
    }

    // Handle status bar tap to scroll to top (standalone only)
    if (isStandalone) {
      const handleStatusBarTap = (e: TouchEvent) => {
        const touch = e.touches[0];
        const statusBarHeight = isIOS ? 44 : 24;
        if (touch && touch.clientY < statusBarHeight) {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      };
      document.addEventListener('touchstart', handleStatusBarTap);

      return () => {
        document.removeEventListener('touchstart', handleStatusBarTap);
        if (window.visualViewport) {
          window.visualViewport.removeEventListener('resize', handleVisualViewportResize);
        }
      };
    }

    return () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleVisualViewportResize);
      }
    };
  }, [isIOS, isStandalone, isMobile]);

  return null;
}
