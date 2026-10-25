import { useState } from 'react';
import { Tabs,TabsList,TabsTrigger,TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { calculateSupporterSalesProjection,calculateTenantRentSalesProjection } from '@/lib/nexaSalesEngine';
import { formatFixedUGX } from '@/lib/supportPlanExample';
import { ACCESS_LIMIT_CAMPAIGN_COPY,buildAgentAccessLimitWhatsAppUrl } from '@/lib/accessLimitMessaging';
import { HandCoins,TrendingUp,Share2,MessageCircle,ArrowRight } from 'lucide-react';
export function NexaSalesHub({onAsk}:{onAsk:(question:string)=>void}) {
  const [amount,setAmount]=useState('100000');
  const [days,setDays]=useState('30');
  const value=Number(amount); const valid=Number.isFinite(value)&&value>0;
  const supporter=calculateSupporterSalesProjection(valid?value:0);
  const tenant=valid?calculateTenantRentSalesProjection(value,Number(days)):null;
  return <section aria-label="Nexa sales hub" className="border-b border-border p-4 text-sm">
    <Tabs defaultValue="supporter">
      <TabsList className="grid h-11 w-full grid-cols-4">
        <TabsTrigger value="supporter" className="min-w-0 text-xs"><HandCoins className="mr-1 h-3.5 w-3.5" />Support</TabsTrigger>
        <TabsTrigger value="tenant" className="min-w-0 text-xs">Rent</TabsTrigger>
        <TabsTrigger value="agent" className="min-w-0 text-xs">Agent</TabsTrigger>
        <TabsTrigger value="human" className="min-w-0 text-xs">Human</TabsTrigger>
      </TabsList>
      <TabsContent value="supporter" className="space-y-3">
        <Label htmlFor="nexa-support-amount">Support amount (UGX)</Label>
        <Input id="nexa-support-amount" inputMode="numeric" type="number" min="1" value={amount} onChange={e=>setAmount(e.target.value)} />
        {valid && <dl className="grid grid-cols-2 gap-3"><div><dt className="text-muted-foreground">Monthly Returns · 15%</dt><dd className="text-base font-semibold text-success">{formatFixedUGX(supporter.monthly)}</dd></div><div><dt className="text-muted-foreground">12-month Returns</dt><dd className="text-base font-semibold">{formatFixedUGX(supporter.annual)}</dd></div></dl>}
        <p className="text-xs text-muted-foreground">Illustrative projection. Approved plan terms apply.</p>
        <Button asChild className="min-h-11 w-full"><a href="/dashboard/funder-new">Choose a Support Plan<ArrowRight className="h-4 w-4" /></a></Button>
      </TabsContent>
      <TabsContent value="tenant" className="space-y-3">
        <p>{ACCESS_LIMIT_CAMPAIGN_COPY}</p>
        <div className="grid grid-cols-2 gap-2"><div><Label htmlFor="nexa-rent-amount">Rent (UGX)</Label><Input id="nexa-rent-amount" type="number" min="1" value={amount} onChange={e=>setAmount(e.target.value)} /></div><div><Label htmlFor="nexa-rent-days">Days</Label><Input id="nexa-rent-days" type="number" min="7" max="364" value={days} onChange={e=>setDays(e.target.value)} /></div></div>
        {tenant && <p>Illustrative daily payment: <strong>{formatFixedUGX(tenant.dailyRepayment)}</strong>. Final approved terms apply.</p>}
        <Button className="min-h-11" onClick={()=>onAsk('How can I grow my Rent Access Limit?')}><TrendingUp className="h-4 w-4" />Ask about rent access</Button>
      </TabsContent>
      <TabsContent value="agent" className="space-y-3"><p>{ACCESS_LIMIT_CAMPAIGN_COPY}</p><Button asChild variant="outline" className="min-h-11"><a href={buildAgentAccessLimitWhatsAppUrl()} target="_blank" rel="noopener noreferrer"><Share2 className="h-4 w-4" />Share with tenants</a></Button></TabsContent>
      <TabsContent value="human" className="space-y-3"><Button variant="outline" className="min-h-11 h-auto w-full whitespace-normal" onClick={()=>onAsk('Please escalate my question to Benjamin’s Desk.')}><MessageCircle className="h-4 w-4 shrink-0" />Ask Human / Escalate to Benjamin’s Desk</Button></TabsContent>
    </Tabs>
  </section>;
}