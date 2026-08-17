const STORAGE_KEY = "crossEPS_v1";
const TEACHER_SESSION_KEY = "crossEPS_teacher_session_v19";
const ADMIN_EMAIL = "eps.applicationsnico@gmail.com";

const SUPABASE_URL = "https://ksqgcobhkwvjbfpwijgq.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_aozGhyoQ-ak-4LRaibM_jg_8msoJr7b";

const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  }
);

let state = loadState();
let lastSyncedState = deepClone(state);
let cloudReady = false;
let cloudUnsubscribe = null;
let teacherSessionUnsubscribe = null;
let teacherExpiryTimer = null;
let saveQueue = Promise.resolve();
let applyingCloudSnapshot = false;
let currentAccess = null;
let currentEventId = null;
let currentStateVersion = 0;
let workspaceMeta = {
  activeSessionCode: null,
  accessExpiresAt: null,
  updatedAt: null,
  updatedBy: null
};

function defaultState(){
  return {students:[], races:[], checkpoints:[], startGroups:[], events:[], resultArchives:[]};
}
function normalizeState(value){
  const s=(value && typeof value==="object")?value:{};
  return {
    students:Array.isArray(s.students)?s.students:[],
    races:Array.isArray(s.races)?s.races:[],
    checkpoints:Array.isArray(s.checkpoints)?s.checkpoints:[],
    startGroups:Array.isArray(s.startGroups)?s.startGroups:[],
    events:Array.isArray(s.events)?s.events:[],
    resultArchives:Array.isArray(s.resultArchives)?s.resultArchives:[]
  };
}
function loadState(){
  try{
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return normalizeState(saved);
  }catch{return defaultState();}
}
function deepClone(value){
  return value===undefined?undefined:JSON.parse(JSON.stringify(value));
}
function sameValue(a,b){
  return JSON.stringify(a)===JSON.stringify(b);
}
function isPlainObject(v){return !!v && typeof v==="object" && !Array.isArray(v);}
function isIdArray(v){return Array.isArray(v) && v.every(x=>isPlainObject(x) && typeof x.id==="string");}

// Fusion à trois voies : évite qu'un passage enregistré sur un téléphone n'écrase
// une arrivée enregistrée au même moment sur un autre appareil.
function mergeCloudValue(base, local, remote){
  if(sameValue(local,base)) return deepClone(remote);
  if(sameValue(remote,base)) return deepClone(local);
  if(sameValue(local,remote)) return deepClone(local);

  if(isIdArray(base||[]) && isIdArray(local||[]) && isIdArray(remote||[])){
    const bm=new Map((base||[]).map(x=>[x.id,x]));
    const lm=new Map((local||[]).map(x=>[x.id,x]));
    const rm=new Map((remote||[]).map(x=>[x.id,x]));
    const ids=new Set([...bm.keys(),...lm.keys(),...rm.keys()]);
    const merged=new Map();
    ids.forEach(id=>{
      const b=bm.get(id), l=lm.get(id), r=rm.get(id);
      if(b && !l){ return; } // suppression locale volontaire
      if(!b && l){ merged.set(id,deepClone(l)); return; }
      if(!l && r){ merged.set(id,deepClone(r)); return; }
      if(l && !r){ merged.set(id,deepClone(l)); return; }
      if(l && r) merged.set(id,mergeCloudValue(b,l,r));
    });
    const order=[];
    (local||[]).forEach(x=>{if(merged.has(x.id))order.push(x.id);});
    (remote||[]).forEach(x=>{if(merged.has(x.id)&&!order.includes(x.id))order.push(x.id);});
    return order.map(id=>merged.get(id));
  }

  if(Array.isArray(local) || Array.isArray(remote)) return deepClone(local);

  if(isPlainObject(local) && isPlainObject(remote)){
    const out={};
    const keys=new Set([...Object.keys(base||{}),...Object.keys(local||{}),...Object.keys(remote||{})]);
    keys.forEach(k=>{
      const b=base?base[k]:undefined, l=local[k], r=remote[k];
      if(!(k in local) && base && k in base){ return; }
      if(!(k in remote) && l!==undefined){ out[k]=deepClone(l); return; }
      const v=mergeCloudValue(b,l,r);
      if(v!==undefined)out[k]=v;
    });
    return out;
  }

  return deepClone(local);
}

function setCloudStatus(text,kind="syncing"){
  const el=document.getElementById("cloudStatus");
  if(!el)return;
  el.textContent=`● ${text}`;
  el.className=`cloud-status ${kind}`;
  const detail=document.getElementById("cloudSyncDetails");
  if(detail)detail.textContent=`État Supabase : ${text}`;
}
function isAdmin(){return currentAccess?.kind==="admin";}
function canUseCloud(){return !!currentAccess && cloudReady;}

function save(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  renderAll();
  if(canUseCloud() && !applyingCloudSnapshot) queueCloudSave();
}

function queueCloudSave(){
  if(!currentEventId)return;

  const baseSnapshot=deepClone(lastSyncedState);
  const localSnapshot=deepClone(state);
  const expectedVersion=currentStateVersion;

  // On conserve toujours la dernière modification locale en attente.
  localStorage.setItem(
    "cross-eps-pending-sync",
    JSON.stringify({
      eventId:currentEventId,
      base:baseSnapshot,
      state:localSnapshot,
      version:expectedVersion
    })
  );

  if(!navigator.onLine){
    setCloudStatus("Hors ligne · modifications en attente","offline");
    return;
  }

  setCloudStatus("Synchronisation…","syncing");

  saveQueue=saveQueue.then(async()=>{
    let attempt=0;
    let base=baseSnapshot;
    let local=localSnapshot;
    let expected=expectedVersion;

    while(attempt<5){
      attempt++;

      const {data,error}=await supabaseClient.rpc("save_app_state",{
        p_event_id:currentEventId,
        p_expected_version:expected,
        p_state:local
      });

      if(error)throw error;

      const row=Array.isArray(data)?data[0]:data;
      if(!row)throw new Error("Réponse Supabase invalide.");

      const remote=normalizeState(row.state);
      const remoteVersion=Number(row.version)||0;

      if(row.saved){
        currentStateVersion=remoteVersion;
        lastSyncedState=deepClone(remote);

        localStorage.removeItem("cross-eps-pending-sync");
        setCloudStatus("Synchronisé","online");
        return;
      }

      local=mergeCloudValue(base,local,remote);
      base=deepClone(remote);
      expected=remoteVersion;
    }

    throw new Error("Trop de modifications simultanées. Réessayez.");

  }).catch(err=>{
    console.error("Supabase save",err);

    localStorage.setItem(
      "cross-eps-pending-sync",
      JSON.stringify({
        eventId:currentEventId,
        base:baseSnapshot,
        state:localSnapshot,
        version:expectedVersion
      })
    );

    setCloudStatus(
      navigator.onLine
        ? "Synchronisation en attente"
        : "Hors ligne · modifications en attente",
      navigator.onLine ? "error" : "offline"
    );
  });
}
function restorePendingSync(){
  if(!currentEventId || !currentAccess)return false;

  const raw=localStorage.getItem("cross-eps-pending-sync");
  if(!raw)return false;

  try{
    const pending=JSON.parse(raw);

    if(pending.eventId !== currentEventId)return false;

    const pendingState=normalizeState(pending.state);
    const pendingBase=normalizeState(pending.base);

    // Fusionne ce qui avait été fait hors ligne avec l'état
    // actuellement chargé afin de ne pas perdre les actions locales.
    state=mergeCloudValue(
      pendingBase,
      pendingState,
      state
    );

    localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
    renderAll();

    if(navigator.onLine){
      setCloudStatus("Reprise des modifications en attente…","syncing");
      queueCloudSave();
    }else{
      setCloudStatus("Hors ligne · modifications en attente","offline");
    }

    return true;

  }catch(err){
    console.error("Restauration hors ligne",err);
    return false;
  }
}
window.addEventListener("offline",()=>{
  if(currentAccess){
    setCloudStatus("Hors ligne · modifications en attente","offline");
  }
});

window.addEventListener("online",async()=>{
  if(!currentAccess || !currentEventId)return;

  setCloudStatus(
    "Connexion retrouvée · récupération des données…",
    "syncing"
  );

  try{
    // Recharge d'abord la version actuelle de Supabase.
    // loadWorkspaceState() fusionnera aussi les éventuelles
    // modifications hors ligne conservées sur le téléphone.
    await loadWorkspaceState();

    setCloudStatus(
      "Connexion retrouvée · synchronisation…",
      "syncing"
    );

  }catch(err){
    console.error("Reconnexion Supabase",err);
    setCloudStatus("Synchronisation en attente","error");
  }
});

async function ensureWorkspaceForAdmin(){
  if(!currentEventId){
    const {data:events,error}=await supabaseClient
      .from("cross_events")
      .select("id,name,status,access_expires_at,created_at")
      .order("created_at",{ascending:false})
      .limit(1);
    if(error)throw error;

    if(events?.length){
      currentEventId=events[0].id;
      workspaceMeta.accessExpiresAt=events[0].access_expires_at;
    }else{
      const {data:newEvent,error:createError}=await supabaseClient
        .from("cross_events")
        .insert({name:"CROSS EPS",status:"preparation"})
        .select("id")
        .single();
      if(createError)throw createError;
      currentEventId=newEvent.id;
    }
  }

  const {data:rows,error}=await supabaseClient
    .from("app_state")
    .select("event_id,version,state,updated_at,updated_by")
    .eq("event_id",currentEventId)
    .limit(1);
  if(error)throw error;

  if(!rows?.length){
    const {error:insertError}=await supabaseClient
      .from("app_state")
      .insert({event_id:currentEventId,state:normalizeState(state)});
    if(insertError)throw insertError;
    currentStateVersion=0;
  }else{
    currentStateVersion=Number(rows[0].version)||0;
    const incoming=normalizeState(rows[0].state);
    applyingCloudSnapshot=true;
    state=incoming;
    lastSyncedState=deepClone(incoming);
    localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
    applyingCloudSnapshot=false;
  }
}

async function loadWorkspaceState(){
  if(!currentEventId)return;

  const {data,error}=await supabaseClient
    .from("app_state")
    .select("version,state,updated_at,updated_by")
    .eq("event_id",currentEventId)
    .single();

  if(error)throw error;

  const incoming=normalizeState(data.state);

  currentStateVersion=Number(data.version)||0;
  workspaceMeta.updatedAt=data.updated_at||null;
  workspaceMeta.updatedBy=data.updated_by||null;

  applyingCloudSnapshot=true;

  // Vérifie s'il existe des modifications effectuées hors connexion
  // avant la fermeture de l'application.
  let pending=null;

  try{
    const raw=localStorage.getItem("cross-eps-pending-sync");

    if(raw){
      const parsed=JSON.parse(raw);

      if(parsed.eventId===currentEventId){
        pending=parsed;
      }
    }
  }catch(err){
    console.error("Lecture sauvegarde hors ligne",err);
  }

  if(pending){
    const pendingBase=normalizeState(pending.base);
    const pendingState=normalizeState(pending.state);

    // Fusionne :
    // - l'ancien état connu du téléphone
    // - les actions faites hors connexion
    // - l'état actuel de Supabase
    state=mergeCloudValue(
      pendingBase,
      pendingState,
      incoming
    );
  }else{
    state=incoming;
  }

  lastSyncedState=deepClone(incoming);

  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(state)
  );

  renderAll();

  applyingCloudSnapshot=false;

  // Si des données hors ligne ont été récupérées,
  // on les renvoie maintenant vers Supabase.
  if(pending){
    setCloudStatus(
      "Reprise des modifications en attente…",
      "syncing"
    );

    queueCloudSave();
  }
}

function startWorkspaceListener(){
  if(cloudUnsubscribe){
    supabaseClient.removeChannel(cloudUnsubscribe);
    cloudUnsubscribe=null;
  }
  cloudReady=true;
  setCloudStatus("Connexion…","syncing");

  loadWorkspaceState()
    .then(()=>{
      setCloudStatus(navigator.onLine?"Synchronisé":"Hors ligne",navigator.onLine?"online":"offline");
      renderCloudAdminPanel();
    })
    .catch(err=>{
      console.error("Supabase initial load",err);
      setCloudStatus("Accès interrompu","error");
    });

  cloudUnsubscribe=supabaseClient
    .channel(`app-state-${currentEventId}`)
    .on(
      "postgres_changes",
      {
        event:"UPDATE",
        schema:"public",
        table:"app_state",
        filter:`event_id=eq.${currentEventId}`
      },
      payload=>{
        const row=payload.new||{};
        const incoming=normalizeState(row.state);
        const version=Number(row.version)||0;
        if(version<currentStateVersion)return;

        currentStateVersion=version;
        applyingCloudSnapshot=true;
        state=incoming;
        lastSyncedState=deepClone(incoming);
        localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
        renderAll();
        applyingCloudSnapshot=false;
        setCloudStatus(navigator.onLine?"Synchronisé":"Hors ligne",navigator.onLine?"online":"offline");
      }
    )
    .subscribe(status=>{
      if(status==="SUBSCRIBED")setCloudStatus("Synchronisé","online");
      if(status==="CHANNEL_ERROR")setCloudStatus("Erreur temps réel","error");
    });
}

function uid(prefix="id"){return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;}
function esc(s){return String(s ?? "").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]));}
function studentById(id){return state.students.find(s=>s.id===id);}
function raceById(id){return state.races.find(r=>r.id===id);}
function startGroupById(id){return (state.startGroups||[]).find(g=>g.id===id);}
function resultArchiveById(id){return (state.resultArchives||[]).find(a=>a.id===id);}

function snapshotRace(r, sourceType="race", sourceId=null, sourceName=null){
  if(!r)return null;
  const participants=(r.participantIds||[]).map(studentById).filter(Boolean).map(s=>({
    id:s.id,
    bib:s.bib,
    lastName:s.lastName,
    firstName:s.firstName,
    className:s.className,
    gender:s.gender,
    birthDate:s.birthDate
  }));
  return {
    raceId:r.id,
    raceName:r.name,
    distance:r.distance,
    classNames:[...(r.classNames||[])],
    startedAt:raceEffectiveStartMs(r)||r.startedAt||null,
    stoppedAt:r.stoppedAt||raceGroup(r)?.stoppedAt||Date.now(),
    participants,
    results:JSON.parse(JSON.stringify(r.results||{})),
    participantStatus:JSON.parse(JSON.stringify(r.participantStatus||{})),
    checkpoints:state.checkpoints.filter(c=>c.raceId===r.id).map(c=>({...c})),
    sourceType,
    sourceId,
    sourceName
  };
}

