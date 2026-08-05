/* ---------------- Worker (KV-backed) data layer ---------------- */
const WORKER_BASE = 'https://aimlog-api.dangooorira.workers.dev';
const WORKER_URL = `${WORKER_BASE}/player`;

function sanitizeFileName(name){
  const cleaned = (name||'').trim().replace(/[\\/:*?"<>|]/g,'_').slice(0,80);
  return cleaned || 'unknown';
}

async function fetchJSON(url){
  const attempts = 3;
  let lastErr = null;
  for(let i=0; i<attempts; i++){
    try{
      const bust = url.includes('?') ? '&' : '?';
      const resp = await fetch(url + bust + '_t=' + Date.now(), { cache:'no-store' });
      if(resp.status===404){
        if(i < attempts-1){ await new Promise(r=>setTimeout(r, 900)); continue; }
        return null;
      }
      if(!resp.ok) throw new Error('fetch failed: ' + resp.status);
      return resp.json();
    }catch(err){
      lastErr = err;
      if(i < attempts-1){ await new Promise(r=>setTimeout(r, 900)); continue; }
    }
  }
  if(lastErr) throw lastErr;
  return null;
}

async function fetchPlayerRecords(name){
  const data = await fetchJSON(`${WORKER_BASE}/player?name=${encodeURIComponent(name)}`);
  return (data && Array.isArray(data.records)) ? data.records : [];
}
async function fetchAllRecords(){
  const data = await fetchJSON(`${WORKER_BASE}/all`);
  const names = (data && Array.isArray(data.manifest)) ? data.manifest : [];
  const players = (data && data.players) ? data.players : {};
  const all = [];
  names.forEach(name=>{ (players[name]||[]).forEach(r=> all.push({...r, player: r.player||name})); });
  return all;
}
async function savePlayerRecords(playerName, records){
  const resp = await fetch(WORKER_URL, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ player: playerName, records }),
  });
  let data = {};
  try{ data = await resp.json(); }catch(e){}
  if(!resp.ok || !data.ok) throw new Error(data.error || `save failed: ${resp.status}`);
  return data;
}
async function addRecordRemote(record){
  const player = record.player;
  const existing = await fetchPlayerRecords(player);
  existing.push(record);
  await savePlayerRecords(player, existing);
}
async function editRecordRemote(oldPlayer, id, updatedFields){
  const oldRecords = await fetchPlayerRecords(oldPlayer);
  const idx = oldRecords.findIndex(r=>r.id===id);
  if(idx===-1) throw new Error('元の記録が見つかりませんでした');
  const newPlayer = (updatedFields.player || oldPlayer).trim();
  const merged = { ...oldRecords[idx], ...updatedFields, id, player:newPlayer };
  if(newPlayer === oldPlayer){
    oldRecords[idx] = merged;
    await savePlayerRecords(oldPlayer, oldRecords);
  }else{
    oldRecords.splice(idx,1);
    await savePlayerRecords(oldPlayer, oldRecords);
    const newRecords = await fetchPlayerRecords(newPlayer);
    newRecords.push(merged);
    await savePlayerRecords(newPlayer, newRecords);
  }
}
async function deleteRecordRemote(player, id){
  const records = await fetchPlayerRecords(player);
  const filtered = records.filter(r=>r.id!==id);
  await savePlayerRecords(player, filtered);
}

/* ---------------- Utilities ---------------- */
function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>t.classList.remove('show'), 2600);
}
function todayISO(){ return new Date().toISOString().slice(0,10); }
function fmtNum(n){
  if(n===null||n===undefined||n===''||isNaN(parseFloat(n))) return '—';
  return parseFloat(n).toFixed(2);
}

