/**
 * Shared browser GPS capture for agent field actions.
 *
 * Renewals (and any other flow that needs the property pin) fall back to a
 * fresh on-the-spot capture when the platform has no GPS on record for the
 * property. Errors are plain-language so they can be shown to an agent as-is.
 */
export interface CapturedGps {
  latitude: number;
  longitude: number;
  accuracy: number | null;
}

export function isGpsRequiredError(message: unknown): boolean {
  const raw = typeof message === 'string' ? message : String((message as any)?.message ?? '');
  return raw.includes('GPS_REQUIRED') || raw.includes('RENT_REQUEST_GPS_REQUIRED');
}

function readPosition(options: PositionOptions): Promise<CapturedGps> {
  return new Promise<CapturedGps>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: typeof pos.coords.accuracy === 'number' ? pos.coords.accuracy : null,
      }),
      reject,
      options,
    );
  });
}

/**
 * Staged capture so weak-signal phones stop timing out:
 *  1. high accuracy, generous timeout
 *  2. network/coarse fix (no high accuracy)
 *  3. any recent cached fix (up to 5 minutes old)
 */
export async function captureGps(timeoutMs = 25000): Promise<CapturedGps> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    throw new Error('This device cannot capture GPS. Open the app in a browser that allows location access.');
  }

  const attempts: PositionOptions[] = [
    { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 30000 },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
  ];

  let lastError: any = null;
  for (const options of attempts) {
    try {
      return await readPosition(options);
    } catch (err: any) {
      lastError = err;
      // Permission denied will never succeed on a retry — fail fast.
      if (err && typeof err.code === 'number' && err.code === 1) {
        throw new Error('Location permission was blocked. Allow location for this site, then try again at the house.');
      }
    }
  }

  if (lastError && typeof lastError.code === 'number' && lastError.code === 3) {
    throw new Error('Getting your location took too long. Step outside at the house, turn on device location, then try again.');
  }
  throw new Error('Your location could not be read. Step outside at the house, turn on device location, then try again.');
}
