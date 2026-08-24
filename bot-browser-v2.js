const CLIENT_ID = 'vm3808dv10eqwc7xacypadpuzc1s2d';
const GAS_API = 'https://script.google.com/macros/s/AKfycbzROo5-SoKBzfJcVm1K71iMHcViyXXzKdiuNDEkgl60zw-AcJnxvVMODQfSYkausZ5K/exec';
const REDIRECT_URI = 'https://donson85001.github.io/punnimantobot/';
const SCOPES = ['user:read:chat','user:write:chat'];
const BUILD = 'browser-v2-20260825-0228';

const $ = id => document.getElementById(id);
const loginStatus = $('loginStatus');
const botStatus = $('botStatus');
const loginBtn = $('loginBtn');
const logoutBtn = $('logoutBtn');
const startBtn = $('startBtn');
const stopBtn = $('stopBtn');
const channelInput = $('channel');
const logEl = $('log');

let token = sessionStorage.getItem('twitch_access_token') || '';
let me = null;
let broadcaster = null;
let socket = null;
let intentionalStop = false;
let reconnectTimer = null;
let lastMessageIds = new Set();
let lastSend = '';
let lastSendAt = 0;
let songsCache = [];
let songsCacheAt = 0;
const pendingChoices = new Map();

function clean(v){return String(v ?? '').replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim()}
function log(...args){
  const line = `[${new Date().toLocaleTimeString()}] ${args.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ')}`;
  logEl.textContent += line+'\n';
  logEl.scrollTop = logEl.scrollHeight;
  console.log(...args);
}
function setBotStatus(text, ok=false){botStatus.textContent=text;botStatus.className='status '+(ok?'ok':'')}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function isHtml(text){const s=clean(text).toLowerCase();return s.startsWith('<!doctype')||s.startsWith('<html')}
function norm(s){return clean(s).toLowerCase()}
function choiceKey(room,user){return `${room}:${user}`}

function parseOAuth(){
  if(!location.hash) return;
  const p = new URLSearchParams(location.hash.slice(1));
  const t = p.get('access_token');
  const state = p.get('state');
  const expected = sessionStorage.getItem('oauth_state');
  if(t && state && expected && state === expected){
    token=t;
    sessionStorage.setItem('twitch_access_token',t);
    sessionStorage.removeItem('oauth_state');
    history.replaceState(null,'',location.pathname+location.search);
  }
}
function randomState(){const a=new Uint8Array(24);crypto.getRandomValues(a);return Array.from(a,b=>b.toString(16).padStart(2,'0')).join('')}
function login(){
  const state=randomState();sessionStorage.setItem('oauth_state',state);
  const u=new URL('https://id.twitch.tv/oauth2/authorize');
  u.searchParams.set('client_id',CLIENT_ID);
  u.searchParams.set('redirect_uri',REDIRECT_URI);
  u.searchParams.set('response_type','token');
  u.searchParams.set('scope',SCOPES.join(' '));
  u.searchParams.set('state',state);
  location.href=u.toString();
}
function logout(){
  stop();token='';me=null;broadcaster=null;sessionStorage.removeItem('twitch_access_token');
  loginStatus.textContent='尚未登入';loginStatus.className='status';startBtn.disabled=true;log('已清除登入');
}

async function helix(path,opt={}){
  const res=await fetch('https://api.twitch.tv/helix'+path,{
    ...opt,
    headers:{'Authorization':'Bearer '+token,'Client-Id':CLIENT_ID,'Content-Type':'application/json',...(opt.headers||{})}
  });
  const text=await res.text();
  let data={};try{data=text?JSON.parse(text):{}}catch{data={message:text}}
  if(!res.ok) throw new Error(`Twitch ${res.status}: ${data.message||text}`);
  return data;
}
async function loadMe(){
  const d=await helix('/users');
  me=d.data?.[0];if(!me) throw new Error('無法取得登入帳號');
  loginStatus.textContent=`${me.display_name} (${me.login})`;loginStatus.className='status ok';startBtn.disabled=false;
  log('Twitch 登入成功：',me.login);
}
async function getBroadcaster(login){
  const d=await helix('/users?login='+encodeURIComponent(login));
  const u=d.data?.[0];if(!u) throw new Error('找不到頻道：'+login);return u;
}

