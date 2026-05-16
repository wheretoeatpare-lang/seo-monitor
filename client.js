const API_SECRET_CLIENT = window.__CFG__.secret;
let polling = null;
let wasRunning = false;
let scanMode = 'all';
let globalKeywords = [];

function setScanMode(mode) {
  scanMode = mode;
  document.getElementById('mode-all').classList.toggle('active', mode === 'all');
  document.getElementById('mode-specific').classList.toggle('active', mode === 'specific');
  document.getElementById('pages-field').style.display = mode === 'specific' ? 'block' : 'none';
}

function handleKwInput(e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const val = e.target.value.trim();
  if (!val || globalKeywords.includes(val)) { e.target.value = ''; return; }
  globalKeywords.push(val);
  e.target.value = '';
  renderKwTags();
}

function removeKw(kw) {
  globalKeywords = globalKeywords.filter(k => k !== kw);
  renderKwTags();
}

function renderKwTags() {
  const el = document.getElementById('kw-tags');
  el.innerHTML = '';
  globalKeywords.forEach(function(kw) {
    const tag = document.createElement('span');
    tag.className = 'kw-tag';
    tag.textContent = kw;
    const x = document.createElement('span');
    x.className = 'kw-tag-remove';
    x.textContent = '×';
    x.onclick = function() { removeKw(kw); };
    tag.appendChild(x);
    el.appendChild(tag);
  });
}

// FIX: This was triggerScan() in client.js but HTML called triggerRun() — now both match
async function triggerScan() {
  try {
    const targetPages = scanMode === 'specific'
      ? (document.getElementById('target-pages').value || '').split('\n').map(function(s) { return s.trim(); }).filter(Boolean)
      : [];

    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-secret': API_SECRET_CLIENT },
      // FIX: Send globalKeywords and targetPages so server can use them
      body: JSON.stringify({ targetPages: targetPages, globalKeywords: globalKeywords })
    });
    const data = await res.json();
    console.log('Scan triggered:', data);
    startPolling();
  } catch(e) { console.error('Failed to trigger scan', e); }
}

function startPolling() {
  if (polling) clearInterval(polling);
  polling = setInterval(fetchStatus, 1500);
  fetchStatus();
}

async function fetchStatus() {
  try {
    var results = await Promise.all([fetch('/api/status'), fetch('/api/logs')]);
    var status = await results[0].json();
    var logsData = await results[1].json();
    updateUI(status, logsData);
  } catch(e) {}
}

function updateUI(status, logsData) {
  var btn = document.getElementById('run-btn');
  var btnText = document.getElementById('btn-text');
  var btnIcon = document.getElementById('btn-icon');
  var statusDot = document.getElementById('status-dot');
  var statusText = document.getElementById('status-text');
  var scheduleInfo = document.getElementById('schedule-info');

  // FIX: Server returns isScanning (mapped from isRunning) — check both for safety
  var isScanning = status.isScanning || status.isRunning;

  if (isScanning) {
    wasRunning = true;
    btn.disabled = true;
    btn.classList.add('running');
    btnIcon.outerHTML = '<div class="spinner" id="btn-icon"></div>';
    btnText.textContent = 'Scanning Pages...';
    statusDot.className = 'status-dot running';
    statusText.textContent = 'Scanning';
    scheduleInfo.textContent = 'AI is analyzing your pages...';
  } else {
    btn.disabled = false;
    btn.classList.remove('running');
    var iconEl = document.getElementById('btn-icon');
    if (iconEl) iconEl.outerHTML = '<span id="btn-icon">▶</span>';
    btnText.textContent = 'Run SEO Monitor Now';
    statusDot.className = 'status-dot idle';
    statusText.textContent = 'Idle';
    scheduleInfo.textContent = 'Runs automatically every day at 7:00 AM';
    if (wasRunning) {
      wasRunning = false;
      if (polling) { clearInterval(polling); polling = null; }
    }
  }

  if (status.lastResult) {
    var r = status.lastResult;
    var updEl = document.getElementById('stat-updated');
    var goodEl = document.getElementById('stat-good');
    var errEl = document.getElementById('stat-errors');
    if (updEl) updEl.textContent = r.changed;
    if (goodEl) goodEl.textContent = r.skipped;
    if (errEl) errEl.textContent = r.errors;

    var lastRunEl = document.getElementById('last-run');
    if (lastRunEl) lastRunEl.style.display = 'flex';
    var lastRunDate = document.getElementById('last-run-date');
    if (lastRunDate) lastRunDate.textContent = r.runDate + ' · ' + r.duration + 's';

    var pills = document.getElementById('result-pills');
    if (pills) {
      pills.innerHTML =
        '<span class="pill pill-green">✓ ' + r.changed + ' updated</span>' +
        '<span class="pill pill-purple">◎ ' + r.skipped + ' good</span>' +
        (r.errors > 0 ? '<span class="pill pill-red">✗ ' + r.errors + ' errors</span>' : '');
    }
  }

  var logsBody = document.getElementById('logs-body');
  var logCount = document.getElementById('log-count');
  if (logsData.logs && logsData.logs.length > 0) {
    if (logCount) logCount.textContent = logsData.logs.length + ' lines';
    if (logsBody) {
      logsBody.innerHTML = logsData.logs.map(function(l) {
        var time = new Date(l.time).toLocaleTimeString('en-US', { hour12: false });
        return '<div class="log-line"><span class="log-time">' + time + '</span><span class="log-msg ' + l.type + '">' + escapeHtml(l.msg) + '</span></div>';
      }).join('');
      logsBody.scrollTop = logsBody.scrollHeight;
    }
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

startPolling();
