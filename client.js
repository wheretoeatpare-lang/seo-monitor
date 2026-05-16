const API_SECRET_CLIENT = window.__CFG__.secret;
let polling = null;
let wasRunning = false;
let pendingData = [];
let approvedSet = new Set();
let reviewRendered = false;
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

async function triggerScan() {
  try {
    const targetPages = scanMode === 'specific'
      ? (document.getElementById('target-pages').value || '').split('\n').map(function(s) { return s.trim(); }).filter(Boolean)
      : [];
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-secret': API_SECRET_CLIENT },
      body: JSON.stringify({ targetPages: targetPages, globalKeywords: globalKeywords })
    });
    const data = await res.json();
    console.log('Scan triggered:', data);
    startPolling();
  } catch(e) { console.error('Failed to trigger scan', e); }
}

async function applyApproved() {
  if (approvedSet.size === 0) { alert('No changes approved!'); return; }
  if (!confirm('Apply ' + approvedSet.size + ' approved change(s) to GitHub?')) return;
  document.getElementById('apply-btn').disabled = true;
  try {
    const res = await fetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-secret': API_SECRET_CLIENT },
      body: JSON.stringify({ approved: Array.from(approvedSet) })
    });
    const data = await res.json();
    if (data.status !== 'applying') { alert('Error: ' + data.message); document.getElementById('apply-btn').disabled = false; return; }
    document.getElementById('review-panel').style.display = 'none';
    startPolling();
  } catch (err) { alert('Error: ' + err.message); document.getElementById('apply-btn').disabled = false; }
}

function approve(filePath) {
  approvedSet.add(filePath);
  var card = document.getElementById('card-' + CSS.escape(filePath));
  if (card) {
    card.classList.add('approved');
    card.classList.remove('skipped');
    card.querySelector('.btn-approve').classList.add('active');
    card.querySelector('.btn-skip').classList.remove('active');
  }
  updateApplyBtn();
}

function skip(filePath) {
  approvedSet.delete(filePath);
  var card = document.getElementById('card-' + CSS.escape(filePath));
  if (card) {
    card.classList.add('skipped');
    card.classList.remove('approved');
    card.querySelector('.btn-skip').classList.add('active');
    card.querySelector('.btn-approve').classList.remove('active');
  }
  updateApplyBtn();
}

function approveAll() { pendingData.forEach(function(p) { approve(p.filePath); }); }
function skipAll() { pendingData.forEach(function(p) { skip(p.filePath); }); }

function updateApplyBtn() {
  var btn = document.getElementById('apply-btn');
  var count = document.getElementById('apply-count');
  var n = approvedSet.size;
  var total = pendingData.length;
  var skippedCount = total - n;
  if (n === 0) {
    btn.disabled = true;
    btn.className = 'btn-apply btn-apply-zero';
    count.innerHTML = '<strong>0</strong> approved &middot; ' + total + ' pending';
  } else {
    btn.disabled = false;
    btn.className = 'btn-apply';
    count.innerHTML = '<strong style="color:var(--success)">' + n + ' approved</strong> &middot; ' + (skippedCount > 0 ? skippedCount + ' will be skipped' : 'all approved!');
  }
}

