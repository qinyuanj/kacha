import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../client/node_modules/playwright/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(here, process.env.OUTPUT ?? 'results.json');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const html = String.raw`<!doctype html><meta charset="utf-8"><title>Issue 122 clipboard probe</title>
<style>body{font:16px sans-serif}button{display:block;margin:4px;padding:8px}img,canvas{width:96px;height:96px;border:1px solid}#drop{width:180px;height:100px;border:2px dashed}</style>
<img id="img" src="/protected.png" draggable="true">
<canvas id="canvas" width="96" height="96" draggable="true"></canvas><div id="drop">drop here</div>
<button id="exec-img">exec img</button><button id="exec-canvas">exec canvas</button>
<button id="copy-event">copy event image/png</button><button id="copy-event-web">copy event web image/png</button>
<button id="async-write">async clipboard write</button><button id="data-transfer">synthetic DataTransfer</button>
<script>
const img = document.querySelector('#img');
const canvas = document.querySelector('#canvas');
const ctx = canvas.getContext('2d');
ctx.fillStyle='#ff0000';ctx.fillRect(0,0,48,96);ctx.fillStyle='#0000ff';ctx.fillRect(48,0,48,96);
window.events=[];window.dropEvents=[];
const imageDataUrl='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const pngBlobPromise=fetch('/protected.png').then(r=>r.blob());
const canvasBlobPromise=new Promise(r=>canvas.toBlob(r,'image/png'));canvasBlobPromise.then(b=>window.canvasBlob=b);
function select(node){const range=document.createRange();range.selectNode(node);const selection=getSelection();selection.removeAllRanges();selection.addRange(range)}
window.apiFacts=()=>({isSecureContext,clipboardType:typeof navigator.clipboard,clipboardWriteType:typeof navigator.clipboard?.write,clipboardItemType:typeof ClipboardItem,execCommandType:typeof document.execCommand,dataTransferType:typeof DataTransfer,userAgent:navigator.userAgent});
async function run(kind){
 const entry={kind,api:apiFacts(),copyEvent:false};
 const copyHandler=e=>{entry.copyEvent=true;entry.copyTypesBefore=[...e.clipboardData.types]};
 document.addEventListener('copy',copyHandler,{once:true});
 try{
  if(kind==='exec-img'||kind==='exec-canvas'){
   const node=kind==='exec-img'?img:canvas;if(kind==='exec-img')await img.decode();select(node);entry.returnValue=document.execCommand('copy');
  }else if(kind==='copy-event'||kind==='copy-event-web'){
   await img.decode();select(img);
   document.addEventListener('copy',e=>{e.preventDefault();const type=kind==='copy-event'?'image/png':'web image/png';try{e.clipboardData.setData(type,imageDataUrl);entry.setData={type,ok:true}}catch(error){entry.setData={type,ok:false,error:String(error)}};e.clipboardData.setData('text/plain',kind);entry.copyTypesAfter=[...e.clipboardData.types]},{once:true,capture:true});
   entry.returnValue=document.execCommand('copy');
  }else if(kind==='async-write'){
   if(!navigator.clipboard?.write||typeof ClipboardItem==='undefined')throw new Error('ASYNC_CLIPBOARD_API_UNAVAILABLE');
   const item=new ClipboardItem({'image/png':pngBlobPromise});await navigator.clipboard.write([item]);entry.write='resolved';
  }else if(kind==='data-transfer'){
   const blob=await canvasBlobPromise;const dt=new DataTransfer();dt.items.add(new File([blob],'probe.png',{type:'image/png'}));
   const event=new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt});window.dispatchEvent(event);entry.dataTransfer={types:[...dt.types],files:dt.files.length,eventDispatched:window.dispatchEvent(event)};
  }
 }catch(error){entry.error={name:error.name,message:error.message,String:String(error)}}
 window.events.push(entry);document.removeEventListener('copy',copyHandler);return entry;
}
for(const id of ['exec-img','exec-canvas','copy-event','copy-event-web','async-write','data-transfer'])document.querySelector('#'+id).onclick=()=>run(id);
for(const node of [img,canvas])node.addEventListener('dragstart',e=>{e.dataTransfer.setData('image/png',imageDataUrl);if(node===canvas&&window.canvasBlob)e.dataTransfer.items.add(new File([window.canvasBlob],'canvas.png',{type:'image/png'}));window.dropEvents.push({type:'dragstart',source:node.id,types:[...e.dataTransfer.types],files:e.dataTransfer.files.length})});
const drop=document.querySelector('#drop');drop.addEventListener('dragover',e=>e.preventDefault());drop.addEventListener('drop',e=>{e.preventDefault();window.dropEvents.push({type:'drop',types:[...e.dataTransfer.types],files:e.dataTransfer.files.length})});
</script>`;

