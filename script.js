/* AI Triage Pro v2.0 — script.js */

const API_BASE = "http://localhost:5000/api";

// ── State ──────────────────────────────────────────────
let state = {
  audioFile: null, imageFile: null,
  audioResult: null, visionResult: null,
  _recordedBlob: null,
  lastFusion: null,
};

let history = JSON.parse(localStorage.getItem('triageHistory') || '[]');
let patients = JSON.parse(localStorage.getItem('triagePatients') || '[]');
let dispatches = JSON.parse(localStorage.getItem('triageDispatches') || '[]');
let tokenCounter = parseInt(localStorage.getItem('triageToken') || '1000');

let scoreChartInst = null;
let severityChartInst = null;

// ── Recording ──────────────────────────────────────────
let mediaRecorder = null, recordedChunks = [], recordingTimer = null;
let recordingSeconds = 0, isRecording = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── NAVIGATION ─────────────────────────────────────────
function showPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  const el = document.getElementById('page-' + page);
  if (el) el.classList.add('active');
  document.querySelectorAll(`[data-page="${page}"]`).forEach(l => l.classList.add('active'));
  if (document.getElementById('sidebar').classList.contains('open')) toggleSidebar();
  if (page === 'dashboard') refreshDashboard();
  if (page === 'patients') renderPatientQueue('all');
  if (page === 'home') refreshHomeStats();
  if (page === 'dispatch') renderDispatchLog();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

// ── THEME ──────────────────────────────────────────────
function toggleTheme() {
  const html = document.documentElement;
  const isLight = html.getAttribute('data-theme') === 'light';
  html.setAttribute('data-theme', isLight ? 'dark' : 'light');
  // isLight = we ARE currently in light mode, so we are SWITCHING to dark
  const icon  = isLight ? '☾' : '☀';
  const label = isLight ? 'DARK MODE' : 'LIGHT MODE';
  document.getElementById('themeIcon').textContent = icon;
  document.getElementById('themeLabel').textContent = label;
  document.getElementById('themeIconMobile').textContent = icon;
  localStorage.setItem('triageTheme', isLight ? 'dark' : 'light');
  if (scoreChartInst || severityChartInst) refreshCharts();
}

// Restore saved theme
const savedTheme = localStorage.getItem('triageTheme');
if (savedTheme) {
  document.documentElement.setAttribute('data-theme', savedTheme);
  if (savedTheme === 'light') {
    document.getElementById('themeIcon').textContent = '☾';
    document.getElementById('themeLabel').textContent = 'DARK MODE';
    document.getElementById('themeIconMobile').textContent = '☾';
  }
}

// ── HELPERS ────────────────────────────────────────────
function setStep(stepId, statusId, cls, label) {
  document.getElementById(stepId).className = 'timeline-step ' + cls;
  document.getElementById(statusId).textContent = label;
}

function setSystemStatus(text, cls) {
  const el = document.getElementById('systemStatus');
  el.className = 'status-pill' + (cls ? ' ' + cls : '');
  el.innerHTML = `<span class="dot"></span> ${text}`;
}

