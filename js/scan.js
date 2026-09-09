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

  /* ---- Returning from Stripe checkout (?paid=1&email=...) ---- */
  (function handlePaidReturn() {
    if (!paidNotice) return;
    var q = new URLSearchParams(window.location.search);
    if (q.get('paid') === '1') {
      var em = q.get('email') || '';
      if (emailEl && em) emailEl.value = em;
      paidNotice.style.display = 'block';
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
      textEl.value = d.text || '';
      textEl.dispatchEvent(new Event('input'));
    } catch (e) {
      showError('Could not load the sample contract. Please try again.');
    }
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
      try {
        var b64 = await readFileAsBase64(file);
        payload.fileBase64 = b64;
        payload.filename = file.name;
      } catch (e) {
        showError('Could not read that file. Try copy-pasting the text instead.');
        return;
      }
    } else if (textEl.value.trim().length >= 50) {
      payload.text = textEl.value;
    } else {
      showError('Paste your contract text (or upload a PDF/DOCX) before scanning.');
      return;
    }

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
      renderResults(data);
    } catch (e) {
      showError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
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

  function renderResults(data) {
    lastResult = data;
    var band = bandFor(data.score);
    var circ = 2 * Math.PI * 56;
    var frac = Math.max(0, Math.min(100, data.score)) / 100;
    var color = band.cls === 'high' ? 'var(--high)' : band.cls === 'medium' ? 'var(--med)' : 'var(--low)';

    var flagsHtml = (data.flags || []).map(function (f) {
      return (
        '<article class="flag">' +
          '<div class="flag-head"><h3>' + esc(f.title) + '</h3>' +
          '<span class="risk ' + esc(f.risk) + '">' + esc(f.risk) + ' risk</span></div>' +
          '<div class="clause">&ldquo;' + esc(f.clause) + '&rdquo;</div>' +
          '<p><span class="lbl">Why it matters &mdash; </span>' + esc(f.explanation) + '</p>' +
          '<p><span class="lbl">What to do &mdash; </span>' + esc(f.suggestion) + '</p>' +
        '</article>'
      );
    }).join('');

    if (!flagsHtml) {
      flagsHtml = '<p>No major red flags found. Standard terms throughout &mdash; but always read the full agreement yourself.</p>';
    }

    document.getElementById('modeBadge').textContent = data.demoMode ? 'Demo report' : 'AI report';
    document.getElementById('modeBadge').className = 'mode-badge' + (data.demoMode ? '' : ' live');
    document.getElementById('modeNote').textContent = data.demoMode
      ? 'Demo mode is on: this is a sample report so you can try the full flow. Connect an LLM key for live scans.'
      : 'Generated from the contract text you provided.';

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
    document.getElementById('flagsList').innerHTML = flagsHtml;

    inputPanel.style.display = 'none';
    resultsEl.style.display = 'block';
    resultsEl.scrollIntoView({ behavior: 'smooth' });
  }

  if (isScanPage) {
  document.getElementById('scanAnotherBtn').addEventListener('click', function () {
    resultsEl.style.display = 'none';
    inputPanel.style.display = 'block';
    textEl.value = '';
    fileEl.value = '';
    if (emailEl) emailEl.value = '';
    textEl.dispatchEvent(new Event('input'));
    window.scrollTo({ top: 0, behavior: 'smooth' });
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

  /* ---- Pay buttons: create a Stripe Checkout session, then redirect ---- */
  function getPayEmail() {
    var el = document.getElementById('emailInput') || document.getElementById('pricingEmail');
    if (el && el.value.trim()) return el.value.trim();
    var typed = window.prompt('Enter your email for the receipt and scan credits:');
    return (typed || '').trim();
  }

  document.querySelectorAll('[data-pay]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
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
    });
  });
})();
