# Why the houses map doesn't load

## Diagnosis (confirmed)

The map code is fine. Google is rejecting the API key for the domain the app is being viewed on.

Evidence from the live preview console:

```text
Google Maps JavaScript API error: RefererNotAllowedMapError
Your site URL to be authorized: https://43e6c2e1-...lovableproject.com/dashboard/tenant
```

And from the database: the `map_config` row exists but its `browser_api_key` is empty (length 0, never set). So `useGoogleMapsLoader` falls back to the Lovable-managed Maps key, and that key's HTTP-referrer allowlist does not include the preview domain (and per project memory it is restricted to browser Maps JS only).

Result: the Maps script "loads", then Google refuses to render tiles. `gm_authFailure` fires and `HousesMapView` shows the "Map unavailable / Switch to List view" fallback — which is why the Map tab looks broken.

Note: this is a configuration problem, not a bug in `HousesMapView.tsx` or `useGoogleMapsLoader.ts`. No code change can make a referrer-rejected key work.

## The fix

1. Create (or reuse) a Google Cloud API key with **Maps JavaScript API** enabled and an HTTP-referrer allowlist covering every domain the app runs on:
   - `https://welileapp.com/*`, `https://www.welileapp.com/*`
   - `https://welilereceipts.com/*`
   - `https://*.lovable.app/*`
   - `https://*.lovableproject.com/*` (preview/editor)
2. Paste it into the existing manager-only **Map key** settings card (`MapKeySettingsCard`), which already tests the key live against the current domain before saving and stores it in `map_config.browser_api_key`. Once saved, `get_maps_browser_key` serves it to all clients and the map works on every listed domain.

## Optional code follow-ups (only if you want them)

- Make the "Map unavailable" fallback explain the cause for staff (`referrer not authorised`) instead of the generic message, so this is diagnosable without opening the console.
- Migrate `google.maps.Marker` to `AdvancedMarkerElement` to clear the deprecation warning in the console (cosmetic; unrelated to the failure).

Say which of these you want and I will implement; the key itself must be supplied/configured by you since it lives in Google Cloud.
