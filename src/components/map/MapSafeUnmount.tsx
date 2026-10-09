import { useEffect } from 'react';
import L from 'leaflet';
import { useMap } from 'react-leaflet';

/**
 * Leaflet keeps zoom/pan animations running on timers and animation frames.
 * When a modal or sheet closes mid-animation, those callbacks read
 * `_leaflet_pos` on panes that are already detached and crash.
 * The guards below make the late callbacks harmless; <MapSafeUnmount/>
 * stops every animation and listener before react-leaflet removes the map.
 */
const proto = L.Map.prototype as any;
if (!proto.__welileSafePatched) {
  proto.__welileSafePatched = true;
  const origGetPanePos = proto._getMapPanePos;
  proto._getMapPanePos = function (this: any) {
    if (!this._mapPane || !(this._mapPane as any)._leaflet_pos) return L.point(0, 0);
    return origGetPanePos.call(this);
  };
  const origZoomEnd = proto._onZoomTransitionEnd;
  if (origZoomEnd) {
    proto._onZoomTransitionEnd = function (this: any, ...args: any[]) {
      if (!this._mapPane || !this._container) return;
      return origZoomEnd.apply(this, args);
    };
  }
  const origCatchTransition = proto._catchTransitionEnd;
  if (origCatchTransition) {
    proto._catchTransitionEnd = function (this: any, ...args: any[]) {
      if (!this._mapPane || !this._container) return;
      return origCatchTransition.apply(this, args);
    };
  }
}

export function MapSafeUnmount() {
  const map = useMap();
  useEffect(() => {
    return () => {
      try {
        map.stop();
        const m = map as any;
        if (m._panAnim) m._panAnim.stop?.();
        if (m._flyToFrame) L.Util.cancelAnimFrame(m._flyToFrame);
        if (m._transitionEndTimer) clearTimeout(m._transitionEndTimer);
        m._animatingZoom = false;
        map.off();
      } catch {
        /* map already torn down */
      }
    };
  }, [map]);
  return null;
}

export default MapSafeUnmount;
