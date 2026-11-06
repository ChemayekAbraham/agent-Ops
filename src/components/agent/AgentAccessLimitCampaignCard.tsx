import { TrendingUp, Share2, Mail, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ACCESS_LIMIT_CAMPAIGN_COPY, buildAgentAccessLimitWhatsAppUrl, buildAccessLimitMailtoHref, buildAgentAccessLimitEmail, buildAgentAccessLimitSmsCopy } from '@/lib/accessLimitMessaging';
export function AgentAccessLimitCampaignCard() {
  return <section aria-label="Rent access campaign" className="space-y-3 border-y border-border py-4">
    <h2 className="flex items-center gap-2 text-base font-semibold"><TrendingUp className="h-5 w-5 text-success" /> Help tenants grow rent access</h2>
    <p className="text-sm text-muted-foreground">{ACCESS_LIMIT_CAMPAIGN_COPY}</p>
    <div className="flex flex-wrap gap-2">
      <Button asChild variant="outline" className="min-h-11"><a href={buildAgentAccessLimitWhatsAppUrl()} target="_blank" rel="noopener noreferrer"><Share2 className="h-4 w-4" /> Share on WhatsApp</a></Button>
      <Button asChild variant="outline" className="min-h-11"><a href={`sms:?body=${encodeURIComponent(buildAgentAccessLimitSmsCopy())}`}><MessageSquare className="h-4 w-4" /> SMS</a></Button>
      <Button asChild variant="ghost" className="min-h-11"><a href={buildAccessLimitMailtoHref('', buildAgentAccessLimitEmail())}><Mail className="h-4 w-4" /> Email</a></Button>
    </div>
  </section>;
}