function log(msg, isErr) {
  const box = document.getElementById('liveLog');
  const line = document.createElement('div');
  line.className = 'log-line' + (isErr ? ' err' : '');
  line.textContent = (isErr ? '❌ ' : '› ') + msg;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function logErr(msg) { log(msg, true); }
function clearLog() { document.getElementById('liveLog').innerHTML = ''; }

function setBadge(id, clean, text) {
  const b = document.getElementById(id);
  b.className = 'security-badge ' + (clean ? 'clean' : 'warn');
  b.textContent = text;
}
function clearBadge(id) { const b = document.getElementById(id); b.className = 'security-badge'; b.textContent = ''; }
function fmtTime(s) { return String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0'); }
function fmtDateTime(ts) { return new Date(ts).toLocaleString('en-IN', { dateStyle:'short', timeStyle:'short' }); }
function getNextToken() { tokenCounter++; localStorage.setItem('triageToken', tokenCounter); return 'TRG-' + tokenCounter; }

function severityLabel(score) {
  return { 1:'CRITICAL', 2:'URGENT', 3:'MODERATE', 4:'MINOR', 5:'STABLE' }[score] || 'STABLE';
}
function severityClass(score) {
  if (score <= 2) return 'critical'; if (score === 3) return 'moderate'; return 'stable';
}

// ── FILE INPUTS ────────────────────────────────────────
document.getElementById('audioInput').addEventListener('change', function () {
  const file = this.files[0]; if (!file) return;
  state.audioFile = file; state._recordedBlob = null;
  document.getElementById('audioFileName').textContent = file.name;
  document.getElementById('audioCard').classList.add('loaded');
  document.getElementById('audioPlayback').style.display = 'none';
  clearBadge('audioBadge');
});

document.getElementById('imageInput').addEventListener('change', function () {
  const file = this.files[0]; if (!file) return;
  state.imageFile = file;
  document.getElementById('imageFileName').textContent = file.name;
  document.getElementById('imageCard').classList.add('loaded');
  const reader = new FileReader();
  reader.onload = e => { document.getElementById('imagePreview').innerHTML = `<img src="${e.target.result}" alt="Preview" />`; };
  reader.readAsDataURL(file);
  clearBadge('imageBadge');
});

// ── RECORDING ─────────────────────────────────────────
async function toggleRecording() { isRecording ? stopRecording() : await startRecording(); }

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = []; recordingSeconds = 0;
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: 'audio/webm' });
      state._recordedBlob = blob;
      state.audioFile = new File([blob], 'live-recording.webm', { type: 'audio/webm' });
      const url = URL.createObjectURL(blob);
      const pb = document.getElementById('audioPlayback');
      pb.src = url; pb.style.display = 'block';
      document.getElementById('audioFileName').textContent = `live-recording.webm (${fmtTime(recordingSeconds)})`;
      document.getElementById('audioCard').classList.add('loaded');
      setBadge('audioBadge', true, '✓ LIVE RECORDING');
      stream.getTracks().forEach(t => t.stop());
    };
    mediaRecorder.start(); isRecording = true;
    document.getElementById('recordBtn').classList.add('recording');
    document.getElementById('recordLabel').textContent = 'STOP';
    document.getElementById('recordTimer').style.display = 'flex';
    document.getElementById('waveformBars').style.display = 'flex';
    document.getElementById('audioPlayback').style.display = 'none';
    document.getElementById('timerDisplay').textContent = '00:00';
    recordingTimer = setInterval(() => {
      recordingSeconds++;
      document.getElementById('timerDisplay').textContent = fmtTime(recordingSeconds);
      if (recordingSeconds >= 120) stopRecording();
    }, 1000);
  } catch (err) { showToast('Microphone access denied. Please allow mic permissions.', 'warn'); }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  isRecording = false; clearInterval(recordingTimer);
  document.getElementById('recordBtn').classList.remove('recording');
  document.getElementById('recordLabel').textContent = 'RECORD LIVE';
  document.getElementById('recordTimer').style.display = 'none';
  document.getElementById('waveformBars').style.display = 'none';
}

