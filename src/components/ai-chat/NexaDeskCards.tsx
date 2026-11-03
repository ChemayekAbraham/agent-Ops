import { useState } from 'react';
import { useNexaDesk } from '@/hooks/useNexaDesk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { RefreshCw } from 'lucide-react';
export function NexaDeskCards({open}:{open:boolean}) {
  const desk=useNexaDesk(open);
  const [selected,setSelected]=useState<string|null>(null);
  const [response,setResponse]=useState('');
  const [teach,setTeach]=useState(false);
  const [topic,setTopic]=useState(''); const [pattern,setPattern]=useState(''); const [answer,setAnswer]=useState('');
  if(!desk.rows.length && !desk.error)return null;
  return <section className="space-y-3 border-b border-border p-4" aria-label="Benjamin’s Desk replies">
    <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Benjamin’s Desk</h3><Button size="icon" variant="ghost" aria-label="Refresh desk replies" onClick={()=>void desk.refresh()}><RefreshCw className="h-4 w-4" /></Button></div>
    {desk.error && <p role="status" className="text-sm text-muted-foreground">{desk.error}</p>}
    {desk.rows.map(row=><article key={row.id} className="space-y-2 rounded-md border border-border bg-card p-3 text-sm">
      <p className="break-words">{row.user_question}</p>
      {row.founder_response?<><h4 className="font-semibold text-success">Reply from Benjamin’s Desk</h4><p className="whitespace-pre-wrap break-words">{row.founder_response}</p></>:<p className="text-muted-foreground">Awaiting a reply</p>}
      {desk.canAnswer && row.status==='pending' && <Button variant="outline" onClick={()=>{setSelected(row.id);setResponse('');setTeach(false);}}>Reply</Button>}
      {selected===row.id && <div className="space-y-2"><Label htmlFor={`reply-${row.id}`}>Private response</Label><Textarea id={`reply-${row.id}`} value={response} onChange={e=>setResponse(e.target.value)} maxLength={4000} />
        <Label className="flex items-center gap-2"><Checkbox checked={teach} onCheckedChange={v=>setTeach(v===true)} />Save a separate general answer for Nexa</Label>
        {teach && <><Label htmlFor="nexa-topic">Topic</Label><Input id="nexa-topic" value={topic} onChange={e=>setTopic(e.target.value)} /><Label htmlFor="nexa-pattern">Question</Label><Input id="nexa-pattern" value={pattern} onChange={e=>setPattern(e.target.value)} /><Label htmlFor="nexa-public-answer">General answer (no personal details)</Label><Textarea id="nexa-public-answer" value={answer} onChange={e=>setAnswer(e.target.value)} /></>}
        <Button disabled={desk.busy || !response.trim() || (teach && (!topic.trim() || !pattern.trim() || !answer.trim()))} onClick={async()=>{if(await desk.answer(row.id,response,teach?{topic,pattern,answer}:undefined))setSelected(null);}}>Save reply</Button>
      </div>}
    </article>)}
  </section>;
}