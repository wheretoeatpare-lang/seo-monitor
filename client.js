const API_SECRET_CLIENT = window.__CFG__.secret;
let polling = null;
let wasRunning = false;
let scanMode = 'all';
let globalKeywords = [];

// { [id]: 'approved' | 'skipped' }
let approvalDecisions = {};

// ── Scan mode ─────────────────────────────────────────────────────────────────
function setScanMode(mode) {
  scanMode = mode;
  document.getElementById('mode-all').classList.toggle('active', mode === 'all');
  document.getElementById('mode-specific').classList.toggle('active', mode === 'specific');
  document.getElementById('pages-field').style.display = mode === 'specific' ? 'block' : 'none';
}

// ── Keyword tags ──────────────────────────────────────────────────────────────
function handleKwInput(e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  var val = e.target.value.trim();
  if (!val || globalKeywords.includes(val)) { e.target.value = ''; return; }
  globalKeywords.push(val);
  e.target.value = '';
  renderKwTags();
}

function removeKw(kw) {
  globalKeywords = globalKeywords.filter(function(k) { return k !== kw; });
  renderKwTags();
}

function renderKwTags() {
  var el = document.getElementById('kw-tags');
  el.innerHTML = '';
  globalKeywords.forEach(function(kw) {
    var tag = document.createElement('span');
    tag.className = 'kw-tag';
    tag.textContent = kw;
    var x = document.createElement('span');
    x.className = 'kw-tag-remove';
    x.textContent = '×';
    x.onclick = function() { removeKw(kw); };
    tag.appendChild(x);
    el.appendChild(tag);
  });
}

// ── Trigger scan ──────────────────────────────────────────────────────────────
async function triggerScan() {
  try {
    var targetPages = scanMode === 'specific'
      ? (document.getElementById('target-pages').value || '').split('\n').map(function(s) { return s.trim(); }).filter(Boolean)
      : [];

    var res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-secret': API_SECRET_CLIENT },
      body: JSON.stringify({ targetPages: targetPages, globalKeywords: globalKeywords })
    });
    var data = await res.json();
    console.log('Scan triggered:', data);
    approvalDecisions = {};
    window.__PENDING__ = [];
    startPolling();
  } catch(e) { console.error('Failed to trigger scan', e); }
}

// ── Polling ───────────────────────────────────────────────────────────────────
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

// ── Approval panel ────────────────────────────────────────────────────────────
function renderApprovalPanel(pending) {
  var panel = document.getElementById('approval-panel');
  var itemsEl = document.getElementById('approval-items');

  if (!pending || pending.length === 0) {
    panel.classList.remove('visible');
    return;
  }

  panel.classList.add('visible');
  itemsEl.innerHTML = '';

  pending.forEach(function(p) {
    var decision = approvalDecisions[p.id];

    var reasonParts = [];
    if (!p.titleOk) reasonParts.push('TITLE: ' + (p.basisTitle || p.reasonTitle || ''));
    if (!p.metaOk)  reasonParts.push('META: '  + (p.basisMeta  || p.reasonMeta  || ''));
    var reasonText = reasonParts.join('\n');

    var itemClass = 'approval-item';
    if (decision === 'approved') itemClass += ' approved';
    else if (decision === 'skipped') itemClass += ' skipped';

    var div = document.createElement('div');
    div.className = itemClass;
    div.id = 'item-' + p.id;

    div.innerHTML =
      '<div class="approval-file">📄 ' + escapeHtml(p.filePath) +
        ' · <a href="' + escapeHtml(p.url) + '" target="_blank" style="color:var(--muted);font-size:11px">' + escapeHtml(p.url) + '</a>' +
      '</div>' +

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
        '<button class="btn-approve' + (decision === 'approved' ? ' selected' : '') +
          '" onclick="decide(\'' + p.id + '\', \'approved\')">✓ Approve &amp; Commit</button>' +
        '<button class="btn-skip' + (decision === 'skipped' ? ' selected' : '') +
          '" onclick="decide(\'' + p.id + '\', \'skipped\')">✗ Skip</button>' +
      '</div>';

    itemsEl.appendChild(div);
  });

  refreshCommitBar(pending);
}

// Called when user clicks Approve or Skip on an item
function decide(id, action) {
  approvalDecisions[id] = action;

  // Update just this card's visual state without re-rendering everything
  var item = document.getElementById('item-' + id);
  if (item) {
    item.className = 'approval-item ' + (action === 'approved' ? 'approved' : 'skipped');
    var btnApprove = item.querySelector('.btn-approve');
    var btnSkip    = item.querySelector('.btn-skip');
    if (btnApprove) btnApprove.className = 'btn-approve' + (action === 'approved' ? ' selected' : '');
    if (btnSkip)    btnSkip.className    = 'btn-skip'    + (action === 'skipped'  ? ' selected' : '');
  }

  refreshCommitBar(window.__PENDING__ || []);
}