function archiveRaceResults(r, label=null, force=false){
  if(!r)return null;
  state.resultArchives=state.resultArchives||[];
  const effectiveStart=raceEffectiveStartMs(r)||r.startedAt||null;
  const existing=!force && state.resultArchives.find(a=>
    a.sourceType==="race" &&
    a.races?.length===1 &&
    a.races[0]?.raceId===r.id &&
    a.races[0]?.startedAt===effectiveStart
  );
  if(existing)return existing;

  const archive={
    id:uid("archive"),
    name:label||`${r.name} · ${new Date().toLocaleString("fr-FR")}`,
    createdAt:Date.now(),
    sourceType:"race",
    sourceId:r.id,
    races:[snapshotRace(r,"race",r.id,r.name)]
  };
  state.resultArchives.unshift(archive);
  return archive;
}

function archiveGroupResults(g, label=null, force=false){
  if(!g)return null;
  state.resultArchives=state.resultArchives||[];
  const existing=!force && state.resultArchives.find(a=>
    a.sourceType==="group" &&
    a.sourceId===g.id &&
    a.groupStartedAt===g.startedAt
  );
  if(existing)return existing;

  const races=(g.raceIds||[]).map(raceById).filter(Boolean);
  const archive={
    id:uid("archive"),
    name:label||`${g.name} · ${new Date().toLocaleString("fr-FR")}`,
    createdAt:Date.now(),
    sourceType:"group",
    sourceId:g.id,
    groupName:g.name,
    groupStartedAt:g.startedAt||null,
    groupStoppedAt:g.stoppedAt||Date.now(),
    races:races.map(r=>snapshotRace(r,"group",g.id,g.name))
  };
  state.resultArchives.unshift(archive);
  return archive;
}

function clearRaceForNewRun(r){
  if(!r)return;
  r.startedAt=null;
  r.stoppedAt=null;
  r.results={};
  r.participantStatus={};
  state.checkpoints=state.checkpoints.filter(c=>c.raceId!==r.id);
}

function prepareRaceRestart(r){
  archiveRaceResults(r);
  clearRaceForNewRun(r);
}

function prepareGroupRestart(g){
  archiveGroupResults(g);
  (g.raceIds||[]).map(raceById).filter(Boolean).forEach(clearRaceForNewRun);
  g.startedAt=null;
  g.stoppedAt=null;
}
function formatBib(value){
  if(value===null || value===undefined || value==="") return "—";
  const n=Number(value);
  if(!Number.isFinite(n)) return String(value);
  return String(Math.trunc(n)).padStart(3,"0");
}
function getBirthYear(student){
  if(!student?.birthDate) return null;
  const text=String(student.birthDate).trim();
  const iso=text.match(/^(\d{4})[-/]/);
  if(iso) return Number(iso[1]);
  const fr=text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if(fr) return Number(fr[3]);
  const any=text.match(/(19|20)\d{2}/);
  return any?Number(any[0]):null;
}

function normalizeClassName(value){
  return String(value||"").trim();
}

function availableClassNames(){
  return [...new Set(
    state.students
      .map(s=>normalizeClassName(s.className))
      .filter(Boolean)
  )].sort((a,b)=>a.localeCompare(b,"fr",{numeric:true,sensitivity:"base"}));
}

function studentMatchesRaceCriteria(student, gender, birthMin, birthMax, classNames=[]){
  const g=gender||"ALL";
  const y1=birthMin!==null && birthMin!==undefined && birthMin!=="" ? Number(birthMin) : null;
  const y2=birthMax!==null && birthMax!==undefined && birthMax!=="" ? Number(birthMax) : null;
  const selectedClasses=(Array.isArray(classNames)?classNames:[])
    .map(normalizeClassName)
    .filter(Boolean);

  if(g!=="ALL" && student.gender!==g) return false;

  if(selectedClasses.length){
    const studentClass=normalizeClassName(student.className);
    if(!selectedClasses.includes(studentClass)) return false;
  }

  if(y1!==null || y2!==null){
    const year=getBirthYear(student);
    if(year===null) return false;

    if(y1!==null && y2!==null){
      const low=Math.min(y1,y2);
      const high=Math.max(y1,y2);
      if(year<low || year>high) return false;
    }else if(y1!==null){
      if(year!==y1) return false;
    }else if(y2!==null){
      if(year!==y2) return false;
    }
  }
  return true;
}

function autoParticipantIdsForCriteria(gender,birthMin,birthMax,classNames=[]){
  return state.students
    .filter(s=>studentMatchesRaceCriteria(s,gender,birthMin,birthMax,classNames))
    .map(s=>s.id);
}

function renderRaceClassChoices(selected=[]){
  const wrap=document.getElementById("raceClassChoices");
  if(!wrap)return;

  const selectedSet=new Set((selected||[]).map(normalizeClassName));
  const classes=availableClassNames();

  wrap.innerHTML=classes.length
    ? classes.map(cls=>`
        <label class="class-choice">
          <input type="checkbox" value="${esc(cls)}" ${selectedSet.has(cls)?"checked":""}>
          <span>${esc(cls)}</span>
        </label>
      `).join("")
    : '<span class="muted">Aucune classe disponible. Importez d’abord les élèves.</span>';
}

function selectedRaceClasses(){
  return [...document.querySelectorAll("#raceClassChoices input[type=checkbox]:checked")]
    .map(el=>normalizeClassName(el.value))
    .filter(Boolean);
}
function formatTime(sec){
  if(sec==null || !Number.isFinite(Number(sec))) return "—";
  sec=Number(sec); const m=Math.floor(sec/60), s=Math.floor(sec%60), d=Math.floor((sec-Math.floor(sec))*10);
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${d}`;
}
function formatClock(ms){
  const sec=ms/1000, m=Math.floor(sec/60), s=Math.floor(sec%60), d=Math.floor((sec-Math.floor(sec))*10);
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${d}`;
}
function elapsedForRace(r){
  if(!r?.startedAt) return 0;
  const end = r.stoppedAt || Date.now();
  return Math.max(0,end-r.startedAt);
}
function resultFor(r, sid){return (r.results||{})[sid];}
function participantStatusFor(r,sid){
  return r?.participantStatus?.[sid]?.status||"active";
}
function participantIsWithdrawn(r,sid){
  const status=participantStatusFor(r,sid);
  return status==="no_start" || status==="abandoned";
}
function participantStatusLabel(status){
  if(status==="no_start")return "Non-partant";
  if(status==="abandoned")return "Abandon";
  return "Actif";
}
function ensureParticipantStatus(r){
  if(!r)return;
  r.participantStatus=r.participantStatus||{};
  const allowed=new Set(r.participantIds||[]);
  Object.keys(r.participantStatus).forEach(sid=>{
    if(!allowed.has(sid))delete r.participantStatus[sid];
  });
}
function activeRaceParticipants(r){
  return (r?.participantIds||[])
    .map(studentById)
    .filter(Boolean)
    .filter(s=>!participantIsWithdrawn(r,s.id));
}
function sortedFinishers(r){
  return (r.participantIds||[]).map(studentById).filter(Boolean)
    .filter(s=>!participantIsWithdrawn(r,s.id))
    .filter(s=>resultFor(r,s.id)?.finishSeconds!=null)
    .sort((a,b)=>resultFor(r,a.id).finishSeconds-resultFor(r,b.id).finishSeconds);
}

document.querySelectorAll(".nav-btn").forEach(btn=>btn.addEventListener("click",()=>{
  document.querySelectorAll(".nav-btn").forEach(b=>b.classList.remove("active"));
  document.querySelectorAll(".view").forEach(v=>v.classList.remove("active-view"));
  btn.classList.add("active");
  document.getElementById(btn.dataset.view).classList.add("active-view");
  document.getElementById("sidebar").classList.remove("open");
  renderAll();
}));
document.getElementById("menuBtn").onclick=()=>document.getElementById("sidebar").classList.toggle("open");


function syncRaceParticipantsWithCriteria(r){
  if(!r) return;
  const autoIds=autoParticipantIdsForCriteria(r.gender,r.birthMin,r.birthMax,r.classNames||[]);
  const manualIds=Array.isArray(r.manualParticipantIds)?r.manualParticipantIds:[];
  r.participantIds=[...new Set([...autoIds,...manualIds])].filter(id=>studentById(id));
  ensureParticipantStatus(r);
}
function syncAllRaceParticipants(){
  state.races.forEach(syncRaceParticipantsWithCriteria);
}

function renderAll(){
  syncAllRaceParticipants();
  renderDashboard(); renderStudents(); renderRaces(); renderStartGroups(); fillRaceSelects(); fillStartGroupSelects(); renderParticipantStatus(); renderCheckpoint(); renderFinish(); renderResults(); renderTimer(); renderBibs(); renderEvents();
}
function renderDashboard(){
  const allRunning=state.races.filter(r=>r.startedAt&&!r.stoppedAt).length + (state.startGroups||[]).filter(g=>g.startedAt&&!g.stoppedAt).length;
  const finished=state.races.reduce((n,r)=>n+sortedFinishers(r).length,0);
  document.getElementById("statStudents").textContent=state.students.length;
  document.getElementById("statRaces").textContent=state.races.length;
  document.getElementById("statRunning").textContent=allRunning;
  document.getElementById("statFinished").textContent=finished;
}

let studentFilter="";
document.getElementById("studentSearch").addEventListener("input",e=>{studentFilter=e.target.value.toLowerCase();renderStudents();});
function renderStudents(){
  const body=document.getElementById("studentsBody");
  const rows=state.students.filter(s=>`${s.bib} ${s.lastName} ${s.firstName} ${s.className}`.toLowerCase().includes(studentFilter));
  body.innerHTML=rows.map(s=>`<tr>
    <td><strong>${esc(formatBib(s.bib))}</strong></td><td>${esc(s.lastName)}</td><td>${esc(s.firstName)}</td><td>${esc(s.birthDate)}</td><td>${esc(s.gender)}</td><td>${esc(s.className)}</td>
    <td><button class="btn secondary" onclick="editStudent('${s.id}')">Modifier</button> <button class="btn danger" onclick="deleteStudent('${s.id}')">Supprimer</button></td>
  </tr>`).join("") || `<tr><td colspan="7" class="muted">Aucun élève.</td></tr>`;
}
const studentDialog=document.getElementById("studentDialog");
document.getElementById("addStudentBtn").onclick=()=>{
  document.getElementById("studentForm").reset(); document.getElementById("studentId").value=""; document.getElementById("studentDialogTitle").textContent="Ajouter un élève"; studentDialog.showModal();
};
window.editStudent=id=>{
  const s=studentById(id); if(!s)return;
  studentId.value=s.id; studentLastName.value=s.lastName; studentFirstName.value=s.firstName; studentBirthDate.value=s.birthDate; studentGender.value=s.gender; studentClass.value=s.className; studentBib.value=s.bib!=null?formatBib(s.bib):"";
  studentDialogTitle.textContent="Modifier un élève"; studentDialog.showModal();
};
window.deleteStudent=id=>{
  if(!confirm("Supprimer cet élève ?")) return;
  state.students=state.students.filter(s=>s.id!==id);
  state.races.forEach(r=>{r.participantIds=(r.participantIds||[]).filter(x=>x!==id); if(r.results) delete r.results[id];});
  save();
};
document.getElementById("saveStudentBtn").onclick=e=>{
  e.preventDefault();
  if(!studentLastName.value.trim()||!studentFirstName.value.trim()||!studentBirthDate.value||!studentClass.value.trim()){alert("Complétez les champs obligatoires.");return;}
  const id=studentId.value||uid("stu");
  const bib=studentBib.value.trim()?Number(studentBib.value.trim()):null;
  if(bib && state.students.some(s=>s.bib===bib && s.id!==id)){alert("Ce numéro de dossard est déjà utilisé.");return;}
  const data={id,lastName:studentLastName.value.trim().toUpperCase(),firstName:studentFirstName.value.trim(),birthDate:studentBirthDate.value,gender:studentGender.value,className:studentClass.value.trim(),bib};
  const idx=state.students.findIndex(s=>s.id===id); if(idx>=0) state.students[idx]=data; else state.students.push(data);
  studentDialog.close(); save();
};

document.getElementById("resetStudentsBtn").onclick=()=>{
  if(!state.students.length){
    alert("La liste des élèves est déjà vide.");
    return;
  }

  const first=confirm(
    "Réinitialiser tous les élèves ?\n\n" +
    "Cette opération supprimera la liste des élèves, leurs dossards, leurs résultats et leurs passages enregistrés.\n" +
    "Les courses et leurs paramètres seront conservés."
  );
  if(!first)return;

  const second=confirm(
    "Confirmation définitive : supprimer tous les élèves et toutes les données qui leur sont associées ?"
  );
  if(!second)return;

  state.students=[];
  state.checkpoints=[];
  state.races.forEach(r=>{
    r.participantIds=[];
    r.manualParticipantIds=[];
    r.results={};
    r.participantStatus={};
    r.startedAt=null;
    r.stoppedAt=null;
  });
  (state.startGroups||[]).forEach(g=>{
    g.startedAt=null;
    g.stoppedAt=null;
  });

  save();
  alert("Les élèves ont été réinitialisés. Les courses et leurs paramètres ont été conservés.");
};

document.getElementById("assignBibBtn").onclick=()=>{
  const configured=state.races.filter(r=>r.bibStart!=null && r.bibEnd!=null);
  if(!configured.length){
    alert("Définissez d'abord une plage de dossards dans au moins une course.");
    return;
  }
  if(!confirm("Attribuer automatiquement les dossards selon les plages définies pour les courses ?")) return;

  let assigned=0;
  for(const r of configured){
    const result=assignRaceBibsInternal(r,false);
    if(result.error){
      alert(`${r.name} : ${result.error}`);
      return;
    }
    assigned+=result.assigned;
  }
  save();
  alert(`${assigned} dossard(s) attribué(s) selon les plages des courses.`);
};

