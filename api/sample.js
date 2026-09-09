/**
 * GET /api/sample — return the demo contract text so the UI's
 * "Try the sample contract" button can fill the textarea.
 */
'use strict';

const { SAMPLE_CONTRACT } = require('../lib/analysis');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  return res.status(200).json({ text: SAMPLE_CONTRACT });
};