/* ---------------- Image preprocessing (improves OCR accuracy) ---------------- */
function preprocessImage(fileOrBlob){
  return new Promise((resolve,reject)=>{
    const img = new Image();
    const url = URL.createObjectURL(fileOrBlob);
    img.onload = ()=>{
      const scale = 3;
      const canvas = document.createElement('canvas');
      canvas.width = img.width*scale;
      canvas.height = img.height*scale;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img,0,0,canvas.width,canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob=>resolve(blob), 'image/png');
    };
    img.onerror = ()=>{ URL.revokeObjectURL(url); reject(new Error('image load failed')); };
    img.src = url;
  });
}
function cropTopRegion(fileOrBlob, heightFraction, scale){
  return new Promise((resolve,reject)=>{
    const img = new Image();
    const url = URL.createObjectURL(fileOrBlob);
    img.onload = ()=>{
      const cropHeight = Math.max(1, Math.round(img.height * heightFraction));
      const canvas = document.createElement('canvas');
      canvas.width = img.width*scale;
      canvas.height = cropHeight*scale;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0,0,img.width,cropHeight, 0,0,canvas.width,canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob=>resolve(blob), 'image/png');
    };
    img.onerror = ()=>{ URL.revokeObjectURL(url); reject(new Error('crop failed')); };
    img.src = url;
  });
}

/* ---------------- OCR parsing (robust, line-based) ---------------- */
function sanitizeLevel(value){
  if(!value) return value;
  const parts = value.split('.');
  const intPart = parts[0];
  if(intPart.length === 3 && intPart[0] === '1'){
    const stripped = intPart.slice(1);
    if(parseInt(stripped,10) < 80){ parts[0] = stripped; return parts.join('.'); }
  }
  return value;
}
function findMetricValue(lines, keywordRegex){
  let idx = lines.findIndex(l => keywordRegex.test(l) && /AVERAGE/i.test(l));
  if(idx === -1) idx = lines.findIndex(l => keywordRegex.test(l) && /LEVEL/i.test(l));
  if(idx === -1) return '';
  const line = lines[idx];

  function tryMatch(str){
    const m = str.match(/LEVEL\s*[:=]?\s*([0-9]{1,3})(?:[.,:]([0-9]{1,2}))?/i);
    if(!m) return '';
    return m[2] ? `${m[1]}.${m[2]}` : m[1];
  }
  let value = tryMatch(line);
  if(!value){
    const m = line.match(/LEVEL[^0-9]{0,6}([0-9]{1,3})(?:[.,:]([0-9]{1,2}))?/i);
    if(m) value = m[2] ? `${m[1]}.${m[2]}` : m[1];
  }
  if(!value){
    const km = line.match(keywordRegex);
    const start = km ? km.index + km[0].length : 0;
    const rest = line.slice(start);
    const m = rest.match(/([0-9]{1,3})(?:[.,:]([0-9]{1,2}))?/);
    if(m) value = m[2] ? `${m[1]}.${m[2]}` : m[1];
  }
  if(!value) return '';
  if(!value.includes('.')){
    for(let j=idx+1; j<=idx+2 && j<lines.length; j++){
      const frag = lines[j].match(/^[.,:]?\s*([0-9]{1,2})\s*$/);
      if(frag){ value = value + '.' + frag[1]; break; }
      if(/[A-Za-z]{3,}/.test(lines[j])) break;
    }
  }
  return value;
}
function parseAimLabText(text){
  const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  let result = {
    combined: sanitizeLevel(findMetricValue(lines, /COMBIN/i)),
    flick: sanitizeLevel(findMetricValue(lines, /FLICK/i)),
    track: sanitizeLevel(findMetricValue(lines, /TRACK/i)),
    chal: sanitizeLevel(findMetricValue(lines, /CHALLENG/i)),
  };
  if(!result.combined){
    const joined = lines.join(' ');
    const m = joined.match(/COMBIN[A-Z]*\s*AVERAGE\s*LEVEL[^0-9]{0,15}([0-9]{1,3})(?:[.,:]([0-9]{1,2}))?/i);
    if(m) result.combined = sanitizeLevel(m[2] ? `${m[1]}.${m[2]}` : m[1]);
  }
  return result;
}