document.getElementById("csvInput").addEventListener("change",async e=>{
  const file=e.target.files[0]; if(!file)return;
  try{
    let rows=[];
    const ext=(file.name.split(".").pop()||"").toLowerCase();

    if(ext==="xlsx" || ext==="xls"){
      if(typeof XLSX==="undefined"){
        alert("Le module Excel n'a pas pu être chargé. Vérifiez la connexion Internet puis rechargez la page.");
        e.target.value="";
        return;
      }
      const data=await file.arrayBuffer();
      const workbook=XLSX.read(data,{type:"array",cellDates:true});
      const sheet=workbook.Sheets[workbook.SheetNames[0]];
      rows=XLSX.utils.sheet_to_json(sheet,{header:1,defval:"",raw:false,dateNF:"yyyy-mm-dd"});
    }else{
      const buffer=await file.arrayBuffer();
      const bytes=new Uint8Array(buffer);
      let text="";

      // Détection de l'encodage afin de conserver correctement les accents
      // dans les CSV provenant notamment d'Excel.
      if(bytes.length>=3 && bytes[0]===0xEF && bytes[1]===0xBB && bytes[2]===0xBF){
        text=new TextDecoder("utf-8").decode(bytes.subarray(3));
      }else if(bytes.length>=2 && bytes[0]===0xFF && bytes[1]===0xFE){
        text=new TextDecoder("utf-16le").decode(bytes.subarray(2));
      }else if(bytes.length>=2 && bytes[0]===0xFE && bytes[1]===0xFF){
        // UTF-16 BE : inversion des octets puis décodage LE.
        const swapped=new Uint8Array(bytes.length-2);
        for(let i=2;i+1<bytes.length;i+=2){
          swapped[i-2]=bytes[i+1];
          swapped[i-1]=bytes[i];
        }
        text=new TextDecoder("utf-16le").decode(swapped);
      }else{
        try{
          text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
        }catch{
          text=new TextDecoder("windows-1252").decode(bytes);
        }
      }
      text=text.replace(/^\uFEFF/,"");
      const lines=text.split(/\r?\n/).filter(l=>l.trim());
      const sep=lines[0]?.includes(";")?";":",";
      rows=lines.map(line=>line.split(sep).map(x=>x.trim().replace(/^"|"$/g,"")));
    }

    if(rows.length<2){alert("Fichier vide ou invalide.");e.target.value="";return;}

    const headers=rows[0].map(h=>String(h).trim().toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu,""));
    const idx=(...names)=>headers.findIndex(h=>names.includes(h));
    const iNom=idx("nom","lastname");
    const iPre=idx("prenom","firstname");
    const iDate=idx("date de naissance","date_naissance","naissance","birthdate");
    const iClass=idx("classe","class");
    const iGender=idx("genre","sexe","gender");
    const iBib=idx("dossard","numero","numero dossard","n° dossard","no dossard");

    if([iNom,iPre,iDate,iClass].some(i=>i<0)){
      alert("Colonnes attendues : Nom, Prénom, Date de naissance, Classe. Genre et Dossard sont optionnels.");
      e.target.value="";
      return;
    }

    let count=0;
    for(let n=1;n<rows.length;n++){
      const c=rows[n].map(x=>String(x??"").trim());
      if(!c[iNom]&&!c[iPre]) continue;

      let gender=iGender>=0?(c[iGender]||"X").toUpperCase().charAt(0):"X";
      if(!["F","M","X"].includes(gender)) gender="X";

      let bib=iBib>=0&&c[iBib]?Number(String(c[iBib]).replace(",", ".")):null;
      let birth=c[iDate]||"";
      const m=birth.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
      if(m) birth=`${m[3]}-${String(m[2]).padStart(2,"0")}-${String(m[1]).padStart(2,"0")}`;

      state.students.push({
        id:uid("stu"),
        lastName:(c[iNom]||"").toUpperCase(),
        firstName:c[iPre]||"",
        birthDate:birth,
        gender,
        className:c[iClass]||"",
        bib:Number.isFinite(bib)?bib:null
      });
      count++;
    }
    e.target.value="";
    save();
    alert(`${count} élève(s) importé(s).`);
  }catch(err){
    console.error(err);
    alert("Impossible de lire ce fichier. Vérifiez son format et les noms de colonnes.");
    e.target.value="";
  }
});

const raceDialog=document.getElementById("raceDialog");

function assignRaceBibsInternal(r,force=true){
  if(!r || r.bibStart==null || r.bibEnd==null){
    return {error:"Aucune plage de dossards n'est définie pour cette course.",assigned:0};
  }

  const participants=(r.participantIds||[]).map(studentById).filter(Boolean)
    .sort((a,b)=>(a.className+a.lastName+a.firstName).localeCompare(b.className+b.lastName+b.firstName,"fr"));

  const rangeSize=r.bibEnd-r.bibStart+1;
  if(participants.length>rangeSize){
    return {error:`${participants.length} participants pour seulement ${rangeSize} numéros disponibles (${formatBib(r.bibStart)} à ${formatBib(r.bibEnd)}).`,assigned:0};
  }

  const participantIds=new Set(participants.map(s=>s.id));
  const usedOutside=new Set(
    state.students
      .filter(s=>!participantIds.has(s.id) && s.bib!=null)
      .map(s=>Number(s.bib))
  );

  const available=[];
  for(let n=r.bibStart;n<=r.bibEnd;n++){
    if(!usedOutside.has(n)) available.push(n);
  }
  if(available.length<participants.length){
    return {error:`Il ne reste que ${available.length} numéros libres dans la plage ${formatBib(r.bibStart)} à ${formatBib(r.bibEnd)}.`,assigned:0};
  }

  participants.forEach((s,i)=>{s.bib=available[i];});
  return {error:null,assigned:participants.length};
}

window.assignRaceBibs=id=>{
  const r=raceById(id);
  if(!r)return;
  if(r.bibStart==null||r.bibEnd==null){
    alert("Modifiez d'abord la course pour définir le premier et le dernier numéro de dossard.");
    return;
  }
  if(!confirm(`Attribuer les dossards ${formatBib(r.bibStart)} à ${formatBib(r.bibEnd)} aux participants de « ${r.name} » ? Les dossards actuels de ces participants seront remplacés.`)) return;
  const result=assignRaceBibsInternal(r,true);
  if(result.error){alert(result.error);return;}
  save();
  alert(`${result.assigned} dossard(s) attribué(s) à la course « ${r.name} ».`);
};

function renderRaces(){
  const wrap=document.getElementById("raceCards");
  wrap.innerHTML=state.races.map(r=>`<article class="race-card">
    <h3>${esc(r.name)}</h3>
    <div class="race-meta">${esc(r.distance)} m · ${r.participantIds?.length||0} inscrit(s) · ${activeRaceParticipants(r).length} actif(s) · ${r.startedAt?(r.stoppedAt?"Terminée":"En cours"):"Non démarrée"}</div>
    <div class="race-meta">Dossards : ${r.bibStart!=null&&r.bibEnd!=null?`${formatBib(r.bibStart)} à ${formatBib(r.bibEnd)}`:"plage non définie"}</div>
    <div class="race-meta">Classes : ${r.classNames?.length?esc(r.classNames.join(", ")):"Toutes les classes"}</div>
    <div class="race-actions"><button class="btn secondary" onclick="editRace('${r.id}')">Modifier</button><button class="btn secondary" onclick="assignRaceBibs('${r.id}')">Attribuer les dossards</button><button class="btn danger" onclick="deleteRace('${r.id}')">Supprimer</button></div>
  </article>`).join("") || `<div class="panel muted">Aucune course créée.</div>`;
}
function buildParticipantChecks(manualSelected=[]){
  const target=document.getElementById("raceParticipants");
  const gender=raceGender.value||"ALL";
  const birthMin=raceBirthMin.value||"";
  const birthMax=raceBirthMax.value||"";
  const autoIds=new Set(autoParticipantIdsForCriteria(gender,birthMin,birthMax,selectedRaceClasses()));
  const manualIds=new Set(manualSelected||[]);

  const sorted=[...state.students].sort((a,b)=>{
    const ma=autoIds.has(a.id)?0:1;
    const mb=autoIds.has(b.id)?0:1;
    if(ma!==mb) return ma-mb;
    return (a.className+a.lastName+a.firstName).localeCompare(b.className+b.lastName+b.firstName,"fr");
  });

  target.innerHTML=sorted.map(s=>{
    const automatic=autoIds.has(s.id);
    const manual=manualIds.has(s.id) && !automatic;
    const checked=automatic || manual;
    const badge=automatic
      ? '<span class="criteria-badge auto">Automatique</span>'
      : manual
        ? '<span class="criteria-badge manual">Ajout manuel</span>'
        : '<span class="criteria-badge other">Hors critères</span>';
    return `<div class="check-item ${automatic?"auto-match":""}">
      <input type="checkbox" value="${s.id}" ${checked?"checked":""} data-auto="${automatic?"1":"0"}">
      <label>${esc(formatBib(s.bib))} · ${esc(s.lastName)} ${esc(s.firstName)} · ${esc(s.className)} · ${esc(getBirthYear(s)||"?")} · ${esc(s.gender)}</label>
      ${badge}
    </div>`;
  }).join("") || `<span class="muted">Ajoutez d'abord des élèves.</span>`;
}
document.getElementById("addRaceBtn").onclick=()=>{
  raceForm.reset();
  raceId.value="";
  raceDialogTitle.textContent="Nouvelle course";
  renderRaceClassChoices([]);
  buildParticipantChecks([]);
  raceDialog.showModal();
};
window.editRace=id=>{
  const r=raceById(id); if(!r)return;
  raceId.value=r.id;
  raceName.value=r.name;
  raceDistance.value=r.distance;
  raceGender.value=r.gender||"ALL";
  raceBirthMin.value=r.birthMin||"";
  raceBirthMax.value=r.birthMax||"";
  raceBibStart.value=r.bibStart??"";
  raceBibEnd.value=r.bibEnd??"";
  renderRaceClassChoices(r.classNames||[]);
  buildParticipantChecks(r.manualParticipantIds||[]);
  raceDialogTitle.textContent="Modifier la course";
  raceDialog.showModal();
};
window.deleteRace=id=>{if(confirm("Supprimer cette course et ses résultats ?")){state.races=state.races.filter(r=>r.id!==id);save();}};

function currentManualRaceSelections(){
  return [...document.querySelectorAll("#raceParticipants input:checked")]
    .filter(x=>x.dataset.auto!=="1")
    .map(x=>x.value);
}

function refreshRaceParticipantsFromCriteria(){
  const manual=currentManualRaceSelections();
  buildParticipantChecks(manual);
}

["raceGender","raceBirthMin","raceBirthMax"].forEach(id=>{
  document.getElementById(id).addEventListener("change",refreshRaceParticipantsFromCriteria);
  document.getElementById(id).addEventListener("input",refreshRaceParticipantsFromCriteria);
});
document.getElementById("raceClassChoices").addEventListener("change",refreshRaceParticipantsFromCriteria);
document.getElementById("applyRaceCriteriaBtn").addEventListener("click",refreshRaceParticipantsFromCriteria);

document.getElementById("saveRaceBtn").onclick=e=>{
  e.preventDefault();
  if(!raceName.value.trim()||!raceDistance.value){alert("Nom et distance obligatoires.");return;}
  const id=raceId.value||uid("race");
  const checked=[...document.querySelectorAll("#raceParticipants input:checked")];
  const manualParticipantIds=checked.filter(x=>x.dataset.auto!=="1").map(x=>x.value);
  const classNames=selectedRaceClasses();
  const autoParticipantIds=autoParticipantIdsForCriteria(raceGender.value,raceBirthMin.value,raceBirthMax.value,classNames);
  const selected=[...new Set([...autoParticipantIds,...manualParticipantIds])];
  const bibStart=raceBibStart.value?Number(raceBibStart.value):null;
  const bibEnd=raceBibEnd.value?Number(raceBibEnd.value):null;

  if((bibStart===null)!==(bibEnd===null)){
    alert("Renseignez le premier ET le dernier numéro de dossard.");
    return;
  }
  if(bibStart!==null && (!Number.isInteger(bibStart)||!Number.isInteger(bibEnd)||bibStart<1||bibEnd<bibStart)){
    alert("La plage de dossards est invalide.");
    return;
  }

  if(bibStart!==null){
    const overlapping=state.races.find(r=>r.id!==id && r.bibStart!=null && r.bibEnd!=null && bibStart<=r.bibEnd && bibEnd>=r.bibStart);
    if(overlapping){
      alert(`Cette plage chevauche celle de la course « ${overlapping.name} » (${formatBib(overlapping.bibStart)} à ${formatBib(overlapping.bibEnd)}).`);
      return;
    }
    if(selected.length > (bibEnd-bibStart+1)){
      alert(`La plage ${formatBib(bibStart)} à ${formatBib(bibEnd)} ne contient que ${bibEnd-bibStart+1} numéros pour ${selected.length} participants.`);
      return;
    }
  }

  let existing=raceById(id);
  const rawBirth1=raceBirthMin.value?Number(raceBirthMin.value):null;
  const rawBirth2=raceBirthMax.value?Number(raceBirthMax.value):null;
  const normalizedBirthMin=rawBirth1!==null&&rawBirth2!==null?Math.min(rawBirth1,rawBirth2):(rawBirth1??rawBirth2);
  const normalizedBirthMax=rawBirth1!==null&&rawBirth2!==null?Math.max(rawBirth1,rawBirth2):(rawBirth1??rawBirth2);
  const data={id,name:raceName.value.trim(),distance:Number(raceDistance.value),gender:raceGender.value,birthMin:normalizedBirthMin,birthMax:normalizedBirthMax,classNames,bibStart,bibEnd,participantIds:selected,manualParticipantIds,startedAt:existing?.startedAt||null,stoppedAt:existing?.stoppedAt||null,results:existing?.results||{},participantStatus:existing?.participantStatus||{}};
  const idx=state.races.findIndex(r=>r.id===id); if(idx>=0)state.races[idx]=data;else state.races.push(data);raceDialog.close();save();
};


const startGroupDialog=document.getElementById("startGroupDialog");

function buildStartGroupRaceChecks(selected=[]){
  const target=document.getElementById("startGroupRaces");
  target.innerHTML=state.races.map(r=>`<div class="check-item">
    <input type="checkbox" value="${r.id}" ${selected.includes(r.id)?"checked":""}>
    <label><strong>${esc(r.name)}</strong> · ${esc(r.distance)} m · dossards ${r.bibStart!=null&&r.bibEnd!=null?`${formatBib(r.bibStart)}–${formatBib(r.bibEnd)}`:"non définis"}</label>
  </div>`).join("") || '<span class="muted">Créez d’abord les catégories / courses.</span>';
}

