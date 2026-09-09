/**
 * POST /api/scan — analyze a contract and return a risk report.
 *
 * Body (JSON):
 *   { "text": "<pasted contract text>" }
 *   or
 *   { "fileBase64": "<base64 file bytes>", "filename": "agreement.pdf" }
 *     (.pdf, .docx, .txt — max ~4MB)
 *
 * Response (JSON):
 *   { "demoMode": true|false, "score": 0-100, "summary": "...",
 *     "flags": [{ "title", "clause", "risk", "explanation", "suggestion" }] }
 *
 * Demo mode: when no LLM_API_KEY env var is set, returns a realistic canned
 * analysis so the full UI flow works without any key or spend.
 */
'use strict';

const { analyzeContract, extractText } = require('../lib/analysis');

const MAX_TEXT_CHARS = 100000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  try {
    const body = req.body || {};
    let text = '';

    if (typeof body.text === 'string' && body.text.trim()) {
      text = body.text;
    } else if (body.fileBase64 && body.filename) {
      const buffer = Buffer.from(String(body.fileBase64), 'base64');
      if (buffer.length > MAX_FILE_BYTES) {
        return res.status(413).json({ error: 'file_too_large', message: 'File must be under 4MB.' });
      }
      try {
        text = await extractText(buffer, String(body.filename));
      } catch (e) {
        if (e && e.code === 'unsupported_file') {
          return res.status(400).json({ error: 'unsupported_file', message: 'Please upload a PDF, DOCX, or TXT file.' });
        }
        return res.status(422).json({ error: 'could_not_parse_file', message: 'We could not read that file. Try copy-pasting the text instead.' });
      }
    } else {
      return res.status(400).json({ error: 'no_input', message: 'Paste contract text or upload a file.' });
    }

    text = text.trim();
    if (text.length < 50) {
      return res.status(400).json({ error: 'text_too_short', message: 'Please provide more contract text (at least a few sentences).' });
    }
    if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);

    const result = await analyzeContract(text);
    return res.status(200).json(result);
  } catch (err) {
    if (err && err.message === 'llm_error') {
      return res.status(502).json({ error: 'analysis_failed', message: 'The analysis service is unavailable right now. Please try again.' });
    }
    if (err && err.message === 'bad_response') {
      return res.status(502).json({ error: 'analysis_failed', message: 'The analysis came back unreadable. Please try again.' });
    }
    console.error('scan error:', err);
    return res.status(500).json({ error: 'server_error', message: 'Something went wrong. Please try again.' });
  }
};