// ── HEALTH CHECK ───────────────────────────────────────
async function checkBackendHealth() {
  try {
    const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
}

// ── API CALLS ──────────────────────────────────────────
async function runAudioPipeline() {
  setStep('step1', 's1Status', 'active', 'RUNNING');
  log('Sending audio → Whisper (acoustic fingerprint + transcription)…');
  const form = new FormData();
  form.append('audio', state.audioFile);
  let res;
  try { res = await fetch(`${API_BASE}/analyze/audio`, { method: 'POST', body: form }); }
  catch { throw new Error('Cannot reach Flask backend. Run: python app.py'); }
  if (!res.ok) { const err = await res.json().catch(() => ({ error: res.statusText })); setStep('step1','s1Status','error','FAILED'); throw new Error('Audio API: ' + (err.error || res.statusText)); }
  const data = await res.json();
  setStep('step1', 's1Status', 'done', 'COMPLETE');
  log(`Security: ${data.security}`);
  setBadge('audioBadge', !data.security.includes('WARNING'), data.security.includes('WARNING') ? '⚠ ' + data.security : '✓ VOICE AUTHENTIC');
  setStep('step2', 's2Status', 'active', 'RUNNING'); await sleep(200);
  log(`Transcript: "${(data.transcript || '').slice(0, 80)}"`);
  setStep('step2', 's2Status', 'done', 'COMPLETE');
  setStep('step3', 's3Status', 'active', 'RUNNING'); await sleep(200);
  log(`Audio triage score: ${data.audio_triage_score} / 5`);
  if (data.detected_condition && data.detected_condition !== 'None') log(`Detected: ${data.detected_condition.toUpperCase()}`);
  setStep('step3', 's3Status', 'done', 'COMPLETE');
  state.audioResult = data;
}

async function runVisionPipeline() {
  setStep('step4', 's4Status', 'active', 'RUNNING');
  log('Sending image → CLIP zero-shot classifier…');
  const form = new FormData();
  form.append('image', state.imageFile);
  let res;
  try { res = await fetch(`${API_BASE}/analyze/image`, { method: 'POST', body: form }); }
  catch { throw new Error('Cannot reach Flask backend. Run: python app.py'); }
  if (!res.ok) { const err = await res.json().catch(() => ({ error: res.statusText })); setStep('step4','s4Status','error','FAILED'); throw new Error('Image API: ' + (err.error || res.statusText)); }
  const data = await res.json();
  const failed  = data.security === 'FAILED_PIXEL_SCAN';
  const invalid = data.top_category === 'INVALID_IMAGE';

  if (invalid) {
    setStep('step4', 's4Status', 'error', 'INVALID IMAGE');
    setBadge('imageBadge', false, '⚠ NOT A MEDICAL IMAGE');
    log(`Image rejected: ${data.invalid_reason || 'Not a medical or injury image.'}`);
    // Show inline warning on the image card
    const preview = document.getElementById('imagePreview');
    preview.innerHTML = `
      <div style="
        background:var(--amber-dim);border:1px solid rgba(244,162,97,.3);
        border-radius:8px;padding:16px 14px;text-align:center;
        font-family:var(--font-mono);font-size:11px;color:var(--amber);
        letter-spacing:.06em;line-height:1.7;
      ">
        <div style="font-size:22px;margin-bottom:8px">🚫</div>
        <strong style="letter-spacing:.12em;font-size:12px">INVALID IMAGE TYPE</strong><br>
        <span style="color:var(--text-dim);font-size:10px">
          ${data.invalid_reason || 'Please upload a photo of the affected body part or injury.'}
        </span>
      </div>`;
    state.visionResult = { ...data, skipped: false };
    return;  // Don't throw — let fusion continue with vision weight = 0
  }

  setStep('step4', 's4Status', failed ? 'error' : 'done', failed ? 'SECURITY VOID' : 'COMPLETE');
  log(`Visual category: ${data.top_category}`);
  log(`Image security: ${data.security}`);
  if (data.confidence !== undefined) log(`Confidence: ${(data.confidence * 100).toFixed(1)}%`);
  setBadge('imageBadge', data.security === 'METADATA_CLEAN', data.security === 'METADATA_CLEAN' ? '✓ METADATA CLEAN' : '⚠ ' + data.security);
  state.visionResult = data;
}

async function runFusion() {
  setStep('step5', 's5Status', 'active', 'RUNNING');
  log('Running weighted fusion engine…');
  let res;
  try {
    res = await fetch(`${API_BASE}/analyze/fuse`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_result: state.audioResult || {}, vision_result: state.visionResult || {} }),
    });
  } catch { throw new Error('Cannot reach Flask backend for fusion.'); }
  if (!res.ok) throw new Error('Fusion API failed: ' + res.statusText);
  const data = await res.json();
  log(`Final score: ${data.final_score} / 5  →  ${data.action}`);
  setStep('step5', 's5Status', 'done', 'COMPLETE');
  return data;
}

