import { useState } from 'react';
import { PhoneCall } from 'lucide-react';
import { useCanUseAutocall } from '@/hooks/useVoiceAutocall';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AutocallOverview } from './AutocallOverview';
import { AutocallCampaigns } from './AutocallCampaigns';
import { AutocallScripts } from './AutocallScripts';
import { AutocallCallLog } from './AutocallCallLog';
import { AutocallPauses } from './AutocallPauses';
const tabs = [{id:'autocall-overview',label:'Overview'},{id:'autocall-campaigns',label:'Campaigns'},{id:'autocall-scripts',label:'Scripts'},{id:'autocall-calls',label:'Call Log'},{id:'autocall-pauses',label:'Paused People'}];
export function AutocallCommandCenter({tab,onTabChange}: {tab:string;onTabChange:(tab:string)=>void}) {
 const allowed=useCanUseAutocall();const [campaignId,setCampaignId]=useState<string|null>(null);const [scriptId,setScriptId]=useState<string|null>(null);
 if(!allowed) return <p role="alert">Automated calls are limited to CRM, CTO and super admin.</p>;
 return <div className="min-w-0 space-y-6"><header className="space-y-4"><h1 className="flex items-center gap-3 text-2xl font-semibold"><PhoneCall className="h-6 w-6 shrink-0 text-primary"/>Automated Calls</h1><Tabs value={tab} onValueChange={onTabChange}><TabsList className="h-auto w-full flex-wrap justify-start gap-1 sm:w-auto">{tabs.map(t=><TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>)}</TabsList></Tabs></header>{tab === 'autocall-overview' && <AutocallOverview/>}{tab === 'autocall-campaigns' && <AutocallCampaigns onViewCalls={id=>{setCampaignId(id);onTabChange('autocall-calls');}} onViewScript={id=>{setScriptId(id);onTabChange('autocall-scripts');}}/>}{tab === 'autocall-scripts' && <AutocallScripts initialScriptId={scriptId}/>} {tab === 'autocall-calls' && <AutocallCallLog initialCampaignId={campaignId}/>} {tab === 'autocall-pauses' && <AutocallPauses/>}</div>;
}