/* ---------------- App State ---------------- */
let currentImageBlob = null;
let allRecords = [];
let recordsCache = null; // null = not loaded yet; once loaded, mutations update this in place for instant reflection
let chartInstance = null;
let activeMetrics = new Set(['combined']);
let editingId = null;
let editingPlayer = null;
let currentPeriod = 'daily';

function cacheAddRecord(record){
  if(recordsCache) recordsCache = [...recordsCache, record];
}
function cacheEditRecord(oldPlayer, id, updatedFields){
  if(!recordsCache) return;
  const newPlayer = (updatedFields.player || oldPlayer).trim();
  recordsCache = recordsCache.map(r => (r.player===oldPlayer && r.id===id) ? { ...r, ...updatedFields, id, player:newPlayer } : r);
}
function cacheDeleteRecord(player, id){
  if(!recordsCache) return;
  recordsCache = recordsCache.filter(r => !(r.player===player && r.id===id));
}
// Loads records from cache instantly if available (rendering right away), then silently
// refreshes from GitHub in the background to pick up changes from other players/devices.
async function loadRecords(renderFn){
  if(recordsCache){
    allRecords = recordsCache;
    renderFn();
    fetchAllRecords().then(fresh=>{
      recordsCache = fresh;
      allRecords = fresh;
      renderFn();
    }).catch(()=>{ /* background refresh failed silently — cached view stays */ });
  }else{
    allRecords = await fetchAllRecords();
    recordsCache = allRecords;
    renderFn();
  }
}

/* ---------------- Navigation ---------------- */
document.querySelectorAll('.nav-pills .pill').forEach(link=>{
  link.addEventListener('click', ()=>{
    document.querySelectorAll('.nav-pills .pill').forEach(l=>l.classList.remove('active'));
    link.classList.add('active');
    const view = link.dataset.view;
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    document.getElementById('view-'+view).classList.add('active');
    if(view==='ranking') renderRanking();
    if(view==='stats') renderStats();
  });
});

/* ---------------- New record: dropzone / OCR ---------------- */
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const runOcrBtn = document.getElementById('runOcrBtn');

dropzone.addEventListener('click', ()=>fileInput.click());
dropzone.addEventListener('dragover', e=>{e.preventDefault(); dropzone.classList.add('drag');});
dropzone.addEventListener('dragleave', ()=>dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', e=>{
  e.preventDefault(); dropzone.classList.remove('drag');
  if(e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', e=>{
  if(e.target.files[0]) handleFile(e.target.files[0]);
});
function handleFile(file){
  currentImageBlob = file;
  const url = URL.createObjectURL(file);
  document.getElementById('dropzone-inner').innerHTML = `<img src="${url}">`;
  runOcrBtn.disabled = false;
  if(!document.getElementById('f-date').value) document.getElementById('f-date').value = todayISO();
}