// ── RENDER RESULTS ─────────────────────────────────────
function renderResults(fusion) {
  const score = fusion.final_score;
  const isUrgent = fusion.is_critical;
  const circ = 2 * Math.PI * 50;
  const fraction = Math.max(0, Math.min(1, (5 - score) / 4));
  const ring = document.getElementById('ringFill');
  ring.style.strokeDasharray = `${circ * fraction} ${circ}`;
  ring.classList.remove('safe');
  ring.style.stroke = score <= 2 ? 'var(--accent)' : score === 3 ? 'var(--amber)' : 'var(--green)';
  if (score >= 4) ring.classList.add('safe');
  document.getElementById('scoreNumber').textContent = score;
  const sevEl = document.getElementById('scoreSeverity');
  sevEl.textContent = severityLabel(score);
  sevEl.classList.remove('safe');
  sevEl.style.color = score <= 2 ? 'var(--accent)' : score === 3 ? 'var(--amber)' : 'var(--green)';
  const a = state.audioResult || {};
  const v = state.visionResult || {};
  document.getElementById('resAudioStatus').textContent = a.security || '—';
  document.getElementById('resVisionStatus').textContent = v.security || '—';
  document.getElementById('resTranscript').textContent = a.transcript ? `"${a.transcript.slice(0, 120)}"` : '"No audio provided"';
  document.getElementById('resVisualType').textContent = v.top_category || 'No image provided';
  const tf = fusion.trust_flags || {};
  let trustText = `Audio ×${fusion.weights?.audio ?? '—'}  ·  Vision ×${fusion.weights?.vision ?? '—'}`;
  if (tf.audio_suspicious && tf.vision_suspicious) trustText += '  ⚠ BOTH SIGNALS UNVERIFIED';
  else if (tf.audio_suspicious) trustText += '  ⚠ Audio unverified';
  else if (tf.vision_suspicious) trustText += '  ⚠ No camera metadata';
  if (tf.penalty_applied) trustText += ' — score adjusted';
  document.getElementById('resTrustWeights').textContent = trustText;
  const banner = document.getElementById('actionBanner');
  banner.className = 'action-banner' + (isUrgent ? '' : ' safe');
  document.getElementById('actionIcon').textContent = isUrgent ? '🚨' : '✅';
  document.getElementById('actionPriority').textContent = fusion.action;
  document.getElementById('actionText').textContent = isUrgent
    ? 'High-severity signals detected. Dispatch emergency unit immediately.'
    : 'No critical indicators. Patient may seek non-emergency care.';
  const dispBtn = document.getElementById('dispatchBtn');
  dispBtn.style.display = isUrgent ? 'inline-block' : 'none';
  state.lastFusion = fusion;
}

// ── MAIN ANALYSIS ──────────────────────────────────────
async function runAnalysis() {
  if (!state.audioFile && !state.imageFile) { showToast('Upload at least one file to run analysis.', 'warn'); return; }
  const btn = document.getElementById('analyzeBtn');
  btn.disabled = true;
  document.querySelector('.btn-text').hidden = true;
  document.getElementById('btnLoader').hidden = false;
  clearLog();
  document.getElementById('phasePanel').style.display = 'block';
  document.getElementById('resultsPanel').style.display = 'none';
  setSystemStatus('PROCESSING', 'processing');
  document.getElementById('phasePanel').scrollIntoView({ behavior: 'smooth' });
  ['step1','step2','step3','step4','step5'].forEach((id, i) => setStep(id, `s${i+1}Status`, '', 'PENDING'));

  log('Checking backend connectivity…');
  const healthy = await checkBackendHealth();
  if (!healthy) {
    logErr('Backend unreachable at http://localhost:5000');
    logErr('Run: python app.py in your project folder');
    logErr('Also ensure ffmpeg is installed and on your PATH');
    setSystemStatus('BACKEND OFFLINE', 'alert');
    btn.disabled = false; document.querySelector('.btn-text').hidden = false; document.getElementById('btnLoader').hidden = true;
    return;
  }
  log('Backend online ✓');

  try {
    if (state.audioFile) { await runAudioPipeline(); }
    else {
      ['step1','step2','step3'].forEach((id, i) => setStep(id, `s${i+1}Status`, 'done', 'SKIPPED'));
      state.audioResult = { transcript: '', audio_triage_score: 5, security: 'UNKNOWN', skipped: true };
      log('No audio file — skipping audio pipeline.');
    }
    if (state.imageFile) { await runVisionPipeline(); }
    else {
      setStep('step4', 's4Status', 'done', 'SKIPPED');
      state.visionResult = { top_category: 'No image', image_triage_score: 5, security: 'UNKNOWN', skipped: true };
      log('No image file — skipping vision pipeline.');
    }
    const fusion = await runFusion();
    document.getElementById('resultsPanel').style.display = 'block';
    renderResults(fusion);
    setSystemStatus(fusion.is_critical ? '🚨 ALERT — DISPATCH NOW' : 'ANALYSIS COMPLETE', fusion.is_critical ? 'alert' : '');
    document.getElementById('resultsPanel').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    logErr(err.message);
    setSystemStatus('ERROR — CHECK LOG', 'alert');
    console.error(err);
  }

  btn.disabled = false; document.querySelector('.btn-text').hidden = false; document.getElementById('btnLoader').hidden = true;
}

