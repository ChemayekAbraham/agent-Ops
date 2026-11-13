/// <reference types="google.maps" />
/**
 * The Google Maps script loader shared by the funders map (FunderNewRouteMap /
 * FunderV3Map) and the boardroom ops map. One script per page; the caller
 * says where the browser key comes from, so the public boardroom page can load
 * the map without the signed-in app client.
 */

let mapsPromise: Promise<typeof google.maps> | null = null;

declare global {
  interface Window {
    __initFunderNewGoogleMap?: () => void;
  }
}

export async function ensureMapsReady(): Promise<typeof google.maps> {
  const maps = window.google?.maps as (typeof google.maps & { importLibrary?: (n: string) => Promise<unknown> }) | undefined;
  if (!maps) throw new Error('Google Maps did not initialise.');
  // With loading=async the namespace can exist before Map/Marker are attached.
  if (typeof maps.Map !== 'function' && typeof maps.importLibrary === 'function') {
    await maps.importLibrary('maps');
    await maps.importLibrary('marker');
  }
  if (typeof window.google?.maps?.Map !== 'function') throw new Error('Google Maps did not initialise.');
  return window.google.maps;
}

/** Loads the Maps JavaScript API once per page with the key `resolveKey` gives; later calls share it. */
export function loadGoogleMapsWith(resolveKey: () => Promise<string>): Promise<typeof google.maps> {
  if (typeof window.google?.maps?.Map === 'function') return Promise.resolve(window.google.maps);
  if (mapsPromise) return mapsPromise;
  if (window.google?.maps) {
    mapsPromise = ensureMapsReady();
    mapsPromise.catch(() => { mapsPromise = null; });
    return mapsPromise;
  }

  const channel = import.meta.env['VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_TRACKING_ID'] as string | undefined;

  mapsPromise = resolveKey().then(
    (key) =>
      new Promise<typeof google.maps>((resolve, reject) => {
        const callbackName = '__initFunderNewGoogleMap';
        window[callbackName] = () => {
          ensureMapsReady().then(resolve, reject);
          delete window[callbackName];
        };

        const script = document.createElement('script');
        const params = new URLSearchParams({ key, loading: 'async', callback: callbackName, libraries: 'geometry' });
        if (channel) params.set('channel', channel);
        script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
        script.async = true;
        script.onerror = () => reject(new Error('Google Maps could not be loaded.'));
        document.head.appendChild(script);
      }),
  );
  mapsPromise.catch(() => {
    mapsPromise = null;
  });
  return mapsPromise;
}
