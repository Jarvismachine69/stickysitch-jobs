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
const FROM_EMAIL   = 'StickySitch Jobs <info@stickysitch.com.au>'; // jobs@ isn't a real mailbox — use a display name on the real address

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};

    const customerEmail = (body.customerEmail || '').toLowerCase().trim();
    const draftOrderNum = String(body.orderNumber || '').replace(/^#/, '').trim();
    const draftOrderId  = String(body.orderId || '').trim();

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

    const storedUrls     = [];
    const attachments    = [];
    const uploadFailures = [];

    // Buckets to try, in order. `artwork` is the public bucket the job board
    // already reads from (durable public URLs); `pending-artwork` is a
    // fallback. Set PENDING_BUCKET to force a specific one first.
    const BUCKETS = [process.env.PENDING_BUCKET, 'artwork', 'pending-artwork']
      .filter(Boolean)
      .filter((b, i, a) => a.indexOf(b) === i);   // de-dupe

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.fileContent) continue;

      const fileBuffer = Buffer.from(item.fileContent, 'base64');
      const filename   = item.filename || 'artwork';
      const mimeType   = item.fileType || 'application/octet-stream';

      // ── Upload to storage, trying each bucket until one accepts it ───────
      const emailSlug   = ((customerEmail.split('@')[0]) || 'unknown').replace(/[^a-z0-9]/gi, '_') || 'unknown';
      const rand        = Math.random().toString(36).slice(2, 8);
      const storagePath = `pending/${emailSlug}/${Date.now()}_${rand}_${filename}`;

      let publicUrl = null, usedBucket = null, lastErr = null;
      for (const bucket of BUCKETS) {
        try {
          const { error: storageErr } = await supabase.storage
            .from(bucket)
            .upload(storagePath, fileBuffer, { contentType: mimeType, upsert: false });
          if (!storageErr) {
            usedBucket = bucket;
            const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(storagePath);
            publicUrl = urlData?.publicUrl || null;
            console.log(`Artwork stored in "${bucket}": ${storagePath}`);
            break;
          }
          lastErr = storageErr.message;
          console.error(`Storage upload to "${bucket}" failed: ${storageErr.message}`);
        } catch (e) {
          lastErr = e.message;
          console.error(`Storage upload to "${bucket}" threw: ${e.message}`);
        }
      }
      if (publicUrl) storedUrls.push({ url: publicUrl, filename, product: item.product });
      else           uploadFailures.push({ filename, error: lastErr || 'unknown' });

      // ── ALWAYS record the submission — even if every bucket failed ───────
      // Losing the file is bad; losing the whole submission (the customer's
      // email, specs, and the fact they tried) is worse and unrecoverable.
      // The webhook matches on this row; the team email below still carries
      // the actual file as an attachment as a final safety net.
      try {
        const { error: dbErr } = await supabase.from('pending_orders').insert({
          email:            customerEmail || null,
          product_type:     item.product || null,
          notes:            item.notes   || null,
          artwork_url:      publicUrl,                 // null if all uploads failed
          artwork_filename: filename,
          source_page:      'upload-artwork',
          raw_fields: {
            specification: item.specification,
            draftOrder:    draftOrderNum,
            storage:       usedBucket ? { bucket: usedBucket, path: storagePath } : null,
            upload_error:  publicUrl ? null : (lastErr || 'storage upload failed — file not saved; submission recorded for manual follow-up'),
          },
        });
        if (dbErr) console.error('pending_orders insert error:', dbErr.message);
        else       console.log(`Saved pending_orders for ${customerEmail || filename}${publicUrl ? '' : ' (NO FILE — upload failed, see email attachment)'}`);
      } catch (e) {
        console.error('pending_orders insert threw:', e.message);
      }

      attachments.push({ filename, content: item.fileContent, type: mimeType });
    }

    // ── Send team notification email (same as before) ────────────────────
    const firstItem = items[0] || {};
    const subject   = ['Artwork received', draftOrderNum ? 'Draft #'+draftOrderNum : '', firstItem.product || ''].filter(Boolean).join(' · ');

    const storeHandle    = (process.env.SHOPIFY_STORE_DOMAIN || '').replace('.myshopify.com', '');
    const draftOrderLink = (storeHandle && draftOrderId)
      ? `https://admin.shopify.com/store/${storeHandle}/draft_orders/${draftOrderId}`
      : null;

    const specRows = items.map((it, idx) => `
      ${items.length > 1 ? `<div style="font-weight:700;margin-top:${idx>0?'16px':'0'};color:#1E1B4B">Item ${idx+1}: ${it.product}</div>` : ''}
      <table style="width:100%;border-collapse:collapse;margin-top:4px">
        ${it.specification ? `<tr><td style="padding:3px 0;color:#6B7280;width:120px">Spec</td><td>${it.specification}</td></tr>` : ''}
        ${it.notes         ? `<tr><td style="padding:3px 0;color:#6B7280">Notes</td><td>${it.notes}</td></tr>` : ''}
        ${it.filename      ? `<tr><td style="padding:3px 0;color:#6B7280">File</td><td style="font-weight:500">${it.filename}</td></tr>` : ''}
      </table>`).join('');

    const urlLinks = storedUrls.map(u => `<a href="${u.url}" style="color:#7C3AED">${u.filename}</a>`).join('<br>');
    const failWarn = uploadFailures.length
      ? `<div style="margin-top:14px;padding:12px;background:#FEF2F2;border:1px solid #FCA5A5;border-radius:8px;font-size:13px;color:#991B1B"><b>⚠ File storage failed for:</b> ${uploadFailures.map(f => f.filename).join(', ')}.<br>The submission was still recorded and the file is <b>attached to this email</b>. Check the Supabase storage bucket config, then upload the attached file to the job manually.</div>`
      : '';

    const html = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#1E1B4B">📎 Artwork received — StickySitch</h2>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
        ${customerEmail ? `<tr><td style="padding:5px 0;color:#6B7280;width:120px">Customer email</td><td><a href="mailto:${customerEmail}">${customerEmail}</a></td></tr>` : ''}
        ${draftOrderNum ? `<tr><td style="padding:5px 0;color:#6B7280">Draft order</td><td>#${draftOrderNum}${draftOrderLink ? ` &nbsp;<a href="${draftOrderLink}" style="color:#7C3AED;font-weight:600">View in Shopify &rarr;</a>` : ''}</td></tr>` : ''}
      </table>
      ${specRows}
      ${urlLinks ? `<div style="margin-top:14px;padding:12px;background:#F5F3FF;border-radius:8px;font-size:13px"><b>Saved to job board storage:</b><br>${urlLinks}<br><small style="color:#6B7280">Links to the job automatically when customer pays.</small></div>` : ''}
      ${failWarn}
      <hr style="margin:20px 0;border:none;border-top:1px solid #E5E7EB">
      <p style="color:#9CA3AF;font-size:11px">Artwork stored in Supabase. Will link to the job when Shopify order is paid.</p>
    </div>`;

    if (RESEND_KEY) {
      const emailPayload = { from: FROM_EMAIL, to: NOTIFY_EMAIL, subject, html, attachments };
      // Reply-To the customer directly so staff can hit Reply on desktop or
      // mobile and it goes straight to them, no manual address change needed.
      if (customerEmail) emailPayload.reply_to = customerEmail;

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(emailPayload),
      });
    }

    // Always 200: the submission is recorded (and emailed) even if storage
    // failed, so the customer's flow is never blocked by a bucket problem.
    return res.status(200).json({
      success: true,
      stored:  storedUrls.length,
      failed:  uploadFailures.length,
    });

  } catch (err) {
    console.error('upload-artwork error:', err);
    return res.status(500).json({ error: err.message || 'Upload failed' });
  }
}