// ── SAVE TO HISTORY ────────────────────────────────────
function saveToHistory() {
  if (!state.lastFusion) { showToast('Run an analysis first.', 'warn'); return; }
  const token = getNextToken();
  const name = document.getElementById('patientName').value.trim() || 'Unknown';
  const age = document.getElementById('patientAge').value || '—';
  const location = document.getElementById('patientLocation').value.trim() || '—';
  const notes = document.getElementById('callerNotes').value.trim() || '';
  const score = state.lastFusion.final_score;
  const entry = {
    token, timestamp: Date.now(), name, age, location, notes,
    score, severity: severityLabel(score),
    visualCategory: (state.visionResult || {}).top_category || '—',
    transcript: (state.audioResult || {}).transcript || '',
    audioSecurity: (state.audioResult || {}).security || '—',
    visionSecurity: (state.visionResult || {}).security || '—',
    action: state.lastFusion.action,
    weights: state.lastFusion.weights,
    isCritical: state.lastFusion.is_critical,
    dispatchStatus: 'pending',
  };
  history.unshift(entry);
  patients.unshift({ ...entry });
  localStorage.setItem('triageHistory', JSON.stringify(history));
  localStorage.setItem('triagePatients', JSON.stringify(patients));
  showToast(`✅ Saved as ${token}`, 'ok');
  refreshHomeStats();
}

// ── DASHBOARD ─────────────────────────────────────────
function refreshDashboard() {
  const total = history.length;
  const critical = history.filter(h => h.score <= 2).length;
  const moderate = history.filter(h => h.score === 3).length;
  const stable = history.filter(h => h.score >= 4).length;
  document.getElementById('dashTotal').textContent = total;
  document.getElementById('dashCritical').textContent = critical;
  document.getElementById('dashModerate').textContent = moderate;
  document.getElementById('dashStable').textContent = stable;
  renderHistoryTable();
  refreshCharts();
}

function refreshHomeStats() {
  document.getElementById('statTotal').textContent = history.length;
  document.getElementById('statCritical').textContent = history.filter(h => h.score <= 2).length;
  document.getElementById('statStable').textContent = history.filter(h => h.score >= 4).length;
  document.getElementById('statPatients').textContent = patients.length;
}

function renderHistoryTable() {
  const tbody = document.getElementById('historyBody');
  if (history.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-row">No analyses yet. Run your first triage above.</td></tr>';
    return;
  }
  tbody.innerHTML = history.map(h => `
    <tr>
      <td style="font-family:var(--font-display);color:var(--accent);letter-spacing:.05em">${h.token}</td>
      <td style="color:var(--text-muted)">${fmtDateTime(h.timestamp)}</td>
      <td>${h.name} <span style="color:var(--text-muted);font-size:10px">(${h.age})</span></td>
      <td><span class="score-badge s${h.score}">${h.score}/5</span></td>
      <td style="color:${h.score<=2?'var(--accent)':h.score===3?'var(--amber)':'var(--green)'}">${h.severity}</td>
      <td style="color:var(--text-dim);font-size:10px">${(h.visualCategory||'—').slice(0,22)}</td>
      <td><button class="action-link" onclick="dispatchFromHistory('${h.token}')">🚑 Dispatch</button></td>
    </tr>
  `).join('');
}