function renderPendingChanges(pending) {
  if (reviewRendered && pendingData.length === pending.length) return;
  reviewRendered = true;
  pendingData = pending;
  var panel = document.getElementById('review-panel');
  var cards = document.getElementById('change-cards');
  var title = document.getElementById('review-title');
  var subtitle = document.getElementById('review-subtitle');
  if (!pending || pending.length === 0) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  title.textContent = '⚠ ' + pending.length + ' Page' + (pending.length > 1 ? 's' : '') + ' Need SEO Improvements';
  subtitle.textContent = 'Review the AI analysis below — approve to apply changes, or skip to leave as-is';
  cards.innerHTML = pending.map(function(p) {
    var a = p.analysis;
    var titleLenOld = a.titleLength || 0;
    var titleLenNew = a.newTitleLength || (a.newTitle ? a.newTitle.length : 0);
    var metaLenOld = a.metaLength || 0;
    var metaLenNew = a.newMetaLength || (a.newMetaDesc ? a.newMetaDesc.length : 0);
    function lenClass(n, lo, hi) { return (n >= lo && n <= hi) ? 'field-length-good' : 'field-length-bad'; }
    var titleField = !a.titleOk ? (
      '<div class="change-field">' +
        '<div class="field-header"><div class="field-label">📌 Page Title</div>' +
        '<div class="field-lengths"><span class="' + lenClass(titleLenOld,50,60) + '">' + titleLenOld + ' chars</span> &rarr; <span class="' + lenClass(titleLenNew,50,60) + '">' + titleLenNew + ' chars</span></div></div>' +
        (a.basisTitle ? '<div class="field-issues">' + escapeHtml(a.basisTitle) + '</div>' : '') +
        '<div class="comparison">' +
          '<div class="comp-old"><div class="comp-label">Current</div><div class="comp-text">' + escapeHtml(p.oldTitle || '(empty)') + '</div></div>' +
          '<div class="comp-arrow">&rarr;</div>' +
          '<div class="comp-new"><div class="comp-label">AI suggestion</div><div class="comp-text">' + escapeHtml(a.newTitle) + '</div></div>' +
        '</div>' +
        '<div class="ai-reason"><div class="ai-reason-label">🤖 AI Explanation</div>' + escapeHtml(a.reasonTitle) + '</div>' +
      '</div>'
    ) : '';
    var metaField = !a.metaOk ? (
      '<div class="change-field">' +
        '<div class="field-header"><div class="field-label">📝 Meta Description</div>' +
        '<div class="field-lengths"><span class="' + lenClass(metaLenOld,150,160) + '">' + metaLenOld + ' chars</span> &rarr; <span class="' + lenClass(metaLenNew,150,160) + '">' + metaLenNew + ' chars</span></div></div>' +
        (a.basisMeta ? '<div class="field-issues">' + escapeHtml(a.basisMeta) + '</div>' : '') +
        '<div class="comparison">' +
          '<div class="comp-old"><div class="comp-label">Current</div><div class="comp-text">' + escapeHtml(p.oldMeta || '(empty)') + '</div></div>' +
          '<div class="comp-arrow">&rarr;</div>' +
          '<div class="comp-new"><div class="comp-label">AI suggestion</div><div class="comp-text">' + escapeHtml(a.newMetaDesc) + '</div></div>' +
        '</div>' +
        '<div class="ai-reason"><div class="ai-reason-label">🤖 AI Explanation</div>' + escapeHtml(a.reasonMeta) + '</div>' +
      '</div>'
    ) : '';
    return '<div class="change-card" id="card-' + CSS.escape(p.filePath) + '">' +
      '<div class="card-header"><div>' +
        '<div class="card-file">📄 ' + escapeHtml(p.filePath) + '</div>' +
        '<div class="card-url">' + escapeHtml(p.url) + '</div>' +
        (a.primaryKeyword ? '<div class="card-keyword">🔑 ' + escapeHtml(a.primaryKeyword) + '</div>' : '') +
      '</div><div class="card-btns">' +
        '<button class="btn-approve" onclick="approve(' + JSON.stringify(p.filePath) + ')">✓ Approve</button>' +
        '<button class="btn-skip" onclick="skip(' + JSON.stringify(p.filePath) + ')">✗ Skip</button>' +
      '</div></div>' +
      '<div class="card-body">' + titleField + metaField + '</div></div>';
  }).join('');
  updateApplyBtn();
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
    if (status.scanComplete && status.pendingCount > 0) {
      var pendRes = await fetch('/api/pending');
      var pendData = await pendRes.json();
      renderPendingChanges(pendData.pending);
    }
  } catch(e) {}
}