runOcrBtn.addEventListener('click', async ()=>{
  if(!currentImageBlob) return;
  const statusEl = document.getElementById('ocrStatus');
  const bar = document.getElementById('ocrBar');
  const pct = document.getElementById('ocrPct');
  const label = document.getElementById('ocrLabel');
  statusEl.style.display = 'flex';
  runOcrBtn.disabled = true;
  bar.style.width = '0%'; pct.textContent = '0%';
  label.textContent = '画像を前処理中…';

  try{
    const processed = await preprocessImage(currentImageBlob);
    const result = await Tesseract.recognize(processed, 'eng', {
      logger: m=>{
        if(m.status) label.textContent = m.status === 'recognizing text' ? '文字認識中…' : m.status;
        if(typeof m.progress === 'number'){ const p=Math.round(m.progress*100); bar.style.width=p+'%'; pct.textContent=p+'%'; }
      }
    });
    const text = result.data.text;
    document.getElementById('f-raw').value = text.trim();
    let parsed = parseAimLabText(text);

    if(!parsed.combined){
      label.textContent = 'Combined Levelを再解析中…';
      try{
        const cropBlob = await cropTopRegion(currentImageBlob, 0.28, 4);
        const result2 = await Tesseract.recognize(cropBlob, 'eng', {
          logger: m=>{ if(typeof m.progress === 'number'){ const p=Math.round(m.progress*100); bar.style.width=p+'%'; pct.textContent=p+'%'; } }
        });
        const text2 = result2.data.text;
        const lines2 = text2.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
        const combined2 = sanitizeLevel(findMetricValue(lines2, /COMBIN/i));
        if(combined2){
          parsed.combined = combined2;
          document.getElementById('f-raw').value = text.trim() + '\n\n--- (Combined Level 再解析結果) ---\n' + text2.trim();
        }
      }catch(err){ console.error('Combined level fallback OCR failed', err); }
    }

    document.getElementById('f-combined').value = parsed.combined;
    document.getElementById('f-flick').value = parsed.flick;
    document.getElementById('f-track').value = parsed.track;
    document.getElementById('f-chal').value = parsed.chal;
    ['f-combined','f-flick','f-track','f-chal'].forEach(markFieldState);
    if(parsed.combined){
      label.textContent = '完了 ✓ 内容を確認・修正してください';
      toast('OCR抽出が完了しました。数値を確認してください。');
    }else{
      label.textContent = '完了（Combined Levelは読み取れませんでした。手動で入力してください）';
      toast('Combined Average Levelが読み取れませんでした。手動で入力してください。');
    }
  }catch(err){
    console.error(err);
    label.textContent = 'OCRに失敗しました。手動で入力してください。';
    toast('OCRエラー: 手動入力に切り替えてください');
  }finally{
    runOcrBtn.disabled = false;
  }
});

/* ---------------- Required field validation ---------------- */
const REQUIRED_IDS = ['f-player','f-date','f-combined','f-flick','f-track','f-chal'];
function markFieldState(id){
  const el = document.getElementById(id);
  if(!el.value || !el.value.trim()) el.classList.add('error');
  else el.classList.remove('error');
}
function validateRequiredFields(){
  let allOk = true;
  REQUIRED_IDS.forEach(id=>{
    const el = document.getElementById(id);
    if(!el.value || !el.value.trim()){ el.classList.add('error'); allOk = false; }
    else el.classList.remove('error');
  });
  return allOk;
}
REQUIRED_IDS.forEach(id=>{
  document.getElementById(id).addEventListener('input', ()=>markFieldState(id));
});

/* ---------------- Save new record ---------------- */
document.getElementById('saveBtn').addEventListener('click', async ()=>{
  if(!validateRequiredFields()){
    toast('赤枠の項目が未入力です。確認・入力してから保存してください。');
    return;
  }
  const saveBtn = document.getElementById('saveBtn');
  const saveMsg = document.getElementById('saveMsg');
  const date = document.getElementById('f-date').value || todayISO();
  const player = document.getElementById('f-player').value.trim();
  const combined = document.getElementById('f-combined').value;
  const flick = document.getElementById('f-flick').value;
  const track = document.getElementById('f-track').value;
  const chal = document.getElementById('f-chal').value;
  const note = document.getElementById('f-note').value;
  const raw = document.getElementById('f-raw').value;

  const record = { id: Date.now(), date, player, combined, flick, track, chal, note, raw, createdAt: Date.now() };

  saveBtn.disabled = true;
  saveMsg.textContent = 'GitHubに保存しています…';
  try{
    await addRecordRemote(record);
    cacheAddRecord(record);
    toast('記録を保存しました ✓');
    saveMsg.textContent = '';

    document.getElementById('f-player').value='';
    document.getElementById('f-combined').value='';
    document.getElementById('f-flick').value='';
    document.getElementById('f-track').value='';
    document.getElementById('f-chal').value='';
    document.getElementById('f-note').value='';
    document.getElementById('f-raw').value='';
    document.getElementById('f-date').value=todayISO();
    document.getElementById('dropzone-inner').innerHTML = `<div class="icon">⬆</div><div class="txt">ここに画像をドラック＆ドロップ</div>`;
    currentImageBlob = null;
    runOcrBtn.disabled = true;
    document.getElementById('ocrStatus').style.display='none';
    REQUIRED_IDS.forEach(id=>document.getElementById(id).classList.remove('error'));
  }catch(err){
    console.error(err);
    saveMsg.textContent = '保存に失敗しました: ' + (err.message||err);
    toast('保存に失敗しました。通信状況を確認してもう一度お試しください。');
  }finally{
    saveBtn.disabled = false;
  }
});

