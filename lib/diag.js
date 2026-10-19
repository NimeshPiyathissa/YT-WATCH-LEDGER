/* lib/diag.js — tiny capped event log in chrome.storage.local, self.YTDiag. */
(function (root){
  "use strict";
  const KEY="diag_log", MAX=200;
  function push(level,msg,extra){
    return new Promise(res=>{
      chrome.storage.local.get({[KEY]:[]},o=>{
        const log=o[KEY]||[];
        log.push({t:Date.now(),level:level,msg:String(msg),extra:extra||null});
        while(log.length>MAX) log.shift();
        chrome.storage.local.set({[KEY]:log},res);
      });
    });
  }
  function read(){return new Promise(res=>chrome.storage.local.get({[KEY]:[]},o=>res(o[KEY]||[])));}
  function clear(){return new Promise(res=>chrome.storage.local.set({[KEY]:[]},res));}
  root.YTDiag={push,read,clear,info:(m,e)=>push("info",m,e),warn:(m,e)=>push("warn",m,e),error:(m,e)=>push("error",m,e)};
})(typeof self!=="undefined"?self:this);
