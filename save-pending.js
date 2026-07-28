// api/save-pending.js
// Receives artwork + specs from the StickySitch configurator.
// Replaces FormSubmit — handles file upload to Supabase Storage,
// saves a pending_orders record, and sends team notification via Resend.
//
// Form must POST multipart/form-data with fields:
//   email, name, phone, product_type, shape, width_mm, height_mm,
//   material, laminate, quantity, notes, source_page
//   artwork: (file)

import { createClient } from '@supabase/supabase-js';
import formidable from 'formidable';
import fs from 'fs';
import path from 'path';

// Vercel: disable default body parser so we can parse multipart
export const config = { api: { bodyParser: false } };

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const RESEND_KEY    = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL  = 'info@stickysitch.com.au';
const FROM_EMAIL    = 'jobs@stickysitch.com.au';

// ── Parse multipart form ──────────────────────────────────────────────
function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({ maxFileSize: 50 * 1024 * 1024 }); // 50 MB
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      // formidable v3 returns arrays — flatten to single values
      const f = {};
      for (const [k, v] of Object.entries(fields)) f[k] = Array.isArray(v) ? v[0] : v;
      resolve({ fields: f, files });
    });
  });
}

// ── Upload artwork file to Supabase Storage ───────────────────────────
async function uploadArtwork(file) {
  if (!file) return { url: null, filename: null };

  const ext      = path.extname(file.originalFilename || file.newFilename || 'file');
  const filename = `pending/${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
  const buffer   = fs.readFileSync(file.filepath);

  const { error } = await supabase.storage
    .from('pending-artwork')
    .upload(filename, buffer, {
      contentType: file.mimetype || 'application/octet-stream',
      upsert: false,
    });

  if (error) {
    console.error('Artwork upload error:', error);
    return { url: null, filename: file.originalFilename };
  }

  const { data: { publicUrl } } = supabase.storage
    .from('pending-artwork')
    .getPublicUrl(filename);

  return { url: publicUrl, filename: file.originalFilename || filename };
}

// ── Send team notification email via Resend ───────────────────────────
async function sendNotification(fields, artworkUrl, artworkFilename) {
  const sizeStr = (fields.width_mm && fields.height_mm)
    ? `${fields.width_mm} × ${fields.height_mm} mm`
    : fields.size || '—';

  const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
  <h2 style="color:#1E1B4B">📎 New artwork submission — StickySitch</h2>
  <table style="width:100%;border-collapse:collapse">
    <tr><td style="padding:6px 0;color:#6b7280;width:140px">Name</td><td style="padding:6px 0;font-weight:600">${fields.name || '—'}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Email</td><td style="padding:6px 0"><a href="mailto:${fields.email}">${fields.email}</a></td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Phone</td><td style="padding:6px 0">${fields.phone || '—'}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Product</td><td style="padding:6px 0">${fields.product_type || '—'}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Shape</td><td style="padding:6px 0">${fields.shape || '—'}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Size</td><td style="padding:6px 0">${sizeStr}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Material</td><td style="padding:6px 0">${fields.material || '—'}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Laminate</td><td style="padding:6px 0">${fields.laminate || '—'}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Quantity</td><td style="padding:6px 0">${fields.quantity || '—'}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Notes</td><td style="padding:6px 0">${fields.notes || '—'}</td></tr>
  </table>
  ${artworkUrl ? `<p style="margin-top:16px"><a href="${artworkUrl}" style="background:#1E1B4B;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600">⬇ Download artwork (${artworkFilename})</a></p>` : '<p style="color:#6b7280;margin-top:16px">No artwork file attached.</p>'}
  <hr style="margin:20px 0;border:none;border-top:1px solid #e5e7eb">
  <p style="color:#6b7280;font-size:12px">This submission is saved to the job board as a pending order. It will be automatically linked to the confirmed Shopify order when the customer completes checkout using the same email address.</p>
</div>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: NOTIFY_EMAIL,
      subject: `New artwork: ${fields.name || fields.email} — ${fields.product_type || 'Order'} · ${fields.quantity || ''} · ${sizeStr}`,
      html,
    }),
  });
}

// ── Main handler ──────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { fields, files } = await parseForm(req);

    if (!fields.email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Upload artwork if provided
    const artFile = files.artwork?.[0] || files.artwork || null;
    const { url: artworkUrl, filename: artworkFilename } = await uploadArtwork(artFile);

    // Save pending record to Supabase
    const record = {
      email:            fields.email.toLowerCase().trim(),
      name:             fields.name             || null,
      phone:            fields.phone            || null,
      product_type:     fields.product_type     || null,
      shape:            fields.shape            || null,
      width_mm:         fields.width_mm         ? parseFloat(fields.width_mm)  : null,
      height_mm:        fields.height_mm        ? parseFloat(fields.height_mm) : null,
      material:         fields.material         || null,
      laminate:         fields.laminate         || null,
      quantity:         fields.quantity         ? parseInt(fields.quantity)    : null,
      notes:            fields.notes            || null,
      source_page:      fields.source_page      || null,
      artwork_url:      artworkUrl,
      artwork_filename: artworkFilename,
      raw_fields:       fields,
    };

    const { error: dbErr } = await supabase.from('pending_orders').insert(record);
    if (dbErr) console.error('DB insert error:', dbErr);

    // Send team notification (non-blocking)
    sendNotification(fields, artworkUrl, artworkFilename).catch(console.error);

    // Redirect to thank-you page (mimics FormSubmit behaviour)
    const redirectUrl = fields._next || `https://www.stickysitch.com.au/thank-you`;
    return res.redirect(302, redirectUrl);

  } catch (err) {
    console.error('save-pending error:', err);
    return res.status(500).json({ error: 'Failed to save submission' });
  }
}
