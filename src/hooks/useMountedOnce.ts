import { useState } from 'react';

/**
 * True from the first render in which `flag` is true, and stays true afterwards.
 *
 * For dialogs and sheets that are loaded on demand: nothing is mounted (and no
 * data is fetched) until the first time they are needed, but once mounted they
 * stay in the tree, so the close animation still plays and reopening is instant.
 */
export function useMountedOnce(flag: boolean): boolean {
  const [seen, setSeen] = useState(flag);
  if (flag && !seen) setSeen(true);
  return seen || flag;
}
