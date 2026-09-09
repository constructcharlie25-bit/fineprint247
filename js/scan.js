/* FinePrint scanner frontend. Plain JS, no framework.
 *
 * Flow (payments live):
 *  1. User pastes a contract + email, hits "See my free risk score".
 *  2. POST /api/scan returns a TEASER: risk score, severity counts, the
 *     first finding in full (its pushback email stays locked), an encrypted
 *     unlock token, and a "Unlock the full report — $5" CTA.
 *  3. The token is kept in sessionStorage (never in a URL). After the $5
 *     Stripe Checkout succeeds, the client POSTs it to /api/unlock and
 *     renders the full report instantly — no re-scan, no waiting.
 */
(function () {
  'use strict';

  var textEl = document.getElementById('contractText');
  var emailEl = document.getElementById('emailInput');
  var charCount = document.getElementById('charCount');
  var scanBtn = document.getElementById('scanBtn');
  var sampleBtn = document.getElementById('sampleBtn');
  var clearBtn = document.getElementById('clearBtn');
  var fileInput = document.getElementById('fileInput');
  var spinner = document.getElementById('spinner');
  var resultsEl = document.getElementById('results');
  var scoreDial = document.getElementById('scoreDial');
  var bandLabel = document.getElementById('bandLabel');
  var summaryText = document.getElementById('summaryText');
  var flagsList = document.getElementById('flagsList');
  var sevFilter = document.getElementById('sevFilter');
  var unlockPanel = document.getElementById('unlockPanel');
  var resultActions = document.getElementById('resultActions');
  var moreScansPanel = document.getElementById('moreScansPanel');
  var historyList = document.getElementById('historyList');
  var historyPanel = document.getElementById('historyPanel');
  var errorBox = document.getElementById('errorBox');
  var paidNotice = document.getElementById('paidNotice');
  var modeBadge = document.getElementById('modeBadge');
  var modeNote = document.getElementById('modeNote');
  var chatPanel = document.getElementById('chatPanel');
  var chatLog = document.getElementById('chatLog');
  var chatQuota = document.getElementById('chatQuota');
  var chatForm = document.getElementById('chatForm');
  var chatInput = document.getElementById('chatInput');
  var chatSend = document.getElementById('chatSend');
  var chatUpsell = document.getElementById('chatUpsell');

  var SCAN_BTN_LABEL = 'See my free risk score';

  var lastResults = null;
  var activeFilter = 'all';
  var reportEmail = '';

  /* ---------- follow-up Q&A chat ("Ask about your contract") ---------- */

  // The chat token is the unlock token issued with the teaser / paid scan.
  // The server decrypts it and re-derives the report context — the client
  // never sends report content. Kept in sessionStorage (never in a URL).
  var CHAT_KEY = 'fineprint_chat_token_v1';
  var chatToken = null;
  var chatEmail = '';
  var chatHistory = []; // [{role, content}], capped locally
  var chatTier = null;  // 'free' | 'paid' | 'subscriber' (server-confirmed on first answer)
  var chatExhausted = false;

  function setChatToken(token, email) {
    chatToken = token || null;
    chatEmail = email || '';
    try {
      if (chatToken) sessionStorage.setItem(CHAT_KEY, JSON.stringify({ token: chatToken, email: chatEmail }));
      else sessionStorage.removeItem(CHAT_KEY);
    } catch (e) {}
  }

  function setChatEnabled(on) {
    if (chatInput) chatInput.disabled = !on;
    if (chatSend) chatSend.disabled = !on;
  }

  function resetChat() {
    chatHistory = [];
    chatTier = null;
    chatExhausted = false;
    if (chatLog) chatLog.innerHTML = '';
    if (chatUpsell) { chatUpsell.innerHTML = ''; chatUpsell.style.display = 'none'; }
    if (chatForm) chatForm.style.display = '';
    setChatEnabled(true);
  }

  function showChatPanel(tierHint) {
    if (!chatPanel) return;
    if (!chatToken) { chatPanel.style.display = 'none'; return; }
    resetChat();
    chatTier = tierHint || null;
    updateChatQuota(null);
    chatPanel.style.display = '';
  }

  function hideChatPanel() {
    if (chatPanel) chatPanel.style.display = 'none';
    setChatToken(null, '');
  }

  function updateChatQuota(questionsLeft) {
    if (!chatQuota) return;
    if (chatExhausted) { chatQuota.innerHTML = ''; return; }
    if (chatTier === 'free') {
      var left = (questionsLeft === null || questionsLeft === undefined) ? 2 : questionsLeft;
      chatQuota.innerHTML = left > 0
        ? 'You have <strong>' + left + ' free question' + (left === 1 ? '' : 's') + '</strong> about this report.'
        : '';
    } else {
      chatQuota.textContent = 'Ask anything about this report \u2014 Q&A is included' +
        (chatTier === 'subscriber' ? ' with your subscription.' : ' with your purchase.');
    }
  }

  function appendChatMsg(role, text, isError) {
    var div = document.createElement('div');
    div.className = 'chat-msg ' + (role === 'user' ? 'user' : (isError ? 'error' : 'assistant'));
    div.textContent = text;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
    return div;
  }

  function showChatTyping() {
    var div = document.createElement('div');
    div.className = 'chat-msg assistant chat-typing';
    div.setAttribute('aria-label', 'FinePrint is typing');
    div.innerHTML = '<span></span><span></span><span></span>';
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
    return div;
  }

  function showChatUpsell(message) {
    chatExhausted = true;
    setChatEnabled(false);
    if (chatForm) chatForm.style.display = 'none';
    if (chatQuota) chatQuota.innerHTML = '';
    chatUpsell.innerHTML =
      '<strong>' + esc(message || 'You\u2019ve used your 2 free questions.') + '</strong>' +
      '<div class="unlock-row">' +
        '<button class="btn small" data-pay="single">Unlock the full report \u2014 $5</button>' +
        '<button class="btn small ghost pack-tier" data-pay="pack" style="display:none">5-scan pack \u2014 $20</button>' +
        '<button class="btn small ghost" data-pay="subscription">Unlimited \u2014 $29/mo</button>' +
      '</div>';
    chatUpsell.style.display = '';
    refreshPackVisibility();
  }

  function handleChatError(status, d) {
    var msg = (d && d.message) || '';
    if (status === 402 && d.error === 'free_questions_exhausted') {
      appendChatMsg('assistant', msg);
      showChatUpsell(msg);
      return;
    }
    if (status === 410) {
      appendChatMsg('assistant',
        msg || 'This report\u2019s Q&A link expired after 24 hours. Scan again for a fresh report with Q&A.', true);
      chatExhausted = true;
      setChatEnabled(false);
      if (chatForm) chatForm.style.display = 'none';
      return;
    }
    if (status === 429) {
      appendChatMsg('assistant',
        msg || 'You\u2019ve asked a lot of questions \u2014 take a short break and try again.', true);
      return;
    }
    appendChatMsg('assistant', msg || 'Something went wrong \u2014 try asking again in a moment.', true);
  }

  if (chatForm) {
    chatForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (chatExhausted || !chatToken) return;
      var msg = (chatInput.value || '').trim();
      if (!msg) return;
      if (msg.length > 2000) {
        appendChatMsg('assistant', 'Keep questions under 2000 characters.', true);
        return;
      }
      chatInput.value = '';
      setChatEnabled(false);
      appendChatMsg('user', msg);
      var typing = showChatTyping();
      fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: chatEmail,
          token: chatToken,
          message: msg,
          history: chatHistory.slice(-10)
        })
      })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (d) {
            return { status: r.status, d: d };
          });
        })
        .then(function (x) {
          typing.remove();
          var d = x.d || {};
          if (x.status === 200) {
            chatHistory.push({ role: 'user', content: msg });
            chatHistory.push({ role: 'assistant', content: String(d.answer || '') });
            if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
            if (d.tier) chatTier = d.tier;
            appendChatMsg('assistant', d.answer || 'I could not come up with an answer \u2014 try rephrasing.');
            if (typeof d.questionsLeft === 'number') updateChatQuota(d.questionsLeft);
            else updateChatQuota(null);
            if (d.upsell && d.upsell.message) showChatUpsell(d.upsell.message);
            else if (d.tier === 'free' && d.questionsLeft === 0) showChatUpsell();
            setChatEnabled(!chatExhausted);
            return;
          }
          handleChatError(x.status, d);
          setChatEnabled(!chatExhausted);
        })
        .catch(function () {
          typing.remove();
          appendChatMsg('assistant', 'Could not reach the assistant. Check your connection and try again.', true);
          setChatEnabled(!chatExhausted);
        });
    });
  }

  /* ---------- helpers ---------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.style.display = 'block';
    if (resultsEl) resultsEl.classList.remove('visible');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function clearError() {
    errorBox.textContent = '';
    errorBox.style.display = 'none';
  }

  function showToast(msg) {
    var t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { t.remove(); }, 400);
    }, 3200);
  }

  function setLoading(on, text) {
    spinner.classList.toggle('visible', !!on);
    scanBtn.disabled = !!on;
    scanBtn.textContent = on ? (text || 'Checking every clause…') : SCAN_BTN_LABEL;
  }

  function isValidEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim().toLowerCase());
  }

  /* ---------- pending unlock token (sessionStorage, never a URL) ---------- */

  var PENDING_KEY = 'fineprint_pending_unlock_v1';

  function savePendingUnlock(teaser, payload) {
    try {
      if (!teaser || !teaser.unlockToken) {
        sessionStorage.removeItem(PENDING_KEY);
        return;
      }
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({
        token: teaser.unlockToken,
        expiresAt: teaser.unlockExpiresAt,
        text: payload && payload.text ? payload.text : null,
        email: (payload && payload.email) || '',
        savedAt: Date.now()
      }));
    } catch (e) { /* storage full/blocked — unlock still works via paid re-scan */ }
  }

  function loadPendingUnlock() {
    try {
      var raw = sessionStorage.getItem(PENDING_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (!p || !p.token) return null;
      return p;
    } catch (e) { return null; }
  }

  function clearPendingUnlock() {
    try { sessionStorage.removeItem(PENDING_KEY); } catch (e) {}
  }

  /* ---------- score dial ---------- */

  function scoreColor(score) {
    if (score >= 70) return '#c0392b';
    if (score >= 40) return '#d48806';
    return '#1e7e34';
  }

  function renderDial(score) {
    var s = Math.max(0, Math.min(100, Number(score) || 0));
    var c = 2 * Math.PI * 54;
    var color = scoreColor(s);
    scoreDial.innerHTML =
      '<svg viewBox="0 0 120 120" role="img" aria-label="Risk score ' + s + ' out of 100">' +
      '<circle cx="60" cy="60" r="54" fill="none" stroke="#e8e4da" stroke-width="12"/>' +
      '<circle cx="60" cy="60" r="54" fill="none" stroke="' + color + '" stroke-width="12" ' +
      'stroke-linecap="round" stroke-dasharray="' + (c * s / 100).toFixed(1) + ' ' + c.toFixed(1) + '" ' +
      'transform="rotate(-90 60 60)"/>' +
      '<text x="60" y="68" text-anchor="middle" font-size="30" font-weight="800" fill="' + color + '">' + s + '</text>' +
      '<text x="60" y="86" text-anchor="middle" font-size="11" fill="#6b6257">/ 100</text>' +
      '</svg>';
    bandLabel.textContent =
      s >= 70 ? 'High risk — read carefully before you sign' :
      s >= 40 ? 'Medium risk — a few clauses need pushback' :
                'Low risk — mostly clean, still skim the flags';
    bandLabel.style.color = color;
  }

  /* ---------- findings ---------- */

  function flagHtml(f, idx) {
    var sev = String(f.severity || 'medium').toLowerCase();
    var negEmailHtml = '';
    if (f.negotiationEmail && f.negotiationEmail.body) {
      negEmailHtml =
        '<div class="neg-email">' +
          '<div class="neg-email-head"><span class="lbl">Copy-paste pushback email</span><span class="neg-email-tag">included in your report</span></div>' +
          '<div class="neg-email-subject"><strong>Subject:</strong> ' + esc(f.negotiationEmail.subject || '') + '</div>' +
          '<pre class="neg-email-text">' + esc(f.negotiationEmail.body || '') + '</pre>' +
          '<button type="button" class="btn small ghost copy-email-btn" data-email-idx="' + idx + '">Copy email</button>' +
        '</div>';
    }
    return (
      '<article class="flag sev-' + esc(sev) + '" data-sev="' + esc(sev) + '">' +
        '<div class="flag-head">' +
          '<span class="risk ' + esc(sev) + '">' + esc(sev) + ' risk</span>' +
          '<h3>' + esc(f.title || 'Flagged clause') + '</h3>' +
        '</div>' +
        '<blockquote class="clause">&ldquo;' + esc(f.clause || '') + '&rdquo;</blockquote>' +
        '<p><strong>Why it matters:</strong> ' + esc(f.risk || '') + '</p>' +
        (f.plainEnglish ? '<p><strong>In plain English:</strong> ' + esc(f.plainEnglish) + '</p>' : '') +
        (f.negotiation ? '<p><strong>What to negotiate:</strong> ' + esc(f.negotiation) + '</p>' : '') +
        negEmailHtml +
        (f.legalReview
          ? '<p class="lawyer-nudge">&#9878; This one is worth a quick lawyer review before you sign.</p>'
          : '') +
      '</article>'
    );
  }

  function renderFlags(flags) {
    flagsList.innerHTML = (flags || []).map(function (f, i) { return flagHtml(f, i); }).join('');
    applyFilter();
  }

  function applyFilter() {
    var cards = flagsList.querySelectorAll('.flag');
    cards.forEach(function (card) {
      card.style.display =
        activeFilter === 'all' || card.getAttribute('data-sev') === activeFilter ? '' : 'none';
    });
    var btns = sevFilter.querySelectorAll('button');
    btns.forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-sev') === activeFilter);
    });
  }

  sevFilter.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-sev]');
    if (!btn) return;
    activeFilter = btn.getAttribute('data-sev');
    applyFilter();
  });

  /* ---------- full report ---------- */

  function renderResults(data) {
    lastResults = data;
    clearError();
    clearPendingUnlock();
    renderDial(data.score);
    summaryText.textContent = data.summary || '';
    modeBadge.textContent = data.unlocked ? 'Full report — unlocked' : 'Full report';
    modeNote.textContent = data.unlocked
      ? 'Paid unlock — every finding below, with copy-paste pushback emails.'
      : '';
    activeFilter = 'all';
    renderFlags(data.flags || []);
    sevFilter.style.display = '';
    unlockPanel.style.display = 'none';
    resultActions.style.display = '';
    moreScansPanel.style.display = '';
    // Follow-up Q&A: a fresh paid scan carries a chat token; the paid
    // unlock flow set one from the pending token just before this render.
    if (data.chatToken) setChatToken(data.chatToken, reportEmail);
    showChatPanel(chatToken ? 'paid' : null);
    resultsEl.classList.add('visible');
    resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    saveHistory(data);
  }

  /* ---------- free teaser ---------- */

  function countsLine(counts) {
    counts = counts || {};
    var h = Number(counts.high) || 0;
    var m = Number(counts.medium) || 0;
    var l = Number(counts.low) || 0;
    return h + ' high &middot; ' + m + ' medium &middot; ' + l + ' low';
  }

  function renderTeaser(data) {
    lastResults = null;
    clearError();
    renderDial(data.score);
    summaryText.textContent = data.summary || '';
    modeBadge.textContent = 'Free risk score';
    modeNote.textContent = data.demoMode
      ? 'Demo report — connect a live analysis key for real scans.'
      : 'This is your free risk score. Unlock the full report for the complete clause-by-clause breakdown.';
    activeFilter = 'all';
    sevFilter.style.display = 'none';

    var counts = data.severityCounts || {};
    var total = Number(data.totalFindings) || 0;
    var locked = total - (data.topFlag ? 1 : 0);

    var html =
      '<div class="teaser-counts">' +
        '<span class="teaser-counts-line">' + countsLine(counts) +
        (locked > 0
          ? ' <span class="teaser-locked">&middot; ' + locked + ' more finding' + (locked === 1 ? '' : 's') + ' locked</span>'
          : '') +
        '</span>' +
      '</div>';

    if (data.topFlag) {
      html += '<div class="flags">' + flagHtml(data.topFlag, 0) + '</div>';
      html += '<p class="locked-note">&#128274; The pushback email for this finding is locked — ' +
        'unlock the full report to get copy-paste emails for every major red flag.</p>';
    } else {
      html += '<p class="lede" style="margin-top:12px">No major red flags found in this contract.</p>';
    }

    flagsList.innerHTML = html;

    // Unlock CTA
    unlockPanel.innerHTML =
      '<h3>Unlock your full report — $5</h3>' +
      '<p class="lede">Get all ' + total + ' finding' + (total === 1 ? '' : 's') +
      ', every risky clause explained in plain English, and copy-paste pushback emails for every major red flag.</p>' +
      '<div class="unlock-row" style="margin-top:14px">' +
        '<button class="btn" data-pay="single">Unlock the full report — $5</button>' +
        '<button class="btn ghost pack-tier" data-pay="pack" style="display:none">5-scan pack — $20</button>' +
        '<button class="btn ghost" data-pay="subscription">Unlimited — $29/mo</button>' +
      '</div>' +
      '<p class="file-hint" style="margin-top:12px">Your unlock is ready now and stays valid for 24 hours. ' +
      'Paid scans are backed by our promise: if the report doesn&rsquo;t flag a single useful issue, the $5 comes back. No questions.</p>';
    refreshPackVisibility();
    unlockPanel.style.display = '';

    resultActions.style.display = 'none';
    moreScansPanel.style.display = 'none';
    // The teaser unlock token doubles as the Q&A context token: 2 free
    // follow-up questions about the free risk score.
    if (data.unlockToken) {
      setChatToken(data.unlockToken, reportEmail);
      showChatPanel('free');
    } else {
      hideChatPanel();
    }
    resultsEl.classList.add('visible');
    resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderAlreadyClaimed(data) {
    lastResults = null;
    clearError();
    flagsList.innerHTML = '';
    sevFilter.style.display = 'none';
    scoreDial.innerHTML = '';
    bandLabel.textContent = '';
    summaryText.textContent = '';
    modeBadge.textContent = 'Free risk score claimed';
    modeNote.textContent = data && data.message
      ? data.message
      : 'This email already claimed its free risk score.';
    unlockPanel.innerHTML =
      '<h3>Unlock your full report — $5</h3>' +
      '<p class="lede">Every risky clause explained in plain English, plus copy-paste pushback emails for every major red flag.</p>' +
      '<div class="unlock-row" style="margin-top:14px">' +
        '<button class="btn" data-pay="single">Unlock the full report — $5</button>' +
        '<button class="btn ghost pack-tier" data-pay="pack" style="display:none">5-scan pack — $20</button>' +
        '<button class="btn ghost" data-pay="subscription">Unlimited — $29/mo</button>' +
      '</div>' +
      '<p class="file-hint" style="margin-top:12px">Paid scans are backed by our promise: if the report doesn&rsquo;t flag a single useful issue, the $5 comes back. No questions.</p>';
    refreshPackVisibility();
    unlockPanel.style.display = '';
    resultActions.style.display = 'none';
    moreScansPanel.style.display = 'none';
    hideChatPanel(); // no fresh token here — Q&A needs a report
    resultsEl.classList.add('visible');
    resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- report actions ---------- */

  function reportText(data) {
    var lines = [];
    lines.push('FINEPRINT CONTRACT RISK REPORT');
    lines.push('Risk score: ' + data.score + '/100');
    lines.push('');
    lines.push('SUMMARY');
    lines.push(data.summary || '');
    lines.push('');
    (data.flags || []).forEach(function (f, i) {
      lines.push('---');
      lines.push('FINDING ' + (i + 1) + ' [' + String(f.severity || '').toUpperCase() + '] ' + (f.title || ''));
      lines.push('Clause: "' + (f.clause || '') + '"');
      lines.push('Why it matters: ' + (f.risk || ''));
      if (f.plainEnglish) lines.push('In plain English: ' + f.plainEnglish);
      if (f.negotiation) lines.push('What to negotiate: ' + f.negotiation);
      if (f.negotiationEmail && f.negotiationEmail.body) {
        lines.push('');
        lines.push('PUSHBACK EMAIL (copy-paste):');
        lines.push('Subject: ' + (f.negotiationEmail.subject || ''));
        lines.push(f.negotiationEmail.body);
      }
      if (f.legalReview) lines.push('Note: worth a quick lawyer review before signing.');
      lines.push('');
    });
    lines.push('Not legal advice. FinePrint is an informational tool, not a law firm.');
    return lines.join('\n');
  }

  document.getElementById('copyBtn').addEventListener('click', function () {
    if (!lastResults) return;
    navigator.clipboard.writeText(reportText(lastResults)).then(
      function () { showToast('Report copied to clipboard.'); },
      function () { showToast('Copy failed — select the text manually.'); }
    );
  });

  document.getElementById('downloadBtn').addEventListener('click', function () {
    if (!lastResults) return;
    var blob = new Blob([reportText(lastResults)], { type: 'text/markdown' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'fineprint-report.md';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  });

  document.getElementById('printBtn').addEventListener('click', function () {
    window.print();
  });

  document.getElementById('scanAnotherBtn').addEventListener('click', function () {
    resultsEl.classList.remove('visible');
    clearPendingUnlock();
    hideChatPanel();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  flagsList.addEventListener('click', function (e) {
    var btn = e.target.closest('.copy-email-btn');
    if (!btn || !lastResults) return;
    var idx = Number(btn.getAttribute('data-email-idx'));
    var f = (lastResults.flags || [])[idx];
    if (!f || !f.negotiationEmail) return;
    var txt = 'Subject: ' + (f.negotiationEmail.subject || '') + '\n\n' + (f.negotiationEmail.body || '');
    navigator.clipboard.writeText(txt).then(
      function () { showToast('Pushback email copied — paste it into your reply.'); },
      function () { showToast('Copy failed — select the text manually.'); }
    );
  });

  /* ---------- payments ---------- */

  function getPayEmail() {
    return (emailEl.value || '').trim().toLowerCase();
  }

  async function refreshPackVisibility() {
    try {
      var r = await fetch('/api/tiers');
      var d = await r.json();
      var show = !!(d && d.tiers && d.tiers.pack);
      document.querySelectorAll('.pack-tier').forEach(function (el) {
        el.style.display = show ? '' : 'none';
      });
    } catch (e) { /* leave as-is */ }
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-pay]');
    if (!btn) return;
    var mode = btn.getAttribute('data-pay');
    var email = getPayEmail();
    if (!isValidEmail(email)) {
      showError('Enter your email first — it is how we deliver your paid scans.');
      emailEl.focus();
      return;
    }
    btn.disabled = true;
    fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: mode, email: email })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        btn.disabled = false;
        if (x.ok && x.d.url) {
          // The pending unlock token stays in sessionStorage across the
          // Stripe redirect; /api/unlock redeems it on return.
          window.location.href = x.d.url;
        } else {
          showError((x.d && x.d.message) || 'Checkout is not available right now. Please try again.');
        }
      })
      .catch(function () {
        btn.disabled = false;
        showError('Could not reach checkout. Please try again.');
      });
  });

  /* ---------- scanning ---------- */

  function updateCount() {
    charCount.textContent = (textEl.value || '').length + ' characters';
  }
  textEl.addEventListener('input', updateCount);
  updateCount();

  sampleBtn.addEventListener('click', function () {
    fetch('/api/sample')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        textEl.value = d.text || '';
        updateCount();
        showToast('Sample contract loaded — hit "' + SCAN_BTN_LABEL + '".');
      })
      .catch(function () { showError('Could not load the sample contract.'); });
  });

  clearBtn.addEventListener('click', function () {
    textEl.value = '';
    fileInput.value = '';
    updateCount();
    resultsEl.classList.remove('visible');
    clearError();
    clearPendingUnlock();
    hideChatPanel();
  });

  fileInput.addEventListener('change', function () {
    var file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      showError('That file is over 4MB. Try a smaller file or paste the text.');
      fileInput.value = '';
      return;
    }
    clearError();
    var name = file.name || '';
    if (/\.pdf$/i.test(name)) {
      var reader = new FileReader();
      reader.onload = function () {
        parsePdf(new Uint8Array(reader.result)).then(function (txt) {
          if (txt && txt.trim().length > 50) {
            textEl.value = txt;
            updateCount();
            showToast('PDF text extracted — review it, then scan.');
          } else {
            showError('Could not pull text from that PDF (it may be scanned images). Paste the text instead.');
          }
        }).catch(function () {
          showError('Could not read that PDF. Paste the text instead.');
        });
      };
      reader.readAsArrayBuffer(file);
    } else if (/\.docx$/i.test(name)) {
      showError('DOCX files need a quick conversion — open the file, copy the text, and paste it above.');
      fileInput.value = '';
    } else {
      var tr = new FileReader();
      tr.onload = function () {
        textEl.value = String(tr.result || '');
        updateCount();
        showToast('File loaded — review the text, then scan.');
      };
      tr.readAsText(file);
    }
  });

  function parsePdf(data) {
    return new Promise(function (resolve, reject) {
      if (!window.pdfjsLib) return reject(new Error('pdf.js not loaded'));
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      window.pdfjsLib.getDocument({ data: data }).promise.then(function (pdf) {
        var pages = [];
        for (var i = 1; i <= pdf.numPages; i++) pages.push(i);
        var texts = [];
        (function next() {
          if (!pages.length) return resolve(texts.join('\n\n'));
          var n = pages.shift();
          pdf.getPage(n).then(function (page) {
            page.getTextContent().then(function (tc) {
              texts.push(tc.items.map(function (it) { return it.str; }).join(' '));
              next();
            }).catch(reject);
          }).catch(reject);
        })();
      }).catch(reject);
    });
  }

  scanBtn.addEventListener('click', function () {
    var text = (textEl.value || '').trim();
    var email = getPayEmail();
    if (!text) {
      showError('Paste your contract text or upload a file first.');
      textEl.focus();
      return;
    }
    if (!isValidEmail(email)) {
      showError('Enter your email to see your free risk score — it also verifies paid scans.');
      emailEl.focus();
      return;
    }
    clearError();
    runScan({ text: text, email: email });
  });

  function runScan(payload) {
    setLoading(true);
    reportEmail = (payload && payload.email) || '';
    var body = { email: payload.email };
    if (payload.text) body.text = payload.text;
    if (payload.fileBase64) {
      body.fileBase64 = payload.fileBase64;
      body.filename = payload.fileName;
    }
    fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) {
        return r.json().then(function (d) { return { status: r.status, d: d }; })
          .catch(function () { return { status: r.status, d: null }; });
      })
      .then(function (x) {
        setLoading(false);
        var d = x.d || {};
        if (x.status === 200 && d.teaser) {
          savePendingUnlock(d, payload);
          renderTeaser(d);
          return;
        }
        if (x.status === 200) {
          renderResults(d);
          return;
        }
        if (d.error === 'teaser_already_claimed') {
          renderAlreadyClaimed(d);
          return;
        }
        if (d.error === 'email_required') {
          showError(d.message || 'Enter your email to see your free risk score.');
          emailEl.focus();
          return;
        }
        if (x.status === 402) {
          showError('You are out of scans. Grab another below — $5, backed by our money-back promise.');
          renderAlreadyClaimed(d);
          return;
        }
        showError(d.message || 'Something went wrong. Please try again.');
      })
      .catch(function () {
        setLoading(false);
        showError('Could not reach the scanner. Check your connection and try again.');
      });
  }

  /* ---------- paid return: instant unlock ---------- */

  function fetchJson(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        return { status: r.status, ok: r.ok, d: d };
      });
    });
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function attemptUnlock(email, token) {
    var x = await fetchJson('/api/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, token: token })
    });
    return x;
  }

  async function autoUnlockAfterPayment(email) {
    var pending = loadPendingUnlock();
    spinner.classList.add('visible');
    try {
      if (pending && pending.token) {
        var unlockEmail = email || pending.email;
        reportEmail = unlockEmail;
        var x = await attemptUnlock(unlockEmail, pending.token);
        if (x.ok) {
          spinner.classList.remove('visible');
          // Keep the token as the Q&A context token before the pending
          // unlock entry is cleared.
          setChatToken(pending.token, unlockEmail);
          clearPendingUnlock();
          renderResults(Object.assign({}, x.d, { unlocked: true }));
          showToast('Full report unlocked — no re-scan needed.');
          return;
        }
        if (x.status === 402) {
          // The webhook may not have delivered the credit yet — retry a
          // couple of times before giving up.
          for (var i = 0; i < 2; i++) {
            await sleep(4000);
            var retry = await attemptUnlock(unlockEmail, pending.token);
            if (retry.ok) {
              spinner.classList.remove('visible');
              setChatToken(pending.token, unlockEmail);
              clearPendingUnlock();
              renderResults(Object.assign({}, retry.d, { unlocked: true }));
              showToast('Full report unlocked — no re-scan needed.');
              return;
            }
            if (retry.status !== 402) { x = retry; break; }
          }
          if (x.status === 402) {
            spinner.classList.remove('visible');
            paidNotice.textContent =
              'Payment confirmed — we are still confirming it with Stripe. Wait a few seconds, then hit "' + SCAN_BTN_LABEL + '" below; your credit will apply automatically.';
            paidNotice.style.display = 'block';
            return;
          }
        }
        // Token expired/invalid (or still failing): fall back to a fresh
        // paid scan if we still have the contract text.
        if (pending.text && unlockEmail) {
          spinner.classList.remove('visible');
          showToast('Unlock link stale — running your paid scan fresh instead.');
          runScan({ text: pending.text, email: unlockEmail });
          return;
        }
        spinner.classList.remove('visible');
        paidNotice.textContent =
          'Payment confirmed — paste your contract below and hit "' + SCAN_BTN_LABEL + '". Your credit is ready.';
        paidNotice.style.display = 'block';
        return;
      }
      spinner.classList.remove('visible');
      paidNotice.textContent =
        'Payment confirmed — paste your contract below and hit "' + SCAN_BTN_LABEL + '". Your credit is ready.';
      paidNotice.style.display = 'block';
    } catch (e) {
      spinner.classList.remove('visible');
      paidNotice.textContent =
        'Payment confirmed — paste your contract below and hit "' + SCAN_BTN_LABEL + '". Your credit is ready.';
      paidNotice.style.display = 'block';
    }
  }

  (function handlePaidReturn() {
    if (!paidNotice) return;
    var q = new URLSearchParams(window.location.search);
    var em = q.get('email') || '';
    var paid = q.get('paid') === '1';
    if (em && emailEl && !emailEl.value) emailEl.value = em;
    if (em || paid) {
      q.delete('paid');
      q.delete('email');
      var qs = q.toString();
      window.history.replaceState({}, '', window.location.pathname + (qs ? '?' + qs : ''));
    }
    refreshPackVisibility();
    if (paid) {
      autoUnlockAfterPayment(em);
    } else if (em) {
      showToast('Email saved — paste your contract below to see your free risk score.');
    }
  })();

  /* ---------- history ---------- */

  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem('fineprint_history') || '[]');
    } catch (e) { return []; }
  }

  function saveHistory(data) {
    try {
      var h = loadHistory();
      h.unshift({
        score: data.score,
        summary: (data.summary || '').slice(0, 140),
        at: Date.now()
      });
      localStorage.setItem('fineprint_history', JSON.stringify(h.slice(0, 10)));
      renderHistory();
    } catch (e) {}
  }

  function renderHistory() {
    if (!historyList) return;
    var h = loadHistory();
    historyPanel.style.display = h.length ? '' : 'none';
    historyList.innerHTML = h.map(function (item) {
      var d = new Date(item.at);
      var when = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return '<div class="history-item"><span class="h-score" style="color:' +
        scoreColor(item.score) + '">' + item.score + '</span>' +
        '<span class="h-meta"><span class="h-summary">' + esc(item.summary) + '</span><br>' +
        '<span class="h-date">' + esc(when) + '</span></span></div>';
    }).join('');
  }
  renderHistory();
})();
