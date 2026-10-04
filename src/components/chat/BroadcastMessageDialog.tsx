import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { MessageSquare, Send, Loader2, Users, CheckCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';

interface BroadcastMessageDialogProps {
  trigger?: React.ReactNode;
}

export default function BroadcastMessageDialog({ trigger }: BroadcastMessageDialogProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [userCount, setUserCount] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);
  const [progress, setProgress] = useState({ sent: 0, total: 0 });

  const fetchUserCount = async () => {
    setLoadingCount(true);
    try {
      const { count, error } = await supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .neq('id', user?.id || '');

      if (error) throw error;
      setUserCount(count);
    } catch (error) {
      console.error('Error fetching user count:', error);
    } finally {
      setLoadingCount(false);
    }
  };

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen) {
      fetchUserCount();
      setProgress({ sent: 0, total: 0 });
    } else {
      setMessage('');
    }
  };

  const handleSend = async () => {
    if (!user || !message.trim()) {
      toast.error('Please enter a message');
      return;
    }

    setSending(true);
    try {
      // Fetch all user IDs except current user
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('id')
        .neq('id', user.id);

      if (profilesError) throw profilesError;

      if (!profiles || profiles.length === 0) {
        toast.error('No users found to message');
        setSending(false);
        return;
      }

      const userIds = profiles.map(p => p.id);
      setProgress({ sent: 0, total: userIds.length });

      let successCount = 0;
      const batchSize = 10; // Process in smaller batches for progress updates

      for (let i = 0; i < userIds.length; i += batchSize) {
        const batch = userIds.slice(i, i + batchSize);
        
        // Process each user in the batch
        await Promise.all(batch.map(async (userId) => {
          try {
            // Check if conversation exists
            const { data: existingParticipations } = await supabase
              .from('conversation_participants')
              .select('conversation_id')
              .eq('user_id', user.id);

            let conversationId: string | null = null;

            if (existingParticipations) {
              for (const p of existingParticipations) {
                const { data: otherParticipant } = await supabase
                  .from('conversation_participants')
                  .select('user_id')
                  .eq('conversation_id', p.conversation_id)
                  .eq('user_id', userId)
                  .single();

                if (otherParticipant) {
                  conversationId = p.conversation_id;
                  break;
                }
              }
            }

            // Create conversation if it doesn't exist
            if (!conversationId) {
              const { data: newConvId, error: convError } = await supabase
                .rpc('create_direct_conversation', { other_user_id: userId });

              if (convError) {
                console.error(`Failed to create conversation with ${userId}:`, convError);
                return;
              }
              conversationId = newConvId;
            }

            // Send the message
            if (conversationId) {
              const { error: msgError } = await supabase
                .from('messages')
                .insert({
                  conversation_id: conversationId,
                  sender_id: user.id,
                  content: message.trim()
                });

              if (!msgError) {
                successCount++;
              }
            }
          } catch (err) {
            console.error(`Error sending to user ${userId}:`, err);
          }
        }));

        setProgress({ sent: Math.min(i + batchSize, userIds.length), total: userIds.length });
      }

      // Also send push notification to notify users
      try {
        await supabase.functions.invoke('send-push-notification', {
          body: {
            all: true,
            payload: {
              title: 'New Message',
              body: message.trim().substring(0, 100) + (message.length > 100 ? '...' : ''),
              type: 'info',
              icon: '/welile-logo.png',
              url: '/chat'
            }
          }
        });
      } catch (pushError) {
        console.log('Push notification attempted:', pushError);
      }

      // Notify managers about broadcast (fire-and-forget)
      supabase.functions.invoke('notify-managers', {
        body: { title: '📢 Broadcast Sent', body: `Broadcast message sent to ${successCount} users`, url: '/dashboard/manager' }
      }).catch(() => {});

      toast.success(`Message sent to ${successCount} users!`, {
        icon: <CheckCircle className="h-4 w-4 text-success" />,
      });
      
      setMessage('');
      setOpen(false);
    } catch (error) {
      console.error('Error broadcasting message:', error);
      toast.error('Failed to send broadcast message');
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" className="gap-2">
            <MessageSquare className="h-4 w-4" />
            Message All Users
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5 text-primary" />
            Broadcast Message
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            {loadingCount ? (
              <span>Loading user count...</span>
            ) : (
              <span>Send a direct message to <Badge variant="secondary">{userCount?.toLocaleString() || 0}</Badge> users</span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Message */}
          <div className="space-y-2">
            <Textarea
              placeholder="Write your broadcast message here..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={5}
              maxLength={1000}
              className="resize-none"
            />
            <p className="text-xs text-muted-foreground text-right">
              {message.length}/1000
            </p>
          </div>

          {/* Preview */}
          {message && (
            <div className="p-3 rounded-lg border bg-primary/5">
              <p className="text-xs text-muted-foreground mb-2">Preview:</p>
              <div className="flex items-start gap-2">
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
                  <MessageSquare className="h-4 w-4 text-primary" />
                </div>
                <div className="flex-1 bg-card rounded-lg p-2 shadow-sm">
                  <p className="text-sm whitespace-pre-wrap">{message}</p>
                </div>
              </div>
            </div>
          )}

          {/* Progress */}
          {sending && progress.total > 0 && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Sending messages...</span>
                <span>{progress.sent} / {progress.total}</span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div 
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${(progress.sent / progress.total) * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* Info */}
          <div className="p-3 bg-muted/50 rounded-lg">
            <p className="text-xs text-muted-foreground">
              💡 This will create or update a direct conversation with each user and send them your message. They will also receive a push notification.
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={sending}>
            Cancel
          </Button>
          <Button 
            onClick={handleSend} 
            disabled={sending || !message.trim()}
            className="gap-2"
          >
            {sending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Sending... ({progress.sent}/{progress.total})
              </>
            ) : (
              <>
                <Send className="h-4 w-4" />
                Send to All Users
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
