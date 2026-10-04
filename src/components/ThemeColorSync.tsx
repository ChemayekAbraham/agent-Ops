import { useEffect } from 'react';
import { useTheme } from 'next-themes';

/** Keeps the mobile browser chrome colour in sync with the active theme. */
export function ThemeColorSync() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const meta = document.getElementById('theme-color-meta');
    if (meta) meta.setAttribute('content', resolvedTheme === 'dark' ? '#5b21b6' : '#7c3aed');
  }, [resolvedTheme]);

  return null;
}

export default ThemeColorSync;