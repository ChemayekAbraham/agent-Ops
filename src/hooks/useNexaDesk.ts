import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
export interface NexaEscalation { id:string; user_question:string; founder_response:string|null; status:string; created_at:string; responded_at:string|null }
/** New tables remain absent until approved SQL is applied. Errors never imply success. */
export function useNexaDesk(enabled:boolean) {
  const { user, roles } = useAuth();
  const [rows,setRows] = useState<NexaEscalation[]>([]);
  const [error,setError] = useState<string|null>(null);
  const [busy,setBusy] = useState(false);
  const canAnswer=roles.includes('super_admin'); // visibility only; RPC is the authority
  const refresh=useCallback(async()=>{
    if(!user || !enabled) {setRows([]);return;}
    const client=supabase as unknown as {from:(name:string)=>any};
    let query=client.from('nexa_human_escalations').select('id,user_question,founder_response,status,created_at,responded_at').order('created_at',{ascending:false}).limit(30);
    if(!canAnswer)query=query.eq('user_id',user.id);
    const {data,error:readError}=await query;
    if(readError) {setError('Benjamin’s Desk is not available yet.');return;}
    setError(null);setRows(data ?? []);
  },[user?.id,enabled,canAnswer]);
  useEffect(()=>{void refresh();},[refresh]);
  useEffect(()=>{
    if(!enabled || !user)return;
    const handler=()=>{void refresh();};
    window.addEventListener('focus',handler);
    const timer=window.setInterval(handler,60000);
    return()=>{window.removeEventListener('focus',handler);window.clearInterval(timer);};
  },[enabled,user?.id,refresh]);
  const answer=async(id:string,response:string,knowledge?:{topic:string;pattern:string;answer:string})=>{
    if(!user || !response.trim())return false;
    setBusy(true);
    const rpc=supabase.rpc as unknown as (name:string,args:Record<string,unknown>)=>Promise<{error:unknown}>;
    try {
      const {error:saveError}=await rpc('nexa_answer_escalation',{p_id:id,p_response:response,p_topic:knowledge?.topic ?? null,p_pattern:knowledge?.pattern ?? null,p_answer:knowledge?.answer ?? null,p_role_scope:'all'});
      if(saveError){setError('Reply was not saved. Check your access and try again.');return false;}
      await refresh();return true;
    }finally{setBusy(false);}
  };
  return {rows,error,busy,canAnswer,refresh,answer};
}