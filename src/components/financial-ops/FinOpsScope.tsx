import type { ReactNode } from 'react';
import { WorkspaceThemeContext } from '@/components/ui/workspace-theme';
import './finops.css';

/** Includes lazy tools and their nested portals without theming other workspaces. */
export function FinOpsScope({ children }: { children: ReactNode }) {
  return (
    <WorkspaceThemeContext.Provider value="finops">
      <div data-workspace="finops" className="finops-workspace">{children}</div>
    </WorkspaceThemeContext.Provider>
  );
}