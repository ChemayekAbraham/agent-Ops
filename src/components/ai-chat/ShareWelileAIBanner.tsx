import { Share2 } from 'lucide-react';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { toast } from 'sonner';

const SHARE_URL = `${getPublicOrigin()}/ai`;

export default function ShareWelileAIBanner() {
  const handleShare = async () => {
    const text = `💰 Earn up to 15% monthly platform rewards by helping tenants pay rent in Africa!

🏠 How it works:
• You support a tenant's rent cycle (30-90 days)
• Welile manages collection & tenant placement
• You earn up to 15% monthly platform rewards

🔒 Your capital is secured by Welile's Operational Assurance — if a tenant defaults, Welile replaces them.

📈 Start with as little as UGX 50,000 and auto-compound your rewards!

🤖 Chat with Welile AI to learn more: ${SHARE_URL}`;
    
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Welile AI', text, url: SHARE_URL });
        return;
      } catch (e: any) {
        if (e.name === 'AbortError') return;
      }
    }
    
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Link copied!');
    } catch {
      toast.error('Could not copy link');
    }
  };

  return (
    <button
      onClick={handleShare}
      className="flex items-center gap-2 w-full px-3 py-2 mt-1 rounded-xl bg-primary/10 hover:bg-primary/15 border border-primary/20 transition-colors text-left"
    >
      <div className="h-7 w-7 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
        <Share2 className="h-3.5 w-3.5 text-primary" />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-semibold text-primary">Share Welile AI & earn UGX 500</p>
        <p className="text-[10px] text-muted-foreground truncate">For every person who signs up through your link</p>
      </div>
    </button>
  );
}
