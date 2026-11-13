import type { BoardScreen } from '@/lib/boardDisplay';

/**
 * E97: the boardroom's screen switcher, shown only when the link may switch
 * (display.can_switch, office-locked links). Large TV-readable tabs from
 * display.screens (Funders · Pipeline · Ops map), the one on screen
 * highlighted, and the Auto-rotate toggle beside them. Styled by the screen
 * it sits on: light on the funders board, dark on the ops screens.
 */
export function ScreenSwitcher({
  screens,
  active,
  rotate,
  onPick,
  onRotate,
}: {
  screens: { key: BoardScreen; label: string }[];
  active: BoardScreen;
  rotate: boolean;
  onPick: (screen: BoardScreen) => void;
  onRotate: () => void;
}) {
  return (
    <div className="screen-switch" role="group" aria-label="Screen" data-screen-switch>
      {screens.map((s) => (
        <button key={s.key} type="button" className="screen-tab" aria-pressed={active === s.key} data-screen-tab={s.key} onClick={() => onPick(s.key)}>
          {s.label}
        </button>
      ))}
      <button type="button" className="screen-rotate" aria-pressed={rotate} data-screen-rotate onClick={onRotate}>
        <span className="screen-rotate-dot" aria-hidden="true" />
        Auto-rotate
      </button>
    </div>
  );
}
