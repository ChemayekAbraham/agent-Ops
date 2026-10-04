import { useCallback, useEffect, useState } from 'react';

/**
 * Per-device favorite dashboard sections, persisted in localStorage and keyed
 * by role (e.g. "cfo"). Lets a user pin the sections they use most and surface
 * them as one-tap shortcuts at the top of the dashboard on mobile.
 */
export function useFavoriteSections(role: string) {
  const storageKey = `dashboard:${role}:favoriteSections`;

  const read = useCallback((): string[] => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }, [storageKey]);

  const [favorites, setFavorites] = useState<string[]>(read);

  // Re-read when role changes.
  useEffect(() => {
    setFavorites(read());
  }, [read]);

  // Keep multiple tabs / mounts in sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === storageKey) setFavorites(read());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [storageKey, read]);

  const persist = useCallback(
    (next: string[]) => {
      setFavorites(next);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
    },
    [storageKey],
  );

  const isFavorite = useCallback((id: string) => favorites.includes(id), [favorites]);

  const toggleFavorite = useCallback(
    (id: string) => {
      persist(favorites.includes(id) ? favorites.filter((f) => f !== id) : [...favorites, id]);
    },
    [favorites, persist],
  );

  const removeFavorite = useCallback(
    (id: string) => persist(favorites.filter((f) => f !== id)),
    [favorites, persist],
  );

  return { favorites, isFavorite, toggleFavorite, removeFavorite };
}