/* ---------------- Ranking view ---------------- */
document.querySelectorAll('.period-pill').forEach(p=>{
  p.addEventListener('click', ()=>{
    document.querySelectorAll('.period-pill').forEach(x=>x.classList.remove('active'));
    p.classList.add('active');
    currentPeriod = p.dataset.period;
    document.getElementById('dailyDatePicker').style.display = currentPeriod==='daily' ? 'inline-block' : 'none';
    document.getElementById('weeklyPicker').style.display = currentPeriod==='weekly' ? 'inline-block' : 'none';
    renderRanking();
  });
});
document.getElementById('dailyDatePicker').addEventListener('change', renderRanking);
document.getElementById('weeklyPicker').addEventListener('change', renderRanking);

function fmtMDY(d){
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}
function localISODate(d){
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${yyyy}-${mm}-${dd}`;
}
function mondayOf(date){
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day===0 ? -6 : 1-day);
  d.setDate(d.getDate()+diff);
  d.setHours(0,0,0,0);
  return d;
}
function initDailyDefault(records){
  const picker = document.getElementById('dailyDatePicker');
  if(!picker.value){
    if(records.length>0){
      const sorted = [...records].sort((a,b)=> (b.date||'').localeCompare(a.date||''));
      picker.value = sorted[0].date || todayISO();
    }else{ picker.value = todayISO(); }
  }
}
function populateWeekOptions(records){
  const select = document.getElementById('weeklyPicker');
  const prevVal = select.value;
  const weekMap = new Map();
  records.forEach(r=>{
    if(!r.date) return;
    const monday = mondayOf(new Date(r.date+'T00:00:00'));
    const key = localISODate(monday);
    if(!weekMap.has(key)){ const sunday = new Date(monday); sunday.setDate(monday.getDate()+6); weekMap.set(key, {monday, sunday}); }
  });
  const curMonday = mondayOf(new Date());
  const curKey = localISODate(curMonday);
  if(!weekMap.has(curKey)){ const curSunday = new Date(curMonday); curSunday.setDate(curMonday.getDate()+6); weekMap.set(curKey, {monday:curMonday, sunday:curSunday}); }
  const keys = Array.from(weekMap.keys()).sort().reverse();
  select.innerHTML = keys.map(k=>{
    const {monday,sunday} = weekMap.get(k);
    return `<option value="${k}">${fmtMDY(monday)} - ${fmtMDY(sunday)}</option>`;
  }).join('');
  if(prevVal && weekMap.has(prevVal)) select.value = prevVal;
}
function filterByPeriod(records, period){
  if(period==='all') return records;
  if(period==='daily'){
    const val = document.getElementById('dailyDatePicker').value;
    if(!val) return [];
    return records.filter(r=>r.date===val);
  }
  if(period==='weekly'){
    const val = document.getElementById('weeklyPicker').value;
    if(!val) return [];
    const monday = new Date(val+'T00:00:00');
    const sunday = new Date(monday); sunday.setDate(monday.getDate()+6); sunday.setHours(23,59,59,999);
    return records.filter(r=>{ if(!r.date) return false; const d = new Date(r.date+'T00:00:00'); return d >= monday && d <= sunday; });
  }
  return records;
}
function buildRankList(records, metric){
  const best = new Map();
  records.forEach(r=>{
    const name = (r.player||'').trim() || '—';
    const value = parseFloat(r[metric]);
    if(isNaN(value)) return;
    if(!best.has(name) || value > best.get(name)) best.set(name, value);
  });
  return Array.from(best.entries()).map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value).slice(0,5);
}
const rankIcons = ['🥇','🥈','🥉'];
function renderRankList(containerId, list){
  const el = document.getElementById(containerId);
  if(list.length===0){ el.innerHTML = `<div class="rank-empty">対象期間の記録がありません</div>`; return; }
  el.innerHTML = list.map((item, i)=>`
    <div class="rank-row">
      <span class="rank-icon ${i>=3?'num':''}">${i<3?rankIcons[i]:(i+1)}</span>
      <span class="rank-value">${fmtNum(item.value)}</span>
      <span class="rank-name">${item.name}</span>
    </div>`).join('');
}
function doRenderRanking(){
  const sub = document.getElementById('rankingSub');
  initDailyDefault(allRecords);
  populateWeekOptions(allRecords);
  const filtered = filterByPeriod(allRecords, currentPeriod);
  sub.textContent = `${filtered.length}件の記録から集計`;
  renderRankList('rank-combined', buildRankList(filtered,'combined'));
  renderRankList('rank-flick', buildRankList(filtered,'flick'));
  renderRankList('rank-track', buildRankList(filtered,'track'));
  renderRankList('rank-chal', buildRankList(filtered,'chal'));
}
async function renderRanking(){
  const sub = document.getElementById('rankingSub');
  if(!recordsCache) sub.textContent = '読み込み中…';
  try{
    await loadRecords(doRenderRanking);
  }catch(err){
    console.error(err);
    sub.textContent = 'データの読み込みに失敗しました';
    toast('GitHubからのデータ取得に失敗しました');
  }
}

/* ---------------- Stats view ---------------- */
let currentStatsPlayer = 'all';
function populateStatsPlayerFilter(records){
  const select = document.getElementById('statsPlayerFilter');
  const prevVal = select.value || currentStatsPlayer;
  const names = Array.from(new Set(records.map(r=>(r.player||'').trim()).filter(Boolean))).sort();
  select.innerHTML = `<option value="all">すべてのプレイヤー</option>` + names.map(n=>`<option value="${n}">${n}</option>`).join('');
  select.value = (prevVal==='all' || names.includes(prevVal)) ? prevVal : 'all';
  currentStatsPlayer = select.value;
}
document.getElementById('statsPlayerFilter').addEventListener('change', (e)=>{
  currentStatsPlayer = e.target.value;
  updateStatsView();
});
function getStatsFilteredRecords(){
  if(currentStatsPlayer==='all') return allRecords;
  return allRecords.filter(r=>(r.player||'').trim()===currentStatsPlayer);
}
async function renderStats(){
  const empty = document.getElementById('recordsEmpty');
  if(!recordsCache){ empty.style.display='block'; empty.textContent = '読み込み中…'; }
  try{
    await loadRecords(()=>{
      populateStatsPlayerFilter(allRecords);
      updateStatsView();
    });
  }catch(err){
    console.error(err);
    empty.style.display='block';
    empty.textContent = 'データの読み込みに失敗しました';
    toast('GitHubからのデータ取得に失敗しました');
  }
}
function updateStatsView(){
  const filtered = getStatsFilteredRecords();
  const sorted = [...filtered].sort((a,b)=> (a.date||'').localeCompare(b.date||'') || a.createdAt-b.createdAt);
  const combinedVals = sorted.map(r=>parseFloat(r.combined)).filter(v=>!isNaN(v));
  document.getElementById('stat-latest').textContent = combinedVals.length ? fmtNum(combinedVals[combinedVals.length-1]) : '—';
  document.getElementById('stat-best').textContent = combinedVals.length ? fmtNum(Math.max(...combinedVals)) : '—';
  document.getElementById('stat-avg').textContent = combinedVals.length ? fmtNum(combinedVals.reduce((a,b)=>a+b,0)/combinedVals.length) : '—';
  document.getElementById('stat-count').textContent = filtered.length;
  drawChart(sorted);
  renderRecordsTable(filtered);
}
const metricConfig = {
  combined: {label:'Combined', color:'#3EA8FF'},
  flick: {label:'Flicking', color:'#22D3EE'},
  track: {label:'Tracking', color:'#7FE3C0'},
  chal: {label:'Challenge', color:'#FFC94A'},
};
document.querySelectorAll('.chip').forEach(chip=>{
  chip.addEventListener('click', (e)=>{
    e.preventDefault();
    const metric = chip.dataset.metric;
    const cb = chip.querySelector('input');
    if(activeMetrics.has(metric)){ activeMetrics.delete(metric); cb.checked=false; chip.classList.remove('on'); }
    else{ activeMetrics.add(metric); cb.checked=true; chip.classList.add('on'); }
    updateStatsView();
  });
});
function drawChart(records){
  const ctx = document.getElementById('chart');
  const labels = records.map(r=>r.date);
  const datasets = [];
  activeMetrics.forEach(metric=>{
    const cfg = metricConfig[metric];
    datasets.push({
      label: cfg.label,
      data: records.map(r=>{ const v=parseFloat(r[metric]); return isNaN(v)?null:v; }),
      borderColor: cfg.color, backgroundColor: cfg.color+'22',
      tension:0.3, spanGaps:true, pointRadius:3, pointBackgroundColor:cfg.color,
    });
  });
  if(chartInstance) chartInstance.destroy();
  chartInstance = new Chart(ctx, {
    type:'line', data:{labels, datasets},
    options:{ responsive:true,
      plugins:{legend:{labels:{color:'#8B96AC', font:{family:'Inter'}}}},
      scales:{ x:{ticks:{color:'#8B96AC'}, grid:{color:'rgba(255,255,255,0.06)'}},
               y:{ticks:{color:'#8B96AC'}, grid:{color:'rgba(255,255,255,0.06)'}} }
    }
  });
}

/* ---------------- Records table ---------------- */
function renderRecords(){ renderRecordsTable(getStatsFilteredRecords()); }
function renderRecordsTable(records){
  const sorted = [...records].sort((a,b)=> (b.date||'').localeCompare(a.date||'') || b.createdAt-a.createdAt);
  const body = document.getElementById('recordsBody');
  const empty = document.getElementById('recordsEmpty');
  body.innerHTML = '';
  if(sorted.length===0){ empty.style.display='block'; empty.textContent = 'まだ記録がありません。「記録を入力」から最初のスコアを追加しましょう。'; return; }
  empty.style.display='none';
  for(const rec of sorted){
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${rec.date||''}</td>
      <td>${rec.player||''}</td>
      <td><span class="lvl-pill">${fmtNum(rec.combined)}</span></td>
      <td><span class="lvl-pill">${fmtNum(rec.flick)}</span></td>
      <td><span class="lvl-pill">${fmtNum(rec.track)}</span></td>
      <td><span class="lvl-pill">${fmtNum(rec.chal)}</span></td>
      <td><div class="row-actions">
        <button class="btn btn-sm" data-open="${rec.id}" data-player="${rec.player}">開く</button>
        <button class="btn btn-danger btn-sm" data-del="${rec.id}" data-player="${rec.player}">削除</button>
      </div></td>`;
    body.appendChild(tr);
  }
  body.querySelectorAll('[data-open]').forEach(b=>b.addEventListener('click', ()=>openModal(parseInt(b.dataset.open), b.dataset.player)));
  body.querySelectorAll('[data-del]').forEach(b=>b.addEventListener('click', async ()=>{
    if(!confirm('この記録を削除しますか？')) return;
    b.disabled = true;
    try{
      await deleteRecordRemote(b.dataset.player, parseInt(b.dataset.del));
      cacheDeleteRecord(b.dataset.player, parseInt(b.dataset.del));
      toast('削除しました');
      allRecords = recordsCache || [];
      populateStatsPlayerFilter(allRecords);
      updateStatsView();
    }catch(err){
      console.error(err);
      toast('削除に失敗しました: ' + (err.message||err));
      b.disabled = false;
    }
  }));
}

