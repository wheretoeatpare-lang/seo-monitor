const API_SECRET_CLIENT = window.__CFG__.secret;
let polling = null;
let wasRunning = false;
let scanMode = 'all';
let globalKeywords = [];

// Tracks per-item decisions: { [id]: 'approved' | 'skipped' }
let approvalDecisions = {};

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
    // Reset decisions for new scan
    approvalDecisions = {};
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

// ── Approval Panel ────────────────────────────────────────────────────────────
function renderApprovalPanel(pending) {
  const panel = document.getElementById('approval-panel');
  const itemsEl = document.getElementById('approval-items');

  if (!pending || pending.length === 0) {
    panel.classList.remove('visible');
    return;
  }

  panel.classList.add('visible');
  itemsEl.innerHTML = '';

  pending.forEach(function(p) {
    const decision = approvalDecisions[p.id];
    const div = document.createElement('div');
    div.className = 'approval-item' + (decision === 'approved' ? ' approved' : decision === 'skipped' ? ' skipped' : '');
    div.id = 'item-' + p.id;

    // Build reason text combining title + meta reasons
    var reasonParts = [];
    if (!p.titleOk) reasonParts.push('TITLE: ' + (p.basisTitle || p.reasonTitle || ''));
    if (!p.metaOk)  reasonParts.push('META: '  + (p.basisMeta  || p.reasonMeta  || ''));
    var reasonText = reasonParts.join('\n');

    div.innerHTML =
      '<div class="approval-file">📄 ' + escapeHtml(p.filePath) + ' · <a href="' + escapeHtml(p.url) + '" target="_blank" style="color:var(--muted);font-size:11px">' + escapeHtml(p.url) + '</a></div>' +

      '<div class="approval-row">' +
        '<div class="approval-label">Title</div>' +
        '<div class="approval-old">' + escapeHtml(p.oldTitle) + '</div>' +
        '<div class="approval-new">' + escapeHtml(p.newTitle) + '</div>' +
      '</div>' +

      '<div class="approval-row">' +
        '<div class="approval-label">Meta</div>' +
        '<div class="approval-old">' + escapeHtml(p.oldMeta) + '</div>' +
        '<div class="approval-new">' + escapeHtml(p.newMeta) + '</div>' +
      '</div>' +

      (reasonText ? '<div class="approval-reason">' + escapeHtml(reasonText) + '</div>' : '') +

      '<div class="approval-actions">' +
        '<button class="btn-approve' + (decision === 'approved' ? ' selected' : '') + '" onclick="decide(\'' + p.id + '\', \'approved\')">✓ Approve &amp; Commit</button>' +
        '<button class="btn-skip'    + (decision === 'skipped'  ? ' selected' : '') + '" onclick="decide(\'' + p.id + '\', \'skipped\')">✗ Skip</button>' +
      '</div>';

    itemsEl.appendChild(div);
  });

  updateCommitButton(pending);
}

function decide(id, action) {
  approvalDecisions[id] = action;
  // Re-render just this item's button states
  const item = document.getElementById('item-' + id);
  if (item) {
    item.className = 'approval-item ' + (action === 'approved' ? 'approved' : 'skipped');
    const btnApprove = item.querySelector('.btn-approve');
    const btnSkip    = item.querySelector('.btn-skip');
    if (btnApprove) btnApprove.className = 'btn-approve' + (action === 'approved' ? ' selected' : '');
    if (btnSkip)    btnSkip.className    = 'btn-skip'    + (action === 'skipped'  ? ' selected' : '');
  }
  // Get current pending from last status poll (stored on window)
  updateCommitButton(window.__PENDING__ || []);
}

function updateCommitButton(pending) {
  const btn  = document.getElementById('commit-btn');
  const hint = document.getElementById('commit-hint');
  if (!btn) return;

  const decided  = pending.filter(function(p) { return approvalDecisions[p.id]; });
  const approved = pending.filter(function(p) { return approvalDecisions[p.id] === 'approved'; });
  const allDone  = decided.length === pending.length;

  btn.disabled = !allDone || approved.length === 0 && decided.length > 0 && allDone
    // Allow commit even if some skipped, as long as at least one approved
    ? !(allDone && approved.length > 0)
    : !allDone;

  // Simpler: enable commit only when all decided AND at least one approved
  btn.disabled = !(allDone && approved.length > 0);

  if (!allDone) {
    hint.textContent = (pending.length - decided.length) + ' page(s) still need a decision';
  } else if (approved.length === 0) {
    hint.textContent = 'All skipped — nothing to commit';
    btn.disabled = false; // allow submitting all-skipped to send email
  } else {
    hint.textContent = approved.length + ' will be committed, ' + (pending.length - approved.length) + ' skipped';
  }
}

async function submitApprovals() {
  const pending = window.__PENDING__ || [];
  if (!pending.length) return;

  const approved = pending.filter(function(p) { return approvalDecisions[p.id] === 'approved'; }).map(function(p) { return p.id; });
  const rejected = pending.filter(function(p) { return approvalDecisions[p.id] !== 'approved'; }).map(function(p) { return p.id; });

  const btn = document.getElementById('commit-btn');
  btn.disabled = true;
  btn.textContent = 'Committing...';

  try {
    const res = await fetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-secret': API_SECRET_CLIENT },
      body: JSON.stringify({ approved: approved, rejected: rejected })
    });
    const data = await res.json();
    console.log('Approve response:', data);
    approvalDecisions = {};
    window.__PENDING__ = [];
    document.getElementById('approval-panel').classList.remove('visible');
    startPolling();
  } catch(e) {
    console.error('Failed to submit approvals', e);
    btn.disabled = false;
    btn.textContent = '▶ Commit Approved to GitHub';
  }
}

// ── Main UI update ────────────────────────────────────────────────────────────
function updateUI(status, logsData) {
  var btn = document.getElementById('run-btn');
  var btnText = document.getElementById('btn-text');
  var btnIcon = document.getElementById('btn-icon');
  var statusDot = document.getElementById('status-dot');
  var statusText = document.getElementById('status-text');
  var scheduleInfo = document.getElementById('schedule-info');

  var isScanning = status.isScanning || status.isRunning;
  var hasPending = status.pendingApprovals && status.pendingApprovals.length > 0;

  // Save pending for use in decide() / submitApprovals()
  window.__PENDING__ = status.pendingApprovals || [];

  if (isScanning) {
    wasRunning = true;
    btn.disabled = true;
    btn.classList.add('running');
    btnIcon.outerHTML = '<div class="spinner" id="btn-icon"></div>';
    btnText.textContent = 'Scanning Pages...';
    statusDot.className = 'status-dot running';
    statusText.textContent = 'Scanning';
    scheduleInfo.textContent = 'AI is analyzing your pages...';
  } else if (hasPending) {
    btn.disabled = false;
    btn.classList.remove('running');
    var iconEl2 = document.getElementById('btn-icon');
    if (iconEl2) iconEl2.outerHTML = '<span id="btn-icon">▶</span>';
    btnText.textContent = 'Run SEO Monitor Now';
    statusDot.className = 'status-dot running'; // orange = waiting for action
    statusText.textContent = 'Awaiting Approval';
    scheduleInfo.textContent = 'Review suggestions below before committing';
    if (polling) { clearInterval(polling); polling = null; } // stop hammering while waiting
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

  // Render approval panel whenever there are pending items
  renderApprovalPanel(status.pendingApprovals || []);

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
