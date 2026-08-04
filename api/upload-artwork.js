// api/upload-artwork.js  (stickysitch WEBSITE repo — replaces existing file)
//
// Flow: Configure → Upload artwork HERE → Shopify payment
// At upload time there is no confirmed order yet, so we store the artwork
// in Supabase with the customer email. The job board webhook matches by email
// when the Shopify payment fires and links the artwork automatically.
//
// Still sends the team notification email via Resend — same as before.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const RESEND_KEY   = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = 'info@stickysitch.com.au';
const FROM_EMAIL   = 'jobs@stickysitch.com.au';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};

    const customerEmail = (body.customerEmail || '').toLowerCase().trim();
    const draftOrderNum = String(body.orderNumber || '').replace(/^#/, '').trim();

    // Items — handles both single upload and submitAllArtwork (array)
    const items = body.items
      ? body.items
      : [{
          product:       body.product       || '',
          specification: body.specification || '',
          notes:         body.notes         || '',
          filename:      body.filename      || 'artwork',
          fileContent:   body.fileContent   || '',
          fileType:      body.fileType      || 'application/octet-stream',
        }];

    const storedUrls  = [];
    const attachments = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.fileContent) continue;

      const fileBuffer = Buffer.from(item.fileContent, 'base64');
      const filename   = item.filename || 'artwork';
      const mimeType   = item.fileType || 'application/octet-stream';

      // ── Upload artwork file to Supabase Storage ──────────────────────────
      const emailSlug   = customerEmail.split('@')[0].replace(/[^a-z0-9]/gi, '_') || 'unknown';
      const storagePath = `pending/${emailSlug}/${Date.now()}_${filename}`;

      const { error: storageErr } = await supabase.storage
        .from('artwork')
        .upload(storagePath, fileBuffer, { contentType: mimeType, upsert: false });

      let publicUrl = null;
      if (!storageErr) {
        const { data: urlData } = supabase.storage.from('artwork').getPublicUrl(storagePath);
        publicUrl = urlData?.publicUrl || null;
        storedUrls.push({ url: publicUrl, filename, product: item.product });
        console.log(`Artwork stored: ${storagePath}`);
      } else {
        console.error('Storage error:', storageErr.message);
      }

      // ── Save to pending_orders so webhook can match by email ─────────────
      if (customerEmail && publicUrl) {
        const { error: dbErr } = await supabase.from('pending_orders').insert({
          email:            customerEmail,
          product_type:     item.product || null,
          notes:            item.notes   || null,
          artwork_url:      publicUrl,
          artwork_filename: filename,
          raw_fields:       { specification: item.specification, draftOrder: draftOrderNum },
          source_page:      'upload-artwork',
        });
        if (dbErr) console.error('pending_orders error:', dbErr.message);
        else       console.log(`Saved to pending_orders for ${customerEmail}`);
      }

      attachments.push({ filename, content: item.fileContent, type: mimeType });
    }

    // ── Send team notification email (same as before) ────────────────────
    const firstItem = items[0] || {};
    const subject   = ['Artwork received', draftOrderNum ? 'Draft #'+draftOrderNum : '', firstItem.product || ''].filter(Boolean).join(' · ');

    const specRows = items.map((it, idx) => `
      ${items.length > 1 ? `<div style="font-weight:700;margin-top:${idx>0?'16px':'0'};color:#1E1B4B">Item ${idx+1}: ${it.product}</div>` : ''}
      <table style="width:100%;border-collapse:collapse;margin-top:4px">
        ${it.specification ? `<tr><td style="padding:3px 0;color:#6B7280;width:120px">Spec</td><td>${it.specification}</td></tr>` : ''}
        ${it.notes         ? `<tr><td style="padding:3px 0;color:#6B7280">Notes</td><td>${it.notes}</td></tr>` : ''}
        ${it.filename      ? `<tr><td style="padding:3px 0;color:#6B7280">File</td><td style="font-weight:500">${it.filename}</td></tr>` : ''}
      </table>`).join('');

    const urlLinks = storedUrls.map(u => `<a href="${u.url}" style="color:#7C3AED">${u.filename}</a>`).join('<br>');

    const html = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#1E1B4B">📎 Artwork received — StickySitch</h2>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
        ${customerEmail ? `<tr><td style="padding:5px 0;color:#6B7280;width:120px">Customer email</td><td><a href="mailto:${customerEmail}">${customerEmail}</a></td></tr>` : ''}
        ${draftOrderNum ? `<tr><td style="padding:5px 0;color:#6B7280">Draft order</td><td>#${draftOrderNum}</td></tr>` : ''}
      </table>
      ${specRows}
      ${urlLinks ? `<div style="margin-top:14px;padding:12px;background:#F5F3FF;border-radius:8px;font-size:13px"><b>Saved to job board storage:</b><br>${urlLinks}<br><small style="color:#6B7280">Links to the job automatically when customer pays.</small></div>` : ''}
      <hr style="margin:20px 0;border:none;border-top:1px solid #E5E7EB">
      <p style="color:#9CA3AF;font-size:11px">Artwork stored in Supabase. Will link to the job when Shopify order is paid.</p>
    </div>`;

    if (RESEND_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM_EMAIL, to: NOTIFY_EMAIL, subject, html, attachments }),
      });
    }

    return res.status(200).json({ success: true, stored: storedUrls.length });

  } catch (err) {
    console.error('upload-artwork error:', err);
    return res.status(500).json({ error: err.message || 'Upload failed' });
  }
}
