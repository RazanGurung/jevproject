import{rc as R}from"./chunk-KFB7SWXH.js";import{l as E,m as y}from"./chunk-D754TIHB.js";import{L as B,n as u}from"./chunk-WL2JRRQF.js";var s={available:!1,model:"",analyzing:!1,fetchingSignal:!1,selectedTimeframe:"intraday",lastResult:null,lastSignal:null,signalsByTf:{},error:null},X=!1;async function N(){try{let t=await E("/api/jev/status");return s.available=!!t?.available,s.model=t?.model||"",X=!0,T(),s}catch(t){return s.available=!1,s.error=t?.message||"Status check failed",T(),s}}function H(t){let a=(t||"intraday").toLowerCase();s.selectedTimeframe=a,C();let i=u.trading.currentCoin||"BTC",n=s.signalsByTf[a];n&&n.coin===i&&Date.now()-(n.timestamp||0)<15e3?(s.lastSignal=n,m(n)):w(i,a).catch(()=>{})}function Q(t){switch(String(t||"").trim().toLowerCase()){case"1m":case"3m":case"5m":case"15m":case"30m":case"scalp":return"scalp";case"1d":case"3d":case"1w":case"swing":return"swing";default:return"intraday"}}function ee(t){let a=Q(t);s.selectedTimeframe=a,C();let i=u.trading.currentCoin||"BTC",n=s.signalsByTf[a];n&&n.coin===i&&Date.now()-(n.timestamp||0)<6e4?(s.lastSignal=n,B(n),m(n)):s.available&&w(i,a).catch(()=>{})}typeof window<"u"&&(window.onChartTimeframeChanged=ee);var te={scalp:"SCALP 15m",intraday:"INTRADAY 4h",swing:"SWING 1d+"},b=0,h=null;function x(){h&&(clearInterval(h),h=null),b=0}function ne(t,a){x(),b=Math.max(1,t),h=setInterval(()=>{b--;let i=document.getElementById("jevToxicCountdownText");i&&(b>0?i.textContent=`TOXIC SWEEP HALT: ${b}s (STABILIZING)`:i.textContent="\u2713 ORDERBOOK STABILIZED \xB7 SCANNING..."),b<=0&&(x(),w(a,s.selectedTimeframe).catch(()=>{}))},1e3)}function C(){let t=document.getElementById("jevTfSelectorBar");if(!t)return;let a=s.selectedTimeframe||"intraday",i=u.trading.currentCoin||"BTC";t.querySelectorAll(".jev-tf-btn").forEach(c=>{let e=c.dataset.tf;e===a?c.classList.add("active"):c.classList.remove("active");let l=s.signalsByTf[e],o="edge-none",r="No signal cached";if(l&&l.coin===i){let d=(l.action||"HOLD").toUpperCase(),v=l.conviction||0;l.isToxicHalted||l.reason&&l.reason.includes("Toxic flow")?(o="edge-toxic",r="Toxic flow tripwire active"):d!=="HOLD"&&v>=.7?(o="edge-strong",r=`${d} (${Math.round(v*100)}% conviction)`):d!=="HOLD"&&v>=.55?(o="edge-moderate",r=`${d} (${Math.round(v*100)}% conviction)`):(o="edge-neutral",r="HOLD / Neutral flow")}let f=te[e]||(e?e.toUpperCase():"");c.innerHTML=`${f} <span class="jev-tf-edge-dot ${o}" title="${r}"></span>`})}async function M(t){let a=t||u.trading.currentCoin||"BTC";s.analyzing=!0,s.error=null,T();try{let i=await y("/api/jev/analyze",{coin:a});return s.lastResult=i,s.analyzing=!1,T(),i}catch(i){throw s.analyzing=!1,s.error=i?.message||"Analysis failed",T(),i}}async function w(t,a){let i=t||u.trading.currentCoin||"BTC",n=a||s.selectedTimeframe||"intraday";s.selectedTimeframe=n,s.fetchingSignal=!0,m();try{let c=await E(`/api/jev/signal?coin=${encodeURIComponent(i)}&timeframe=${encodeURIComponent(n)}`);return s.lastSignal=c,s.signalsByTf[n]=c,c&&c.coin===u.trading.currentCoin&&B(c),s.fetchingSignal=!1,m(c),c}catch(c){throw s.fetchingSignal=!1,m(),c}}function p(t){return!t||!Number.isFinite(t)||t<=0?"\u2014":t>=1e3?"$"+t.toLocaleString(void 0,{minimumFractionDigits:1,maximumFractionDigits:2}):t>=1?"$"+t.toLocaleString(void 0,{minimumFractionDigits:2,maximumFractionDigits:4}):"$"+t.toLocaleString(void 0,{minimumFractionDigits:4,maximumFractionDigits:6})}function $(t){return!t||!Number.isFinite(t)||t<=0?"\u2014":t>=1e6?"$"+(t/1e6).toFixed(2)+"M":t>=1e4?"$"+(t/1e3).toFixed(1)+"K":t>=1e3?"$"+(t/1e3).toFixed(2)+"K":t>=100?"$"+t.toFixed(1):t>=1?"$"+t.toFixed(2):"$"+t.toFixed(4)}function L(t){let a=t||s.lastSignal;if(!a||!a.action||a.action==="HOLD")return!1;let i=a.action.toUpperCase()==="BUY",n=i?"buyBtn":"sellBtn",c=document.getElementById(n);c&&typeof c.click=="function"?c.click():typeof window<"u"&&typeof window.setSide=="function"&&window.setSide(i?"buy":"sell");let e=document.getElementById("priceModeSelect");if(e&&(e.value="manual",e.dispatchEvent(new Event("change",{bubbles:!0}))),typeof window<"u"&&typeof window.setLimitPriceEntryModeSelection=="function"&&window.setLimitPriceEntryModeSelection("manual"),a.entryPrice>0){let o=document.getElementById("priceInput")||document.getElementById("price");o&&(o.value=a.entryPrice,o.dispatchEvent(new Event("input",{bubbles:!0})),o.dispatchEvent(new Event("change",{bubbles:!0})))}if(a.takeProfitPct>0){let o=document.getElementById("tpPctInput");o&&(o.value=a.takeProfitPct,o.dispatchEvent(new Event("input",{bubbles:!0})),o.dispatchEvent(new Event("change",{bubbles:!0})))}if(a.stopLossPct>0){let o=document.getElementById("slPctInput");o&&(o.value=a.stopLossPct,o.dispatchEvent(new Event("input",{bubbles:!0})),o.dispatchEvent(new Event("change",{bubbles:!0})))}return typeof window<"u"&&typeof window.updateSummary=="function"&&window.updateSummary(),[document.getElementById("jevTicketFillBtn"),document.getElementById("jevExecuteSignalBtn")].filter(Boolean).forEach(o=>{let r=o.textContent;o.classList.add("prepared"),o.textContent="\u2713 TICKET PREPARED (ENTRY, TP & SL)",setTimeout(()=>{o.classList.remove("prepared"),o.textContent=r},2500)}),!0}function m(t){let a=document.getElementById("jevSignalWindow"),i=document.getElementById("jevSignalSection"),n=document.getElementById("jevTicketFillBtn"),c=document.getElementById("jevSignalRefreshBtn");if(c&&(c.disabled=s.fetchingSignal),C(),!s.available){i&&i.classList.add("hidden"),n&&n.classList.add("hidden");return}i&&i.classList.remove("hidden");let e=t||s.lastSignal,l=e?.coin||u.trading.currentCoin||"BTC",o=(e?.timeframe||s.selectedTimeframe||"intraday").toUpperCase();if(a)if(!e&&s.fetchingSignal)a.innerHTML=`
        <div class="jev-window-empty">
          <span class="jev-spark-icon">\u26A1</span>
          <span>Analyzing ${l} [${o}] orderbook & flow...</span>
        </div>
      `;else if(e){let r=(e.action||"HOLD").toUpperCase(),f=Math.round((e.conviction||0)*100),d=Math.round((e.toxicRisk||0)*100),v=e.bookImbalance||0,U=v>0?"+":"",O=v>0?"text-green":v<0?"text-red":"text-neutral",g=r==="HOLD",I=r==="BUY",P=r==="SELL",k=!!(e.isToxicHalted||e.reason&&e.reason.includes("Toxic flow")),F=e.toxicHaltRemainingSeconds||15;k?ne(F,l):x();let A=e.signalType||"trend",J=e.marketEnvironment||"range",V=A.toUpperCase().replace("_","-"),W=J.toUpperCase(),_=I?`TP (+${e.takeProfitPct||1}%)`:P?`TP (-${e.takeProfitPct||1}%)`:`TP (${e.takeProfitPct?e.takeProfitPct.toFixed(2):"1.00"}% ATR)`,G=I?`SL (-${e.stopLossPct||.5}%)`:P?`SL (+${e.stopLossPct||.5}%)`:`SL (${e.stopLossPct?e.stopLossPct.toFixed(2):"0.50"}% ATR)`,K=!!(e.vah&&e.val&&e.vah>e.val),D=(e.profileHorizon||(o==="swing"?"quarterly":"monthly")).toLowerCase(),Y=D==="quarterly"?"Quarterly":"Monthly",S=D==="quarterly"?"90D":"30D",j=e.distFromTwapPct!==void 0?e.distFromTwapPct:e.distFrom365dPct!==void 0?e.distFrom365dPct:0,q=j>=0?"+":"",Z=j>=6?"text-red":j<=-6?"text-green":"";a.innerHTML=`
        <div class="jev-window-card">
          <div class="jev-window-toprow">
            <div class="jev-window-coin-badge">
              <span class="jev-window-coin" id="jevSignalCoin">${e.coin||l}</span>
              <span id="jevSignalAction" class="jev-signal-action ${r.toLowerCase()}">${r}</span>
              ${g?"":`<span id="jevSignalTypeBadge" class="jev-signal-type-badge ${A.toLowerCase().replace("_","-")}">${V}</span>`}
              ${g?"":`<span id="jevMarketEnvBadge" class="jev-market-env-badge ${J.toLowerCase()}">${W}</span>`}
            </div>
            <span class="jev-window-conviction" id="jevSignalConv">Conv: <b>${f}%</b> (${e.score?.toFixed(1)||"3.0"}/5)</span>
          </div>

          <div class="jev-window-duration-row">
            <span class="jev-duration-badge" id="jevSignalDuration">\u23F1 ${e.estimatedDuration||"2h \u2013 8h (Session Intraday)"}</span>
            <span class="jev-duration-horizon" id="jevSignalHorizon">${o}</span>
          </div>

          ${K?`
          <div class="jev-window-vp-row" id="jevSignalVPRow">
            <span class="jev-vp-label" title="${Y} (${S}) Volume Profile Structure">${S} VP:</span>
            <span title="Value Area Low: ${p(e.val)}">VAL <b>${$(e.val)}</b></span>
            <span class="jev-vp-sep">\xB7</span>
            <span title="Point of Control: ${p(e.poc)}">POC <b>${$(e.poc)}</b></span>
            <span class="jev-vp-sep">\xB7</span>
            <span title="Value Area High: ${p(e.vah)}">VAH <b>${$(e.vah)}</b></span>
            <span class="jev-vp-twap ${Z}" title="Distance from ${S} TWAP">(${q}${j.toFixed(1)}% TWAP)</span>
          </div>`:""}

          <div class="jev-window-metrics-grid">
            <div class="jev-metric-card">
              <span class="jev-metric-label">Mid Price</span>
              <span class="jev-metric-value" id="jevSignalMid">${p(e.midPrice)}</span>
            </div>
            <div class="jev-metric-card">
              <span class="jev-metric-label">Limit Entry</span>
              <span class="jev-metric-value" id="jevSignalEntry">${g?"\u2014":p(e.entryPrice)}</span>
            </div>
            <div class="jev-metric-card">
              <span class="jev-metric-label">${_}</span>
              <span class="jev-metric-value ${g?"text-neutral":"text-green"}" id="jevSignalTP">${g?"\u2014":p(e.takeProfitPrice)}</span>
            </div>
            <div class="jev-metric-card">
              <span class="jev-metric-label">${G}</span>
              <span class="jev-metric-value ${g?"text-neutral":"text-red"}" id="jevSignalSL">${g?"\u2014":p(e.stopLossPrice)}</span>
            </div>
          </div>

          <div class="jev-window-stats-row">
            <span title="Order Flow Imbalance">OFI: <b class="${O}">${U}${v.toFixed(2)}</b></span>
            <span title="Spread">Spread: <b>${e.spreadBps?.toFixed(1)||"0.0"} bps</b></span>
            <span title="Risk to Reward">R:R: <b>${e.riskRewardRatio?.toFixed(1)||"2.0"}:1</b></span>
            <span title="Toxic sweep risk">Toxic: <b class="${d>40?"text-red":"text-green"}">${d}%</b></span>
          </div>

          ${k?`
          <div class="jev-toxic-halt-pill" id="jevToxicHaltPill">
            <span class="jev-toxic-icon">\u26A0\uFE0F</span>
            <span id="jevToxicCountdownText">TOXIC SWEEP HALT: ${F}s (STABILIZING)</span>
          </div>`:""}

          <div class="jev-window-reason-card" id="jevSignalReason">${e.reason||"Order flow analyzed."}</div>
          <div class="jev-window-footer">
            <span class="jev-window-model" id="jevSignalModel">${e.model||"jev-1.13.0"}${e.visibilityLevel?" \xB7 "+e.visibilityLevel.toUpperCase():""}${e.cacheReused?" \xB7 CACHED":""}</span>
            <span class="jev-window-time">${new Date(e.timestamp||Date.now()).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})}</span>
          </div>
        </div>
      `}else{a.innerHTML=`
        <div class="jev-window-empty">
          <span class="jev-spark-icon">\u26A1</span>
          <span>No active [${o}] signal for ${l}</span>
          <button type="button" class="btn btn-sm jev-execute-signal-btn" id="jevScanNowBtn">SCAN NOW</button>
        </div>
      `;let r=a.querySelector("#jevScanNowBtn");r&&r.addEventListener("click",()=>w(l,s.selectedTimeframe).catch(()=>{}))}if(n)if(n.classList.remove("hidden"),!e)n.textContent=s.fetchingSignal?`\u26A1 JEV: SCANNING ${o}...`:"\u26A1 FILL JEV TICKET",n.className="btn btn-sm jev-ticket-fill-btn hold",n.disabled=!0;else{let r=(e.action||"HOLD").toUpperCase(),f=o,d=e.signalType==="counter_trend"?"COUNTER-TREND ":"";r==="BUY"?(n.textContent=`\u26A1 FILL JEV TICKET (${f} ${d}BUY @ ${p(e.entryPrice)})`,n.className="btn btn-sm jev-ticket-fill-btn buy",n.disabled=!1):r==="SELL"?(n.textContent=`\u26A1 FILL JEV TICKET (${f} ${d}SELL @ ${p(e.entryPrice)})`,n.className="btn btn-sm jev-ticket-fill-btn sell",n.disabled=!1):(n.textContent=`\u26A1 JEV: HOLD (${f} NO EDGE)`,n.className="btn btn-sm jev-ticket-fill-btn hold",n.disabled=!0)}try{let r=u.ui.jevSignalsVisible&&e&&e.coin===l;R(r?e:null)}catch{}}function z(t){let a=t||s.lastResult;if(!a)return!1;if(a.direction==="bullish"){let i=document.getElementById("buyBtn");i&&typeof i.click=="function"&&i.click()}else if(a.direction==="bearish"){let i=document.getElementById("sellBtn");i&&typeof i.click=="function"&&i.click()}if(a.suggestedLimitPrice>0){let i=document.getElementById("priceInput")||document.getElementById("price");i&&(i.value=a.suggestedLimitPrice,i.dispatchEvent(new Event("input",{bubbles:!0})),i.dispatchEvent(new Event("change",{bubbles:!0})))}return!0}function T(){let t=document.getElementById("jevStatusBadge"),a=document.getElementById("jevResultPanel"),i=document.getElementById("jevAnalyzeBtn");if(t&&(s.available?(t.classList.remove("hidden"),t.textContent=s.model?`JEV (${s.model})`:"JEV AI"):t.classList.add("hidden")),i&&(i.disabled=s.analyzing||!s.available,i.textContent=s.analyzing?"ANALYZING...":"JEV AUDIT"),a&&s.lastResult){let n=s.lastResult,c=n.direction==="bullish"?"text-green":n.direction==="bearish"?"text-red":"text-neutral",e=Math.round((n.directionConfidence||0)*100),l=Math.round((n.toxicFlowRisk||0)*100);a.innerHTML=`
      <div class="jev-result-row">
        <span class="jev-badge ${c}">${n.direction.toUpperCase()} (${e}%)</span>
        <span class="jev-score">Conviction: ${n.confidenceScore?.toFixed(1)||"3.0"}/5</span>
      </div>
      <div class="jev-result-details">
        <span>OFI: <b>${n.bookImbalance>0?"+":""}${n.bookImbalance?.toFixed(2)||"0.00"}</b></span>
        <span>Spread: <b>${n.spreadBps?.toFixed(1)||"0.0"} bps</b></span>
        <span>Toxic Risk: <b class="${l>50?"text-red":"text-green"}">${l}%</b></span>
      </div>
      <button type="button" class="btn btn-sm jev-align-btn" id="jevAlignTicketBtn">ALIGN TICKET</button>
    `;let o=document.getElementById("jevAlignTicketBtn");o&&(o.onclick=()=>z(n))}m(s.lastSignal)}function ie(){let t=document.getElementById("jevAnalyzeBtn");t&&!t._jevBound&&(t._jevBound=!0,t.addEventListener("click",()=>{M().catch(e=>{console.error("Jev audit error:",e)})}));let a=document.getElementById("jevSignalRefreshBtn");a&&!a._jevBound&&(a._jevBound=!0,a.addEventListener("click",()=>{w().catch(e=>{console.error("Jev signal fetch failed:",e)})}));let i=document.getElementById("jevExecuteSignalBtn");i&&!i._jevBound&&(i._jevBound=!0,i.addEventListener("click",()=>{L()}));let n=document.getElementById("jevTicketFillBtn");n&&!n._jevBound&&(n._jevBound=!0,n.addEventListener("click",()=>{L()}));let c=document.getElementById("jevTfSelectorBar");c&&!c._jevBound&&(c._jevBound=!0,c.addEventListener("click",e=>{let l=e.target.closest(".jev-tf-btn");l&&l.dataset.tf&&H(l.dataset.tf)})),N().then(e=>{e&&e.available&&w().catch(()=>{})})}async function ae(t,a,i){return y("/api/jev/pre-trade-audit",{coin:t,isBuy:a,sizeUsd:i})}async function se(t){return y("/api/jev/classify-news",{headline:t})}async function oe(t,a,i,n){return y("/api/jev/evaluate-mispricing",{coin:t,markPrice:a,referenceClose:i,deviationPct:n})}typeof window<"u"&&(window.checkJevStatus=N,window.initJevUI=ie,window.setTimeframe=H,window.analyzeWithJev=M,window.alignTicketWithJev=z,window.fetchJevSignal=w,window.executeJevSignal=L,window.updateJevSignalUI=m,window.auditPreTradeWithJev=ae,window.classifyNewsWithJev=se,window.evaluateMispricingWithJev=oe,window.JevState=s);export{s as a,ie as b};
