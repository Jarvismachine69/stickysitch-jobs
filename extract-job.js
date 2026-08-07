// api/extract-job.js  (job board Vercel repo)
// Server-side Claude API proxy for job detail extraction from text or PDF/image.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Vercel environment variables' });
  }

  try {
    const { text, fileBase64, fileType, fileName } = req.body || {};

    if (!text && !fileBase64) {
      return res.status(400).json({ error: 'Provide text or a file' });
    }

    const PROMPT = `Extract print job details from the content provided.
Return ONLY a valid JSON object — no markdown, no explanation, just the JSON.
Use null for any field not found.

{
  "biz":       "business or customer name",
  "contact":   "contact person full name",
  "email":     "email address",
  "phone":     "phone number",
  "addr":      "full delivery address",
  "product":   "one of: rolls, sheets, individual, bumper",
  "qty":       500,
  "shape":     "e.g. Circle, Rectangle, Square, Custom",
  "width_mm":  90,
  "height_mm": 60,
  "material":  "e.g. White Vinyl, Gloss Paper, Clear Vinyl",
  "laminate":  "one of: None, Gloss, Matte, Soft Touch",
  "dispatch":  "one of: road, pickup",
  "notes":     "any special instructions or notes"
}`;

    const isPdf = (fileType || '').includes('pdf') || (fileName || '').toLowerCase().endsWith('.pdf');
    const isImg = /image\/(jpeg|png|gif|webp)/i.test(fileType || '');

    // Build content array
    const content = [];

    if (fileBase64 && isPdf) {
      // Try sending as document type (requires beta header)
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 },
      });
    } else if (fileBase64 && isImg) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: fileType, data: fileBase64 },
      });
    }

    // Always add the text prompt last
    const userText = text && text.trim() ? `Document text:\n${text.trim()}\n\n${PROMPT}` : PROMPT;
    content.push({ type: 'text', text: userText });

    // Build headers — include PDF beta only when sending a PDF document
    const headers = {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    };
    if (fileBase64 && isPdf) {
      headers['anthropic-beta'] = 'pdfs-2024-09-25';
    }

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers,
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 1000,
        messages:   [{ role: 'user', content }],
      }),
    });

    // If PDF document type fails, retry with text-only request
    if (!claudeResp.ok && fileBase64 && isPdf) {
      console.log('PDF document type failed, retrying as text-only...');
      const retryResp = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      'claude-sonnet-4-6',
          max_tokens: 1000,
          messages:   [{
            role: 'user',
            content: text
              ? `Extract job details from this text:\n${text}\n\n${PROMPT}`
              : `The user uploaded a PDF invoice but it could not be read. Please return null for all fields.\n\n${PROMPT}`,
          }],
        }),
      });

      if (!retryResp.ok) {
        const errText = await retryResp.text();
        console.error('Retry also failed:', errText);
        return res.status(502).json({ error: 'Claude API error: ' + retryResp.status, detail: errText.slice(0, 300) });
      }

      const retryData = await retryResp.json();
      const raw = retryData.content?.[0]?.text || '';
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return res.status(422).json({ error: 'No JSON in Claude response' });
      return res.json({ ok: true, extracted: JSON.parse(match[0]), source: 'text-fallback' });
    }

    if (!claudeResp.ok) {
      const errText = await claudeResp.text();
      console.error('Claude API error:', claudeResp.status, errText);
      return res.status(502).json({
        error: 'Claude API returned error ' + claudeResp.status,
        detail: errText.slice(0, 500),
      });
    }

    const data  = await claudeResp.json();
    const raw   = data.content?.[0]?.text || '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      return res.status(422).json({ error: 'Could not parse response', raw: raw.slice(0, 200) });
    }

    return res.json({ ok: true, extracted: JSON.parse(match[0]) });

  } catch (err) {
    console.error('extract-job error:', err);
    return res.status(500).json({ error: err.message });
  }
}