async function gas(action,payload=null){
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),30000);
  try{
    const u=new URL(GAS_API);
    u.searchParams.set('action',action);
    if(payload && typeof payload==='object'){
      u.searchParams.set('payload',JSON.stringify(payload));
      Object.entries(payload).forEach(([k,v])=>{if(v!==undefined&&v!==null)u.searchParams.set(k,String(v))});
    }
    u.searchParams.set('_',String(Date.now()));
    const res=await fetch(u.toString(),{method:'GET',cache:'no-store',redirect:'follow',signal:ctrl.signal});
    const raw=(await res.text()).trim();
    log('GAS_STATUS',res.status,action);
    log('GAS_TEXT',clean(raw).slice(0,250));
    if(!res.ok) throw new Error(`GAS HTTP ${res.status}`);
    if(!raw) throw new Error('GAS 空白回應');
    if(isHtml(raw)) throw new Error('GAS 回傳 HTML');
    if(raw.startsWith('ERR:')) throw new Error(raw);
    let data;
    try{data=JSON.parse(raw)}catch{throw new Error('GAS 回傳不是 JSON：'+clean(raw).slice(0,120))}
    if(data && !Array.isArray(data) && data.ok===false) throw new Error(data.error||data.message||'GAS 操作失敗');
    return data;
  }finally{clearTimeout(timer)}
}

async function getSongs(force=false){
  if(!force && songsCache.length && Date.now()-songsCacheAt<60000) return songsCache;
  const d=await gas('songs');
  songsCache=Array.isArray(d)?d:(Array.isArray(d?.data)?d.data:[]);
  songsCacheAt=Date.now();
  log('SONGS_LOADED',songsCache.length);
  return songsCache;
}
function findSongs(list,q){
  const needle=norm(q);
  if(!needle)return[];
  const exact=list.filter(s=>norm(s.title)===needle);
  if(exact.length)return exact.slice(0,9);
  return list.filter(s=>norm(s.title).includes(needle)||norm(s.artist).includes(needle)||norm(s.subtag).includes(needle)).slice(0,9);
}
async function addSong(song,user){
  const res=await gas('queue_add',{songId:song.id});
  if(!res || res.ok===false) throw new Error(res?.error||'加入 Queue 失敗');
  return `@${user} 已加入：${song.title}${song.artist?` - ${song.artist}`:''}`;
}

async function say(msg){
  let text=clean(msg).slice(0,430);if(!text||!me||!broadcaster)return;
  if(text===lastSend) text+=' .';
  const wait=Math.max(0,900-(Date.now()-lastSendAt));if(wait)await sleep(wait);
  await helix('/chat/messages',{method:'POST',body:JSON.stringify({broadcaster_id:broadcaster.id,sender_id:me.id,message:text})});
  lastSend=text;lastSendAt=Date.now();log('BOT_SAY',text);
}

