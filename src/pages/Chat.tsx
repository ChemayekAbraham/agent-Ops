import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useIsMobile } from '@/hooks/use-mobile';
import { useOfflineStatus } from '@/hooks/useOfflineStatus';
import { PresenceProvider } from '@/hooks/usePresence';
import ChatList from '@/components/chat/ChatList';
import ChatWindow from '@/components/chat/ChatWindow';
import OfflineBanner from '@/components/chat/OfflineBanner';
// ShareChatLinkButton removed — no public chat links
import BroadcastMessageDialog from '@/components/chat/BroadcastMessageDialog';
import { WhatsAppRequestsSheet } from '@/components/chat/WhatsAppRequestsSheet';
import { Button } from '@/components/ui/button';
import { ArrowLeft, MessageCircle, Megaphone, Home } from 'lucide-react';

import { getLastSyncTime } from '@/lib/offlineStorage';

export default function ChatPage() {
  const { user, role: currentRole, signOut } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { isOnline } = useOfflineStatus();
  const [selectedConversation, setSelectedConversation] = useState<string | null>(
    searchParams.get('conversation')
  );
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);

  useEffect(() => {
    const convId = searchParams.get('conversation');
    if (convId) {
      setSelectedConversation(convId);
    }
  }, [searchParams]);

  useEffect(() => {
    getLastSyncTime().then(setLastSyncTime);
  }, []);

  if (!user) {
    return null;
  }

  const handleSelectConversation = (id: string) => {
    setSelectedConversation(id);
    navigate(`/chat?conversation=${id}`, { replace: true });
  };

  const handleBack = () => {
    setSelectedConversation(null);
    navigate('/chat', { replace: true });
  };

  // Mobile view: show either list or conversation
  if (isMobile) {
    return (
      <PresenceProvider>
        <div className="min-h-screen bg-background flex flex-col pb-16">
          {/* Offline Banner */}
          {!isOnline && <OfflineBanner lastSyncTime={lastSyncTime} compact />}
          
          {/* Header */}
          <div className="p-4 border-b flex items-center gap-3">
            {selectedConversation ? (
              <Button variant="ghost" size="icon" onClick={handleBack}>
                <ArrowLeft className="h-5 w-5" />
              </Button>
            ) : (
              <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
                <Home className="h-5 w-5" />
              </Button>
            )}
            <h1 className="font-bold text-lg flex-1">
              {selectedConversation ? '' : 'Messages'}
            </h1>
            {!selectedConversation && (
              <>
                <WhatsAppRequestsSheet />
                <BroadcastMessageDialog 
                  trigger={
                    <Button variant="ghost" size="icon" className="text-primary">
                      <Megaphone className="h-5 w-5" />
                    </Button>
                  }
                />
              </>
            )}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-hidden">
            {selectedConversation ? (
              <ChatWindow conversationId={selectedConversation} onBack={handleBack} isOffline={!isOnline} />
            ) : (
              <ChatList onSelectConversation={handleSelectConversation} isOffline={!isOnline} />
            )}
          </div>

          
        </div>
      </PresenceProvider>
    );
  }

  // Desktop view: side by side
  return (
    <PresenceProvider>
      <div className="min-h-screen bg-background flex flex-col">
        {/* Offline Banner */}
        {!isOnline && <OfflineBanner lastSyncTime={lastSyncTime} />}
        
        <div className="flex-1 flex">
          {/* Sidebar */}
          <div className="w-80 border-r flex flex-col">
            <div className="p-4 border-b flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={() => navigate('/')} title="Back to Dashboard">
                <Home className="h-5 w-5" />
              </Button>
              <h1 className="font-bold text-lg flex-1">Messages</h1>
              <WhatsAppRequestsSheet />
              <BroadcastMessageDialog 
                trigger={
                  <Button variant="ghost" size="icon" className="text-primary">
                    <Megaphone className="h-5 w-5" />
                  </Button>
                }
              />
            </div>
            <div className="flex-1 overflow-hidden">
              <ChatList 
                onSelectConversation={handleSelectConversation} 
                selectedId={selectedConversation || undefined}
                isOffline={!isOnline}
              />
            </div>
          </div>

          {/* Main content */}
          <div className="flex-1 flex flex-col">
            {selectedConversation ? (
              <ChatWindow conversationId={selectedConversation} isOffline={!isOnline} />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
                <div className="p-6 rounded-full bg-muted mb-4">
                  <MessageCircle className="h-12 w-12" />
                </div>
                <h2 className="font-semibold text-lg mb-1">Select a conversation</h2>
                <p className="text-sm">Choose a conversation from the list to start chatting</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </PresenceProvider>
  );
}
