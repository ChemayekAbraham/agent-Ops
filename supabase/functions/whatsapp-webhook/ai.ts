import { createOpenAI } from 'npm:@ai-sdk/openai@3';
import { streamText } from 'npm:ai@6';
import { createLovableAiGatewayRunIdFetch } from './run-id.ts';
/** One-shot WhatsApp text consumes a streamed gateway result; no account data. */
export async function buildWhatsAppAiReply(apiKey:string, instructions:string, question:string, signal:AbortSignal) {
  const gateway = createLovableAiGatewayRunIdFetch();
  const provider = createOpenAI({
    baseURL:'https://ai.gateway.lovable.dev/v1',apiKey,
    headers:{'Lovable-API-Key':apiKey,'X-Lovable-AIG-SDK':'vercel-ai-sdk'},
    fetch:gateway.fetch,
  });
  const result=streamText({
    model:provider.responses('openai/gpt-6-astra'),system:instructions,
    messages:[{role:'user',content:question}],abortSignal:signal,
    providerOptions:{openai:{forceReasoning:true,reasoningEffort:'low',reasoningSummary:'auto',store:false,include:['reasoning.encrypted_content']}},
  });
  let text='';
  for await (const part of result.fullStream) {
    if(part.type==='error') throw part.error;
    if(part.type==='text-delta')text+=part.text;
  }
  const answer=text.trim().slice(0,4000);
  if(!answer)throw new Error('Empty AI response');
  return answer;
}