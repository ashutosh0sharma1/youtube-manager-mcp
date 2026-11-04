import 'dotenv/config';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {google} from 'googleapis';
import os from 'node:os';
// Lower only this CLI process; descendants keep production in the background.
if(process.env.SBS_NORMAL_PRIORITY!=='1'){try{os.setPriority(0,os.constants.priority.PRIORITY_BELOW_NORMAL);}catch{/* Some hosts disallow priority changes; concurrency remains bounded. */}}
export const root=process.cwd();
export const batch=path.resolve(process.env.SBS_BATCH_DIR||'output/shorts/batch');
export const publicRoot=path.resolve('public/shorts',path.basename(batch));
export const publicPrefix=`shorts/${path.basename(batch)}`;
export const channelId=process.env.YOUTUBE_CHANNEL_ID||'YOUR_CHANNEL_ID';
export const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
export async function readJson(file,fallback){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT'&&fallback!==undefined)return fallback;throw e;}}
export async function writeJson(file,value){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file+'.tmp',JSON.stringify(value,null,2)+'\n');for(let attempt=0;;attempt++){try{await fs.rename(file+'.tmp',file);break;}catch(e){if(!['EPERM','EBUSY','EACCES'].includes(e.code)||attempt>=3)throw e;await new Promise(resolve=>setTimeout(resolve,200*(attempt+1)));}}}
export const run=async(bin,args)=>{try{return await promisify(execFile)(bin,args,{windowsHide:true,maxBuffer:16*1024*1024});}catch(e){throw Error(`${path.basename(bin)} failed (exit ${e.code??'unknown'}); inspect local operation log rather than exposing command/network details`);}};
export async function probe(file){const {stdout}=await run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file]);return JSON.parse(stdout);}
export async function youtube(){
 const cfile=process.env.YOUTUBE_OAUTH_CLIENT_FILE||path.join(root,'.youtube-mcp/client_secret.json');
 const parsed=JSON.parse(await fs.readFile(cfile,'utf8'));const c=parsed.installed||parsed.web;
 const auth=new google.auth.OAuth2(process.env.YOUTUBE_CLIENT_ID||c.client_id,process.env.YOUTUBE_CLIENT_SECRET||c.client_secret);
 auth.setCredentials(JSON.parse(await fs.readFile(path.join(root,'.youtube-mcp/tokens/main.json'),'utf8')));
 const api=google.youtube({version:'v3',auth});
 const channel=(await api.channels.list({part:['snippet','statistics'],mine:true})).data.items?.[0];
 if(channel?.id!==channelId)throw Error('YouTube channel identity mismatch');
 return {api,analytics:google.youtubeAnalytics({version:'v2',auth}),channel};
}
export function duration(s){const m=s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);return m?Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0):0;}
export const escapeHtml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function validatePlan(plan){
 if(plan.channelId!==channelId||!Array.isArray(plan.clips)||!plan.clips.length)throw Error('Invalid Shorts plan');
 if(new Set(plan.clips.map(x=>x.id)).size!==plan.clips.length)throw Error('Duplicate clip IDs');
 for(const c of plan.clips){
  if(!/^[0-9a-z-]{1,64}$/.test(c.id)||!/^[A-Za-z0-9_-]{11}$/.test(c.sourceId))throw Error('Invalid clip/source ID');
  if(c.hook?.length!==2||c.hook.some(x=>typeof x!=='string'||x.length>80))throw Error('Invalid hook');
  if(c.cards&&(c.cards.length!==3||c.cards.some(x=>!Array.isArray(x.lines)||x.lines.length<1||x.lines.length>2||x.lines.some(s=>typeof s!=='string'||s.length>90))))throw Error('Invalid reviewed cards');
  if(c.audioStart!=null&&(!Number.isFinite(c.audioStart)||c.audioStart<0))throw Error('Invalid audio start');
  if(c.audioEnd!=null&&(!Number.isFinite(c.audioEnd)||c.audioEnd<=(c.audioStart??0)))throw Error('Invalid audio end');
 }
 return plan;
}