async function handleChat(event){
  if(!event)return;
  const user=clean(event.chatter_user_login||event.chatter_user_name||'chat');
  const room=broadcaster.login.toLowerCase();
  const text=clean(event.message?.text||'');
  log('CHAT_IN',user,text);

  if(text==='!bot健康'||text==='!bothealth'){
    try{const all=await getSongs(true);await say(`@${user} bot在線，Twitch監聽正常，歌單 ${all.length} 首`)}
    catch(e){log('GAS_ERROR',e.message);await say(`@${user} bot在線，但 GAS 失敗：${clean(e.message)}`)}
    return;
  }

  let pick=text.match(/^!點歌#\s*([1-9])$/);
  if(!pick) pick=text.match(/^!點歌\s+#?([1-9])$/);
  if(pick){
    const saved=pendingChoices.get(choiceKey(room,user));
    if(!saved || Date.now()-saved.at>10*60*1000){
      pendingChoices.delete(choiceKey(room,user));
      await say(`@${user} 沒有待選歌曲，請先輸入：!點歌 歌名`);
      return;
    }
    const song=saved.items[Number(pick[1])-1];
    if(!song){await say(`@${user} 沒有第 ${pick[1]} 首，請重新搜尋`);return;}
    try{
      const msg=await addSong(song,user);
      pendingChoices.delete(choiceKey(room,user));
      await say(msg);
    }catch(e){log('COMMAND_ERROR',e.message);await say(`@${user} 加入失敗：${clean(e.message)}`)}
    return;
  }

  if(text==='!點歌'){
    await say(`@${user} 用法：!點歌 歌名`);
    return;
  }

  if(text.startsWith('!點歌 ')){
    const q=clean(text.slice('!點歌 '.length));if(!q)return;
    try{
      const all=await getSongs();
      const found=findSongs(all,q);
      if(!found.length){await say(`@${user} 找不到「${q}」`);return;}
      if(found.length===1){await say(await addSong(found[0],user));return;}
      pendingChoices.set(choiceKey(room,user),{items:found,at:Date.now()});
      const menu=found.map((s,i)=>`#${i+1} ${s.title}${s.artist?`-${s.artist}`:''}`).join('｜');
      await say(`@${user} 找到 ${found.length} 首：${menu}；輸入 !點歌 #編號`);
    }catch(e){
      log('COMMAND_ERROR',e.message);
      await say(`@${user} 系統忙碌中，請再試`);
    }
  }
}

async function subscribe(sessionId){
  const body={type:'channel.chat.message',version:'1',condition:{broadcaster_user_id:broadcaster.id,user_id:me.id},transport:{method:'websocket',session_id:sessionId}};
  const d=await helix('/eventsub/subscriptions',{method:'POST',body:JSON.stringify(body)});
  log('EventSub 訂閱成功',d.data?.[0]?.status||'enabled');setBotStatus(`監聽中：${broadcaster.display_name}`,true);
}
function connect(url='wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30'){
  if(socket)try{socket.close()}catch{}
  socket=new WebSocket(url);
  socket.onopen=()=>log('WebSocket 已連線');
  socket.onmessage=async e=>{
    try{
      const m=JSON.parse(e.data);const type=m.metadata?.message_type;const mid=m.metadata?.message_id;
      if(mid){if(lastMessageIds.has(mid))return;lastMessageIds.add(mid);if(lastMessageIds.size>500)lastMessageIds=new Set(Array.from(lastMessageIds).slice(-250));}
      if(type==='session_welcome') await subscribe(m.payload.session.id);
      else if(type==='notification') await handleChat(m.payload.event);
      else if(type==='session_reconnect'){
        const u=m.payload?.session?.reconnect_url;if(u){log('Twitch 要求重新連線');const old=socket;socket=null;connect(u);setTimeout(()=>{try{old.close()}catch{}},1000)}
      }else if(type==='revocation'){log('訂閱被撤銷',m.payload?.subscription?.status);setBotStatus('訂閱被 Twitch 撤銷')}
    }catch(err){log('MESSAGE_ERROR',err.message)}
  };
  socket.onerror=()=>log('WebSocket 發生錯誤');
  socket.onclose=()=>{log('WebSocket 已斷線');if(!intentionalStop){setBotStatus('斷線，正在重連…');clearTimeout(reconnectTimer);reconnectTimer=setTimeout(()=>connect(),3000)}};
}
async function start(){
  try{
    intentionalStop=false;startBtn.disabled=true;channelInput.disabled=true;setBotStatus('啟動中…');
    const login=clean(channelInput.value).replace(/^#/,'').toLowerCase();if(!login)throw new Error('請輸入頻道');
    broadcaster=await getBroadcaster(login);log('目標頻道：',broadcaster.login);connect();stopBtn.disabled=false;
  }catch(e){log('START_FAIL',e.message);setBotStatus('啟動失敗：'+e.message);startBtn.disabled=false;channelInput.disabled=false;}
}
function stop(){
  intentionalStop=true;clearTimeout(reconnectTimer);if(socket){try{socket.close()}catch{}socket=null}stopBtn.disabled=true;startBtn.disabled=!token;channelInput.disabled=false;setBotStatus('已停止');
}

loginBtn.onclick=login;logoutBtn.onclick=logout;startBtn.onclick=start;stopBtn.onclick=stop;

(async()=>{
  log('BUILD',BUILD);
  parseOAuth();
  if(token){try{await loadMe()}catch(e){log('登入失效：',e.message);logout()}}
})();