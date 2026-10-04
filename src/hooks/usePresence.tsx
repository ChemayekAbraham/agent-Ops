// Presence tracking STUBBED to prevent expensive realtime connections at scale.
// At 40M+ users, presence channels would saturate the connection pool.
import { useState, useCallback, createContext, useContext, ReactNode } from 'react';

export function usePresence() {
  const [onlineUsers] = useState<Set<string>>(new Set());
  const isOnline = useCallback((_userId: string) => false, []);
  return { onlineUsers, isOnline };
}

interface PresenceContextValue {
  onlineUsers: Set<string>;
  isOnline: (userId: string) => boolean;
}

const PresenceContext = createContext<PresenceContextValue>({
  onlineUsers: new Set(),
  isOnline: () => false,
});

interface PresenceProviderProps {
  children: ReactNode;
}

export function PresenceProvider({ children }: PresenceProviderProps) {
  const presence = usePresence();
  return (
    <PresenceContext.Provider value={presence}>
      {children}
    </PresenceContext.Provider>
  );
}

export function usePresenceContext() {
  return useContext(PresenceContext);
}
