/**
 * POST /api/waitlist — collect launch-waitlist emails.
 *
 * Body: { "email": "person@example.com" }
 *
 * MVP storage: appends to a JSONL file in the OS temp dir. This works for
 * local dev and demos, but serverless filesystems are EPHEMERAL — on Vercel
 * entries will not persist. Before launch, point this at a real email
 * provider (Buttondown, ConvertKit, or Mailchimp — see SETUP.md) and/or a
 * database, and replace the file write below.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const STORE = path.join(os.tmpdir(), 'fineprint-waitlist.jsonl');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'bad_email', message: 'Please enter a valid email address.' });
  }

  // TODO (launch): replace with your email provider / database API call.
  try {
    fs.appendFileSync(STORE, JSON.stringify({ email, ts: new Date().toISOString() }) + '\n');
  } catch (e) {
    console.error('waitlist write failed:', e);
    return res.status(500).json({ error: 'server_error' });
  }
  return res.status(200).json({ ok: true });
};
