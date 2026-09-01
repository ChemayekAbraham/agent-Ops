import { useEffect, useState } from 'react';

/** Tailwind's lg breakpoint. Below it the calling hub becomes a handset surface. */
const LG = 1024;

export function useBelowLg() {
  const [below, setBelow] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : window.innerWidth < LG,
  );

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${LG - 1}px)`);
    const onChange = () => setBelow(window.innerWidth < LG);
    mql.addEventListener('change', onChange);
    onChange();
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return below;
}