function refreshCharts() {
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
  const textColor = isDark ? '#8a9ba8' : '#4a5a6a';

  // Score distribution bar chart
  const scoreCounts = [1,2,3,4,5].map(s => history.filter(h => h.score === s).length);
  const scoreCtx = document.getElementById('scoreChart');
  if (scoreChartInst) scoreChartInst.destroy();
  scoreChartInst = new Chart(scoreCtx, {
    type: 'bar',
    data: {
      labels: ['1 Critical','2 Urgent','3 Moderate','4 Minor','5 Stable'],
      datasets: [{
        data: scoreCounts,
        backgroundColor: ['#e63946','#ff6b6b','#f4a261','#4fc3f7','#2dce89'],
        borderRadius: 6, borderSkipped: false,
      }]
    },
    options: {
      responsive: true, plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { color: textColor, stepSize: 1 }, grid: { color: gridColor } },
        x: { ticks: { color: textColor }, grid: { display: false } }
      }
    }
  });

  // Severity doughnut
  const critical = history.filter(h => h.score <= 2).length;
  const moderate = history.filter(h => h.score === 3).length;
  const stable = history.filter(h => h.score >= 4).length;
  const sevCtx = document.getElementById('severityChart');
  if (severityChartInst) severityChartInst.destroy();
  severityChartInst = new Chart(sevCtx, {
    type: 'doughnut',
    data: {
      labels: ['Critical/Urgent','Moderate','Stable/Minor'],
      datasets: [{ data: [critical, moderate, stable], backgroundColor: ['#e63946','#f4a261','#2dce89'], borderWidth: 0, hoverOffset: 6 }]
    },
    options: {
      responsive: true, cutout: '65%',
      plugins: { legend: { position: 'bottom', labels: { color: textColor, padding: 16, font: { size: 11 } } } }
    }
  });
}

function clearHistory() {
  // Use a non-blocking inline confirm banner instead of window.confirm()
  const existing = document.getElementById('clearConfirm');
  if (existing) { existing.remove(); return; }
  const banner = document.createElement('div');
  banner.id = 'clearConfirm';
  Object.assign(banner.style, {
    background: 'var(--accent-dim)', border: '1px solid rgba(230,57,70,.3)',
    borderRadius: '8px', padding: '14px 18px', marginBottom: '12px',
    display: 'flex', alignItems: 'center', gap: '14px',
    fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--accent)',
    letterSpacing: '.05em',
  });
  banner.innerHTML = `
    <span style="flex:1">⚠ Clear ALL history and patients? This cannot be undone.</span>
    <button onclick="confirmClearHistory()" style="padding:6px 14px;background:var(--accent);border:none;border-radius:6px;color:#fff;font-family:var(--font-mono);font-size:10px;cursor:pointer;letter-spacing:.1em">YES, CLEAR</button>
    <button onclick="document.getElementById('clearConfirm').remove()" style="padding:6px 14px;background:transparent;border:1px solid var(--border-strong);border-radius:6px;color:var(--text-dim);font-family:var(--font-mono);font-size:10px;cursor:pointer;letter-spacing:.1em">CANCEL</button>`;
  const dashHeader = document.querySelector('#page-dashboard .page-header');
  if (dashHeader) dashHeader.after(banner); else document.getElementById('page-dashboard').prepend(banner);
}

function confirmClearHistory() {
  const b = document.getElementById('clearConfirm');
  if (b) b.remove();
  history = []; patients = []; dispatches = [];
  localStorage.setItem('triageHistory', '[]');
  localStorage.setItem('triagePatients', '[]');
  localStorage.setItem('triageDispatches', '[]');
  refreshDashboard(); refreshHomeStats();
  showToast('History cleared.', 'ok');
}

