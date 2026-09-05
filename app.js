import { FilesetResolver, HandLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/+esm";

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const camera = $("#camera");
const canvas = $("#canvas");
const ctx = canvas.getContext("2d", {alpha:false});
const stage = $("#stage");
const startBtn = $("#startCameraBtn");
const overlay = $("#permissionOverlay");
const statusText = $("#statusText");
const cameraDot = $("#cameraDot");
const chordNameEl = $("#chordName");
const keyboardDisplay = $("#keyboardChordDisplay");
const tuningText = $("#tuningText");
const audioState = $("#audioState");
const gestureState = $("#gestureState");
const instrumentName = $("#instrumentName");
const instrumentDetail = $("#instrumentDetail");
const spacingSlider = $("#spacing");
const volumeSlider = $("#volume");

const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const TIP_IDS = [4,8,12,16,20];
const FRET_TIPS = [8,12,16,20];

const INSTRUMENTS = {
  bass:{name:"貝斯",detail:"4 弦 · DEEP LOW",accent:"#38bdf8",names:["E1","A1","D2","G2"],freqs:[41.20,55,73.42,98],wave:"triangle",release:1.9},
  electric:{name:"電吉他",detail:"6 弦 · HIGH GAIN",accent:"#ef4444",names:["E2","A2","D3","G3","B3","E4"],freqs:[82.41,110,146.83,196,246.94,329.63],wave:"sawtooth",release:1.35},
  acoustic:{name:"民謠吉他",detail:"6 弦 · STEEL",accent:"#f59e0b",names:["E2","A2","D3","G3","B3","E4"],freqs:[82.41,110,146.83,196,246.94,329.63],wave:"triangle",release:1.55},
  classical:{name:"古典吉他",detail:"6 弦 · NYLON",accent:"#d6a76f",names:["E2","A2","D3","G3","B3","E4"],freqs:[82.41,110,146.83,196,246.94,329.63],wave:"sine",release:1.75}
};

const CHORDS = {
  C:{frets:[null,3,2,0,1,0],required:[[1,3],[2,2],[4,1]]},
  G:{frets:[3,2,0,0,0,3],required:[[0,3],[1,2],[5,3]]},
  D:{frets:[null,null,0,2,3,2],required:[[3,2],[4,3],[5,2]]},
  E:{frets:[0,2,2,1,0,0],required:[[1,2],[2,2],[3,1]]},
  Em:{frets:[0,2,2,0,0,0],required:[[1,2],[2,2]]},
  A:{frets:[null,0,2,2,2,0],required:[[2,2],[3,2],[4,2]]},
  Am:{frets:[null,0,2,2,1,0],required:[[2,2],[3,2],[4,1]]},
  Dm:{frets:[null,null,0,2,3,1],required:[[3,2],[4,3],[5,1]]},
  Cmaj7:{frets:[null,3,2,0,0,0]}, Dm7:{frets:[null,null,0,2,1,1]},
  Fmaj7:{frets:[null,null,3,2,1,0]}, G7:{frets:[3,2,0,0,0,1]},
  Em7:{frets:[0,2,0,0,0,0]}, A7:{frets:[null,0,2,0,2,0]},
  D7:{frets:[null,null,0,2,1,2]}, E7:{frets:[0,2,0,1,0,0]}, Am7:{frets:[null,0,2,0,1,0]}
};

const DEFAULT_MAP = {a:"Am7",s:"Cmaj7",d:"Dm7",f:"Fmaj7",g:"G7",h:"Em7",j:"A7",k:"D7",l:"E7"};
let keyMap = {...DEFAULT_MAP};
try {
  const saved = JSON.parse(localStorage.getItem("virtual-guitar-keymap-v10") || "null");
  if (saved) for (const k of Object.keys(DEFAULT_MAP)) if (CHORDS[saved[k]]) keyMap[k] = saved[k];
} catch {}

let currentInstrument = "electric";
let keyboardChord = null;
let physicalChord = null;
let activeChord = null;
let physicalCandidate = null;
let physicalCandidateSince = 0;
let lastPhysicalSeen = 0;
let audioCtx = null;
let master = null;
let handLandmarker = null;
let stream = null;
let lastVideoTime = -1;
let history = new Map();
let lastPluck = new Map();
let lastStrum = 0;

function cfg(){ return INSTRUMENTS[currentInstrument]; }
function setStatus(text,type="idle"){
  statusText.textContent=text;
  cameraDot.classList.toggle("live",type==="live");
  cameraDot.classList.toggle("error",type==="error");
}
function setInstrument(name){
  currentInstrument=name;
  const c=cfg();
  document.documentElement.style.setProperty("--accent",c.accent);
  instrumentName.textContent=c.name; instrumentDetail.textContent=c.detail;
  tuningText.textContent=`${c.name}${c.names.length}弦：${c.names.join(" · ")}`;
  $$(".instrument-btn").forEach(b=>b.classList.toggle("active",b.dataset.instrument===name));
  if(name==="bass"){physicalChord=null;keyboardChord=null;activeChord=null;}
  updateChordUI();
}
async function ensureAudio(){
  if(!audioCtx){
    const Ctx=window.AudioContext||window.webkitAudioContext;
    if(!Ctx) throw new Error("此瀏覽器不支援 Web Audio");
    audioCtx=new Ctx({latencyHint:"interactive"});
    master=audioCtx.createGain(); master.connect(audioCtx.destination);
  }
  if(audioCtx.state!=="running") await audioCtx.resume();
  master.gain.setTargetAtTime(Math.max(.02,Number(volumeSlider.value)/100)*.72,audioCtx.currentTime,.02);
  audioState.textContent=audioCtx.state==="running"?"🔊 音訊已啟用":`🔇 ${audioCtx.state}`;
  return audioCtx.state==="running";
}
function playVoice(stringIndex,fret=0,strength=.8,delay=0){
  if(!audioCtx||audioCtx.state!=="running") return;
  const c=cfg(); const base=c.freqs[stringIndex]; if(!base) return;
  const f=base*Math.pow(2,Math.max(0,fret)/12);
  const t=audioCtx.currentTime+delay;
  const o=audioCtx.createOscillator(),g=audioCtx.createGain();
  o.type=c.wave;o.frequency.setValueAtTime(f,t);
  g.gain.setValueAtTime(.0001,t);
  g.gain.exponentialRampToValueAtTime(Math.min(.36,.09+strength*.25),t+.006);
  g.gain.exponentialRampToValueAtTime(.0001,t+c.release);
  o.connect(g);g.connect(master);o.start(t);o.stop(t+c.release+.05);
}
async function testSound(){
  try{await ensureAudio();playVoice(Math.min(2,cfg().freqs.length-1),0,.95);setStatus("測試聲音正常","live");}
  catch(e){setStatus(`音訊失敗：${e.message}`,"error");}
}
function resize(){
  const r=stage.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2);
  canvas.width=Math.max(640,Math.round(r.width*d));canvas.height=Math.max(360,Math.round(r.height*d));
}
function geometry(){
  const w=canvas.width,h=canvas.height,count=cfg().names.length,scale=Number(spacingSlider.value)/100;
  const spacing=Math.max(14,h*(count===4?.052:.041)*scale);
  const centerY=h*.59,yTop=centerY-spacing*(count-1)/2;
  const neckStart=w*.075,bodyJoint=w*.665,bodyX=w*.79,stringEnd=w*.895;
  const fretLines=Array.from({length:7},(_,i)=>neckStart+(bodyJoint-neckStart)*(1-Math.pow(1-i/12,1.28)));
  return {w,h,count,spacing,centerY,yTop,stringYs:Array.from({length:count},(_,i)=>yTop+i*spacing),
    neckStart,bodyJoint,bodyX,stringEnd,fretLines,fretX1:fretLines[0],fretX2:fretLines[4],
    pluckX1:bodyX-w*.14,pluckX2:bodyX+w*.14};
}
function drawCamera(g){
  if(camera.readyState>=2){
    ctx.save();ctx.translate(g.w,0);ctx.scale(-1,1);ctx.drawImage(camera,0,0,g.w,g.h);ctx.restore();
  }else{ctx.fillStyle="#050507";ctx.fillRect(0,0,g.w,g.h);}
  ctx.fillStyle="rgba(0,0,0,.22)";ctx.fillRect(0,0,g.w,g.h);
}
function drawGuitar(g){
  ctx.save();
  ctx.fillStyle="rgba(35,35,42,.86)";
  ctx.fillRect(g.neckStart,g.centerY-g.spacing*(g.count+.4)/2,g.bodyJoint-g.neckStart,g.spacing*(g.count+.4));
  ctx.beginPath();ctx.ellipse(g.bodyX,g.centerY,g.w*.12,g.h*.24,0,0,Math.PI*2);ctx.fillStyle="rgba(70,30,30,.88)";ctx.fill();
  ctx.strokeStyle="rgba(255,255,255,.26)";ctx.lineWidth=2;
  g.fretLines.forEach(x=>{ctx.beginPath();ctx.moveTo(x,g.yTop-g.spacing*.55);ctx.lineTo(x,g.stringYs[g.count-1]+g.spacing*.55);ctx.stroke();});
  g.stringYs.forEach((y,i)=>{ctx.beginPath();ctx.moveTo(g.neckStart,y);ctx.lineTo(g.stringEnd,y);ctx.strokeStyle="rgba(245,245,247,.94)";ctx.lineWidth=1.5;ctx.stroke();});
  ctx.strokeStyle="rgba(255,255,255,.18)";ctx.setLineDash([7,6]);ctx.strokeRect(g.pluckX1,g.yTop-g.spacing*.7,g.pluckX2-g.pluckX1,g.spacing*(g.count+.4));ctx.setLineDash([]);
  ctx.fillStyle="rgba(255,255,255,.75)";ctx.font=`700 ${Math.max(10,g.h*.014)}px system-ui`;ctx.fillText("右手 單弦 / 刷弦區",g.pluckX1+8,g.yTop-g.spacing*.9);
  ctx.fillText("左手 按弦區",g.fretX1+8,g.yTop-g.spacing*.9);
  ctx.restore();
}
function nearestString(g,y){
  let index=0,d=Infinity;g.stringYs.forEach((sy,i)=>{const n=Math.abs(y-sy);if(n<d){d=n;index=i;}});
  return {index,d};
}
function fretAtX(g,x){
  for(let i=1;i<g.fretLines.length;i++) if(x>=g.fretLines[i-1]&&x<g.fretLines[i]) return i;
  return null;
}
function chordFret(i){
  if(!activeChord) return 0; const f=CHORDS[activeChord]?.frets?.[i]; return f==null?null:f;
}
function recognizePhysical(presses,now){
  if(currentInstrument==="bass"){physicalChord=null;activeChord=null;return;}
  const observed=new Set(presses.map(p=>`${p.stringIndex}:${p.fret}`));
  let best=null,bestScore=-1;
  for(const [name,chord] of Object.entries(CHORDS)){
    if(!chord.required) continue;
    const req=chord.required.map(([s,f])=>`${s}:${f}`);
    const hits=req.filter(k=>observed.has(k)).length;
    if(hits!==req.length) continue;
    const extras=[...observed].filter(k=>!req.includes(k)).length;
    const score=req.length*10-extras*2;
    if(score>bestScore){bestScore=score;best=name;}
  }
  if(best){
    lastPhysicalSeen=now;
    if(physicalCandidate!==best){physicalCandidate=best;physicalCandidateSince=now;}
    else if(now-physicalCandidateSince>105) physicalChord=best;
  }else{
    physicalCandidate=null;
    if(now-lastPhysicalSeen>380) physicalChord=null;
  }
  activeChord=physicalChord||keyboardChord||null;
  gestureState.textContent=physicalChord?`左手：${physicalChord}（優先）`:(keyboardChord?`鍵盤備援：${keyboardChord}`:"左手：等待辨識");
  updateChordUI();
}
function updateChordUI(){
  chordNameEl.textContent=activeChord||"OPEN";
  if(physicalChord){
    keyboardDisplay.innerHTML=`<span>LEFT HAND</span><strong>${physicalChord}</strong><small>目前和弦</small>`;
  }else if(keyboardChord){
    const k=Object.keys(keyMap).find(k=>keyMap[k]===keyboardChord)||"KEY";
    keyboardDisplay.innerHTML=`<span>${k.toUpperCase()}</span><strong>${keyboardChord}</strong><small>鍵盤備援</small>`;
  }else{
    keyboardDisplay.innerHTML="<span>SPACE</span><strong>OPEN</strong><small>目前和弦</small>";
  }
  $$(".chord-key").forEach(b=>{
    const k=b.dataset.key; const on=(!physicalChord&&keyboardChord&&k&&keyMap[k]===keyboardChord)||(!physicalChord&&!keyboardChord&&b.hasAttribute("data-open"));
    b.classList.toggle("active",!!on);
  });
}
function setKeyboard(key=""){
  if(currentInstrument==="bass") return;
  keyboardChord=key?keyMap[key]:null;
  activeChord=physicalChord||keyboardChord||null;
  updateChordUI();
}
function processStrum(p,prev,g,now){
  if(!prev||currentInstrument==="bass") return false;
  if(p.x<g.pluckX1||p.x>g.pluckX2) return false;
  const dy=p.y-prev.y;if(Math.abs(dy)<g.spacing*.65||now-lastStrum<95) return false;
  const lo=Math.min(prev.y,p.y),hi=Math.max(prev.y,p.y);
  const crossed=g.stringYs.map((sy,i)=>({sy,i})).filter(s=>s.sy>=lo&&s.sy<=hi);
  if(crossed.length<2) return false;
  lastStrum=now;crossed.sort((a,b)=>dy>0?a.sy-b.sy:b.sy-a.sy);
  ensureAudio().then(()=>crossed.forEach((s,n)=>{const fret=activeChord?chordFret(s.i):0;if(fret!=null)playVoice(s.i,fret,.8,n*.013);}));
  return true;
}
function processPluck(fid,p,prev,g,now){
  if(!prev) return;
  if(p.x<g.pluckX1||p.x>g.pluckX2) return;
  const dy=p.y-prev.y;if(Math.abs(dy)<Math.max(1.5,g.spacing*.06)) return;
  let candidate=null;
  for(let i=0;i<g.stringYs.length;i++){
    const sy=g.stringYs[i],cross=(prev.y<sy&&p.y>=sy)||(prev.y>sy&&p.y<=sy);
    if(cross){candidate=i;break;}
  }
  if(candidate==null){const n=nearestString(g,p.y);if(n.d<g.spacing*.20)candidate=n.index;}
  if(candidate==null) return;
  if(now-(lastPluck.get(candidate)||0)<38) return;
  const fret=activeChord?chordFret(candidate):0;if(fret==null)return;
  lastPluck.set(candidate,now);ensureAudio().then(()=>playVoice(candidate,fret,.78));
}
function drawHandsAndPlay(results,g){
  const now=performance.now(),hands=[];
  for(let hi=0;hi<(results.landmarks?.length||0);hi++){
    const lm=results.landmarks[hi],label=results.handedness?.[hi]?.[0]?.categoryName||`H${hi}`,tips=new Map();
    lm.forEach((p,id)=>{if(TIP_IDS.includes(id))tips.set(id,{x:(1-p.x)*g.w,y:p.y*g.h});});
    hands.push({label,tips});
  }
  const presses=[];
  hands.forEach(hand=>FRET_TIPS.forEach(fid=>{
    const p=hand.tips.get(fid);if(!p||p.x<g.fretX1||p.x>g.fretX2)return;
    const n=nearestString(g,p.y),fret=fretAtX(g,p.x);
    if(fret&&n.d<g.spacing*.50)presses.push({stringIndex:n.index,fret,x:p.x,y:p.y});
  }));
  recognizePhysical(presses,now);
  presses.forEach(p=>{ctx.beginPath();ctx.arc(p.x,g.stringYs[p.stringIndex],Math.max(7,g.spacing*.2),0,Math.PI*2);ctx.fillStyle=cfg().accent;ctx.fill();});
  hands.forEach(hand=>{
    const index=hand.tips.get(8),strumKey=`${hand.label}-strum`,strumPrev=history.get(strumKey);
    const didStrum=index?processStrum(index,strumPrev,g,now):false;
    if(index)history.set(strumKey,{...index,t:now});
    TIP_IDS.forEach(fid=>{
      const p=hand.tips.get(fid);if(!p)return;
      const key=`${hand.label}-${fid}`,prev=history.get(key);
      ctx.beginPath();ctx.arc(p.x,p.y,8,0,Math.PI*2);ctx.fillStyle=fid===4?"#60d2ff":"#ffbf46";ctx.fill();
      if(!didStrum)processPluck(fid,p,prev,g,now);
      history.set(key,{...p,t:now});
    });
  });
}
async function initHands(){
  if(handLandmarker)return;
  setStatus("載入手部辨識模型…");
  const vision=await FilesetResolver.forVisionTasks(WASM_URL);
  try{
    handLandmarker=await HandLandmarker.createFromOptions(vision,{baseOptions:{modelAssetPath:MODEL_URL,delegate:"GPU"},runningMode:"VIDEO",numHands:2,minHandDetectionConfidence:.52,minHandPresenceConfidence:.52,minTrackingConfidence:.55});
  }catch{
    handLandmarker=await HandLandmarker.createFromOptions(vision,{baseOptions:{modelAssetPath:MODEL_URL},runningMode:"VIDEO",numHands:2,minHandDetectionConfidence:.48,minHandPresenceConfidence:.48,minTrackingConfidence:.52});
  }
}
async function startCamera(){
  try{
    startBtn.disabled=true;await ensureAudio();await initHands();
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"user",width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30,max:60}},audio:false});
    camera.srcObject=stream;await camera.play();overlay.classList.add("hidden");setStatus("鏡頭開啟 · 左手按弦優先","live");loop();
  }catch(e){
    console.error(e);startBtn.disabled=false;
    const msg=e?.name==="NotAllowedError"?"相機權限被拒絕，請在瀏覽器網站設定允許相機":(e?.message||e?.name||"未知錯誤");
    setStatus(`啟動失敗：${msg}`,"error");
  }
}
function loop(){
  resize();const g=geometry();drawCamera(g);drawGuitar(g);
  if(handLandmarker&&camera.readyState>=2&&camera.currentTime!==lastVideoTime){
    lastVideoTime=camera.currentTime;
    const results=handLandmarker.detectForVideo(camera,performance.now());
    drawHandsAndPlay(results,g);
  }
  requestAnimationFrame(loop);
}
function buildEditor(){
  const chords=Object.keys(CHORDS).filter(n=>CHORDS[n].frets).sort();
  const grid=$("#editorGrid");grid.innerHTML="";
  Object.keys(DEFAULT_MAP).forEach(k=>{
    const label=document.createElement("label");label.innerHTML=`<kbd>${k.toUpperCase()}</kbd>`;
    const sel=document.createElement("select");
    chords.forEach(c=>{const o=document.createElement("option");o.value=c;o.textContent=c;sel.appendChild(o);});
    sel.value=keyMap[k];sel.addEventListener("change",()=>{keyMap[k]=sel.value;localStorage.setItem("virtual-guitar-keymap-v10",JSON.stringify(keyMap));refreshKeyLabels();if(keyboardChord) setKeyboard(k);});
    label.appendChild(sel);grid.appendChild(label);
  });
}
function refreshKeyLabels(){
  $$(".chord-key[data-key]").forEach(b=>b.querySelector("span").textContent=keyMap[b.dataset.key]);
}
window.addEventListener("keydown",e=>{
  if(e.metaKey||e.ctrlKey||e.altKey||e.repeat)return;
  if(["INPUT","SELECT","TEXTAREA"].includes(e.target?.tagName))return;
  const k=e.key.toLowerCase();
  if(keyMap[k]){e.preventDefault();setKeyboard(k);}
  else if(e.code==="Space"){e.preventDefault();setKeyboard("");}
});
$$(".chord-key[data-key]").forEach(b=>b.addEventListener("click",()=>setKeyboard(b.dataset.key)));
$(".chord-key[data-open]").addEventListener("click",()=>setKeyboard(""));
$$(".instrument-btn").forEach(b=>b.addEventListener("click",async()=>{await ensureAudio();setInstrument(b.dataset.instrument);}));
$("#resetMap").addEventListener("click",()=>{keyMap={...DEFAULT_MAP};localStorage.setItem("virtual-guitar-keymap-v10",JSON.stringify(keyMap));buildEditor();refreshKeyLabels();setKeyboard("");});
startBtn.addEventListener("click",startCamera);
$("#testSoundBtn").addEventListener("click",testSound);
$("#testSoundBtnTop").addEventListener("click",testSound);
$("#fullscreenBtn").addEventListener("click",()=>stage.requestFullscreen?.());
volumeSlider.addEventListener("input",()=>{if(master&&audioCtx)master.gain.setTargetAtTime(Math.max(.02,Number(volumeSlider.value)/100)*.72,audioCtx.currentTime,.02);});
window.addEventListener("resize",resize);

buildEditor();refreshKeyLabels();setInstrument("electric");updateChordUI();resize();
