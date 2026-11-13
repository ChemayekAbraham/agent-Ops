import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { BOARD_ROTATE_MS, boardHash, nextBoardScreen, readBoardHash, type BoardFeed, type BoardScreen } from '@/lib/boardDisplay';
import { ScreenSwitcher } from './ScreenSwitcher';

/**
 * E97: which boardroom screen to show, and auto-rotate. Shared by the TV page
 * (BoardDisplay) and the Command Centre's Boardroom tab.
 *
 *   wanted      the screen asked for (null = the link's own); fetch with it as p_screen
 *   rotate      auto-rotate on: Funders → Pipeline → Ops map, BOARD_ROTATE_MS each
 *   pickScreen  a tap on a tab: that screen, auto-rotate off
 *   toggleRotate
 *   switcher    the ScreenSwitcher, ready for a screen's `switcher` slot; null when
 *               the feed says the link may not switch (or before the first feed)
 *
 * With `syncHash` (the TV's default) the choice is read from and written to the
 * URL hash (#funders, #pipeline, #map, #rotate) so a restart keeps it; a host
 * page that owns its own hash passes false.
 */
export function useBoardScreenControl(feed: BoardFeed | null, { syncHash = true }: { syncHash?: boolean } = {}) {
  const [wanted, setWanted] = useState<BoardScreen | null>(() => (syncHash ? readBoardHash(window.location.hash).screen : null));
  const [rotate, setRotate] = useState<boolean>(() => (syncHash ? readBoardHash(window.location.hash).rotate : false));

  const canSwitch = feed?.display.canSwitch === true;
  const shown = feed?.display.screen ?? null;
  const screens = feed?.display.screens ?? [];
  const screensKey = screens.map((s) => s.key).join(',');

  // Auto-rotate: a minute on each screen, then the next one in the server's order.
  useEffect(() => {
    if (!rotate || !canSwitch || !shown) return;
    const t = window.setTimeout(() => setWanted(nextBoardScreen(screens, shown)), BOARD_ROTATE_MS);
    return () => window.clearTimeout(t);
    // screensKey stands for the screen list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotate, canSwitch, shown, screensKey]);

  // The URL hash follows the choice, with no reload and no history entry.
  useEffect(() => {
    if (!syncHash || !canSwitch) return;
    const hash = boardHash(wanted, rotate);
    if (window.location.hash === hash || (!hash && !window.location.hash)) return;
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
  }, [wanted, rotate, canSwitch, syncHash]);

  // A tap on a tab is the room's choice: that screen, and auto-rotate off.
  const pickScreen = useCallback((s: BoardScreen) => {
    setRotate(false);
    setWanted(s);
  }, []);
  const toggleRotate = useCallback(() => setRotate((r) => !r), []);

  const switcher: ReactNode =
    feed && canSwitch ? (
      <ScreenSwitcher screens={feed.display.screens} active={feed.display.screen} rotate={rotate} onPick={pickScreen} onRotate={toggleRotate} />
    ) : null;

  return { wanted, rotate, canSwitch, pickScreen, toggleRotate, switcher };
}