function updateUI(status, logsData) {
  var btn = document.getElementById('run-btn');
  var btnText = document.getElementById('btn-text');
  var btnIcon = document.getElementById('btn-icon');
  var statusDot = document.getElementById('status-dot');
  var statusText = document.getElementById('status-text');
  var scheduleInfo = document.getElementById('schedule-info');
  document.getElementById('stat-pending').textContent = status.scanComplete ? (status.pendingCount || '0') : '—';
  if (status.isScanning) {
    wasRunning = true; btn.disabled = true; btn.classList.add('running');
    btnIcon.outerHTML = '<div class="spinner" id="btn-icon"></div>';
    btnText.textContent = 'Scanning Pages...'; statusDot.className = 'status-dot running'; statusText.textContent = 'Scanning';
    scheduleInfo.textContent = 'AI is analyzing your pages...';
  } else if (status.isApplying) {
    wasRunning = true; btn.disabled = true; btn.classList.add('running');
    var iconEl = document.getElementById('btn-icon');
    if (iconEl) iconEl.outerHTML = '<div class="spinner" id="btn-icon"></div>';
    btnText.textContent = 'Applying Changes...'; statusDot.className = 'status-dot running'; statusText.textContent = 'Applying';
    scheduleInfo.textContent = 'Committing approved changes to GitHub...';
  } else if (status.scanComplete && status.pendingCount > 0) {
    btn.disabled = false; btn.classList.remove('running');
    var iconEl2 = document.getElementById('btn-icon');
    if (iconEl2) iconEl2.outerHTML = '<span id="btn-icon">🔍</span>';
    btnText.textContent = 'Re-Scan Pages'; statusDot.className = 'status-dot review'; statusText.textContent = 'Review Pending';
    scheduleInfo.textContent = status.pendingCount + ' page(s) need your review — approve or skip below';
  } else {
    btn.disabled = false; btn.classList.remove('running');
    var iconEl3 = document.getElementById('btn-icon');
    if (iconEl3) iconEl3.outerHTML = '<span id="btn-icon">🔍</span>';
    btnText.textContent = 'Run SEO Scan'; statusDot.className = 'status-dot idle'; statusText.textContent = 'Idle';
    scheduleInfo.textContent = 'Scans all pages · You approve before anything changes';
    if (wasRunning && !status.isApplying && !status.isScanning) { wasRunning = false; if (polling) { clearInterval(polling); polling = null; } }
  }
  if (status.lastResult) {
    document.getElementById('stat-updated').textContent = status.lastResult.changed;
    document.getElementById('stat-good').textContent = status.lastResult.skipped;
    document.getElementById('stat-errors').textContent = status.lastResult.errors;
    document.getElementById('last-run').style.display = 'flex';
    document.getElementById('last-run-date').textContent = status.lastResult.runDate + ' · ' + status.lastResult.duration + 's';
    document.getElementById('result-pills').innerHTML =
      '<span class="pill pill-green">✓ ' + status.lastResult.changed + ' applied</span>' +
      '<span class="pill pill-warn">⏭ ' + (status.lastResult.rejected || 0) + ' skipped</span>' +
      '<span class="pill pill-purple">◎ ' + status.lastResult.skipped + ' good</span>' +
      (status.lastResult.errors > 0 ? '<span class="pill pill-red">✗ ' + status.lastResult.errors + ' errors</span>' : '');
  }
  var logsBody = document.getElementById('logs-body');
  var logCount = document.getElementById('log-count');
  if (logsData.logs && logsData.logs.length > 0) {
    logCount.textContent = logsData.logs.length + ' lines';
    logsBody.innerHTML = logsData.logs.map(function(l) {
      var time = new Date(l.time).toLocaleTimeString('en-US', { hour12: false });
      return '<div class="log-line"><span class="log-time">' + time + '</span><span class="log-msg ' + l.type + '">' + escapeHtml(l.msg) + '</span></div>';
    }).join('');
    logsBody.scrollTop = logsBody.scrollHeight;
  }
}

startPolling();