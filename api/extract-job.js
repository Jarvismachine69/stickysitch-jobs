// api/extract-job.js  (job board Vercel repo)
// Proxies the Claude API call server-side so the API key stays secure.
// Called by the + New Job modal when extracting details from pasted text or PDF.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const { text, fileBase64, fileType, fileName } = req.body || {};

    if (!text && !fileBase64) {
      return res.status(400).json({ error: 'Provide text or a file' });
    }

    const PROMPT = `Extract print job details from the content below.
Return ONLY a valid JSON object with exactly these fields (use null for anything not found):
{
  "biz":       "business or customer name",
  "contact":   "contact person name",
  "email":     "email address",
  "phone":     "phone number",
  "addr":      "delivery address",
  "product":   "rolls OR sheets OR individual OR bumper",
  "qty":       123,
  "shape":     "shape name e.g. Circle, Rectangle, Custom",
  "width_mm":  90,
  "height_mm": 60,
  "material":  "e.g. White Vinyl, Gloss Paper",
  "laminate":  "None OR Gloss OR Matte OR Soft Touch",
  "dispatch":  "road OR pickup",
  "notes":     "any special instructions"
}
No extra text, no markdown fences — just the JSON object.`;

    // Build message content
    const content = [];

    if (fileBase64) {
      const isPdf = (fileType || '').includes('pdf') || (fileName || '').toLowerCase().endsWith('.pdf');
      const isImg = /image\/(jpeg|png|gif|webp)/i.test(fileType || '');

      if (isPdf) {
        content.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 },
        });
      } else if (isImg) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: fileType, data: fileBase64 },
        });
      }
    }

    if (text && text.trim()) {
      content.push({ type: 'text', text: `Content:\n${text.trim()}\n\n${PROMPT}` });
    } else {
      content.push({ type: 'text', text: PROMPT });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':         'application/json',
        'x-api-key':            ANTHROPIC_KEY,
        'anthropic-version':    '2023-06-01',
        'anthropic-beta':       'pdfs-2024-09-25',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 1000,
        messages:   [{ role: 'user', content }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Claude API error:', err);
      return res.status(502).json({ error: 'Claude API error', detail: err });
    }

    const data = await response.json();
    const raw  = data.content?.[0]?.text || '';

    // Parse JSON from response
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return res.status(422).json({ error: 'No JSON in response', raw });

    const extracted = JSON.parse(match[0]);
    return res.json({ ok: true, extracted });

  } catch (err) {
    console.error('extract-job error:', err);
    return res.status(500).json({ error: err.message });
  }
}