// ── PATIENT QUEUE ──────────────────────────────────────
function renderPatientQueue(filter) {
  const queue = document.getElementById('patientQueue');
  let filtered = patients;
  if (filter === 'critical') filtered = patients.filter(p => p.score <= 2);
  else if (filter === 'moderate') filtered = patients.filter(p => p.score === 3);
  else if (filter === 'stable') filtered = patients.filter(p => p.score >= 4);
  else if (filter === 'dispatched') filtered = patients.filter(p => p.dispatchStatus === 'dispatched');

  if (filtered.length === 0) {
    queue.innerHTML = `<div class="empty-state"><p class="empty-icon">♥</p><p>No patients in this category.</p><button class="btn-primary" onclick="showPage('analyze')">⚡ Start Analysis</button></div>`;
    return;
  }

  queue.innerHTML = filtered.map(p => {
    const cls = p.score <= 2 ? 'critical-card' : p.score === 3 ? 'moderate-card' : p.dispatchStatus === 'dispatched' ? 'dispatched-card' : 'stable-card';
    const scoreColor = p.score <= 2 ? 'var(--accent)' : p.score === 3 ? 'var(--amber)' : 'var(--green)';
    return `
      <div class="patient-card ${cls}" id="pc-${p.token}">
        <div class="token-badge">${p.token}</div>
        <div class="patient-info">
          <span class="patient-name">${p.name}</span>
          <span class="patient-meta">Age: ${p.age} · ${p.location} · ${fmtDateTime(p.timestamp)}</span>
          ${p.notes ? `<span class="patient-meta" style="color:var(--text-dim)">${p.notes}</span>` : ''}
          ${p.dispatchStatus === 'dispatched' ? '<span style="color:var(--blue);font-size:9px;letter-spacing:.15em">🚑 DISPATCHED</span>' : ''}
        </div>
        <div class="patient-score">
          <div class="patient-score-val" style="color:${scoreColor}">${p.score}</div>
          <div class="patient-score-label">${severityLabel(p.score)}</div>
        </div>
        <div class="patient-actions">
          ${p.dispatchStatus !== 'dispatched' ? `<button class="btn-primary btn-sm" onclick="dispatchFromHistory('${p.token}')">🚑 Dispatch</button>` : ''}
          <button class="btn-ghost btn-sm" onclick="removePatient('${p.token}')">✕ Remove</button>
        </div>
      </div>`;
  }).join('');
}

function filterQueue(filter, btn) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderPatientQueue(filter);
}

function removePatient(token) {
  patients = patients.filter(p => p.token !== token);
  localStorage.setItem('triagePatients', JSON.stringify(patients));
  renderPatientQueue('all');
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.filter-btn').classList.add('active');
}

// ── DISPATCH ──────────────────────────────────────────
function dispatchAmbulance() {
  const patient = document.getElementById('dispatchPatient').value.trim() || 'Unknown';
  const location = document.getElementById('dispatchLocation').value.trim() || 'Unknown location';
  const priority = document.getElementById('dispatchPriority').value;
  const notes = document.getElementById('dispatchNotes').value.trim();
  if (!location || location === 'Unknown location') { showToast('Please enter a pickup location.', 'warn'); return; }

  const entry = { id: Date.now(), patient, location, priority, notes, timestamp: Date.now(), status: 'dispatched' };
  dispatches.unshift(entry);
  localStorage.setItem('triageDispatches', JSON.stringify(dispatches));

  // Mark patient as dispatched
  const pat = patients.find(p => p.token === patient || p.name.toLowerCase() === patient.toLowerCase());
  if (pat) { pat.dispatchStatus = 'dispatched'; localStorage.setItem('triagePatients', JSON.stringify(patients)); }

  // Mark a unit as busy
  const units = document.querySelectorAll('.unit-card.available');
  if (units.length > 0) {
    units[0].classList.remove('available'); units[0].classList.add('busy');
    units[0].querySelector('.unit-status').textContent = 'EN ROUTE';
    setTimeout(() => {
      units[0].classList.remove('busy'); units[0].classList.add('available');
      units[0].querySelector('.unit-status').textContent = 'AVAILABLE';
    }, 15000);
  }

  renderDispatchLog();
  document.getElementById('dispatchPatient').value = '';
  document.getElementById('dispatchLocation').value = '';
  document.getElementById('dispatchNotes').value = '';
  showToast(`🚑 Ambulance dispatched! Priority: ${priority}`, 'ok');
}

function renderDispatchLog() {
  const log = document.getElementById('dispatchLog');
  if (dispatches.length === 0) { log.innerHTML = '<div class="empty-state-sm">No dispatches yet.</div>'; return; }
  log.innerHTML = dispatches.map(d => `
    <div class="dispatch-entry ${d.priority.toLowerCase()}">
      <div class="dispatch-time">${fmtDateTime(d.timestamp)}</div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span class="dispatch-prio">${d.priority}</span>
        <span class="dispatch-patient">${d.patient}</span>
      </div>
      <div class="dispatch-loc">📍 ${d.location}</div>
      ${d.notes ? `<div class="dispatch-loc" style="margin-top:4px">📋 ${d.notes}</div>` : ''}
    </div>`).join('');
}

