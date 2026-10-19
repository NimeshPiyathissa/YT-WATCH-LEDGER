(function(){
  "use strict";
  const U=window.YTUtil, DB=window.YTDB, L=window.YTLock, D=window.YTDiag;
  const $=id=>document.getElementById(id);
  let toastT=null; const toast=m=>{const t=$("toast");t.textContent=m;t.hidden=false;clearTimeout(toastT);toastT=setTimeout(()=>t.hidden=true,2200);};
  const getCfg=k=>new Promise(r=>chrome.storage.local.get(k,r));
  const setCfg=o=>new Promise(r=>chrome.storage.local.set(o,r));

  /* ---- Remote sync / enrollment (opt-in; the only place data can start leaving this device) ---- */
  const REMOTE_KEYS=["sync_server","device_refresh","sync_status","confirm_code","sync_pending","sync_last_ok","sync_last_error","sync_notice","last_remote_command"];
  function mountRemote(el){
    el.hidden=false;
    renderRemote(el);
    chrome.storage.onChanged.addListener((ch,area)=>{ if(area==="local" && REMOTE_KEYS.some(k=>k in ch)) renderRemote(el); });
  }
  async function renderRemote(el){
    const S=window.YTSync, c=await S.cfg(), esc=U.escapeHtml;
    if(!S.isEnrolled(c)){
      el.innerHTML=
        `<h3>Private sync <span class="muted">— off</span></h3>
         <p class="muted">By default everything stays on this device. Pairing sends this browser's YouTube watch history (video titles, channels, watch times and progress) to your own private server. You get a one-time pairing code from the server's dashboard (Devices → Add device); after pairing, the owner must approve this device there before anything is sent. The owner can also remotely pause tracking, change retention, or delete data stored here.</p>
         ${c.sync_notice?`<div class="sync-warn">${esc(c.sync_notice)} <a href="#" id="rmDismiss">Dismiss</a></div>`:""}
         <div class="pw-form">
           <input class="input" id="rmServer" placeholder="Server address, e.g. https://tracker.example.com" />
           <input class="input" id="rmCode" placeholder="Pairing code" autocomplete="off" />
           <label class="muted"><input type="checkbox" id="rmHist" /> Also upload history already recorded on this device (queued only after you are paired)</label>
           <div class="lock-error" id="rmErr" hidden></div>
           <div class="data-actions"><button class="btn btn-accent" id="rmEnroll">Pair this device</button></div>
         </div>`;
      const q=id=>el.querySelector("#"+id), fail=m=>{q("rmErr").textContent=m;q("rmErr").hidden=false;};
      if(q("rmDismiss")) q("rmDismiss").onclick=async e=>{e.preventDefault();await L.setCfg({sync_notice:""});};
      q("rmEnroll").onclick=async()=>{
        const origin=S.normalizeServerUrl(q("rmServer").value);
        if(!origin) return fail("Enter a valid https:// server address.");
        if(!q("rmCode").value.trim()) return fail("Enter the pairing code.");
        let granted=false;
        // must be the first await so the click still counts as a user gesture
        try{ granted=await chrome.permissions.request({origins:[origin+"/*"]}); }catch(e){ return fail("Could not request permission for that address."); }
        if(!granted) return fail("Permission to contact that server was not granted.");
        try{ await S.enroll(origin,q("rmCode").value,{uploadHistory:q("rmHist").checked}); }
        catch(e){ chrome.permissions.remove({origins:[origin+"/*"]},()=>void chrome.runtime.lastError); return fail(e.message); }
        chrome.runtime.sendMessage({type:"SYNC_NOW"},()=>void chrome.runtime.lastError);
        toast("Paired with "+new URL(origin).host+" — waiting for approval");
      };
      return;
    }
    const host=new URL(c.sync_server).host, cmd=c.last_remote_command, waiting=c.sync_status==="pending";
    const queued=await DB.outboxCount().catch(()=>c.sync_pending||0);
    const rows=[
      ["Server",host],["Device name",c.enrolled_label||"—"],
      ["Status",waiting?"Waiting for owner approval":"Approved — syncing"],
      ...(waiting?[["Confirmation code",c.confirm_code||"—"]]:[]),
      ["Last successful sync",c.sync_last_ok?U.fmtDateTime(c.sync_last_ok):"Not yet"],
      ["Pending uploads",String(queued)],
      ["Last error",c.sync_last_error||"None"],
      ["Last remote command",cmd?cmd.type+" · "+U.fmtDateTime(cmd.t):"None"]
    ];
    el.innerHTML=
      `<h3>Private sync <span class="pill ${waiting?"off":"on"}"><span class="dot"></span><span>${waiting?"Pending approval":"Paired"}</span></span></h3>
       <div class="sync-note">${esc(S.syncNoticeText(c))}${waiting?" Check that the code below matches the one shown in your dashboard, then approve this device there.":""}</div>
       <div class="kv-grid">${rows.map(r=>`<div class="k muted">${r[0]}</div><div class="v num">${esc(r[1])}</div>`).join("")}</div>
       <p class="muted">Data already sent stays on your server until you delete it there. Unpairing stops all further sending and discards anything still queued on this device.</p>
       <div class="data-actions"><button class="btn" id="rmNow">Sync now</button><button class="btn btn-danger" id="rmOut">Unpair</button></div>`;
    el.querySelector("#rmNow").onclick=()=>chrome.runtime.sendMessage({type:"SYNC_NOW"},r=>{void chrome.runtime.lastError;toast(r&&r.error?"Sync failed":"Sync requested");renderDiag();});
    const out=el.querySelector("#rmOut"); let armed=false;
    out.onclick=async()=>{
      if(!armed){armed=true;out.textContent="Click again to unpair";return;}
      const origin=c.sync_server;
      await S.unenroll();
      chrome.permissions.remove({origins:[origin+"/*"]},()=>void chrome.runtime.lastError);
      toast("Unpaired — nothing is sent any more");renderDiag();
    };
  }
  window.YTSync.mountAdminSection=mountRemote;

  L.gate($("lockGate"),$("app"),$("lockInput"),$("lockError"),$("lockUnlock"),init);

  async function init(){
    await renderIdentity(); await bindControls(); await renderPw(); await renderDiag();
    renderLive(); setInterval(renderLive, 3000);
    if(window.YTSync && window.YTSync.mountAdminSection) window.YTSync.mountAdminSection($("remoteSection")); // PART B
    $("toDash").addEventListener("click",e=>{e.preventDefault();chrome.tabs.create({url:chrome.runtime.getURL("dashboard/dashboard.html")});});
  }

  async function renderIdentity(){
    const cfg=await getCfg({install_id:"?",installed_at:0,last_activity:0,tracking_enabled:true});
    const counts=await DB.counts();
    let storage="—"; try{const e=await navigator.storage.estimate(); storage=U.fmtBytes(e.usage);}catch(_){}
    const ua=navigator.userAgent;
    const rows=[
      ["Install ID",cfg.install_id],
      ["Installed",cfg.installed_at?U.fmtDateTime(cfg.installed_at):"—"],
      ["Extension version",chrome.runtime.getManifest().version],
      ["Browser / OS (approx.)",ua.replace(/^Mozilla\/5\.0 \(/,"").split(")")[0]],
      ["Tracking",cfg.tracking_enabled!==false?"On":"Off"],
      ["Videos",String(counts.videos)],["Sessions",String(counts.sessions)],
      ["Last activity",cfg.last_activity?U.fmtDateTime(cfg.last_activity):"None"],
      ["Storage used (approx.)",storage]
    ];
    $("identityGrid").innerHTML=rows.map(r=>`<div class="k muted">${r[0]}</div><div class="v num">${U.escapeHtml(r[1])}</div>`).join("");
  }

  async function renderLive(){
    const c=await getCfg({last_heartbeat:0,live_video_id:null});
    const live=c.live_video_id && (Date.now()-c.last_heartbeat<15000);
    const p=$("livePill"); p.className="pill "+(live?"on":"off");
    p.querySelector("span:last-child").textContent=live?"Tracking a video now":"Idle";
  }

  async function bindControls(){
    const cfg=await getCfg({tracking_enabled:true,retention_days:0});
    $("trackToggle").checked=cfg.tracking_enabled!==false;
    $("retentionSel").value=String(cfg.retention_days||0);
    $("themeSel").value=window.YTTheme.current();
    $("trackToggle").addEventListener("change",async()=>{await setCfg({tracking_enabled:$("trackToggle").checked});toast($("trackToggle").checked?"Tracking on":"Tracking off");renderIdentity();});
    $("retentionSel").addEventListener("change",async()=>{const d=Number($("retentionSel").value);await setCfg({retention_days:d});chrome.runtime.sendMessage({type:"ENFORCE_RETENTION"},()=>{void chrome.runtime.lastError;toast("Retention updated");renderIdentity();});});
    $("themeSel").addEventListener("change",()=>window.YTTheme.set($("themeSel").value));
    $("exportAll").addEventListener("click",exportAll);
    $("exportRange").addEventListener("click",()=>rangeForm("export"));
    $("exportChannel").addEventListener("click",()=>channelForm("export"));
    $("delRange").addEventListener("click",()=>rangeForm("delete"));
    $("delChannel").addEventListener("click",()=>channelForm("delete"));
    $("delAll").addEventListener("click",confirmDeleteAll);
    $("copyDiag").addEventListener("click",async()=>{const l=await D.read();await navigator.clipboard.writeText(l.map(e=>new Date(e.t).toISOString()+" ["+e.level+"] "+e.msg+(e.extra?" "+JSON.stringify(e.extra):"")).join("\n"));toast("Log copied");});
    $("clearDiag").addEventListener("click",async()=>{await D.clear();renderDiag();toast("Log cleared");});
  }

  function download(name,text,mime){const b=new Blob([text],{type:mime});const u=URL.createObjectURL(b);const a=document.createElement("a");a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),1000);}
  function exportJson(name,videos,sessions){download(name+"-"+U.dayKey(Date.now())+".json",JSON.stringify({exportedAt:new Date().toISOString(),videos,sessions},null,2),"application/json");toast("Exported "+videos.length+" videos");}
  async function exportAll(){const [videos,sessions]=await Promise.all([DB.getAllVideos(),DB.getAllSessions()]);exportJson("yt-export",videos,sessions);}

  /* ---- inline data forms (#dataForm) ---- */
  function openForm(html){const f=$("dataForm");f.innerHTML=html;f.hidden=false;return f;}
  function closeForm(){const f=$("dataForm");f.hidden=true;f.innerHTML="";}
  // First click arms the button and shows what will happen; second click runs it.
  function twoStep(btn,armedLabel,run){
    let armed=false;
    btn.addEventListener("click",async()=>{
      if(!armed){armed=true;btn.textContent=armedLabel();return;}
      await run();
    });
  }
  const goBtn=(mode,label)=>`<button class="btn ${mode==="delete"?"btn-danger":"btn-accent"}" id="fmGo">${label}</button><button class="btn" id="fmCancel">Cancel</button>`;

  function rangeForm(mode){
    const f=openForm(`<div class="form-row"><label>From <input type="date" id="rgFrom" class="input compact"></label><label>To <input type="date" id="rgTo" class="input compact"></label></div><div class="lock-error" id="fmErr" hidden></div><div class="data-actions">${goBtn(mode,mode==="delete"?"Delete…":"Export")}</div>`);
    const $f=id=>f.querySelector("#"+id);
    $f("fmCancel").onclick=closeForm;
    function bounds(){
      if(!$f("rgFrom").value||!$f("rgTo").value){$f("fmErr").textContent="Pick both dates.";$f("fmErr").hidden=false;return null;}
      const from=new Date($f("rgFrom").value+"T00:00:00").getTime(), to=new Date($f("rgTo").value+"T23:59:59.999").getTime();
      if(from>to){$f("fmErr").textContent="'From' is after 'To'.";$f("fmErr").hidden=false;return null;}
      $f("fmErr").hidden=true;return [from,to];
    }
    async function matches(from,to){return (await DB.getAllVideos()).filter(v=>(v.lastWatched||0)>=from&&(v.lastWatched||0)<=to);}
    if(mode==="export"){
      $f("fmGo").onclick=async()=>{const b=bounds();if(!b)return;const vids=await matches(b[0],b[1]);const ids=new Set(vids.map(v=>v.videoId));const ss=(await DB.getAllSessions()).filter(s=>ids.has(s.videoId));exportJson("yt-range",vids,ss);closeForm();};
    } else {
      const btn=$f("fmGo"); let armed=false;
      btn.onclick=async()=>{
        const b=bounds();if(!b)return;
        if(!armed){const n=(await matches(b[0],b[1])).length;armed=true;btn.textContent="Click again to delete "+n+" video(s)";return;}
        const n=await DB.deleteByRange(b[0],b[1]);await D.info("deleted by range",{videos:n});toast("Deleted "+n+" video(s)");closeForm();renderIdentity();renderDiag();
      };
    }
  }

  async function channelForm(mode){
    const vids=await DB.getAllVideos();
    const channels=Array.from(new Set(vids.map(v=>v.channel||""))).sort();
    if(!channels.length){toast("No channels recorded yet");return;}
    const f=openForm(`<div class="form-row"><label>Channel <select id="chSel" class="input compact">${channels.map(c=>`<option value="${U.escapeHtml(c)}">${U.escapeHtml(c||"(unknown)")}</option>`).join("")}</select></label></div><div class="data-actions">${goBtn(mode,mode==="delete"?"Delete…":"Export")}</div>`);
    const $f=id=>f.querySelector("#"+id);
    $f("fmCancel").onclick=closeForm;
    if(mode==="export"){
      $f("fmGo").onclick=async()=>{const ch=$f("chSel").value;const vs=vids.filter(v=>(v.channel||"")===ch);const ids=new Set(vs.map(v=>v.videoId));const ss=(await DB.getAllSessions()).filter(s=>ids.has(s.videoId));exportJson("yt-channel",vs,ss);closeForm();};
    } else {
      twoStep($f("fmGo"),()=>"Click again to delete "+vids.filter(v=>(v.channel||"")===$f("chSel").value).length+" video(s)",async()=>{
        const n=await DB.deleteByChannel($f("chSel").value);await D.info("deleted by channel",{videos:n});toast("Deleted "+n+" video(s)");closeForm();renderIdentity();renderDiag();
      });
    }
  }

  function confirmDeleteAll(){
    const f=openForm(`<p>This permanently deletes every recorded video and session on this device.</p><div class="data-actions"><button class="btn btn-danger" id="fmGo">Delete all…</button><button class="btn" id="fmCancel">Cancel</button></div>`);
    f.querySelector("#fmCancel").onclick=closeForm;
    twoStep(f.querySelector("#fmGo"),()=>"Click again to confirm deleting everything",()=>new Promise(res=>{
      chrome.runtime.sendMessage({type:"CLEAR_ALL"},()=>{void chrome.runtime.lastError;toast("All data deleted");closeForm();renderIdentity();renderDiag();res();});
    }));
  }

  async function renderPw(){
    const set=await L.isSet();
    $("pwState").textContent=set?"A password is set; the admin pages are locked until it's entered.":"No password set.";
    $("removePw").hidden=!set;
    const done=m=>{toast(m);renderPw();};
    $("setPw").onclick=()=>pwForm(set,false,done);
    $("removePw").onclick=()=>pwForm(set,true,done);
  }
  function pwForm(hasPw,remove,done){ L.renderPwForm($("pwForm"),hasPw,remove,done); }

  async function renderDiag(){const l=await D.read();$("diagLog").textContent=l.slice(-80).map(e=>new Date(e.t).toLocaleTimeString()+" ["+e.level+"] "+e.msg+(e.extra?" "+JSON.stringify(e.extra):"")).join("\n")||"(empty)";}
})();