document.getElementById("addStartGroupBtn").onclick=()=>{
  startGroupForm.reset();
  startGroupId.value="";
  startGroupDialogTitle.textContent="Nouveau départ groupé";
  buildStartGroupRaceChecks([]);
  startGroupDialog.showModal();
};

window.editStartGroup=id=>{
  const g=startGroupById(id); if(!g)return;
  startGroupId.value=g.id;
  startGroupName.value=g.name;
  buildStartGroupRaceChecks(g.raceIds||[]);
  startGroupDialogTitle.textContent="Modifier le départ groupé";
  startGroupDialog.showModal();
};

window.deleteStartGroup=id=>{
  if(!confirm("Supprimer ce départ groupé ? Les catégories seront conservées."))return;
  state.startGroups=(state.startGroups||[]).filter(g=>g.id!==id);
  save();
};

document.getElementById("saveStartGroupBtn").onclick=e=>{
  e.preventDefault();
  const name=startGroupName.value.trim();
  const raceIds=[...document.querySelectorAll("#startGroupRaces input:checked")].map(x=>x.value);
  if(!name){alert("Donnez un nom au départ groupé.");return;}
  if(raceIds.length<2){alert("Sélectionnez au moins deux catégories.");return;}
  const id=startGroupId.value||uid("group");
  const existing=startGroupById(id);
  const data={id,name,raceIds,startedAt:existing?.startedAt||null,stoppedAt:existing?.stoppedAt||null};
  const idx=(state.startGroups||[]).findIndex(g=>g.id===id);
  if(idx>=0)state.startGroups[idx]=data; else state.startGroups.push(data);
  startGroupDialog.close();
  save();
};

function renderStartGroups(){
  const wrap=document.getElementById("startGroupCards"); if(!wrap)return;
  const groups=state.startGroups||[];
  wrap.innerHTML=groups.map(g=>{
    const races=(g.raceIds||[]).map(raceById).filter(Boolean);
    return `<article class="race-card">
      <h3>${esc(g.name)}</h3>
      <div class="race-meta">${races.map(r=>esc(r.name)).join(" + ")}</div>
      <div class="race-meta">${g.startedAt?(g.stoppedAt?"Terminé":"En cours"):"Non démarré"}</div>
      <div class="race-actions">
        <button class="btn secondary" onclick="editStartGroup('${g.id}')">Modifier</button>
        <button class="btn danger" onclick="deleteStartGroup('${g.id}')">Supprimer</button>
      </div>
    </article>`;
  }).join("") || '<div class="panel muted">Aucun départ groupé créé.</div>';
}

function fillStartGroupSelects(){
  ["timingGroupSelect","finishGroupSelect","checkpointGroupSelect","statusGroupSelect","resultsGroupSelect"].forEach(id=>{
    const el=document.getElementById(id); if(!el)return;
    const prev=el.value;
    el.innerHTML='<option value="">Choisir un départ groupé</option>'+(state.startGroups||[]).map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join("");
    if((state.startGroups||[]).some(g=>g.id===prev))el.value=prev;
  });

  const archiveSelect=document.getElementById("resultsArchiveSelect");
  if(archiveSelect){
    const prev=archiveSelect.value;
    archiveSelect.innerHTML='<option value="">Choisir une archive</option>'+(state.resultArchives||[]).map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join("");
    if((state.resultArchives||[]).some(a=>a.id===prev))archiveSelect.value=prev;
  }
}

function groupElapsedMs(g){
  if(!g?.startedAt)return 0;
  return Math.max(0,(g.stoppedAt||Date.now())-g.startedAt);
}

function raceGroup(r){
  return (state.startGroups||[]).find(g=>(g.raceIds||[]).includes(r?.id) && g.startedAt);
}

function raceEffectiveStartMs(r){
  if(r?.startedAt)return r.startedAt;
  return raceGroup(r)?.startedAt||null;
}

function raceEffectiveElapsedMs(r){
  if(r?.startedAt)return elapsedForRace(r);
  const g=raceGroup(r);
  return g?groupElapsedMs(g):0;
}

function fillRaceSelects(){
  ["timingRaceSelect","checkpointRaceSelect","finishRaceSelect","resultsRaceSelect","bibRaceSelect","statusRaceSelect"].forEach(id=>{
    const el=document.getElementById(id), prev=el.value;
    el.innerHTML=`<option value="">Choisir une course</option>`+state.races.map(r=>`<option value="${r.id}">${esc(r.name)}</option>`).join("");
    if(state.races.some(r=>r.id===prev)) el.value=prev;
  });
}
["timingRaceSelect","checkpointRaceSelect","finishRaceSelect","bibRaceSelect","statusRaceSelect"].forEach(id=>document.getElementById(id).addEventListener("change",()=>renderAll()));
resultsRaceSelect.addEventListener("change",renderResults);
document.getElementById("resultsClassSelect").addEventListener("change",renderResults);
["timingGroupSelect","finishGroupSelect","checkpointGroupSelect","statusGroupSelect","resultsGroupSelect"].forEach(id=>document.getElementById(id)?.addEventListener("change",()=>renderAll()));
checkpointName.addEventListener("input",renderCheckpoint);
["timingGroupSelect","finishGroupSelect","checkpointGroupSelect","statusGroupSelect","resultsGroupSelect"].forEach(id=>document.getElementById(id)?.addEventListener("change",()=>renderAll()));
checkpointName.addEventListener("input",renderCheckpoint);

function updateTimingModeUI(){
  const group=timingModeSelect.value==="group";
  timingRaceWrap.style.display=group?"none":"block";
  timingGroupWrap.style.display=group?"block":"none";
  renderTimer();
}
timingModeSelect.addEventListener("change",updateTimingModeUI);

document.getElementById("startRaceBtn").onclick=()=>{
  if(timingModeSelect.value==="group"){
    const g=startGroupById(timingGroupSelect.value);
    if(!g){alert("Choisissez un départ groupé.");return;}
    if(g.startedAt&&!g.stoppedAt){alert("Ce départ est déjà en cours.");return;}

    if(g.stoppedAt){
      if(!confirm("Ce départ groupé a déjà été utilisé. Ses résultats vont être archivés avant de lancer une nouvelle course. Continuer ?"))return;
      prepareGroupRestart(g);
    }

    g.startedAt=Date.now();
    g.stoppedAt=null;
    save();
    return;
  }

  const r=raceById(timingRaceSelect.value);
  if(!r){alert("Choisissez une course.");return;}
  if(r.startedAt&&!r.stoppedAt){alert("Cette course est déjà en cours.");return;}

  if(r.stoppedAt){
    if(!confirm("Cette catégorie a déjà été utilisée. Ses résultats vont être archivés avant de lancer une nouvelle course. Continuer ?"))return;
    prepareRaceRestart(r);
  }

  r.startedAt=Date.now();
  r.stoppedAt=null;
  save();
};

document.getElementById("stopRaceBtn").onclick=()=>{
  if(timingModeSelect.value==="group"){
    const g=startGroupById(timingGroupSelect.value);
    if(g?.startedAt&&!g.stoppedAt){
      g.stoppedAt=Date.now();
      archiveGroupResults(g);
      save();
      alert("Départ groupé arrêté : les résultats ont été sauvegardés dans les archives.");
    }
    return;
  }

  const r=raceById(timingRaceSelect.value);
  if(r?.startedAt&&!r.stoppedAt){
    r.stoppedAt=Date.now();
    archiveRaceResults(r);
    save();
    alert("Course arrêtée : les résultats ont été sauvegardés dans les archives.");
  }
};

document.getElementById("resetRaceBtn").onclick=()=>{
  if(timingModeSelect.value==="group"){
    const g=startGroupById(timingGroupSelect.value);
    if(!g)return;
    if(confirm("Réinitialiser ce départ ? Une archive sera créée avant l’effacement des données actuelles.")){ archiveGroupResults(g);
      g.startedAt=null;g.stoppedAt=null;
      (g.raceIds||[]).map(raceById).filter(Boolean).forEach(r=>{
        r.results={};r.startedAt=null;r.stoppedAt=null;
        state.checkpoints=state.checkpoints.filter(c=>c.raceId!==r.id);
      });
      save();
    }
    return;
  }
  const r=raceById(timingRaceSelect.value);
  if(r&&confirm("Réinitialiser cette course ? Une archive sera créée avant l’effacement des données actuelles.")){ archiveRaceResults(r);
    r.startedAt=null;r.stoppedAt=null;r.results={};
    state.checkpoints=state.checkpoints.filter(c=>c.raceId!==r.id);
    save();
  }
};

function renderTimer(){
  const timer=document.getElementById("mainTimer");
  if(timingModeSelect.value==="group"){
    const g=startGroupById(timingGroupSelect.value);
    timer.textContent=g?.startedAt?formatClock(groupElapsedMs(g)):"00:00.0";
    timingStatus.textContent=!g?"Choisissez un départ groupé.":!g.startedAt?"Départ non démarré.":g.stoppedAt?"Départ arrêté.":"Départ groupé en cours.";
    return;
  }
  const r=raceById(timingRaceSelect.value);
  timer.textContent=r?.startedAt?formatClock(elapsedForRace(r)):"00:00.0";
  timingStatus.textContent=!r?"Choisissez une course.":!r.startedAt?"Course non démarrée.":r.stoppedAt?"Course arrêtée.":"Course en cours.";
}
setInterval(renderTimer,100);

function updateCheckpointModeUI(){
  const group=checkpointModeSelect.value==="group";
  checkpointRaceWrap.style.display=group?"none":"block";
  checkpointGroupWrap.style.display=group?"block":"none";
}

checkpointModeSelect.addEventListener("change",()=>{
  updateCheckpointModeUI();
  renderCheckpoint();
});
checkpointGroupSelect.addEventListener("change",renderCheckpoint);

function selectedCheckpointRaces(){
  if(checkpointModeSelect.value==="group"){
    const g=startGroupById(checkpointGroupSelect.value);
    return g?(g.raceIds||[]).map(raceById).filter(Boolean):[];
  }
  const r=raceById(checkpointRaceSelect.value);
  return r?[r]:[];
}

function renderCheckpoint(){
  updateCheckpointModeUI();
  const races=selectedCheckpointRaces();
  const wrap=document.getElementById("checkpointBibs");
  const log=document.getElementById("checkpointLog");

  if(!races.length){
    wrap.innerHTML='<p class="muted">Choisissez une course ou un départ groupé.</p>';
    log.innerHTML="";
    return;
  }

  const cpName=(checkpointName.value.trim()||"Point");
  const pending=[];

  races.forEach(r=>{
    const passedIds=new Set(
      state.checkpoints
        .filter(c=>c.raceId===r.id && (c.name||"Point")===cpName)
        .map(c=>c.studentId)
    );

    (r.participantIds||[])
      .map(studentById)
      .filter(Boolean)
      .filter(s=>!participantIsWithdrawn(r,s.id))
      .filter(s=>!passedIds.has(s.id))
      .forEach(s=>pending.push({student:s,race:r}));
  });

  pending.sort((a,b)=>(a.student.bib||99999)-(b.student.bib||99999));

  wrap.innerHTML=pending.map(x=>`
    <button class="bib-btn" onclick="markCheckpoint('${x.race.id}','${x.student.id}')">
      ${esc(x.student.bib!=null?formatBib(x.student.bib):"?")}
      <small>${esc(x.student.lastName)} ${esc(x.student.firstName)}</small>
      ${races.length>1?`<small>${esc(x.race.name)}</small>`:""}
    </button>
  `).join("") || '<p class="muted">Tous les participants ont été enregistrés à ce point de passage.</p>';

  const raceIds=new Set(races.map(r=>r.id));
  const passages=state.checkpoints
    .filter(c=>raceIds.has(c.raceId) && (c.name||"Point")===cpName)
    .sort((a,b)=>b.createdAt-a.createdAt);

  log.innerHTML=passages.map(c=>{
    const s=studentById(c.studentId);
    const r=raceById(c.raceId);
    return `<div class="log-row">
      <span>Dossard ${esc(s?.bib!=null?formatBib(s.bib):"?")} · ${esc(s?.lastName||"")} ${esc(s?.firstName||"")}${races.length>1?` · ${esc(r?.name||"")}`:""}</span>
      <span>
        <strong>${formatTime(c.seconds)}</strong>
        <button class="btn secondary" onclick="undoCheckpoint('${c.id}')">Réintégrer</button>
      </span>
    </div>`;
  }).join("") || '<span class="muted">Aucun passage enregistré.</span>';
}

window.markCheckpoint=(raceId,sid)=>{
  const r=raceById(raceId);
  if(participantIsWithdrawn(r,sid)){
    alert("Ce participant est indiqué comme non-partant ou abandon.");
    return;
  }
  if(!raceEffectiveStartMs(r)){
    alert("Le chronomètre de la course ou de son départ groupé doit être démarré.");
    return;
  }

  const cpName=checkpointName.value.trim()||"Point";
  const alreadyPassed=state.checkpoints.some(
    c=>c.raceId===raceId && c.studentId===sid && (c.name||"Point")===cpName
  );
  if(alreadyPassed){
    alert("Ce dossard a déjà été enregistré à ce point de passage.");
    return;
  }

  const seconds=raceEffectiveElapsedMs(r)/1000;
  state.checkpoints.push({
    id:uid("cp"),
    raceId,
    studentId:sid,
    name:cpName,
    seconds,
    createdAt:Date.now()
  });
  save();
};

window.undoCheckpoint=id=>{
  const passage=state.checkpoints.find(c=>c.id===id);
  if(!passage)return;
  const s=studentById(passage.studentId);
  const bib=s?.bib!=null?formatBib(s.bib):"?";
  if(!confirm(`Réintégrer le dossard ${bib} à ce point de passage ?`))return;
  state.checkpoints=state.checkpoints.filter(c=>c.id!==id);
  save();
};

// =======================
// NON-PARTANTS / ABANDONS
// =======================

let statusSearchText="";

document.getElementById("statusStudentSearch").addEventListener("input",e=>{
  statusSearchText=e.target.value||"";
  renderParticipantStatus();
});
document.getElementById("statusRaceSelect").addEventListener("change",renderParticipantStatus);
document.getElementById("statusGroupSelect").addEventListener("change",renderParticipantStatus);
document.getElementById("statusModeSelect").addEventListener("change",()=>{
  updateStatusModeUI();
  renderParticipantStatus();
});

