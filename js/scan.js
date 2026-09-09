/* FinePrint scanner frontend. Plain JS, no framework. */
(function () {
  'use strict';

  var textEl = document.getElementById('contractText');
  var fileEl = document.getElementById('fileInput');
  var emailEl = document.getElementById('emailInput');
  var scanBtn = document.getElementById('scanBtn');
  var sampleBtn = document.getElementById('sampleBtn');
  var clearBtn = document.getElementById('clearBtn');
  var charCount = document.getElementById('charCount');
  var errorBox = document.getElementById('errorBox');
  var spinner = document.getElementById('spinner');
  var resultsEl = document.getElementById('results');
  var inputPanel = document.getElementById('inputPanel');
  var paidNotice = document.getElementById('paidNotice');

  var lastResult = null;
  var lastPayload = null; // last scan request, reused by the gated "unlock" flow
  var sevFilter = 'all';

  /* ---- Client-side PDF text extraction (pdf.js via CDN) ----
     Contracts live in PDFs. Parse in the browser so the text lands
     straight in the textarea. If pdf.js fails or isn't loaded, the
     scan flow falls back to the server-side file upload below. */
  var PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';

  function extractPdfText(file) {
    return new Promise(function (resolve, reject) {
      if (!window.pdfjsLib) return reject(new Error('pdf.js not available'));
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_CDN + 'pdf.worker.min.js';
      var reader = new FileReader();
      reader.onload = function () {
        var bytes = new Uint8Array(reader.result);
        window.pdfjsLib.getDocument({ data: bytes }).promise.then(function (pdf) {
          var jobs = [];
          for (var i = 1; i <= pdf.numPages; i++) {
            jobs.push(pdf.getPage(i).then(function (page) {
              return page.getTextContent().then(function (tc) {
                return tc.items.map(function (it) { return it.str; }).join(' ');
              });
            }));
          }
          return Promise.all(jobs);
        }).then(function (texts) {
          resolve(texts.join('\n\n'));
        }).catch(reject);
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }

  /* Embedded fallback sample contract (used if /api/sample is unreachable).
     Short on purpose, with several deliberately risky clauses. */
  var FALLBACK_SAMPLE_CONTRACT =
'FREELANCE SERVICES AGREEMENT\n' +
'\n' +
'This Freelance Services Agreement ("Agreement") is entered into on September 9, 2026, by and between Acme Marketing Inc. ("Client") and the undersigned freelancer ("Contractor").\n' +
'\n' +
'1. SERVICES. Contractor will provide website design and copywriting services as described in the attached project brief (the "Work").\n' +
'\n' +
'2. PAYMENT. Client will pay Contractor $4,000 upon final delivery of the Work. Payment is due within 60 days of invoicing. Late payments accrue no interest or penalty.\n' +
'\n' +
'3. INTELLECTUAL PROPERTY. All Work, including all drafts, concepts, sketches, and preliminary materials created at any time, whether or not delivered to Client, shall be the exclusive property of Client. Contractor assigns all rights, title, and interest in the Work to Client, including any pre-existing materials incorporated into the Work.\n' +
'\n' +
'4. NON-COMPETE. For a period of 24 months after this Agreement ends, Contractor shall not provide design or marketing services to any business that competes with Client, anywhere in the United States.\n' +
'\n' +
'5. INDEMNIFICATION. Contractor shall indemnify, defend, and hold harmless Client from any and all claims, damages, losses, and expenses, including attorney\'s fees, arising from Contractor\'s performance under this Agreement, with no cap or limitation.\n' +
'\n' +
'6. LIMITATION OF LIABILITY. Client\'s total liability under this Agreement shall not exceed the fees paid. (Contractor\'s liability is not similarly limited.)\n' +
'\n' +
'7. TERMINATION. Client may terminate this Agreement at any time, for any reason, upon written notice. Contractor may not terminate except for Client\'s material breach uncured within 60 days. Upon termination by Client, Contractor is entitled to no further payment, including for Work already completed but not yet invoiced.\n' +
'\n' +
'8. GOVERNING LAW. This Agreement is governed by the laws of the State of Delaware. Any disputes shall be resolved exclusively in the courts of Wilmington, Delaware.\n';

  /* ---- Returning from Stripe checkout (?paid=1&email=...) or the
     homepage free-scan box (?email=...) ---- */
  (function handlePaidReturn() {
    if (!paidNotice) return;
    var q = new URLSearchParams(window.location.search);
    var em = q.get('email') || '';
    if (emailEl && em) emailEl.value = em;
    if (q.get('paid') === '1') {
      paidNotice.style.display = 'block';
    } else if (em) {
      showToast('Email saved — paste your contract below. Your first full report is free.');
    }
    if (em || q.get('paid') === '1') {
      // Clean the URL so a refresh doesn't re-trigger the notice.
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, '', window.location.pathname);
      }
    }
  })();

  function showError(msg) {
    if (!errorBox) { showToast(msg); return; }
    errorBox.textContent = msg;
    errorBox.style.display = 'block';
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function showHtmlError(html) {
    if (!errorBox) return;
    errorBox.innerHTML = html;
    errorBox.style.display = 'block';
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function hideError() { if (errorBox) errorBox.style.display = 'none'; }

  function setLoading(on) {
    scanBtn.disabled = on;
    scanBtn.textContent = on ? 'Scanning…' : 'Scan contract';
    spinner.style.display = on ? 'block' : 'none';
  }

  /* Scan-form wiring only exists on scan.html — index.html shares this file
     for the pay buttons, so guard everything scan-specific. */
  var isScanPage = !!textEl;

  if (isScanPage) {
  textEl.addEventListener('input', function () {
    charCount.textContent = textEl.value.length.toLocaleString() + ' characters';
  });

  sampleBtn.addEventListener('click', async function () {
    hideError();
    sampleBtn.disabled = true;
    try {
      var r = await fetch('/api/sample');
      var d = await r.json();
      textEl.value = (d && d.text) || FALLBACK_SAMPLE_CONTRACT;
    } catch (e) {
      // Works even if the API is unreachable — the demo never blocks on it.
      textEl.value = FALLBACK_SAMPLE_CONTRACT;
    }
    textEl.dispatchEvent(new Event('input'));
    sampleBtn.disabled = false;
  });

  clearBtn.addEventListener('click', function () {
    textEl.value = '';
    fileEl.value = '';
    if (emailEl) emailEl.value = '';
    textEl.dispatchEvent(new Event('input'));
    resultsEl.style.display = 'none';
    inputPanel.style.display = 'block';
    hideError();
  });
  }

  function readFileAsBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var dataUrl = String(reader.result || '');
        resolve(dataUrl.split(',')[1] || '');
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /* Run a scan against /api/scan. Shared by the Scan button and the
     gated-report "unlock" flow below. */
  async function runScan(payload) {
    setLoading(true);
    try {
      var resp = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok) {
        if (resp.status === 402) {
          showHtmlError(
            'You&rsquo;re out of scans. <a href="/#pricing">Buy another scan for $5 or go unlimited for $29/mo</a>.'
          );
        } else {
          showError(data.message || 'Something went wrong. Please try again.');
        }
        return;
      }
      if (data.freeScan) {
        showToast('Your first scan is on us — no card, no catch.');
      }
      lastPayload = payload;
      renderResults(data);
    } catch (e) {
      showError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  if (isScanPage) {
  scanBtn.addEventListener('click', async function () {
    hideError();
    var payload;
    var file = fileEl.files && fileEl.files[0];

    var payload = {};
    if (emailEl && emailEl.value.trim()) payload.email = emailEl.value.trim();

    if (file) {
      if (file.size > 4 * 1024 * 1024) {
        showError('That file is over 4MB. Please use a smaller file or paste the text.');
        return;
      }
      var isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
      if (isPdf && window.pdfjsLib) {
        // Parse the PDF in the browser — instant, no upload needed.
        try {
          var pdfText = await extractPdfText(file);
          if (pdfText && pdfText.trim().length >= 50) {
            payload.text = pdfText;
          }
          // else: fall through to the server-side upload path below
        } catch (e) { /* fall through to server upload */ }
      }
      if (!payload.text) {
        try {
          var b64 = await readFileAsBase64(file);
          payload.fileBase64 = b64;
          payload.filename = file.name;
        } catch (e) {
          showError('Could not read that file. Try copy-pasting the text instead.');
          return;
        }
      }
    } else if (textEl.value.trim().length >= 50) {
      payload.text = textEl.value;
    } else {
      showError('Paste your contract text (or upload a PDF/DOCX) before scanning.');
      return;
    }

    runScan(payload);
  });
  } // end isScanPage: scan button

  function bandFor(score) {
    if (score >= 51) return { label: 'High risk', cls: 'high' };
    if (score >= 26) return { label: 'Medium risk', cls: 'medium' };
    return { label: 'Low risk', cls: 'low' };
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* Negotiation email drafts, parallel to the rendered flag list —
     rebuilt every time flags render (the severity filter re-renders). */
  var negEmails = [];

  function negEmailHtml(f, emailIdx) {
    if (!f || String(f.risk).toLowerCase() !== 'high' || !f.negotiationEmail) return '';
    return (
      '<div class="neg-email">' +
        '<div class="neg-email-head">' +
          '<span class="lbl">Pushback email &mdash; copy, tweak, send</span>' +
          '<button type="button" class="btn small ghost copy-email-btn" data-email-idx="' + emailIdx + '">Copy email</button>' +
        '</div>' +
        '<pre class="neg-email-text">' + esc(f.negotiationEmail) + '</pre>' +
      '</div>'
    );
  }

  function flagHtml(f, emailIdx) {
    return (
      '<article class="flag">' +
        '<div class="flag-head"><h3>' + esc(f.title) + '</h3>' +
        '<span class="risk ' + esc(f.risk) + '">' + esc(f.risk) + ' risk</span></div>' +
        '<div class="clause">&ldquo;' + esc(f.clause) + '&rdquo;</div>' +
        '<p><span class="lbl">Why it matters &mdash; </span>' + esc(f.explanation) + '</p>' +
        '<p><span class="lbl">What to do &mdash; </span>' + esc(f.suggestion) + '</p>' +
        negEmailHtml(f, emailIdx) +
        lawyerNudgeHtml(f) +
      '</article>'
    );
  }

  /* The FAQ promises it: high-severity findings nudge toward a lawyer. */
  function lawyerNudgeHtml(f) {
    if (!f || String(f.risk).toLowerCase() !== 'high') return '';
    return '<p class="lawyer-nudge">High stakes? Run this clause by a lawyer before you sign.</p>';
  }

  function renderFlags(flags, filter) {
    negEmails = [];
    var list = (flags || []).filter(function (f) {
      return filter === 'all' || String(f.risk).toLowerCase() === filter;
    });
    var html = list.map(function (f) {
      var idx = -1;
      if (String(f.risk).toLowerCase() === 'high' && f.negotiationEmail) {
        idx = negEmails.length;
        negEmails.push(f.negotiationEmail);
      }
      return flagHtml(f, idx);
    }).join('');
    if (!html) {
      html = filter === 'all'
        ? '<p>No major red flags found. Standard terms throughout &mdash; but always read the full agreement yourself.</p>'
        : '<p>No ' + esc(filter) + '-risk findings in this report. Try another severity.</p>';
    }
    document.getElementById('flagsList').innerHTML = html;
  }

  function resetSevFilter() {
    sevFilter = 'all';
    var btns = document.querySelectorAll('#sevFilter button');
    btns.forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-sev') === 'all');
    });
  }

  function renderResults(data, opts) {
    opts = opts || {};
    lastResult = data;
    resetSevFilter();

    if (data.gated) {
      renderGatedResults(data);
      return;
    }

    var band = bandFor(data.score);
    var circ = 2 * Math.PI * 56;
    var frac = Math.max(0, Math.min(100, data.score)) / 100;
    var color = band.cls === 'high' ? 'var(--high)' : band.cls === 'medium' ? 'var(--med)' : 'var(--low)';

    var flagsHtml = null; // rendered via renderFlags() below

    if (opts.viewedDate) {
      document.getElementById('modeBadge').textContent = 'Past scan';
      document.getElementById('modeBadge').className = 'mode-badge';
      document.getElementById('modeNote').textContent =
        'Saved on this device on ' + new Date(opts.viewedDate).toLocaleString() +
        '. This is the report as originally generated — scan again for a fresh analysis.';
    } else {
      document.getElementById('modeBadge').textContent = data.demoMode ? 'Demo report' : 'AI report';
      document.getElementById('modeBadge').className = 'mode-badge' + (data.demoMode ? '' : ' live');
      document.getElementById('modeNote').textContent = data.demoMode
        ? 'Demo mode is on: this is a sample report so you can try the full flow. Connect an LLM key for live scans.'
        : 'Generated from the contract text you provided.';
    }

    document.getElementById('scoreDial').innerHTML =
      '<svg width="132" height="132" viewBox="0 0 132 132">' +
        '<circle cx="66" cy="66" r="56" fill="none" stroke="var(--line)" stroke-width="12"/>' +
        '<circle cx="66" cy="66" r="56" fill="none" stroke="' + color + '" stroke-width="12" ' +
          'stroke-linecap="round" stroke-dasharray="' + circ.toFixed(1) + '" ' +
          'stroke-dashoffset="' + (circ * (1 - frac)).toFixed(1) + '"/>' +
      '</svg>' +
      '<div class="score-num"><strong>' + data.score + '</strong><span>/ 100</span></div>';

    document.getElementById('bandLabel').textContent = band.label;
    document.getElementById('bandLabel').className = 'band ' + band.cls;
    document.getElementById('summaryText').textContent = data.summary || '';
    renderFlags(data.flags, 'all');

    if (opts.saveToHistory !== false) saveScanToHistory(data);

    // Full report: hide the gated unlock panel, show the action rows.
    document.getElementById('unlockPanel').style.display = 'none';
    document.getElementById('resultActions').style.display = '';
    document.getElementById('moreScansPanel').style.display = '';

    inputPanel.style.display = 'none';
    resultsEl.style.display = 'block';
    resultsEl.scrollIntoView({ behavior: 'smooth' });
  }

  /* ---- Gated free preview: score + summary + top flag, with an unlock CTA.
     gateReason "no_email"  -> email input; the first full report is free.
     gateReason "free_used" -> that email already claimed its free scan; pay CTA. */
  function renderGatedResults(data) {
    var band = bandFor(data.score);
    var circ = 2 * Math.PI * 56;
    var frac = Math.max(0, Math.min(100, data.score)) / 100;
    var color = band.cls === 'high' ? 'var(--high)' : band.cls === 'medium' ? 'var(--med)' : 'var(--low)';

    document.getElementById('modeBadge').textContent = 'Free preview';
    document.getElementById('modeBadge').className = 'mode-badge';
    document.getElementById('modeNote').textContent =
      'This is a free preview — your risk score and the single biggest red flag. ' +
      'Unlock the clause-by-clause breakdown below.';
    document.getElementById('scoreDial').innerHTML =
      '<svg width="132" height="132" viewBox="0 0 132 132">' +
        '<circle cx="66" cy="66" r="56" fill="none" stroke="var(--line)" stroke-width="12"/>' +
        '<circle cx="66" cy="66" r="56" fill="none" stroke="' + color + '" stroke-width="12" ' +
          'stroke-linecap="round" stroke-dasharray="' + circ.toFixed(1) + '" ' +
          'stroke-dashoffset="' + (circ * (1 - frac)).toFixed(1) + '"/>' +
      '</svg>' +
      '<div class="score-num"><strong>' + data.score + '</strong><span>/ 100</span></div>';
    document.getElementById('bandLabel').textContent = band.label;
    document.getElementById('bandLabel').className = 'band ' + band.cls;
    document.getElementById('summaryText').textContent = data.summary || '';
    renderFlags(data.flags, 'all');

    var panel = document.getElementById('unlockPanel');
    var remaining = Number(data.gatedCount) || 0;
    if (data.gateReason === 'free_used') {
      panel.innerHTML =
        '<h3 style="margin-top:0">You&rsquo;ve used your free scan</h3>' +
        '<p class="lede">This email already claimed its free full report. ' +
        'Get the complete breakdown' + (remaining ? ' — including the other ' + remaining + ' finding' + (remaining === 1 ? '' : 's') : '') +
        ' and copy-paste negotiation emails for every major red flag:</p>' +
        '<div class="scan-actions" style="margin-top:0">' +
          '<button class="btn" data-pay="single">Scan my contract — $5</button>' +
          '<button class="btn ghost pack-tier" data-pay="pack"' + (packTierOn ? '' : ' style="display:none"') + '>5-scan pack — $20</button>' +
          '<button class="btn ghost" data-pay="subscription">Unlimited — $29/mo</button>' +
        '</div>' +
        '<p class="file-hint" style="margin-bottom:0">First paid scan: if the report doesn&rsquo;t flag a single useful issue, the $5 comes back. No questions.</p>';
    } else {
      panel.innerHTML =
        '<h3 style="margin-top:0">Unlock your full report</h3>' +
        '<p class="lede">Your first full report is <strong>free</strong> — no card required. ' +
        'Enter your email to unlock the clause-by-clause breakdown' +
        (remaining ? ' (' + remaining + ' more finding' + (remaining === 1 ? '' : 's') + ')' : '') +
        ', including copy-paste pushback emails for every major red flag.</p>' +
        '<div class="unlock-row">' +
          '<input type="email" id="unlockEmail" class="email-input" placeholder="you@example.com" autocomplete="email" aria-label="Email to unlock the full report">' +
          '<button class="btn" id="unlockBtn" type="button">Unlock my full report</button>' +
        '</div>' +
        '<p class="file-hint" style="margin-bottom:0">One free full report per email. We never share or sell your address.</p>';
      panel.querySelector('#unlockBtn').addEventListener('click', async function () {
        var emEl = document.getElementById('unlockEmail');
        var em = (emEl.value || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) {
          showToast('Enter a valid email address to unlock the report.');
          emEl.focus();
          return;
        }
        if (emailEl) emailEl.value = em;
        var payload = {};
        for (var k in lastPayload) payload[k] = lastPayload[k];
        payload.email = em;
        await runScan(payload);
      });
    }
    panel.style.display = 'block';

    // Gated view: hide the export buttons and the upsell panel (the unlock
    // panel is the CTA here).
    document.getElementById('resultActions').style.display = 'none';
    document.getElementById('moreScansPanel').style.display = 'none';

    inputPanel.style.display = 'none';
    resultsEl.style.display = 'block';
    resultsEl.scrollIntoView({ behavior: 'smooth' });
  }

  /* ---- Scan history in localStorage (this device only) ---- */
  var HISTORY_KEY = 'fineprint_history_v1';
  var HISTORY_MAX = 20;

  function getHistory() {
    try {
      var h = JSON.parse(localStorage.getItem(HISTORY_KEY));
      return Array.isArray(h) ? h : [];
    } catch (e) { return []; }
  }

  function saveScanToHistory(data) {
    try {
      var h = getHistory();
      h.unshift({
        ts: Date.now(),
        score: data.score,
        summary: data.summary || '',
        flags: data.flags || [],
        demoMode: !!data.demoMode,
      });
      while (h.length > HISTORY_MAX) h.pop();
      localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
    } catch (e) { /* storage unavailable — history just won't persist */ }
    renderHistory();
  }

  function renderHistory() {
    var list = document.getElementById('historyList');
    if (!list) return;
    var h = getHistory();
    if (!h.length) {
      list.innerHTML = '<p class="h-empty">No scans yet. Reports you generate will be saved here, on this device only.</p>';
      return;
    }
    list.innerHTML = h.map(function (item, i) {
      var band = bandFor(item.score);
      var bg = band.cls === 'high' ? 'var(--high-bg)' : band.cls === 'medium' ? 'var(--med-bg)' : 'var(--low-bg)';
      var fg = band.cls === 'high' ? 'var(--high)' : band.cls === 'medium' ? 'var(--med)' : 'var(--low)';
      return '<button type="button" class="history-item" data-hidx="' + i + '">' +
        '<span class="h-score" style="background:' + bg + ';color:' + fg + '">' + esc(item.score) + '</span>' +
        '<span class="h-meta"><span class="h-summary">' + esc(item.summary || 'Contract scan') + '</span>' +
        '<br><span class="h-date">' + esc(new Date(item.ts).toLocaleString()) + ' &middot; ' + esc(band.label) + '</span></span>' +
      '</button>';
    }).join('');
    list.querySelectorAll('.history-item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var item = getHistory()[Number(btn.getAttribute('data-hidx'))];
        if (item) renderResults(item, { saveToHistory: false, viewedDate: item.ts });
      });
    });
  }

  if (isScanPage) {
  document.getElementById('scanAnotherBtn').addEventListener('click', function () {    resultsEl.style.display = 'none';
    inputPanel.style.display = 'block';
    textEl.value = '';
    fileEl.value = '';
    if (emailEl) emailEl.value = '';
    textEl.dispatchEvent(new Event('input'));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  /* Copy buttons on individual negotiation-email templates (delegated —
     the flag list re-renders when the severity filter changes). */
  document.getElementById('flagsList').addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.copy-email-btn') : null;
    if (!btn) return;
    var text = negEmails[Number(btn.getAttribute('data-email-idx'))];
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      function () { showToast('Pushback email copied — paste it, tweak the [brackets], send.'); },
      function () { showError('Could not copy to clipboard in this browser.'); }
    );
  });

  document.getElementById('copyBtn').addEventListener('click', function () {
    if (!lastResult) return;
    var lines = [
      'FINEPRINT CONTRACT RISK REPORT',
      'Risk score: ' + lastResult.score + '/100',
      '',
      lastResult.summary,
      '',
    ];
    (lastResult.flags || []).forEach(function (f, i) {
      lines.push((i + 1) + '. ' + f.title + ' [' + f.risk.toUpperCase() + ' RISK]');
      lines.push('   Clause: "' + f.clause + '"');
      lines.push('   Why it matters: ' + f.explanation);
      lines.push('   What to do: ' + f.suggestion);
      if (String(f.risk).toLowerCase() === 'high' && f.negotiationEmail) {
        lines.push('   Pushback email (copy, tweak, send):');
        f.negotiationEmail.split('\n').forEach(function (ln) { lines.push('   ' + ln); });
      }
      lines.push('');
    });
    lines.push('Disclaimer: FinePrint is not a law firm and this is not legal advice. Consult a licensed attorney for legal guidance.');
    navigator.clipboard.writeText(lines.join('\n')).then(
      function () { showToast('Report copied to clipboard.'); },
      function () { showError('Could not copy to clipboard in this browser.'); }
    );
  });

  document.getElementById('downloadBtn').addEventListener('click', function () {
    if (!lastResult) return;
    var md = ['# FinePrint Contract Risk Report', '', '**Risk score: ' + lastResult.score + '/100**', '', lastResult.summary, ''];
    (lastResult.flags || []).forEach(function (f, i) {
      md.push('## ' + (i + 1) + '. ' + f.title + ' (' + f.risk + ' risk)', '');
      md.push('> ' + f.clause, '');
      md.push('**Why it matters:** ' + f.explanation, '');
      md.push('**What to do:** ' + f.suggestion, '');
      if (String(f.risk).toLowerCase() === 'high' && f.negotiationEmail) {
        md.push('**Pushback email** (copy, tweak, send):', '');
        md.push('```', f.negotiationEmail, '```', '');
      }
    });
    md.push('---', '*FinePrint is not a law firm and this is not legal advice. Consult a licensed attorney.*');
    var blob = new Blob([md.join('\n')], { type: 'text/markdown' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'fineprint-report.md';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  });
  // Severity filter + print + history list (scan page only)
  document.querySelectorAll('#sevFilter button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (!lastResult) return;
      sevFilter = btn.getAttribute('data-sev');
      document.querySelectorAll('#sevFilter button').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      renderFlags(lastResult.flags, sevFilter);
    });
  });

  document.getElementById('printBtn').addEventListener('click', function () {
    window.print();
  });

  renderHistory();
  } // end isScanPage: results buttons

  function showToast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
      'background:var(--ink);color:#fff;padding:12px 20px;border-radius:12px;font-size:.95rem;' +
      'z-index:50;max-width:90vw;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.2);';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }

  /* ---- Pay buttons: create a Stripe Checkout session, then redirect.
     Delegated on document so buttons rendered later (e.g. the gated
     unlock panel) work too. ---- */
  function getPayEmail() {
    var el = document.getElementById('emailInput');
    if (el && el.value.trim()) return el.value.trim();
    var typed = window.prompt('Enter your email for the receipt and scan credits:');
    return (typed || '').trim();
  }

  async function startCheckout(btn) {
    var mode = btn.getAttribute('data-pay');
    var email = getPayEmail();
    if (!email) {
      showToast('Enter your email so we can deliver your scan credits.');
      return;
    }
    btn.disabled = true;
    try {
      var resp = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: mode, email: email }),
      });
      var data = await resp.json().catch(function () { return {}; });
      if (data.url) {
        window.location.href = data.url;
      } else if (resp.status === 501) {
        showToast(data.message || 'Payments are not set up yet — scans are free during the beta.');
      } else {
        showToast(data.message || 'Could not start checkout. Please try again.');
      }
    } catch (e) {
      showToast('Could not reach the server. Check your connection and try again.');
    }
    btn.disabled = false;
  }

  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-pay]') : null;
    if (!btn || btn.disabled) return;
    startCheckout(btn);
  });

  /* ---- Pricing tiers: the $20 / 5-scan pack only exists when the owner
     has created the Stripe price (STRIPE_PRICE_PACK). Hide its buttons
     otherwise. Exposed as packTierOn for the gated unlock panel. ---- */
  var packTierOn = false;
  fetch('/api/tiers')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      packTierOn = !!(d && d.tiers && d.tiers.pack);
      if (packTierOn) {
        document.querySelectorAll('.pack-tier').forEach(function (el) { el.style.display = ''; });
        document.querySelectorAll('.pricing').forEach(function (el) { el.classList.add('three'); });
      }
    })
    .catch(function () { /* tiers endpoint unreachable — pack stays hidden */ });
})();
