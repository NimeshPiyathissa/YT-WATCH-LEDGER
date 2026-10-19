/* lib/lock.js — shared admin-password lock (PBKDF2-SHA-256, 100k).
   Exposed as self.YTLock. Honest scope: this gates UI only; local data is
   readable via DevTools and the extension is removable from chrome://extensions. */
(function (root) {
  "use strict";
  function bufToB64(buf){const b=new Uint8Array(buf);let s="";for(let i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);return btoa(s);}
  function b64ToBuf(b64){const s=atob(b64);const a=new Uint8Array(s.length);for(let i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return a.buffer;}
  function randomSalt(){const a=new Uint8Array(16);crypto.getRandomValues(a);return bufToB64(a.buffer);}
  async function derive(pw,saltB64){
    const enc=new TextEncoder();
    const key=await crypto.subtle.importKey("raw",enc.encode(pw),"PBKDF2",false,["deriveBits"]);
    const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt:b64ToBuf(saltB64),iterations:100000,hash:"SHA-256"},key,256);
    return bufToB64(bits);
  }
  function getCfg(keys){return new Promise(r=>chrome.storage.local.get(keys,r));}
  function setCfg(o){return new Promise(r=>chrome.storage.local.set(o,r));}
  async function isSet(){const c=await getCfg({admin_hash:""});return !!c.admin_hash;}
  async function verify(pw){const c=await getCfg({admin_hash:"",admin_salt:""});if(!c.admin_hash)return true;return (await derive(pw,c.admin_salt))===c.admin_hash;}
  async function setPassword(pw){const salt=randomSalt();const hash=await derive(pw,salt);await setCfg({admin_hash:hash,admin_salt:salt});}
  async function clearPassword(){await setCfg({admin_hash:"",admin_salt:""});}
  /* Mount a full-screen gate over `appEl`; calls onUnlock() when satisfied.
     If no password is set, unlocks immediately. */
  async function gate(gateEl, appEl, inputEl, errorEl, unlockBtn, onUnlock){
    if(!(await isSet())){gateEl.hidden=true;appEl.hidden=false;onUnlock();return;}
    gateEl.hidden=false;appEl.hidden=true;inputEl.focus();
    async function attempt(){ if(await verify(inputEl.value)){gateEl.hidden=true;appEl.hidden=false;onUnlock();} else {errorEl.hidden=false;inputEl.select();} }
    unlockBtn.addEventListener("click",attempt);
    inputEl.addEventListener("keydown",e=>{if(e.key==="Enter")attempt();});
  }
  /* Inline set/change/remove form shared by Settings and the Admin console.
     done(message) is called after a successful change. */
  function renderPwForm(el, hasPw, remove, done){
    el.hidden=false;
    el.innerHTML=
      (hasPw?'<input type="password" class="input" id="pwCur" placeholder="Current password" />':"")+
      (remove?"":'<input type="password" class="input" id="pwNew" placeholder="New password (min 4 characters)" />'+
                 '<input type="password" class="input" id="pwConf" placeholder="Confirm new password" />')+
      '<div class="lock-error" id="pwErr" hidden></div>'+
      '<div class="data-actions"><button class="btn btn-accent" id="pwGo">'+(remove?"Remove password":"Save")+'</button><button class="btn" id="pwCancel">Cancel</button></div>';
    const $=id=>el.querySelector("#"+id);
    const fail=m=>{$("pwErr").textContent=m;$("pwErr").hidden=false;};
    $("pwCancel").onclick=()=>{el.hidden=true;el.innerHTML="";};
    $("pwGo").onclick=async()=>{
      if(hasPw && !(await verify($("pwCur").value))) return fail("Current password is incorrect.");
      if(remove){ await clearPassword(); }
      else {
        const nw=$("pwNew").value;
        if(nw.length<4) return fail("Use at least 4 characters.");
        if(nw!==$("pwConf").value) return fail("Passwords do not match.");
        await setPassword(nw);
      }
      el.hidden=true;el.innerHTML="";done(remove?"Password removed":"Password saved");
    };
  }
  root.YTLock={derive,randomSalt,getCfg,setCfg,isSet,verify,setPassword,clearPassword,gate,renderPwForm};
})(typeof self!=="undefined"?self:this);
