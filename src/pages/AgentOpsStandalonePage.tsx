import React from 'react';
import { AgentOpsDashboard } from '@/components/executive/AgentOpsDashboard';
import { useAuth } from '@/hooks/useAuth';
import { LogOut, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function AgentOpsStandalonePage() {
  const { user, signOut } = useAuth();

  return (
    <div className="flex flex-col h-[100dvh] w-full bg-background overflow-hidden select-none">
      {/* iOS Status Bar Safe Area & Header */}
      <header className="shrink-0 z-40 bg-card/95 backdrop-blur border-b border-border/60 px-4 pt-[max(env(safe-area-inset-top),12px)] pb-3 shadow-xs">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-9 w-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-bold text-base shrink-0 shadow-xs border border-primary/20">
              <ShieldCheck className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-bold tracking-tight text-foreground truncate flex items-center gap-1.5">
                Agent Operations
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium border border-primary/20">iOS</span>
              </h1>
              <p className="text-[11px] text-muted-foreground truncate">
                {user?.email || user?.phone || 'Welile Field Ops'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              onClick={() => window.location.reload()}
              title="Refresh"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive hover:bg-destructive/10"
              onClick={() => signOut()}
              title="Sign Out"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      {/* Main Agent Ops Workspace */}
      <main className="flex-1 overflow-y-auto relative w-full pb-[env(safe-area-inset-bottom)]">
        <AgentOpsDashboard />
      </main>
    </div>
  );
}
