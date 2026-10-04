import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Heart, Send, Loader2, Sparkles, CheckCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';

interface TenantInfo {
  tenant_id: string;
  tenant_name: string;
  total_savings: number;
  months_enrolled: number;
}

interface EncouragementMessageDialogProps {
  tenant: TenantInfo;
  trigger?: React.ReactNode;
}

const ENCOURAGEMENT_TEMPLATES = [
  "Keep up the great work on your Welile Homes savings! Every payment brings you closer to homeownership. 🏠",
  "I'm proud to see your savings growing! Your dedication to building a future home is inspiring. 💪",
  "Amazing progress on your homeownership journey! You're doing an incredible job staying consistent. ⭐",
  "Your savings are growing beautifully! Remember, every contribution counts towards your dream home. 🌟",
];

export default function EncouragementMessageDialog({ tenant, trigger }: EncouragementMessageDialogProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (!isOpen) {
      setMessage('');
    }
  };

  const useTemplate = (template: string) => {
    const personalizedMessage = `Hi ${tenant.tenant_name.split(' ')[0]}! ${template}`;
    setMessage(personalizedMessage);
  };

  const handleSend = async () => {
    if (!user || !message.trim()) {
      toast.error('Please enter a message');
      return;
    }

    setSending(true);
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
            .eq('user_id', tenant.tenant_id)
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
          .rpc('create_direct_conversation', { other_user_id: tenant.tenant_id });

        if (convError) {
          console.error('Failed to create conversation:', convError);
          throw convError;
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

        if (msgError) throw msgError;

        // Notification removed - table dropped

        // Send push notification
        try {
          await supabase.functions.invoke('send-push-notification', {
            body: {
              userIds: [tenant.tenant_id],
              payload: {
                title: '💜 Encouragement from your landlord!',
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

        toast.success('Encouragement sent!', {
          icon: <CheckCircle className="h-4 w-4 text-emerald-500" />,
          description: `Your message has been delivered to ${tenant.tenant_name}`
        });

        setMessage('');
        setOpen(false);
      }
    } catch (error) {
      console.error('Error sending encouragement:', error);
      toast.error('Failed to send message');
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="ghost" size="sm" className="gap-1.5 text-purple-600 hover:text-purple-700 hover:bg-purple-50">
            <Heart className="h-4 w-4" />
            Encourage
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-purple-700 flex items-center justify-center">
              <Heart className="h-4 w-4 text-white" />
            </div>
            Send Encouragement
          </DialogTitle>
          <DialogDescription>
            Send a motivating message to <span className="font-medium text-foreground">{tenant.tenant_name}</span> about their Welile Homes progress
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Tenant Progress Summary */}
          <div className="p-3 rounded-xl bg-gradient-to-br from-purple-50 to-emerald-50 border border-purple-100">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center">
                <Sparkles className="h-5 w-5 text-purple-600" />
              </div>
              <div className="flex-1">
                <p className="font-medium text-sm">{tenant.tenant_name}</p>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="secondary" className="bg-emerald-100 text-emerald-700">
                    {formatUGX(tenant.total_savings)} saved
                  </Badge>
                  <span>•</span>
                  <span>{tenant.months_enrolled} months</span>
                </div>
              </div>
            </div>
          </div>

          {/* Quick Templates */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Quick templates:</p>
            <div className="flex flex-wrap gap-2">
              {ENCOURAGEMENT_TEMPLATES.map((template, index) => (
                <Button
                  key={index}
                  variant="outline"
                  size="sm"
                  className="text-xs h-auto py-1.5 px-2"
                  onClick={() => useTemplate(template)}
                >
                  Template {index + 1}
                </Button>
              ))}
            </div>
          </div>

          {/* Message Input */}
          <div className="space-y-2">
            <Textarea
              placeholder={`Write an encouraging message for ${tenant.tenant_name.split(' ')[0]}...`}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              maxLength={500}
              className="resize-none"
            />
            <p className="text-xs text-muted-foreground text-right">
              {message.length}/500
            </p>
          </div>

          {/* Preview */}
          {message && (
            <div className="p-3 rounded-lg border bg-purple-50/50">
              <p className="text-xs text-muted-foreground mb-2">Preview:</p>
              <div className="bg-card rounded-lg p-3 shadow-sm border">
                <p className="text-sm whitespace-pre-wrap">{message}</p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={sending}>
            Cancel
          </Button>
          <Button
            onClick={handleSend}
            disabled={sending || !message.trim()}
            className="gap-2 bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-700 hover:to-purple-800"
          >
            {sending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Send className="h-4 w-4" />
                Send Encouragement
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