// Update the commit button + hint text based on current decisions
function refreshCommitBar(pending) {
  var btn  = document.getElementById('commit-btn');
  var hint = document.getElementById('commit-hint');
  if (!btn || !hint) return;

  var totalItems   = pending.length;
  var decidedCount = pending.filter(function(p) { return !!approvalDecisions[p.id]; }).length;
  var approvedCount= pending.filter(function(p) { return approvalDecisions[p.id] === 'approved'; }).length;
  var skippedCount = decidedCount - approvedCount;
  var allDone      = decidedCount === totalItems;

  if (!allDone) {
    // Still waiting for decisions on some items
    btn.disabled = true;
    hint.textContent = (totalItems - decidedCount) + ' page(s) still need a decision';
  } else {
    // All decided — enable commit regardless of approve/skip mix
    btn.disabled = false;
    if (approvedCount === 0) {
      hint.textContent = 'All skipped — will send report with no changes';
    } else {
      hint.textContent = approvedCount + ' will be committed' + (skippedCount > 0 ? ', ' + skippedCount + ' skipped' : '');
    }
  }
}

// Submit decisions to server
async function submitApprovals() {
  var pending = window.__PENDING__ || [];
  if (!pending.length) return;

  var approvedIds = pending
    .filter(function(p) { return approvalDecisions[p.id] === 'approved'; })
    .map(function(p) { return p.id; });
  var rejectedIds = pending
    .filter(function(p) { return approvalDecisions[p.id] !== 'approved'; })
    .map(function(p) { return p.id; });

  var btn = document.getElementById('commit-btn');
  var hint = document.getElementById('commit-hint');
  btn.disabled = true;
  btn.textContent = 'Committing...';
  if (hint) hint.textContent = 'Writing to GitHub — please wait...';

  try {
    var res = await fetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-secret': API_SECRET_CLIENT },
      body: JSON.stringify({ approved: approvedIds, rejected: rejectedIds })
    });
    var data = await res.json();
    console.log('Approve response:', data);

    // Clear local state
    approvalDecisions = {};
    window.__PENDING__ = [];

    // Hide panel and resume polling to pick up final result
    document.getElementById('approval-panel').classList.remove('visible');
    wasRunning = true; // so polling stops cleanly when server goes idle
    startPolling();
  } catch(e) {
    console.error('Failed to submit approvals', e);
    btn.disabled = false;
    btn.textContent = '▶ Commit Approved to GitHub';
    if (hint) hint.textContent = 'Error — please try again';
  }
}

// ── Main UI update ────────────────────────────────────────────────────────────
function updateUI(status, logsData) {
  var btn         = document.getElementById('run-btn');
  var btnText     = document.getElementById('btn-text');
  var statusDot   = document.getElementById('status-dot');
  var statusText  = document.getElementById('status-text');
  var scheduleInfo= document.getElementById('schedule-info');

  var isScanning = status.isScanning || status.isRunning;
  var hasPending = status.pendingApprovals && status.pendingApprovals.length > 0;

  window.__PENDING__ = status.pendingApprovals || [];

  if (isScanning) {
    wasRunning = true;
    btn.disabled = true;
    btn.classList.add('running');
    // Swap to spinner safely
    var iconEl = document.getElementById('btn-icon');
    if (iconEl && iconEl.tagName !== 'DIV') iconEl.outerHTML = '<div class="spinner" id="btn-icon"></div>';
    btnText.textContent = 'Scanning Pages...';
    statusDot.className = 'status-dot running';
    statusText.textContent = 'Scanning';
    scheduleInfo.textContent = 'AI is analyzing your pages...';

  } else if (hasPending) {
    btn.disabled = false;
    btn.classList.remove('running');
    var iconEl2 = document.getElementById('btn-icon');
    if (iconEl2 && iconEl2.tagName === 'DIV') iconEl2.outerHTML = '<span id="btn-icon">▶</span>';
    btnText.textContent = 'Run SEO Monitor Now';
    statusDot.className = 'status-dot running'; // amber = needs action
    statusText.textContent = 'Awaiting Approval';
    scheduleInfo.textContent = 'Review suggestions below then click Commit';
    // Pause polling — no need to hammer while human reviews
    if (polling) { clearInterval(polling); polling = null; }

  } else {
    btn.disabled = false;
    btn.classList.remove('running');
    var iconEl3 = document.getElementById('btn-icon');
    if (iconEl3 && iconEl3.tagName === 'DIV') iconEl3.outerHTML = '<span id="btn-icon">▶</span>';
    btnText.textContent = 'Run SEO Monitor Now';
    statusDot.className = 'status-dot idle';
    statusText.textContent = 'Idle';
    scheduleInfo.textContent = 'Runs automatically every day at 7:00 AM';

    if (wasRunning) {
      wasRunning = false;
      if (polling) { clearInterval(polling); polling = null; }
    }
  }

  // Render approval panel (no-op if empty)
  renderApprovalPanel(status.pendingApprovals || []);

  // Stats + last run
  if (status.lastResult) {
    var r = status.lastResult;
    var updEl  = document.getElementById('stat-updated');
    var goodEl = document.getElementById('stat-good');
    var errEl  = document.getElementById('stat-errors');
    if (updEl)  updEl.textContent  = r.changed;
    if (goodEl) goodEl.textContent = r.skipped;
    if (errEl)  errEl.textContent  = r.errors;

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

  // Logs
  var logsBody = document.getElementById('logs-body');
  var logCount = document.getElementById('log-count');
  if (logsData.logs && logsData.logs.length > 0) {
    if (logCount) logCount.textContent = logsData.logs.length + ' lines';
    if (logsBody) {
      logsBody.innerHTML = logsData.logs.map(function(l) {
        var time = new Date(l.time).toLocaleTimeString('en-US', { hour12: false });
        return '<div class="log-line"><span class="log-time">' + time +
          '</span><span class="log-msg ' + l.type + '">' + escapeHtml(l.msg) + '</span></div>';
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