const requests=[];
function handler(req,res){
 requests.push({url:req.url,cookie:req.headers.cookie??null});
 if(req.url==='/protected.png'){
  if(req.headers.cookie?.includes('kacha_probe=valid')){res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});res.end(png)}
  else{res.writeHead(401);res.end('cookie required')}
  return;
 }
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Set-Cookie':'kacha_probe=valid; Path=/; SameSite=Lax','Cache-Control':'no-store'});res.end(html);
}
const server=http.createServer(handler);await new Promise(r=>server.listen(Number(process.env.PORT??0),'0.0.0.0',r));
const port=server.address().port;
const addresses=Object.values(os.networkInterfaces()).flat().filter(x=>x?.family==='IPv4'&&!x.internal);
if(!addresses.length)throw new Error('No non-loopback IPv4 address');
const host=addresses[0].address;
const origin=`http://${host}:${port}`;
const httpsServer=https.createServer({key:fs.readFileSync(path.join(here,'key.pem')),cert:fs.readFileSync(path.join(here,'cert.pem'))},handler);
await new Promise(r=>httpsServer.listen(0,'0.0.0.0',r));
const httpsOrigin=`https://${host}:${httpsServer.address().port}`;
console.log(JSON.stringify({origin,httpsOrigin}));

const browserPaths={
 edge:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
 brave:'C:/Program Files/BraveSoftware/Brave-Origin/Application/brave.exe',
 chrome:'C:/Program Files/Google/Chrome/Application/chrome.exe'
};
const selected=(process.env.BROWSERS??'edge,brave').split(',');
const modes=(process.env.MODES??'http,flag,https-untrusted,https').split(',');
const all={startedAt:new Date().toISOString(),os:os.version(),origin,httpsOrigin,runs:[]};
function ps(script,args=[]){return JSON.parse(execFileSync('powershell.exe',['-NoLogo','-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',path.join(here,script),...args],{encoding:'utf8',windowsHide:true}))}
function clearClipboard(){return ps('clipboard-inspect.ps1',['-Clear'])}
function inspectClipboard(){return ps('clipboard-inspect.ps1')}
async function snap(page){return await page.evaluate(()=>({api:apiFacts(),events:window.events,dropEvents:window.dropEvents}))}
async function record(run,candidate,page,operation){
 clearClipboard();const before=await snap(page);let operationError=null;
 try{await operation()}catch(error){operationError=String(error)}
 await page.waitForTimeout(400);const after=await snap(page);const clipboard=inspectClipboard();
 const entry={...run,candidate,before,operationError,after,clipboard,protectedRequests:requests.filter(r=>r.url==='/protected.png')};all.runs.push(entry);fs.writeFileSync(output,JSON.stringify(all,null,2));console.log(JSON.stringify({browser:run.browser,mode:run.mode,candidate,operationError,event:after.events.at(-1),formats:clipboard.formats,hasBitmapFormat:clipboard.hasBitmapFormat}));
}
for(const name of selected){
 const executablePath=browserPaths[name];if(!fs.existsSync(executablePath)){all.runs.push({browser:name,skipped:'browser executable not found',executablePath});continue}
 for(const mode of modes){
  const isHttps=mode==='https'||mode==='https-untrusted';const base=isHttps?httpsOrigin:origin;
  const args=['--no-first-run'];if(mode==='flag')args.push(`--unsafely-treat-insecure-origin-as-secure=${origin}`);
  let browser;
  const run={browser:name,mode,executablePath,args,origin:base};
  try{
   browser=await chromium.launch({executablePath,headless:false,args});run.actualVersion=browser.version();
   const context=await browser.newContext({ignoreHTTPSErrors:mode==='https'});const page=await context.newPage();
   if(mode==='policy'){await page.goto(name+'://policy');run.policyPage=await page.locator('body').innerText()}
   if(mode==='https-untrusted'){
    clearClipboard();try{await page.goto(base,{timeout:15000});run.navigation='unexpected success'}catch(error){run.navigation=String(error)};run.clipboard=inspectClipboard();all.runs.push(run);continue;
   }
   await page.goto(base);await page.waitForFunction(()=>document.querySelector('#img').complete&&document.querySelector('#img').naturalWidth>0);
   if(mode==='http'){
    for(const candidate of ['exec-img','exec-canvas','copy-event','copy-event-web','async-write','data-transfer']){
     await record(run,candidate,page,async()=>page.click('#'+candidate));
     await page.reload();await page.waitForFunction(()=>document.querySelector('#img').complete&&document.querySelector('#img').naturalWidth>0);
    }
    await record(run,'native-drag-canvas',page,async()=>{const box=await page.locator('#canvas').boundingBox();const drop=await page.locator('#drop').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(drop.x+drop.width/2,drop.y+drop.height/2,{steps:12});await page.mouse.up()});
    await page.reload();await page.waitForFunction(()=>document.querySelector('#img').complete&&document.querySelector('#img').naturalWidth>0);
    await record(run,'native-context-menu-copy-image',page,async()=>{await page.locator('#img').click({button:'right'});await page.waitForTimeout(500);try{run.menu=ps('invoke-copy-image-menu.ps1')}catch(error){run.menu={error:String(error),stdout:error.stdout,stderr:error.stderr};await page.keyboard.press('Escape');throw new Error('Native Copy image menu invocation failed')}});
   }else{
    await record(run,'async-write',page,async()=>page.click('#async-write'));
   }
  }catch(error){run.fatal=String(error);all.runs.push(run);console.error(name,mode,error)}finally{if(browser)await browser.close()}
 }
}
all.finishedAt=new Date().toISOString();fs.writeFileSync(output,JSON.stringify(all,null,2));server.close();httpsServer.close();
