import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { MessageCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export default function ChatButton() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [unreadCount, setUnreadCount] = useState(0);

  // Chat unread count DB calls stubbed - offline only

  return (
    <Button
      variant="ghost"
      size="sm"
      className="relative h-8 w-8 p-0"
      onClick={() => navigate('/chat')}
    >
      <MessageCircle className="h-4 w-4" />
      {unreadCount > 0 && (
        <Badge className="absolute -top-0.5 -right-0.5 h-4 min-w-4 px-0.5 flex items-center justify-center text-[10px]">
          {unreadCount > 99 ? '99+' : unreadCount}
        </Badge>
      )}
    </Button>
  );
}
