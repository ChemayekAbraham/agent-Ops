import { useContext, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { AgentAssistant } from './agent/AgentAssistant';
import { AuthContext } from '@/hooks/useAuth';
import { useFunderUiV3PreviewState } from '@/components/funder-v3/useFunderUiV3Preview';

const OPEN_OVERLAY_SELECTOR =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], .app-dialog-content, [data-radix-portal] [role="dialog"]';

/**
 * Whether a modal/sheet is open, and whether a full screen map (the funder
 * houses screen) has the page.
 *
 * `narrow` (funders_ui_v3 preview switch on): cheap by design. Dialogs and
 * sheets render in portals that are direct children of <body>, so only
 * <body>'s own child list and the portal subtrees are watched — never the app
 * tree under #root, where every render triggers a full-document query.
 * Otherwise: today's observer on the whole <body> subtree, unchanged, and
 * `mapExpanded` stays false.
 */
export function useOverlayState(narrow = true): { overlayOpen: boolean; mapExpanded: boolean } {
  const [state, setState] = useState({ overlayOpen: false, mapExpanded: false });
  useEffect(() => {
    if (!narrow) {
      const check = () => {
        const overlayOpen = Boolean(document.querySelector(OPEN_OVERLAY_SELECTOR));
        setState((prev) => (prev.overlayOpen === overlayOpen && !prev.mapExpanded ? prev : { overlayOpen, mapExpanded: false }));
      };
      check();
      const observer = new MutationObserver(check);
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-state'],
      });
      return () => observer.disconnect();
    }
    const root = document.getElementById('root');
    const check = () => {
      const overlayOpen = Boolean(document.querySelector(OPEN_OVERLAY_SELECTOR));
      const mapExpanded = document.body.dataset.mapExpanded === 'true';
      setState((prev) => (prev.overlayOpen === overlayOpen && prev.mapExpanded === mapExpanded ? prev : { overlayOpen, mapExpanded }));
    };
    const portalObserver = new MutationObserver(check);
    const watchPortals = () => {
      portalObserver.disconnect();
      for (const child of Array.from(document.body.children)) {
        if (child === root || child.tagName === 'SCRIPT' || child.tagName === 'NOSCRIPT') continue;
        portalObserver.observe(child, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
      }
    };
    const bodyObserver = new MutationObserver(() => {
      watchPortals();
      check();
    });
    bodyObserver.observe(document.body, { childList: true, attributes: true, attributeFilter: ['data-map-expanded'] });
    watchPortals();
    check();
    return () => {
      bodyObserver.disconnect();
      portalObserver.disconnect();
    };
  }, [narrow]);
  return state;
}

/** Funder screens keep the assistant icon-only (no greeting bubble) and smaller. */
export function isFunderRoute(pathname: string): boolean {
  return pathname.startsWith('/dashboard/funder');
}

/**
 * Launcher rules: dashboards only; hidden while a dialog is open (unless it is
 * the assistant's own chat) and while a full screen map/sheet has the page, so
 * it never sits over the houses list or its Fund buttons.
 */
export function launcherHidden({
  isDashboardRoute,
  overlayOpen,
  mapExpanded,
  assistantChatOpen,
}: {
  isDashboardRoute: boolean;
  overlayOpen: boolean;
  mapExpanded: boolean;
  assistantChatOpen: boolean;
}): boolean {
  if (!isDashboardRoute) return true;
  if (mapExpanded) return true;
  return overlayOpen && !assistantChatOpen;
}

export default function FloatingToolbar() {
  const location = useLocation();

  // Hide the floating FABs on settings, withdraw routes, and whenever a modal/sheet is open
  // so they can never overlap buttons, form fields, or sticky footers.
  const isSettingsOrWithdraw =
    location.pathname.startsWith('/settings') ||
    location.pathname.startsWith('/withdraw') ||
    location.pathname.startsWith('/verification-history');

  // The launcher/observer changes (icon-only on funder screens, hidden under the
  // full screen map, narrower observer) apply only with the funders_ui_v3
  // preview switch; everyone else keeps today's behaviour. The switch is read
  // over the network only on funder routes (shared with the dashboard gate);
  // elsewhere the remembered answer is used, so no boot request is added.
  const userId = useContext(AuthContext)?.user?.id ?? null;
  const onFunderRoute = isFunderRoute(location.pathname);
  const { on: funderUiV3 } = useFunderUiV3PreviewState(userId, { network: onFunderRoute });
  const { overlayOpen: modalOpen, mapExpanded } = useOverlayState(funderUiV3);

  const shouldHide = modalOpen || isSettingsOrWithdraw;

  // The Welile Assistant launcher is only for dashboard workspaces.
  const isDashboardRoute = location.pathname.startsWith('/dashboard');

  return (
    <>
      {!shouldHide && (
        <>
          {/* Desktop toolbar */}
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.5, type: 'spring', stiffness: 200 }}
            className="fixed bottom-6 right-4 z-[60] hidden md:flex flex-col items-center gap-3"
          >
            {/* WhatsApp Button */}
            <motion.a
              href="https://wa.me/256777607640"
              target="_blank"
              rel="noopener noreferrer"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.93 }}
              className={cn(
                "h-11 w-11 rounded-full",
                "bg-[#25D366] text-white",
                "shadow-lg shadow-[#25D366]/30",
                "flex items-center justify-center",
                "border border-white/15"
              )}
              aria-label="Chat on WhatsApp"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
              </svg>
            </motion.a>
          </motion.div>
        </>
      )}

      <AgentAssistant
        hideLauncher={launcherHidden({
          isDashboardRoute,
          overlayOpen: modalOpen,
          mapExpanded,
          assistantChatOpen: Boolean(document.querySelector('.assistant-chat[data-state="open"]')),
        })}
        compact={funderUiV3 && onFunderRoute}
      />
    </>
  );
}
