import { createContext, useContext } from 'react';

/** Opt-in presentation scope. React context also follows Radix portals. */
export const WorkspaceThemeContext = createContext<string | undefined>(undefined);
export const useWorkspaceTheme = () => useContext(WorkspaceThemeContext);
export function useWorkspaceSurface(part: string) {
  const workspace = useWorkspaceTheme();
  return workspace ? { 'data-workspace': workspace, 'data-finops-part': part } : {};
}
