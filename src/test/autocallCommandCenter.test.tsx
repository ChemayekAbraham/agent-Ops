import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
import { campaignIssues } from '@/components/crm/autocall/campaignForm';
import type { AutocallCampaignInput } from '@/hooks/useVoiceAutocall';
const state = vi.hoisted(() => ({ allowed: true, campaigns: [] as unknown[], save: vi.fn().mockResolvedValue('campaign'), setStatus: vi.fn().mockResolvedValue(undefined), pause: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/hooks/useVoiceAutocall', () => ({
 useCanUseAutocall: () => state.allowed,
 useAutocallOverview: () => ({ isPending:false,error:null,refetch:vi.fn(),data:{today:'2026-10-22',system:{configured:true,channels:5,last_tick_at:new Date().toISOString(),balance_amount:100000,balance_currency:'UGX'},categories:['tenant','partner','agent','employee','general'].map(category=>({category,paused:false,active_campaigns:0,people_paused:0,today:{total:0,completed:0,no_answer:0,failed:0,live:0,queued:0,opted_out:0,talk_seconds:0,cost:0}}))} }),
 useSetCategoryPaused: () => ({isPending:false,mutateAsync:state.pause}),
 useAutocallCampaigns: () => ({isPending:false,error:null,refetch:vi.fn(),data:state.campaigns}),
 useAutocallScripts: () => ({isPending:false,error:null,refetch:vi.fn(),data:[{id:'script',name:'Greeting',version:1}]}),
 useSaveCampaign: () => ({isPending:false,mutateAsync:state.save}),
 useSetCampaignStatus: () => ({isPending:false,mutateAsync:state.setStatus}),
 useAddPeopleToCampaign: () => ({isPending:false,mutateAsync:vi.fn()}),
}));
vi.mock('@/components/cfo/UserSearchPicker',()=>({UserSearchPicker:()=>null}));
import { AutocallCommandCenter } from '@/components/crm/autocall/AutocallCommandCenter';
import { AutocallCampaigns } from '@/components/crm/autocall/AutocallCampaigns';
import { AutocallOverview } from '@/components/crm/autocall/AutocallOverview';
const base: AutocallCampaignInput = {category:'tenant',name:'Rent reminders',scriptId:'script',audienceKind:'tenant_due_today',scheduleKind:'daily',windowStart:'08:00',windowEnd:'19:00',daysOfWeek:[1,2,3,4,5,6],maxAttempts:3,retryMinutes:120};
afterEach(()=>{cleanup();vi.clearAllMocks();state.allowed=true;state.campaigns=[];});
describe('Automated Calls safeguards',()=>{
 it('accepts the exact 08:00–19:00 Monday–Saturday window',()=>{expect(campaignIssues(base)).toEqual([]);});
 it('refuses a window starting before 08:00',()=>{expect(campaignIssues({...base,windowStart:'07:59'})).not.toEqual([]);});
 it('refuses a window ending after 19:00',()=>{expect(campaignIssues({...base,windowEnd:'19:01'})).not.toEqual([]);});
 it('refuses Sunday in weekly schedules',()=>{expect(campaignIssues({...base,daysOfWeek:[0]})).not.toEqual([]);});
 it('refuses Sunday for one-time calls in Kampala',()=>{expect(campaignIssues({...base,scheduleKind:'once',startAt:'2026-10-25T08:00:00+03:00'})).not.toEqual([]);});
 it('allows a Saturday one-time call within the window',()=>{expect(campaignIssues({...base,scheduleKind:'once',startAt:'2026-10-24T08:00:00+03:00'})).toEqual([]);});
 it('refuses more than five tries',()=>{expect(campaignIssues({...base,maxAttempts:6})).not.toEqual([]);});
 it('refuses fewer than fifteen minutes between tries',()=>{expect(campaignIssues({...base,retryMinutes:14})).not.toEqual([]);});
 it('refuses more than 1440 minutes between tries',()=>{expect(campaignIssues({...base,retryMinutes:1441})).not.toEqual([]);});
 it('requires separate confirmation to start a draft campaign',async()=>{state.campaigns=[{id:'draft',category:'tenant',name:'Daily reminders',status:'draft',audience_kind:'tenant_due_today',schedule_kind:'daily',window_start:'08:00',window_end:'19:00',days_of_week:[1,2,3,4,5,6],max_attempts:3,retry_minutes:120,script_name:'Greeting',script_version:1,last_run:null}];render(<AutocallCampaigns onViewCalls={vi.fn()} onViewScript={vi.fn()}/>);fireEvent.click(screen.getByRole('button',{name:/^Start$/}));expect(state.setStatus).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:/^Confirm$/}));await waitFor(()=>expect(state.setStatus).toHaveBeenCalledWith({id:'draft',status:'active',cancelQueued:false}));});
 it('does not render engine controls for an unauthorized user',()=>{state.allowed=false;render(<AutocallCommandCenter tab="autocall-overview" onTabChange={vi.fn()}/>);expect(screen.queryByRole('button')).toBeNull();expect(state.pause).not.toHaveBeenCalled();});
 it('requires a reason before category pause is submitted',async()=>{render(<AutocallOverview/>);fireEvent.click(screen.getByRole('button',{name:'Pause all automated calls'}));expect(screen.getByRole('button',{name:'Pause calls'})).toBeDisabled();expect(state.pause).not.toHaveBeenCalled();fireEvent.change(screen.getByRole('textbox',{name:'Pause reason'}),{target:{value:'Staff requested pause'}});fireEvent.click(screen.getByRole('button',{name:'Pause calls'}));await waitFor(()=>expect(state.pause).toHaveBeenCalledWith({category:null,paused:true,reason:'Staff requested pause'}));});
 it('saving a new campaign calls save only and never starts calls',async()=>{render(<AutocallCampaigns onViewCalls={vi.fn()} onViewScript={vi.fn()}/>);fireEvent.click(screen.getByRole('button',{name:'New campaign'}));fireEvent.change(screen.getByLabelText('Name'),{target:{value:'Reminder'}});fireEvent.click(screen.getByRole('combobox',{name:'Script'}));fireEvent.click(await screen.findByRole('option',{name:'Greeting (v1)'}));fireEvent.click(screen.getByRole('button',{name:'Save draft'}));await waitFor(()=>expect(state.save).toHaveBeenCalledWith(expect.objectContaining({name:'Reminder',scriptId:'script',windowStart:'08:00',windowEnd:'19:00',daysOfWeek:[1,2,3,4,5,6]})));expect(state.setStatus).not.toHaveBeenCalled();});
});