/* ---------------- Modal ---------------- */
function openModal(id, player){
  const rec = allRecords.find(r=>r.id===id && r.player===player);
  if(!rec) return;
  editingId = id;
  editingPlayer = player;
  document.getElementById('modalTitle').textContent = `記録 #${id} — ${rec.date}`;
  document.getElementById('m-date').value = rec.date||'';
  document.getElementById('m-player').value = rec.player||'';
  document.getElementById('m-combined').value = rec.combined||'';
  document.getElementById('m-flick').value = rec.flick||'';
  document.getElementById('m-track').value = rec.track||'';
  document.getElementById('m-chal').value = rec.chal||'';
  document.getElementById('m-note').value = rec.note||'';
  document.getElementById('m-raw').textContent = rec.raw||'(なし)';
  document.getElementById('modalBg').classList.add('show');
}
document.getElementById('modalClose').addEventListener('click', ()=>document.getElementById('modalBg').classList.remove('show'));
document.getElementById('modalBg').addEventListener('click', (e)=>{ if(e.target.id==='modalBg') document.getElementById('modalBg').classList.remove('show'); });
document.getElementById('modalSave').addEventListener('click', async ()=>{
  const btn = document.getElementById('modalSave');
  btn.disabled = true;
  try{
    const updatedFields = {
      date: document.getElementById('m-date').value,
      player: document.getElementById('m-player').value.trim(),
      combined: document.getElementById('m-combined').value,
      flick: document.getElementById('m-flick').value,
      track: document.getElementById('m-track').value,
      chal: document.getElementById('m-chal').value,
      note: document.getElementById('m-note').value,
    };
    await editRecordRemote(editingPlayer, editingId, updatedFields);
    cacheEditRecord(editingPlayer, editingId, updatedFields);
    toast('変更を保存しました ✓');
    document.getElementById('modalBg').classList.remove('show');
    allRecords = recordsCache || [];
    populateStatsPlayerFilter(allRecords);
    updateStatsView();
  }catch(err){
    console.error(err);
    toast('保存に失敗しました: ' + (err.message||err));
  }finally{
    btn.disabled = false;
  }
});
document.getElementById('modalDelete').addEventListener('click', async ()=>{
  if(!confirm('この記録を削除しますか？')) return;
  const btn = document.getElementById('modalDelete');
  btn.disabled = true;
  try{
    await deleteRecordRemote(editingPlayer, editingId);
    cacheDeleteRecord(editingPlayer, editingId);
    toast('削除しました');
    document.getElementById('modalBg').classList.remove('show');
    allRecords = recordsCache || [];
    populateStatsPlayerFilter(allRecords);
    updateStatsView();
  }catch(err){
    console.error(err);
    toast('削除に失敗しました: ' + (err.message||err));
  }finally{
    btn.disabled = false;
  }
});

/* ---------------- Export (read-only convenience download) ---------------- */
document.getElementById('exportBtn').addEventListener('click', async ()=>{
  try{
    const records = await fetchAllRecords();
    const blob = new Blob([JSON.stringify(records, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `aimlog-export-${todayISO()}.json`; a.click();
    toast('エクスポートしました');
  }catch(err){
    console.error(err);
    toast('エクスポートに失敗しました');
  }
});

/* ---------------- Init ---------------- */
document.getElementById('f-date').value = todayISO();