function dispatchFromHistory(token) {
  const p = patients.find(x => x.token === token) || history.find(x => x.token === token);
  showPage('dispatch');
  setTimeout(() => {
    document.getElementById('dispatchPatient').value = p ? `${p.token} — ${p.name}` : token;
    document.getElementById('dispatchLocation').value = p?.location || '';
    const prio = p ? (p.score <= 2 ? 'P1' : p.score === 3 ? 'P2' : 'P3') : 'P2';
    document.getElementById('dispatchPriority').value = prio;
    document.getElementById('dispatchNotes').value = p?.notes || '';
  }, 100);
}

function openDispatchFromResult() {
  const fusion = state.lastFusion;
  const name = document.getElementById('patientName').value.trim() || 'Unknown';
  const location = document.getElementById('patientLocation').value.trim() || '';
  showPage('dispatch');
  setTimeout(() => {
    document.getElementById('dispatchPatient').value = name;
    document.getElementById('dispatchLocation').value = location;
    document.getElementById('dispatchPriority').value = fusion?.is_critical ? 'P1' : 'P2';
    document.getElementById('dispatchNotes').value = `Score: ${fusion?.final_score}/5 · ${(state.visionResult||{}).top_category||''}`;
  }, 100);
}

// ── RESET ─────────────────────────────────────────────
function resetSystem() {
  if (isRecording) stopRecording();
  state = { audioFile: null, imageFile: null, audioResult: null, visionResult: null, _recordedBlob: null, lastFusion: null };
  ['audioCard','imageCard'].forEach(id => document.getElementById(id).classList.remove('loaded'));
  document.getElementById('audioFileName').textContent = 'No file selected';
  document.getElementById('imageFileName').textContent = 'No file selected';
  document.getElementById('imagePreview').innerHTML = '';
  document.getElementById('audioPlayback').src = '';
  document.getElementById('audioPlayback').style.display = 'none';
  document.getElementById('audioInput').value = '';
  document.getElementById('imageInput').value = '';
  document.getElementById('patientName').value = '';
  document.getElementById('patientAge').value = '';
  document.getElementById('patientLocation').value = '';
  document.getElementById('callerNotes').value = '';
  clearBadge('audioBadge'); clearBadge('imageBadge');
  document.getElementById('recordLabel').textContent = 'RECORD LIVE';
  document.getElementById('recordTimer').style.display = 'none';
  document.getElementById('waveformBars').style.display = 'none';
  ['step1','step2','step3','step4','step5'].forEach((id, i) => setStep(id, `s${i+1}Status`, '', 'PENDING'));
  clearLog();
  document.getElementById('phasePanel').style.display = 'none';
  document.getElementById('resultsPanel').style.display = 'none';
  const ring = document.getElementById('ringFill');
  ring.style.strokeDasharray = '0 314'; ring.classList.remove('safe');
  document.getElementById('scoreNumber').textContent = '—';
  document.getElementById('scoreSeverity').textContent = 'AWAITING DATA';
  setSystemStatus('SYSTEM READY', '');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── TOAST NOTIFICATIONS ───────────────────────────────────
function showToast(msg, type = 'ok') {
  // Remove any existing toast
  const old = document.getElementById('toastMsg');
  if (old) old.remove();

  const t = document.createElement('div');
  t.id = 'toastMsg';
  t.textContent = msg;
  Object.assign(t.style, {
    position: 'fixed', bottom: '28px', right: '28px', zIndex: '9999',
    padding: '13px 22px', borderRadius: '8px',
    fontFamily: 'var(--font-mono)', fontSize: '12px', letterSpacing: '.06em',
    maxWidth: '340px', lineHeight: '1.5',
    boxShadow: '0 6px 24px rgba(0,0,0,.35)',
    animation: 'fadeUp .25s ease forwards',
    background: type === 'warn' ? 'var(--amber-dim)'  :
                type === 'err'  ? 'var(--accent-dim)' : 'var(--green-dim)',
    color:      type === 'warn' ? 'var(--amber)'      :
                type === 'err'  ? 'var(--accent)'     : 'var(--green)',
    border: `1px solid ${
                type === 'warn' ? 'rgba(244,162,97,.35)'  :
                type === 'err'  ? 'rgba(230,57,70,.35)'   : 'rgba(45,206,137,.35)'}`,
  });
  document.body.appendChild(t);
  setTimeout(() => { if (t.parentNode) t.remove(); }, 3500);
}

// ── INIT ──────────────────────────────────────────────
refreshHomeStats();