function updateStatusModeUI(){
  const group=statusModeSelect.value==="group";
  statusRaceWrap.style.display=group?"none":"block";
  statusGroupWrap.style.display=group?"block":"none";
}

function statusStudentMatchesSearch(s){
  const q=statusSearchText.trim().toLowerCase();
  if(!q)return true;
  return `${s.bib!=null?formatBib(s.bib):""} ${s.lastName} ${s.firstName} ${s.className}`.toLowerCase().includes(q);
}

function statusStudentRow(r,s,mode){
  const finish=resultFor(r,s.id)?.finishSeconds;
  if(mode==="active"){
    const finished=finish!=null;
    return `<div class="status-row">
      <div class="status-person">
        <strong>${esc(s.bib!=null?formatBib(s.bib):"?")} · ${esc(s.lastName)} ${esc(s.firstName)}</strong>
        <span>${esc(s.className)} · ${esc(r.name)}${finished?` · Arrivé en ${formatTime(finish)}`:""}</span>
      </div>
      <div class="status-actions">
        ${finished
          ? '<span class="criteria-badge auto">Arrivé</span>'
          : `<button class="btn secondary" onclick="setParticipantStatus('${r.id}','${s.id}','no_start')">Non-partant</button>
             <button class="btn danger" onclick="setParticipantStatus('${r.id}','${s.id}','abandoned')">Abandon</button>`}
      </div>
    </div>`;
  }

  const record=r.participantStatus?.[s.id]||{};
  return `<div class="status-row withdrawn">
    <div class="status-person">
      <strong>${esc(s.bib!=null?formatBib(s.bib):"?")} · ${esc(s.lastName)} ${esc(s.firstName)}</strong>
      <span>${esc(s.className)} · ${esc(r.name)}${record.at?` · ${new Date(record.at).toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"})}`:""}</span>
    </div>
    <button class="btn secondary" onclick="reinstateParticipant('${r.id}','${s.id}')">Réintégrer</button>
  </div>`;
}

function selectedStatusRaces(){
  if(statusModeSelect.value==="group"){
    const g=startGroupById(statusGroupSelect.value);
    return g?(g.raceIds||[]).map(raceById).filter(Boolean):[];
  }
  const r=raceById(statusRaceSelect.value);
  return r?[r]:[];
}

function renderParticipantStatus(){
  updateStatusModeUI();

  const races=selectedStatusRaces();
  const activeWrap=document.getElementById("statusActiveList");
  const noStartWrap=document.getElementById("statusNoStartList");
  const abandonedWrap=document.getElementById("statusAbandonedList");
  if(!activeWrap||!noStartWrap||!abandonedWrap)return;

  if(!races.length){
    activeWrap.innerHTML=noStartWrap.innerHTML=abandonedWrap.innerHTML='<span class="muted">Choisissez une course ou un départ groupé.</span>';
    statusActiveCount.textContent="0";
    statusNoStartCount.textContent="0";
    statusAbandonedCount.textContent="0";
    statusFinishedCount.textContent="0";
    return;
  }

  const rows=[];
  races.forEach(r=>{
    ensureParticipantStatus(r);
    (r.participantIds||[]).map(studentById).filter(Boolean).forEach(s=>rows.push({race:r,student:s}));
  });

  const active=rows.filter(x=>participantStatusFor(x.race,x.student.id)==="active");
  const noStart=rows.filter(x=>participantStatusFor(x.race,x.student.id)==="no_start");
  const abandoned=rows.filter(x=>participantStatusFor(x.race,x.student.id)==="abandoned");
  const finished=active.filter(x=>resultFor(x.race,x.student.id)?.finishSeconds!=null);

  statusActiveCount.textContent=String(active.length-finished.length);
  statusNoStartCount.textContent=String(noStart.length);
  statusAbandonedCount.textContent=String(abandoned.length);
  statusFinishedCount.textContent=String(finished.length);

  const sortRows=arr=>arr.slice().sort((a,b)=>(a.student.bib||999999)-(b.student.bib||999999));
  const visible=arr=>sortRows(arr).filter(x=>statusStudentMatchesSearch(x.student));

  activeWrap.innerHTML=visible(active).map(x=>statusStudentRow(x.race,x.student,"active")).join("") || '<span class="muted">Aucun participant actif pour cette recherche.</span>';
  noStartWrap.innerHTML=visible(noStart).map(x=>statusStudentRow(x.race,x.student,"no_start")).join("") || '<span class="muted">Aucun non-partant.</span>';
  abandonedWrap.innerHTML=visible(abandoned).map(x=>statusStudentRow(x.race,x.student,"abandoned")).join("") || '<span class="muted">Aucun abandon.</span>';
}

window.setParticipantStatus=(raceId,sid,status)=>{
  const r=raceById(raceId);
  const s=studentById(sid);
  if(!r||!s)return;

  if(resultFor(r,sid)?.finishSeconds!=null){
    alert("Cet élève possède déjà une arrivée. Réintégrez d'abord son arrivée depuis l'écran Arrivée avant de modifier son statut.");
    return;
  }

  const started=!!raceEffectiveStartMs(r);
  const message=status==="no_start"
    ? `Indiquer le dossard ${formatBib(s.bib)} comme NON-PARTANT${started?" pendant cette course":""} ? Il sera retiré du point de passage et de l'arrivée.`
    : `Indiquer le dossard ${formatBib(s.bib)} comme ABANDON ? Il sera retiré des prochains points de passage et de l'arrivée.`;
  if(!confirm(message))return;

  r.participantStatus=r.participantStatus||{};
  r.participantStatus[sid]={status,at:Date.now()};

  if(status==="no_start"){
    state.checkpoints=state.checkpoints.filter(c=>!(c.raceId===raceId && c.studentId===sid));
    if(r.results?.[sid])delete r.results[sid];
  }else if(status==="abandoned"){
    if(r.results?.[sid]){
      delete r.results[sid].finishSeconds;
      delete r.results[sid].finishedAt;
    }
  }
  save();
};

window.reinstateParticipant=(raceId,sid)=>{
  const r=raceById(raceId);
  const s=studentById(sid);
  if(!r||!s)return;
  if(!confirm(`Réintégrer le dossard ${formatBib(s.bib)} dans la course ?`))return;
  r.participantStatus=r.participantStatus||{};
  delete r.participantStatus[sid];
  save();
};


function updateFinishModeUI(){
  const group=finishModeSelect.value==="group";
  finishRaceWrap.style.display=group?"none":"block";
  finishGroupWrap.style.display=group?"block":"none";
  renderFinish();
}
finishModeSelect.addEventListener("change",updateFinishModeUI);

function renderFinish(){
  const wrap=document.getElementById("finishBibs");

  if(finishModeSelect.value==="group"){
    const g=startGroupById(finishGroupSelect.value);
    if(!g){wrap.innerHTML='<p class="muted">Choisissez un départ groupé.</p>';finishLog.innerHTML="";return;}
    const races=(g.raceIds||[]).map(raceById).filter(Boolean);
    const pending=[];
    races.forEach(r=>{
      (r.participantIds||[]).map(studentById).filter(Boolean)
        .filter(s=>!participantIsWithdrawn(r,s.id))
        .filter(s=>resultFor(r,s.id)?.finishSeconds==null)
        .forEach(s=>pending.push({student:s,race:r}));
    });
    pending.sort((a,b)=>(a.student.bib||99999)-(b.student.bib||99999));

    wrap.innerHTML=pending.map(x=>`<button class="bib-btn" onclick="finishStudent('${x.race.id}','${x.student.id}')">
      ${esc(x.student.bib!=null?formatBib(x.student.bib):"?")}
      <small>${esc(x.student.lastName)} ${esc(x.student.firstName)}</small>
      <small>${esc(x.race.name)}</small>
    </button>`).join("") || '<p class="muted">Tous les participants ont une arrivée enregistrée.</p>';

    const finished=[];
    races.forEach(r=>{
      sortedFinishers(r).forEach(s=>finished.push({student:s,race:r,sec:resultFor(r,s.id).finishSeconds}));
    });
    finished.sort((a,b)=>b.sec-a.sec);

    finishLog.innerHTML=finished.slice(0,12).map(x=>`<div class="log-row">
      <span>Dossard ${esc(formatBib(x.student.bib))} · ${esc(x.student.lastName)} ${esc(x.student.firstName)} · ${esc(x.race.name)}</span>
      <span><strong>${formatTime(x.sec)}</strong> <button class="btn secondary" onclick="undoFinish('${x.race.id}','${x.student.id}')">Réintégrer</button></span>
    </div>`).join("") || '<span class="muted">Aucune arrivée enregistrée.</span>';
    return;
  }

  const r=raceById(finishRaceSelect.value);
  if(!r){wrap.innerHTML='<p class="muted">Choisissez une course.</p>';finishLog.innerHTML="";return;}
  const pending=(r.participantIds||[]).map(studentById).filter(Boolean).filter(s=>!participantIsWithdrawn(r,s.id)).filter(s=>resultFor(r,s.id)?.finishSeconds==null).sort((a,b)=>(a.bib||99999)-(b.bib||99999));
  wrap.innerHTML=pending.map(s=>`<button class="bib-btn" onclick="finishStudent('${r.id}','${s.id}')">${esc(s.bib!=null?formatBib(s.bib):"?")}<small>${esc(s.lastName)} ${esc(s.firstName)}</small></button>`).join("") || '<p class="muted">Tous les participants ont une arrivée enregistrée.</p>';
  const finished=sortedFinishers(r).slice().reverse().slice(0,12);
  finishLog.innerHTML=finished.map(s=>`<div class="log-row"><span>Dossard ${esc(s.bib!=null?formatBib(s.bib):"?")} · ${esc(s.lastName)} ${esc(s.firstName)}</span><span><strong>${formatTime(resultFor(r,s.id).finishSeconds)}</strong> <button class="btn secondary" onclick="undoFinish('${r.id}','${s.id}')">Réintégrer</button></span></div>`).join("")||'<span class="muted">Aucune arrivée enregistrée.</span>';
}

window.finishStudent=(raceId,sid)=>{
  const r=raceById(raceId);
  if(participantIsWithdrawn(r,sid)){alert("Ce participant est indiqué comme non-partant ou abandon.");return;}
  if(!raceEffectiveStartMs(r)){alert("Le chronomètre de la course ou de son départ groupé doit être démarré.");return;}
  r.results=r.results||{};r.results[sid]={...(r.results[sid]||{}),finishSeconds:raceEffectiveElapsedMs(r)/1000,finishedAt:Date.now()};save();
};
window.undoFinish=(raceId,sid)=>{const r=raceById(raceId);if(r?.results?.[sid]){delete r.results[sid].finishSeconds;delete r.results[sid].finishedAt;save();}};

function speedKmH(distanceM,sec){return sec>0?(distanceM/1000)/(sec/3600):0;}
function pace(distanceM,sec){if(!sec||!distanceM)return "—";const minPerKm=(sec/60)/(distanceM/1000),m=Math.floor(minPerKm),s=Math.round((minPerKm-m)*60);return `${m}:${String(s).padStart(2,"0")} /km`;}

function buildResultRankings(r){
  const finished=sortedFinishers(r);
  const overallRank=new Map();
  const classRank=new Map();
  const classCounters={};

  finished.forEach((s,index)=>{
    overallRank.set(s.id,index+1);
    const cls=s.className||"Sans classe";
    classCounters[cls]=(classCounters[cls]||0)+1;
    classRank.set(s.id,classCounters[cls]);
  });

  return {finished,overallRank,classRank};
}

function currentResultContext(){
  const mode=resultsModeSelect.value;
  if(mode==="group"){
    const g=startGroupById(resultsGroupSelect.value);
    if(!g)return null;
    return {mode:"group",group:g,races:(g.raceIds||[]).map(raceById).filter(Boolean),name:g.name};
  }
  if(mode==="archive"){
    const a=resultArchiveById(resultsArchiveSelect.value);
    if(!a)return null;
    return {mode:"archive",archive:a,races:a.races||[],name:a.name};
  }
  const r=raceById(resultsRaceSelect.value);
  return r?{mode:"race",race:r,races:[r],name:r.name}:null;
}

function resultContextRows(ctx){
  if(!ctx)return [];

  if(ctx.mode==="archive"){
    const rows=[];
    (ctx.archive.races||[]).forEach(r=>{
      const byId=new Map((r.participants||[]).map(s=>[s.id,s]));
      Object.entries(r.results||{}).forEach(([sid,res])=>{
        if(res?.finishSeconds==null)return;
        const status=r.participantStatus?.[sid]?.status||"active";
        if(status==="no_start"||status==="abandoned")return;
        const s=byId.get(sid);
        if(s)rows.push({student:s,race:r,sec:res.finishSeconds,archived:true});
      });
    });
    return rows.sort((a,b)=>a.sec-b.sec);
  }

  const rows=[];
  ctx.races.forEach(r=>{
    sortedFinishers(r).forEach(s=>{
      rows.push({student:s,race:r,sec:resultFor(r,s.id).finishSeconds,archived:false});
    });
  });
  return rows.sort((a,b)=>a.sec-b.sec);
}

function resultContextParticipantCount(ctx){
  if(!ctx)return 0;
  if(ctx.mode==="archive"){
    return (ctx.archive.races||[]).reduce((sum,r)=>sum+(r.participants||[]).length,0);
  }
  return ctx.races.reduce((sum,r)=>sum+(r.participantIds||[]).length,0);
}

function fillResultsClassSelectFromRows(rows){
  const select=document.getElementById("resultsClassSelect");
  if(!select)return;
  const previous=select.value;
  const classes=[...new Set(rows.map(x=>x.student.className||"Sans classe"))]
    .sort((a,b)=>a.localeCompare(b,"fr"));
  select.innerHTML='<option value="">Toutes les classes</option>'+
    classes.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join("");
  if(classes.includes(previous))select.value=previous;
}

function updateResultsModeUI(){
  const mode=resultsModeSelect.value;
  resultsRaceWrap.style.display=mode==="race"?"block":"none";
  resultsGroupWrap.style.display=mode==="group"?"block":"none";
  resultsArchiveWrap.style.display=mode==="archive"?"block":"none";
  archiveResultsBtn.style.display=mode==="archive"?"none":"inline-flex";
}

["resultsModeSelect","resultsGroupSelect","resultsArchiveSelect"].forEach(id=>{
  document.getElementById(id).addEventListener("change",()=>{
    updateResultsModeUI();
    renderResults();
  });
});

function renderResults(){
  updateResultsModeUI();
  const ctx=currentResultContext();
  const body=document.getElementById("resultsBody");

  if(!ctx){
    body.innerHTML='<tr><td colspan="10" class="muted">Choisissez une course, un départ groupé ou une archive.</td></tr>';
    classRankingBody.innerHTML="";
    rParticipants.textContent="0";
    rFinishers.textContent="0";
    rBest.textContent="—";
    rAvgSpeed.textContent="—";
    fillResultsClassSelectFromRows([]);
    return;
  }

  const rows=resultContextRows(ctx);
  fillResultsClassSelectFromRows(rows);

  // Rangs dans l'ensemble affiché
  const overallRank=new Map();
  rows.forEach((x,i)=>overallRank.set(`${x.race.raceId||x.race.id}:${x.student.id}`,i+1));

  // Rangs par classe dans l'ensemble affiché
  const classCounters={};
  const classRank=new Map();
  rows.forEach(x=>{
    const cls=x.student.className||"Sans classe";
    classCounters[cls]=(classCounters[cls]||0)+1;
    classRank.set(`${x.race.raceId||x.race.id}:${x.student.id}`,classCounters[cls]);
  });

  // Rang dans la catégorie pour les départs groupés / archives groupées
  const raceCounters={};
  const raceRank=new Map();
  rows.forEach(x=>{
    const rid=x.race.raceId||x.race.id;
    raceCounters[rid]=(raceCounters[rid]||0)+1;
    raceRank.set(`${rid}:${x.student.id}`,raceCounters[rid]);
  });

  const selectedClass=document.getElementById("resultsClassSelect")?.value||"";
  const displayed=selectedClass
    ? rows.filter(x=>(x.student.className||"Sans classe")===selectedClass)
    : rows;

  rParticipants.textContent=resultContextParticipantCount(ctx);
  rFinishers.textContent=rows.length;
  rBest.textContent=rows.length?formatTime(rows[0].sec):"—";

  const speeds=rows.map(x=>speedKmH(Number(x.race.distance)||0,x.sec)).filter(Number.isFinite);
  const avg=speeds.length?speeds.reduce((a,b)=>a+b,0)/speeds.length:0;
  rAvgSpeed.textContent=speeds.length?`${avg.toFixed(2)} km/h`:"—";

  const showCategory=ctx.mode!=="race";
  resultsTableHead.innerHTML=`<tr>
    <th>${showCategory?"Rang groupé":"Rang course"}</th>
    ${showCategory?'<th>Rang catégorie</th>':""}
    <th>Rang classe</th>
    <th>Dossard</th>
    <th>Élève</th>
    <th>Classe</th>
    <th>Catégorie</th>
    <th>Temps</th>
    <th>Vitesse</th>
    <th>Allure</th>
    <th>Actions</th>
  </tr>`;

  body.innerHTML=displayed.map(x=>{
    const rid=x.race.raceId||x.race.id;
    const key=`${rid}:${x.student.id}`;
    const raceName=x.race.raceName||x.race.name||"";
    const distance=Number(x.race.distance)||0;
    return `<tr>
      <td><strong>${overallRank.get(key)}</strong> / ${rows.length}</td>
      ${showCategory?`<td><strong>${raceRank.get(key)}</strong></td>`:""}
      <td><strong>${classRank.get(key)}</strong></td>
      <td><strong>${esc(formatBib(x.student.bib))}</strong></td>
      <td>${esc(x.student.lastName)} ${esc(x.student.firstName)}</td>
      <td>${esc(x.student.className)}</td>
      <td>${esc(raceName)}</td>
      <td>${formatTime(x.sec)}</td>
      <td>${speedKmH(distance,x.sec).toFixed(2)} km/h</td>
      <td>${pace(distance,x.sec)}</td>
      <td>${ctx.mode==="archive"||!isAdmin()?"—":`<button class="btn secondary" onclick="openEditResult('${rid}','${x.student.id}')">Corriger</button> <button class="btn danger" onclick="undoFinish('${rid}','${x.student.id}')">Réintégrer</button>`}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="${showCategory?11:10}" class="muted">Aucun résultat pour cette sélection.</td></tr>`;

  const classGroups={};
  rows.forEach(x=>{
    const cls=x.student.className||"Sans classe";
    const distance=Number(x.race.distance)||0;
    const speed=speedKmH(distance,x.sec);
    if(!Number.isFinite(speed))return;
    (classGroups[cls]??=[]).push(speed);
  });

  const classes=Object.entries(classGroups)
    .map(([name,speeds])=>({
      name,
      count:speeds.length,
      avgSpeed:speeds.reduce((a,b)=>a+b,0)/speeds.length
    }))
    .sort((a,b)=>b.avgSpeed-a.avgSpeed);

  classRankingBody.innerHTML=classes.map((c,i)=>`<tr>
    <td>${i+1}</td>
    <td>${esc(c.name)}</td>
    <td>${c.count}</td>
    <td><strong>${c.avgSpeed.toFixed(2)} km/h</strong></td>
  </tr>`).join("") || '<tr><td colspan="4" class="muted">Pas encore de classement.</td></tr>';
}

const editResultDialog=document.getElementById("editResultDialog");
window.openEditResult=(raceId,sid)=>{
  resultsRaceSelect.value=raceId;
  const r=raceById(raceId);
  editResultStudentId.value=sid;
  editResultSeconds.value=resultFor(r,sid)?.finishSeconds??"";
  editResultDialog.showModal();
};

document.getElementById("saveResultBtn").onclick=e=>{
  e.preventDefault();
  const r=raceById(resultsRaceSelect.value),sid=editResultStudentId.value;
  if(!r||!sid)return;
  const sec=Number(editResultSeconds.value);
  if(!Number.isFinite(sec)||sec<0){alert("Temps invalide.");return;}
  r.results=r.results||{};
  r.results[sid]={...(r.results[sid]||{}),finishSeconds:sec,finishedAt:Date.now(),manual:true};
  editResultDialog.close();
  save();
};

document.getElementById("archiveResultsBtn").onclick=()=>{
  const ctx=currentResultContext();
  if(!ctx){alert("Choisissez une course ou un départ groupé.");return;}
  if(ctx.mode==="group"){
    archiveGroupResults(ctx.group,null,true);
  }else if(ctx.mode==="race"){
    archiveRaceResults(ctx.race,null,true);
  }
  save();
  alert("Une copie des résultats a été enregistrée dans les archives.");
};

document.getElementById("exportResultsBtn").onclick=()=>{
  const ctx=currentResultContext();
  if(!ctx){alert("Choisissez une course, un départ groupé ou une archive.");return;}

  const rows=resultContextRows(ctx);
  const selectedClass=document.getElementById("resultsClassSelect")?.value||"";
  const filtered=selectedClass?rows.filter(x=>(x.student.className||"Sans classe")===selectedClass):rows;

  const overallRank=new Map();
  rows.forEach((x,i)=>overallRank.set(`${x.race.raceId||x.race.id}:${x.student.id}`,i+1));
  const classCounters={},classRank=new Map(),raceCounters={},raceRank=new Map();

  rows.forEach(x=>{
    const rid=x.race.raceId||x.race.id;
    const key=`${rid}:${x.student.id}`;
    const cls=x.student.className||"Sans classe";
    classCounters[cls]=(classCounters[cls]||0)+1;
    classRank.set(key,classCounters[cls]);
    raceCounters[rid]=(raceCounters[rid]||0)+1;
    raceRank.set(key,raceCounters[rid]);
  });

  const csvRows=[["Rang_general","Rang_categorie","Rang_classe","Dossard","Nom","Prenom","Classe","Categorie","Distance_m","Temps_secondes","Temps","Vitesse_kmh","Allure_min_km"]];
  filtered.forEach(x=>{
    const rid=x.race.raceId||x.race.id;
    const key=`${rid}:${x.student.id}`;
    const distance=Number(x.race.distance)||0;
    csvRows.push([
      overallRank.get(key),
      raceRank.get(key),
      classRank.get(key),
      x.student.bib!=null?formatBib(x.student.bib):"",
      x.student.lastName,
      x.student.firstName,
      x.student.className,
      x.race.raceName||x.race.name||"",
      distance,
      x.sec.toFixed(1),
      formatTime(x.sec),
      speedKmH(distance,x.sec).toFixed(2),
      pace(distance,x.sec)
    ]);
  });

  const csv=csvRows.map(row=>row.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(";")).join("\n");
  const suffix=selectedClass?`-${slug(selectedClass)}`:"";
  downloadBlob(csv,`${slug(ctx.name)}${suffix}-resultats.csv`,"text/csv;charset=utf-8");
};

function downloadBlob(content,name,type){const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function slug(s){return String(s).toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");}


const BIB_PREFS_KEY="crossEPS_bibPrefs_v1";
const BIB_SIZE_DEFAULTS={
  bibNumberScale:100,
  bibStudentScale:100,
  bibClassScale:100,
  bibRaceScale:100,
  bibSchoolScale:100,
  bibCharityScale:100,
  bibSchoolLogoScale:100,
  bibCharityLogoScale:100
};
function loadBibPrefs(){try{return JSON.parse(localStorage.getItem(BIB_PREFS_KEY))||{};}catch{return {};}}
function saveBibPrefs(p){localStorage.setItem(BIB_PREFS_KEY,JSON.stringify(p));}
function bibSizeValue(prefs,key){
  const n=Number(prefs?.[key]);
  return Number.isFinite(n)?n:BIB_SIZE_DEFAULTS[key];
}
function bibScaleFactor(prefs,key){
  return (bibSizeValue(prefs,key)/100).toFixed(3);
}
function bibInlineVars(prefs){
  return [
    `--bib-number-scale:${bibScaleFactor(prefs,"bibNumberScale")}`,
    `--bib-student-scale:${bibScaleFactor(prefs,"bibStudentScale")}`,
    `--bib-class-scale:${bibScaleFactor(prefs,"bibClassScale")}`,
    `--bib-race-scale:${bibScaleFactor(prefs,"bibRaceScale")}`,
    `--bib-school-scale:${bibScaleFactor(prefs,"bibSchoolScale")}`,
    `--bib-charity-scale:${bibScaleFactor(prefs,"bibCharityScale")}`,
    `--bib-school-logo-scale:${bibScaleFactor(prefs,"bibSchoolLogoScale")}`,
    `--bib-charity-logo-scale:${bibScaleFactor(prefs,"bibCharityLogoScale")}`
  ].join(";");
}
function syncBibSizeControls(){
  const prefs=loadBibPrefs();
  Object.keys(BIB_SIZE_DEFAULTS).forEach(key=>{
    const input=document.getElementById(key);
    const value=document.getElementById(`${key}Value`);
    if(!input)return;
    const n=bibSizeValue(prefs,key);
    input.value=n;
    if(value)value.textContent=`${n} %`;
  });
}
function updateBibSizePref(key,value){
  const prefs=loadBibPrefs();
  prefs[key]=Number(value);
  saveBibPrefs(prefs);
  const label=document.getElementById(`${key}Value`);
  if(label)label.textContent=`${value} %`;
  renderBibs();
}
Object.keys(BIB_SIZE_DEFAULTS).forEach(key=>{
  const input=document.getElementById(key);
  if(input)input.addEventListener("input",e=>updateBibSizePref(key,e.target.value));
});
document.getElementById("resetBibSizesBtn").addEventListener("click",()=>{
  const prefs=loadBibPrefs();
  Object.assign(prefs,BIB_SIZE_DEFAULTS);
  saveBibPrefs(prefs);
  syncBibSizeControls();
  renderBibs();
});
function fileToDataURL(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});}
async function setBibLogo(kind,file){if(!file)return;const prefs=loadBibPrefs();prefs[kind]=await fileToDataURL(file);saveBibPrefs(prefs);renderBibs();}
document.getElementById("schoolLogoInput").addEventListener("change",e=>setBibLogo("schoolLogo",e.target.files[0]));
document.getElementById("charityLogoInput").addEventListener("change",e=>setBibLogo("charityLogo",e.target.files[0]));
document.getElementById("schoolNameInput").addEventListener("input",e=>{const p=loadBibPrefs();p.schoolName=e.target.value;saveBibPrefs(p);renderBibs();});
document.getElementById("charityTextInput").addEventListener("input",e=>{const p=loadBibPrefs();p.charityText=e.target.value;saveBibPrefs(p);renderBibs();});

function bibCardHTML(student,race,prefs){
  const schoolName=prefs.schoolName||"Collège Jean-Jacques Soulier – Montluçon";
  const charityText=prefs.charityText||"Course caritative au profit de Vaincre la Mucoviscidose";
  const schoolLogo=prefs.schoolLogo?`<img class="bib-logo bib-school-logo" src="${prefs.schoolLogo}" alt="Logo collège">`:`<div class="bib-logo-placeholder bib-school-logo">Logo<br>collège</div>`;
  const charityLogo=prefs.charityLogo?`<img class="bib-logo bib-charity-logo" src="${prefs.charityLogo}" alt="Logo association">`:`<div class="bib-logo-placeholder bib-charity-logo">Logo<br>association</div>`;
  return `<article class="print-bib" style="${bibInlineVars(prefs)}">
    <div class="bib-top">
      <div class="bib-brand">${schoolLogo}<span>${esc(schoolName)}</span></div>
      <div class="bib-race"><strong>${esc(race.name)}</strong><span>${esc(race.distance)} m</span></div>
      <div class="bib-brand right">${charityLogo}</div>
    </div>
    <div class="bib-number">${esc(formatBib(student.bib))}</div>
    <div class="bib-separator"></div>
    <div class="bib-student">${esc(student.lastName)} ${esc(student.firstName)}</div>
    <div class="bib-class">${esc(student.className)}</div>
    <div class="bib-charity">${esc(charityText)}</div>
  </article>`;
}
function renderBibs(){
  const select=document.getElementById("bibRaceSelect");
  const preview=document.getElementById("bibPreview");
  if(!select||!preview)return;
  const prefs=loadBibPrefs();
  syncBibSizeControls();
  schoolNameInput.value=prefs.schoolName||"Collège Jean-Jacques Soulier – Montluçon";
  charityTextInput.value=prefs.charityText||"Course caritative au profit de Vaincre la Mucoviscidose";
  const r=raceById(select.value);
  if(!r){preview.innerHTML='<p class="muted">Choisissez une course pour afficher les dossards.</p>';return;}
  const students=(r.participantIds||[]).map(studentById).filter(Boolean).sort((a,b)=>(a.bib||999999)-(b.bib||999999));
  if(!students.length){preview.innerHTML='<p class="muted">Aucun participant dans cette course.</p>';return;}
  preview.innerHTML=students.slice(0,2).map(s=>bibCardHTML(s,r,prefs)).join('<div class="cut-line">✂</div>');
}
document.getElementById("printBibsBtn").onclick=()=>{
  const r=raceById(bibRaceSelect.value);
  if(!r){alert("Choisissez une course.");return;}
  const students=(r.participantIds||[]).map(studentById).filter(Boolean).sort((a,b)=>(a.bib||999999)-(b.bib||999999));
  if(!students.length){alert("Cette course ne contient aucun participant.");return;}
  const prefs=loadBibPrefs();
  const pages=[];
  for(let i=0;i<students.length;i+=2){
    pages.push(`<section class="print-page">${bibCardHTML(students[i],r,prefs)}${students[i+1]?`<div class="print-cut"></div>${bibCardHTML(students[i+1],r,prefs)}`:""}</section>`);
  }
  const w=window.open("","_blank");
  if(!w){alert("Le navigateur a bloqué la fenêtre d'impression.");return;}
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Dossards - ${esc(r.name)}</title>
  <style>
    @page{size:A4 portrait;margin:0}
    *{box-sizing:border-box}
    body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#111}
    .print-page{width:210mm;height:297mm;page-break-after:always;display:flex;flex-direction:column}
    .print-page:last-child{page-break-after:auto}
    .print-bib{width:210mm;height:148.5mm;padding:10mm 12mm;border:1.2mm solid #0f766e;display:flex;flex-direction:column}
    .bib-top{display:grid;grid-template-columns:1fr 1.2fr 1fr;align-items:start;gap:6mm}
    .bib-brand{display:flex;gap:4mm;align-items:center;font-size:calc(11pt * var(--bib-school-scale,1));font-weight:700}.bib-brand.right{justify-content:flex-end}
    .bib-logo{object-fit:contain}.bib-school-logo{max-width:calc(28mm * var(--bib-school-logo-scale,1));max-height:calc(18mm * var(--bib-school-logo-scale,1))}.bib-charity-logo{max-width:calc(28mm * var(--bib-charity-logo-scale,1));max-height:calc(18mm * var(--bib-charity-logo-scale,1))}
    .bib-logo-placeholder{border:1px dashed #888;font-size:8pt;display:flex;align-items:center;justify-content:center;text-align:center;color:#666}.bib-logo-placeholder.bib-school-logo{width:calc(25mm * var(--bib-school-logo-scale,1));height:calc(16mm * var(--bib-school-logo-scale,1))}.bib-logo-placeholder.bib-charity-logo{width:calc(25mm * var(--bib-charity-logo-scale,1));height:calc(16mm * var(--bib-charity-logo-scale,1))}
    .bib-race{text-align:center;font-size:calc(13pt * var(--bib-race-scale,1))}.bib-race span{display:block;margin-top:2mm;color:#0f766e;font-weight:700}
    .bib-number{text-align:center;font-size:calc(72pt * var(--bib-number-scale,1));line-height:.9;font-weight:900;margin:8mm 0 3mm}
    .bib-separator{border-top:.5mm solid #0f766e;margin:0 8mm 4mm}
    .bib-student{text-align:center;font-size:calc(19pt * var(--bib-student-scale,1));font-weight:800}
    .bib-class{text-align:center;font-size:calc(14pt * var(--bib-class-scale,1));font-weight:700;margin-top:1mm}
    .bib-charity{text-align:center;font-size:calc(12pt * var(--bib-charity-scale,1));margin-top:auto;color:#0f766e;font-weight:700}
    .print-cut{height:0;border-top:.35mm dashed #777}
  </style></head><body>${pages.join("")}</body></html>`);
  w.document.close();w.focus();setTimeout(()=>w.print(),300);
};


// =======================
// MANIFESTATIONS / ARCHIVES
// =======================

const eventDialog=document.getElementById("eventDialog");
let eventFilterText="";
let eventFilterStatus="";
let pendingEventFiles=[];

function eventById(id){return (state.events||[]).find(e=>e.id===id);}

function openAttachmentDb(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open("crossEPS_files_v1",1);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains("attachments")){
        const store=db.createObjectStore("attachments",{keyPath:"id"});
        store.createIndex("eventId","eventId",{unique:false});
      }
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}

async function putAttachment(record){
  const db=await openAttachmentDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction("attachments","readwrite");
    tx.objectStore("attachments").put(record);
    tx.oncomplete=()=>{db.close();resolve();};
    tx.onerror=()=>{db.close();reject(tx.error);};
  });
}

async function getAttachment(id){
  const db=await openAttachmentDb();
  return new Promise((resolve,reject)=>{
    const req=db.transaction("attachments","readonly").objectStore("attachments").get(id);
    req.onsuccess=()=>{const value=req.result;db.close();resolve(value);};
    req.onerror=()=>{db.close();reject(req.error);};
  });
}

async function deleteAttachmentBlob(id){
  const db=await openAttachmentDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction("attachments","readwrite");
    tx.objectStore("attachments").delete(id);
    tx.oncomplete=()=>{db.close();resolve();};
    tx.onerror=()=>{db.close();reject(tx.error);};
  });
}

async function deleteEventAttachments(eventId){
  const db=await openAttachmentDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction("attachments","readwrite");
    const store=tx.objectStore("attachments");
    const idx=store.index("eventId");
    const req=idx.openCursor(IDBKeyRange.only(eventId));
    req.onsuccess=()=>{
      const cur=req.result;
      if(cur){cur.delete();cur.continue();}
    };
    tx.oncomplete=()=>{db.close();resolve();};
    tx.onerror=()=>{db.close();reject(tx.error);};
  });
}

function formatFileSize(bytes){
  const n=Number(bytes||0);
  if(n<1024)return `${n} o`;
  if(n<1024*1024)return `${(n/1024).toFixed(1)} Ko`;
  return `${(n/1024/1024).toFixed(1)} Mo`;
}

function formatEventDate(date){
  if(!date)return "Date non renseignée";
  const d=new Date(`${date}T12:00:00`);
  return Number.isNaN(d.getTime())?date:d.toLocaleDateString("fr-FR");
}

function renderEvents(){
  const wrap=document.getElementById("eventCards");
  if(!wrap)return;
  const q=eventFilterText.trim().toLowerCase();
  const events=(state.events||[])
    .filter(e=>!eventFilterStatus || e.status===eventFilterStatus)
    .filter(e=>!q || `${e.name} ${e.date} ${e.place} ${e.contact} ${e.audience} ${e.notes}`.toLowerCase().includes(q))
    .sort((a,b)=>(b.date||"").localeCompare(a.date||""));

  wrap.innerHTML=events.map(e=>`
    <article class="race-card event-card">
      <div class="event-card-top">
        <div>
          <h3>${esc(e.name)}</h3>
          <div class="race-meta">${esc(formatEventDate(e.date))}${e.place?` · ${esc(e.place)}`:""}</div>
        </div>
        <span class="criteria-badge ${e.status==="Terminée"?"auto":e.status==="Annulée"?"other":"manual"}">${esc(e.status||"Prévue")}</span>
      </div>
      ${e.audience?`<div class="race-meta"><strong>Public :</strong> ${esc(e.audience)}</div>`:""}
      ${e.notes?`<p>${esc(e.notes).replace(/\n/g,"<br>")}</p>`:""}
      <div class="race-meta event-doc-count">📁 ${(e.attachments||[]).length} document(s) dans le dossier</div>
      <div class="race-actions">
        <button class="btn secondary" onclick="editEvent('${e.id}')">Ouvrir le dossier</button>
        <button class="btn danger" onclick="deleteEvent('${e.id}')">Supprimer</button>
      </div>
    </article>
  `).join("") || '<div class="panel muted">Aucune manifestation enregistrée.</div>';
}

document.getElementById("eventSearch").addEventListener("input",e=>{
  eventFilterText=e.target.value; renderEvents();
});
document.getElementById("eventStatusFilter").addEventListener("change",e=>{
  eventFilterStatus=e.target.value; renderEvents();
});

document.getElementById("addEventBtn").onclick=()=>{
  eventForm.reset();
  eventId.value="";
  eventStatus.value="Prévue";
  eventDocumentCategory.value="Courrier";
  pendingEventFiles=[];
  eventAttachmentList.innerHTML='<span class="muted">Aucune pièce jointe.</span>';
  eventDialogTitle.textContent="Nouvelle manifestation";
  eventDialog.showModal();
};

window.editEvent=id=>{
  const e=eventById(id);if(!e)return;
  eventId.value=e.id;
  eventName.value=e.name||"";
  eventDate.value=e.date||"";
  eventPlace.value=e.place||"";
  eventStatus.value=e.status||"Prévue";
  eventContact.value=e.contact||"";
  eventAudience.value=e.audience||"";
  eventNotes.value=e.notes||"";
  pendingEventFiles=[];
  renderEventAttachmentList(e);
  eventDialogTitle.textContent="Modifier la manifestation";
  eventDialog.showModal();
};

document.getElementById("eventAttachmentsInput").addEventListener("change",e=>{
  const category=eventDocumentCategory.value||"Autre";
  Array.from(e.target.files||[]).forEach(file=>{
    pendingEventFiles.push({file,category});
  });
  const current=eventById(eventId.value)||{attachments:[]};
  renderEventAttachmentList(current);
  e.target.value="";
});

function renderEventAttachmentList(event){
  const saved=event?.attachments||[];
  const pending=pendingEventFiles||[];
  const parts=[];

  saved.forEach(a=>{
    parts.push(`<div class="attachment-row">
      <div class="attachment-main">
        <span class="document-category">${esc(a.category||"Autre")}</span>
        <span>📎 <strong>${esc(a.name)}</strong> <small>${esc(formatFileSize(a.size))}</small></span>
      </div>
      <span class="attachment-actions">
        <button type="button" class="btn secondary" onclick="downloadEventAttachment('${event.id}','${a.id}')">Ouvrir / Télécharger</button>
        <button type="button" class="btn danger" onclick="removeEventAttachment('${event.id}','${a.id}')">Retirer</button>
      </span>
    </div>`);
  });

  pending.forEach((item,i)=>{
    const f=item.file||item;
    const category=item.category||"Autre";
    parts.push(`<div class="attachment-row pending">
      <div class="attachment-main">
        <span class="document-category">${esc(category)}</span>
        <span>➕ <strong>${esc(f.name)}</strong> <small>${esc(formatFileSize(f.size))} · à enregistrer</small></span>
      </div>
      <button type="button" class="btn danger" onclick="removePendingEventAttachment(${i})">Retirer</button>
    </div>`);
  });

  eventAttachmentList.innerHTML=parts.join("") || '<div class="empty-folder">📁 Aucun document dans ce dossier.</div>';
}

window.removePendingEventAttachment=index=>{
  pendingEventFiles.splice(index,1);
  renderEventAttachmentList(eventById(eventId.value)||{attachments:[]});
};

window.downloadEventAttachment=async(eventId,attachmentId)=>{
  try{
    const record=await getAttachment(attachmentId);
    if(!record?.blob){alert("Le fichier n'est plus disponible sur cet appareil.");return;}
    const url=URL.createObjectURL(record.blob);
    const a=document.createElement("a");
    a.href=url;a.download=record.name||"piece-jointe";
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),2000);
  }catch{
    alert("Impossible d'ouvrir cette pièce jointe.");
  }
};

window.removeEventAttachment=async(eventId,attachmentId)=>{
  const e=eventById(eventId);if(!e)return;
  if(!confirm("Retirer cette pièce jointe de la manifestation ?"))return;
  try{await deleteAttachmentBlob(attachmentId);}catch{}
  e.attachments=(e.attachments||[]).filter(a=>a.id!==attachmentId);
  save();
  if(eventDialog.open)renderEventAttachmentList(e);
};

window.deleteEvent=async id=>{
  const e=eventById(id);if(!e)return;
  if(!confirm(`Supprimer définitivement la manifestation « ${e.name} » et ses pièces jointes ?`))return;
  try{await deleteEventAttachments(id);}catch{}
  state.events=(state.events||[]).filter(x=>x.id!==id);
  save();
};


document.getElementById("saveEventBtn").onclick=async ev=>{
  ev.preventDefault();
  const name=eventName.value.trim();
  if(!name){alert("Le nom de la manifestation est obligatoire.");return;}

  const id=eventId.value||uid("event");
  let existing=eventById(id);
  const data={
    id,
    name,
    date:eventDate.value||"",
    place:eventPlace.value.trim(),
    status:eventStatus.value,
    contact:eventContact.value.trim(),
    audience:eventAudience.value.trim(),
    notes:eventNotes.value.trim(),
    attachments:[...(existing?.attachments||[])],
    createdAt:existing?.createdAt||Date.now(),
    updatedAt:Date.now()
  };

  try{
    for(const item of pendingEventFiles){
      const file=item.file||item;
      const category=item.category||"Autre";
      const attachmentId=uid("att");
      await putAttachment({
        id:attachmentId,
        eventId:id,
        name:file.name,
        type:file.type||"application/octet-stream",
        size:file.size,
        category,
        createdAt:Date.now(),
        blob:file
      });
      data.attachments.push({
        id:attachmentId,
        name:file.name,
        type:file.type||"",
        size:file.size,
        category,
        createdAt:Date.now()
      });
    }
  }catch(err){
    console.error(err);
    alert("Une pièce jointe n'a pas pu être enregistrée. Vérifiez l'espace disponible sur l'appareil.");
    return;
  }

  const idx=(state.events||[]).findIndex(e=>e.id===id);
  if(idx>=0)state.events[idx]=data; else state.events.push(data);
  pendingEventFiles=[];
  eventDialog.close();
  save();
};


document.getElementById("downloadBackupBtn").onclick=()=>downloadBlob(JSON.stringify(state,null,2),`cross-eps-sauvegarde-${new Date().toISOString().slice(0,10)}.json`,"application/json");
document.getElementById("restoreBackupInput").addEventListener("change",async e=>{
  const f=e.target.files[0];if(!f)return;try{const data=JSON.parse(await f.text());Object.keys(state).forEach(k=>delete state[k]);Object.assign(state,data);save();alert("Sauvegarde restaurée.");}catch{alert("Fichier de sauvegarde invalide.");}e.target.value="";
});
document.getElementById("clearDataBtn").onclick=()=>{if(confirm("Effacer définitivement toutes les données locales ?")){Object.keys(state).forEach(k=>delete state[k]);Object.assign(state,defaultState());save();}};
document.getElementById("demoDataBtn").onclick=()=>{
  if(state.students.length||state.races.length){if(!confirm("Ajouter les données de démonstration aux données existantes ?"))return;}
  const demo=[
    ["MARTIN","Léa","2013-04-10","F","5A",101],["DUPONT","Hugo","2013-07-21","M","5A",102],["BERNARD","Emma","2014-02-02","F","6B",103],["ROBERT","Lucas","2014-11-18","M","6B",104],["PETIT","Chloé","2013-09-03","F","5C",105],["RICHARD","Nathan","2014-06-30","M","6A",106]
  ].map(x=>({id:uid("stu"),lastName:x[0],firstName:x[1],birthDate:x[2],gender:x[3],className:x[4],bib:x[5]}));
  state.students.push(...demo);
  state.races.push({id:uid("race"),name:"Course Démo 1 800 m",distance:1800,gender:"ALL",birthMin:null,birthMax:null,participantIds:demo.map(s=>s.id),manualParticipantIds:[],bibStart:100,bibEnd:199,startedAt:null,stoppedAt:null,results:{},participantStatus:{}});
  save();
};


// ======================= SUPABASE / ACCÈS MULTI-APPAREILS =======================
const authGate=document.getElementById("authGate");
const authMessage=document.getElementById("authMessage");
const teacherAccessForm=document.getElementById("teacherAccessForm");
const adminLoginForm=document.getElementById("adminLoginForm");
const logoutBtn=document.getElementById("logoutBtn");

function showAuthMessage(message,type="info"){
  if(!authMessage)return;
  authMessage.hidden=!message;
  authMessage.textContent=message||"";
  authMessage.className=`auth-message ${type}`;
}
function showAuthGate(message=""){
  authGate.hidden=false;
  authGate.classList.remove("hidden");
  if(message)showAuthMessage(message,"error");
}
function hideAuthGate(){
  authGate.hidden=true;
  authGate.classList.add("hidden");
  showAuthMessage("");
}
function roleLabel(role){
  return {admin:"Administration",start:"Départ",checkpoint:"Point de passage",finish:"Arrivée"}[role]||role;
}
function applyRoleUI(){
  const badge=document.getElementById("accessRoleBadge");
  const role=currentAccess?.role||null;
  if(badge){
    badge.hidden=!role;
    badge.textContent=role?roleLabel(role):"";
  }
  logoutBtn.hidden=!currentAccess;

  const allowed={
    admin:["dashboard","students","races","timing","startgroups","participantstatus","checkpoint","finish","results","bibs","events","settings"],
    start:["dashboard","timing","participantstatus"],
    checkpoint:["dashboard","checkpoint","participantstatus"],
    finish:["dashboard","finish","participantstatus","results"]
  }[role]||["dashboard"];

  document.querySelectorAll(".nav-btn").forEach(btn=>{
    btn.hidden=!allowed.includes(btn.dataset.view);
  });
  document.getElementById("cloudAdminPanel").hidden=!isAdmin();

  const activeView=document.querySelector(".view.active-view")?.id;
  if(activeView && !allowed.includes(activeView)){
    document.querySelectorAll(".view").forEach(v=>v.classList.remove("active-view"));
    document.querySelectorAll(".nav-btn").forEach(b=>b.classList.remove("active"));
    document.getElementById("dashboard")?.classList.add("active-view");
    document.querySelector('.nav-btn[data-view="dashboard"]')?.classList.add("active");
  }
}

adminLoginForm.addEventListener("submit",async e=>{
  e.preventDefault();
  try{
    showAuthMessage("Connexion à l'administration…","info");
    const email=(adminEmailInput.value||"").trim().toLowerCase();
    if(email!==ADMIN_EMAIL)throw new Error("Compte administrateur non autorisé.");

    const {data,error}=await supabaseClient.auth.signInWithPassword({
      email,
      password:adminPasswordInput.value
    });
    if(error)throw error;
    if(!data.user)throw new Error("Connexion impossible.");

    const {error:claimError}=await supabaseClient.rpc("claim_app_admin");
    if(claimError)throw claimError;

    await activateAdmin(data.user);
  }catch(err){
    console.error(err);
    showAuthMessage(err.message||"Connexion administrateur impossible.","error");
  }
});

teacherAccessForm.addEventListener("submit",async e=>{
  e.preventDefault();
  const clean=String(teacherCodeInput.value||"").replace(/\D/g,"").slice(0,6);
  const role=teacherRoleSelect.value;

  try{
    if(clean.length!==6)throw new Error("Le code doit comporter 6 chiffres.");
    if(!["start","checkpoint","finish"].includes(role))throw new Error("Poste non valide.");
    showAuthMessage("Connexion au CROSS…","info");

    const {data:sessionData}=await supabaseClient.auth.getSession();
    if(sessionData.session)await supabaseClient.auth.signOut();

    const {data:anonData,error:anonError}=await supabaseClient.auth.signInAnonymously();
    if(anonError)throw anonError;
    if(!anonData.user)throw new Error("Authentification temporaire impossible.");

    const {data,error}=await supabaseClient.rpc("join_cross_event",{
      p_code:clean,
      p_role:role
    });
    if(error)throw error;

    const row=Array.isArray(data)?data[0]:data;
    if(!row?.event_id)throw new Error("Code incorrect ou expiré.");

    const expiry=new Date(row.expires_at).getTime();
    currentEventId=row.event_id;
    localStorage.setItem(
      TEACHER_SESSION_KEY,
      JSON.stringify({eventId:currentEventId,role,expiry})
    );

    await activateTeacherAccess({eventId:currentEventId,role,expiry});
  }catch(err){
    console.error(err);
    showAuthMessage(err.message||"Impossible d'accéder au CROSS.","error");
    try{await supabaseClient.auth.signOut();}catch{}
  }
});

async function activateTeacherAccess(session){
  currentEventId=session.eventId;
  currentAccess={kind:"teacher",role:session.role,eventId:session.eventId,expiry:session.expiry};
  hideAuthGate();
  applyRoleUI();
  startWorkspaceListener();
  
  startTeacherSessionWatch(session.eventId,session.expiry);
}

function startTeacherSessionWatch(eventId,expiry){
  if(teacherSessionUnsubscribe){
    supabaseClient.removeChannel(teacherSessionUnsubscribe);
    teacherSessionUnsubscribe=null;
  }
  if(teacherExpiryTimer)clearTimeout(teacherExpiryTimer);

  teacherSessionUnsubscribe=supabaseClient
    .channel(`event-watch-${eventId}`)
    .on(
      "postgres_changes",
      {event:"UPDATE",schema:"public",table:"cross_events",filter:`id=eq.${eventId}`},
      payload=>{
        const ev=payload.new||{};
        const end=ev.access_expires_at?new Date(ev.access_expires_at).getTime():0;
        if(ev.status!=="open" || !end || Date.now()>=end)expireTeacherAccess();
      }
    )
    .subscribe();

  const delay=Math.max(1000,expiry-Date.now()+500);
  teacherExpiryTimer=setTimeout(expireTeacherAccess,delay);
}

async function expireTeacherAccess(){
  localStorage.removeItem(TEACHER_SESSION_KEY);
  if(cloudUnsubscribe){supabaseClient.removeChannel(cloudUnsubscribe);cloudUnsubscribe=null;}
  if(teacherSessionUnsubscribe){supabaseClient.removeChannel(teacherSessionUnsubscribe);teacherSessionUnsubscribe=null;}
  cloudReady=false;
  currentAccess=null;
  currentEventId=null;
  applyRoleUI();
  setCloudStatus("Session terminée","offline");
  try{await supabaseClient.auth.signOut();}catch{}
  showAuthGate("Le code du CROSS a expiré ou a été fermé par l'organisateur.");
}

logoutBtn.addEventListener("click",async()=>{
  if(!confirm("Quitter cette session CROSS EPS ?"))return;
  localStorage.removeItem(TEACHER_SESSION_KEY);
  if(cloudUnsubscribe){supabaseClient.removeChannel(cloudUnsubscribe);cloudUnsubscribe=null;}
  if(teacherSessionUnsubscribe){supabaseClient.removeChannel(teacherSessionUnsubscribe);teacherSessionUnsubscribe=null;}
  cloudReady=false;
  currentAccess=null;
  currentEventId=null;
  applyRoleUI();
  await supabaseClient.auth.signOut();
  showAuthGate();
});

function randomAccessCode(){
  if(window.crypto?.getRandomValues){
    const a=new Uint32Array(1);
    crypto.getRandomValues(a);
    return String(100000+(a[0]%900000));
  }
  return String(Math.floor(100000+Math.random()*900000));
}

async function sha256Hex(text){
  const bytes=new TextEncoder().encode(text);
  const digest=await crypto.subtle.digest("SHA-256",bytes);
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
}

document.getElementById("createAccessCodeBtn").addEventListener("click",async()=>{
  if(!isAdmin()||!currentEventId)return;
  try{
    const hours=Number(accessDuration.value)||24;
    const code=randomAccessCode();
    const expiresAt=new Date(Date.now()+hours*3600000).toISOString();
    const hash=await sha256Hex(code);

    const {error}=await supabaseClient
      .from("cross_events")
      .update({status:"open",access_code_hash:hash,access_expires_at:expiresAt})
      .eq("id",currentEventId);
    if(error)throw error;

    workspaceMeta.activeSessionCode=code;
    workspaceMeta.accessExpiresAt=expiresAt;
    localStorage.setItem(
      "crossEPS_active_code_v19",
      JSON.stringify({eventId:currentEventId,code,expiresAt})
    );
    renderCloudAdminPanel();
  }catch(err){
    console.error(err);
    alert(err.message||"Impossible de créer le code.");
  }
});

document.getElementById("closeAccessCodeBtn").addEventListener("click",async()=>{
  if(!isAdmin()||!currentEventId)return;
  if(!confirm("Fermer immédiatement l'accès enseignant à ce CROSS ?"))return;

  const {error}=await supabaseClient
    .from("cross_events")
    .update({status:"closed",access_code_hash:null,access_expires_at:null})
    .eq("id",currentEventId);
  if(error){alert(error.message);return;}

  workspaceMeta.activeSessionCode=null;
  workspaceMeta.accessExpiresAt=null;
  localStorage.removeItem("crossEPS_active_code_v19");
  renderCloudAdminPanel();
});

async function renderCloudAdminPanel(){
  if(!isAdmin())return;
  const {data:{user}}=await supabaseClient.auth.getUser();
  adminIdentity.textContent=user?.email||"";

  const saved=JSON.parse(localStorage.getItem("crossEPS_active_code_v19")||"null");
  if(saved?.eventId===currentEventId && new Date(saved.expiresAt).getTime()>Date.now()){
    workspaceMeta.activeSessionCode=saved.code;
    workspaceMeta.accessExpiresAt=saved.expiresAt;
  }

  if(!workspaceMeta.activeSessionCode){
    activeAccessCard.hidden=true;
    closeAccessCodeBtn.hidden=true;
    return;
  }

  const expiry=new Date(workspaceMeta.accessExpiresAt).getTime();
  if(!expiry || Date.now()>=expiry){
    activeAccessCard.hidden=true;
    closeAccessCodeBtn.hidden=true;
    return;
  }

  activeAccessCard.hidden=false;
  closeAccessCodeBtn.hidden=false;
  activeAccessCode.textContent=workspaceMeta.activeSessionCode;
  activeAccessExpiry.textContent=`Valable jusqu'au ${new Date(expiry).toLocaleString("fr-FR")}`;
}

async function activateAdmin(user){
  currentAccess={kind:"admin",role:"admin",email:user.email};
  localStorage.removeItem(TEACHER_SESSION_KEY);
  hideAuthGate();
  applyRoleUI();
  setCloudStatus("Connexion administrateur…","syncing");
  await ensureWorkspaceForAdmin();
  startWorkspaceListener();
  renderCloudAdminPanel();
}

async function restoreSupabaseSession(){
  const {data:{session}}=await supabaseClient.auth.getSession();
  if(!session){
    currentAccess=null;
    cloudReady=false;
    applyRoleUI();
    showAuthGate();
    return;
  }

  const user=session.user;
  try{
    if(!user.is_anonymous){
      const email=(user.email||"").toLowerCase();
      if(email!==ADMIN_EMAIL){
        await supabaseClient.auth.signOut();
        showAuthGate("Ce compte n'est pas autorisé.");
        return;
      }
      const {error}=await supabaseClient.rpc("claim_app_admin");
      if(error)throw error;
      await activateAdmin(user);
      return;
    }

    const saved=JSON.parse(localStorage.getItem(TEACHER_SESSION_KEY)||"null");
    if(!saved?.eventId||!saved?.role||!saved?.expiry || Date.now()>=saved.expiry){
      await supabaseClient.auth.signOut();
      showAuthGate();
      return;
    }

    currentEventId=saved.eventId;
    await activateTeacherAccess(saved);
  }catch(err){
    console.error(err);
    localStorage.removeItem(TEACHER_SESSION_KEY);
    try{await supabaseClient.auth.signOut();}catch{}
    showAuthGate(err.message||"Session invalide.");
  }
}

supabaseClient.auth.onAuthStateChange((event,session)=>{
  if(event==="SIGNED_OUT"){
    currentAccess=null;
    cloudReady=false;
    currentEventId=null;
    applyRoleUI();
  }
});

window.addEventListener("online",()=>{if(currentAccess)setCloudStatus("Connexion rétablie","syncing");});
window.addEventListener("offline",()=>setCloudStatus("Hors connexion","offline"));

restoreSupabaseSession();

// Interface initiale affichée sous le portail d'authentification Supabase.
renderAll();
updateTimingModeUI();
updateFinishModeUI();
applyRoleUI();

