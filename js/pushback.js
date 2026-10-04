/**
 * js/pushback.js — copy-to-clipboard for the free pushback email templates
 * on /pushback/ clause pages. Page guard: no-op where the copy button or
 * the email block is absent.
 *
 * Run: npm test (smoke-tested in test/test-frontend-smoke.js)
 */
'use strict';

(function () {
  var btn = document.getElementById('copyEmailBtn');
  var src = document.getElementById('pushbackEmail');
  if (!btn || !src) return;

  var msg = document.getElementById('copyEmailMsg');

  function emailText() {
    return src.innerText || src.textContent || '';
  }

  function done() {
    if (msg) {
      msg.textContent = 'Copied. Paste it into your email.';
      msg.className = 'form-msg ok';
    }
  }

  function failed() {
    if (msg) {
      msg.textContent = 'Copy did not work - select the text manually.';
      msg.className = 'form-msg err';
    }
  }

  function legacyCopy() {
    var ta = document.createElement('textarea');
    ta.value = emailText();
    // Keep it out of view without display:none (some browsers refuse to copy hidden inputs).
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    if (ok) done(); else failed();
  }

  btn.addEventListener('click', function () {
    var text = emailText();
    if (!text) { failed(); return; }
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, legacyCopy);
    } else {
      legacyCopy();
    }
  });
})();
