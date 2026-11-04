import fs from 'node:fs/promises';
import path from 'node:path';
import {batch,readJson,writeJson,hash} from './lib.mjs';
export function estimateCost(pricing,input,maxOutput){
 if(!Number.isFinite(maxOutput)||maxOutput<=0)throw Error('Invalid output-token cap');
 const p=Number(pricing.prompt),c=Number(pricing.completion);
 if(!Number.isFinite(p)||!Number.isFinite(c)||p<0||c<0)throw Error('Unknown model pricing; refusing unbounded paid call');
 // UTF-8 byte count is a conservative input-token bound for this text workload.
 return (Buffer.byteLength(JSON.stringify(input))*p+maxOutput*c)*1.5;
}
export const reportedCost=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
export async function checkAvailableCredit(reservation){
 const token=process.env.OPENROUTER_API_KEY;if(!token)throw Error('Set existing OPENROUTER_API_KEY in the process environment');
 const r=await fetch('https://openrouter.ai/api/v1/credits',{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error('Cannot verify OpenRouter credit before paid call');
 const info=(await r.json()).data;const available=Number(info?.total_credits)-Number(info?.total_usage);
 if(!Number.isFinite(available)||available<reservation)throw Error('OpenRouter account has insufficient available credit; cached/local stages remain usable');
}
export async function structuredCopy(items,{model=process.env.SBS_OPENROUTER_MODEL||'z-ai/glm-5.3-flash',budget=Number(process.env.SBS_TEXT_BUDGET_USD||1)}={}){
 const cacheDir=path.join(batch,'cache/openrouter');const ledgerFile=path.join(batch,'costs.json');
 const system='You write tasteful Hindi devotional YouTube Shorts copy for Shivala Bhakti Sagar. Only draft from supplied editorial direction and source topic. No promises of cures, wealth, supernatural results, punishments for skipping, fake urgency or engagement coercion. No invented Sanskrit quotations or historical claims. Keep hooks natural and specific, one clear thought. Cards are editorial listening prompts, not transcripts. Respond in the requested JSON schema. Preserve each id exactly. Hook has two short Hindi lines (each at most 24 visible characters). Card lines are at most 32 characters. Title at most 85 characters.';
 const schema={type:'object',additionalProperties:false,properties:{clips:{type:'array',items:{type:'object',additionalProperties:false,properties:{id:{type:'string'},title:{type:'string'},hook:{type:'array',items:{type:'string'}},cards:{type:'array',items:{type:'object',additionalProperties:false,properties:{label:{type:'string'},lines:{type:'array',items:{type:'string'}}},required:['label','lines']}},description:{type:'string'}},required:['id','title','hook','cards','description']}}},required:['clips']};
 const messages=[{role:'system',content:system},{role:'user',content:JSON.stringify({instructions:'Return exactly one clip per provided input, exactly two hook lines and exactly three cards per clip. Cards should deliver the promised reflection, memory cue or devotional meaning; be distinct and concise. Do not produce a generic version of the same card thirty times.',clips:items})}];
 const reasoning={effort:'low',exclude:true};
 const key=hash({model,messages,schema,max_tokens:4500,reasoning});
 const cached=await readJson(path.join(cacheDir,key+'.json'),null);if(cached)return {...cached,cacheHit:true};
 if(!Number.isFinite(budget)||budget<=0)throw Error('Use a finite positive OpenRouter API budget');
 const ledger=await readJson(ledgerFile,{currency:'USD',budget,requests:[],notes:['Only OpenRouter text calls are accounted here. Local rendering has no LLM token charge. Codex usage and prior/built-in image generation are not priced by this ledger. Unknown API outcomes remain reserved.']});
 const failed=ledger.requests.filter(x=>x.cacheKey===key&&x.state!=='succeeded');
 if(failed.length&&!(process.argv.includes('--retry-rejected')&&failed.length===1&&failed[0].safeError?.includes('HTTP 400')))throw Error('Prior request outcome unknown or failed: review ledger before repeating paid operation');
 const catalog=(await (await fetch('https://openrouter.ai/api/v1/models')).json()).data;
 const selected=catalog.find(x=>x.id===model);if(!selected)throw Error('Configured OpenRouter model unavailable');
 if(!selected.supported_parameters?.includes('structured_outputs'))throw Error('Configured model does not advertise structured output');
 const reservation=estimateCost(selected.pricing,messages,4500);
 const committed=ledger.requests.reduce((n,x)=>n+(x.actualCost??x.reservation),0);
 if(committed+reservation>budget)throw Error('Text API budget would be exceeded');
 if(reservation>0.05)throw Error('Per-call text estimate exceeds $0.05 safety ceiling');
 const token=process.env.OPENROUTER_API_KEY;if(!token)throw Error('Set existing OPENROUTER_API_KEY in the process environment');
 await checkAvailableCredit(reservation);
 const entry={cacheKey:key,model,state:'reserved',reservation,pricing:selected.pricing,startedAt:new Date().toISOString()};ledger.requests.push(entry);await writeJson(ledgerFile,ledger);
 try{
  const r=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Title':'SBS Shorts Workshop'},body:JSON.stringify({model,messages,max_tokens:4500,temperature:0.55,reasoning,provider:{require_parameters:true,max_price:{prompt:1,completion:2}},response_format:{type:'json_schema',json_schema:{name:'sbs_copy',strict:true,schema}}}),signal:AbortSignal.timeout(120000)});
  if(!r.ok){const error=await r.json().catch(()=>({}));const message=String(error.error?.message||'No provider message').replace(/sk-[A-Za-z0-9_-]+|Bearer\s+\S+/g,'[REDACTED]').slice(0,1500);throw Error(`OpenRouter HTTP ${r.status}: ${message}`);}
  const response=await r.json();entry.generationId=response.id;entry.usage=response.usage;entry.actualCost=reportedCost(response.usage?.cost);
  const raw=response.choices?.[0]?.message?.content;if(!raw)throw Error('Empty OpenRouter copy; no automatic paid retry');
  const data=JSON.parse(raw);if(!Array.isArray(data.clips)||data.clips.length!==items.length||new Set(data.clips.map(x=>x.id)).size!==items.length||data.clips.some(x=>!items.some(i=>i.id===x.id)||x.hook?.length!==2||x.cards?.length!==3))throw Error('Copy response failed cardinality validation');
  entry.state='succeeded';entry.completedAt=new Date().toISOString();await writeJson(ledgerFile,ledger);
  const saved={data,generationId:response.id,model,cost:entry.actualCost};await writeJson(path.join(cacheDir,key+'.json'),saved);return {...saved,cacheHit:false};
 }catch(e){entry.state='failed-or-unknown';entry.safeError=e.message;await writeJson(ledgerFile,ledger);throw e;}
}
