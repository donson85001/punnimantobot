const CLIENT_ID = 'vm3808dv10eqwc7xacypadpuzc1s2d';
const GAS_API = 'https://script.google.com/macros/s/AKfycbzROo5-SoKBzfJcVm1K71iMHcViyXXzKdiuNDEkgl60zw-AcJnxvVMODQfSYkausZ5K/exec';
const REDIRECT_URI = 'https://donson85001.github.io/punnimantobot/';
const SCOPES = ['user:read:chat','user:write:chat'];
const BUILD = 'browser-v2-20260825-0220';

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

function clean(v){return String(v ?? '').replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim()}
function log(...args){
  const line = `[${new Date().toLocaleTimeString()}] ${args.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ')}`;
  logEl.textContent += line+'\n';
  logEl.scrollTop = logEl.scrollHeight;
  console.log(...args);
}
function setBotStatus(text, ok=false){botStatus.textContent=text;botStatus.className='status '+(ok?'ok':'')}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function isHtml(text){
  const s=clean(text).toLowerCase();
  return s.startsWith('<!doctype') || s.startsWith('<html');
}

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
function randomState(){
  const a=new Uint8Array(24);crypto.getRandomValues(a);return Array.from(a,b=>b.toString(16).padStart(2,'0')).join('');
}
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

async function callGAS(action, params={}){
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),15000);
  try{
    const u=new URL(GAS_API);
    u.searchParams.set('action',action);
    Object.entries(params).forEach(([k,v])=>{
      if(v!==undefined && v!==null) u.searchParams.set(k,String(v));
    });
    u.searchParams.set('_',String(Date.now()));

    const res=await fetch(u.toString(),{
      method:'GET',
      cache:'no-store',
      redirect:'follow',
      signal:ctrl.signal
    });
    const txt=clean(await res.text());
    log('GAS_STATUS',res.status,action);
    log('GAS_TEXT',txt.slice(0,250));

    if(!res.ok) throw new Error(`GAS HTTP ${res.status}`);
    if(!txt) throw new Error('GAS 空白回應');
    if(isHtml(txt)) throw new Error('GAS 回傳 HTML');
    if(txt.startsWith('ERR:')) throw new Error(txt);
    return txt.slice(0,430);
  }finally{
    clearTimeout(timer);
  }
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
    try{
      const r=await callGAS('health');
      await say(`@${user} bot在線 GAS=${r}`);
    }catch(e){
      log('GAS_ERROR',e.message);
      await say(`@${user} bot在線，但 GAS 失敗：${clean(e.message)}`);
    }
    return;
  }

  let pick=text.match(/^!點歌#\s*([1-9])$/);
  if(!pick) pick=text.match(/^!點歌\s+#?([1-9])$/);
  if(pick){
    try{
      const r=await callGAS('chat_pick',{user,room,n:pick[1]});
      await say(r);
    }catch(e){
      log('COMMAND_ERROR',e.message);
      await say(`@${user} 系統忙碌中，請再試`);
    }
    return;
  }

  if(text==='!點歌'){
    await say(`@${user} 用法：!點歌 歌名`);
    return;
  }

  if(text.startsWith('!點歌 ')){
    const q=clean(text.slice('!點歌 '.length));
    if(!q)return;
    try{
      const r=await callGAS('chat_suggest',{user,room,q});
      await say(r);
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