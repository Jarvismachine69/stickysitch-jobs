// api/send-proof.js  (job board Vercel repo)
// Emails an artwork proof to the customer for approval.
//
// The board has already uploaded the proof to Supabase Storage (bucket
// `proofs`) and inserted a `proofs` row before calling this. We just look
// up the customer + job specs, build the branded email, attach the proof
// (fetched from its public URL) and send via Resend.
//
// POST JSON: { jobId, proofUrl, filename }

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const RESEND_KEY   = process.env.RESEND_API_KEY;
const FROM_EMAIL   = 'StickySitch <info@stickysitch.com.au>';
const REPLY_EMAIL  = 'info@stickysitch.com.au';

const PRODUCT_LABELS = { rolls:'Roll labels', sheets:'Sticker sheets', individual:'Individual stickers', bumper:'Bumper stickers', large:'Large format' };

function esc(s){ return (s==null?'':String(s)).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Body may arrive parsed (JSON) or raw depending on runtime
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};

    const jobId    = String(body.jobId || '').trim();
    const proofUrl = String(body.proofUrl || '').trim();
    const filename = String(body.filename || 'proof.pdf').trim();

    if (!jobId)    return res.status(400).json({ error: 'jobId is required' });
    if (!proofUrl) return res.status(400).json({ error: 'proofUrl is required' });

    // ── Look up job + customer + first item for the email body ─────────
    const { data: job } = await supabase
      .from('jobs')
      .select('id, customer_id, customers(business_name, contact_name, email)')
      .eq('id', jobId)
      .maybeSingle();

    // Fall back to the active_jobs view if the join above returns nothing
    let customerEmail = job?.customers?.email || null;
    let businessName  = job?.customers?.business_name || '';
    let contactName   = job?.customers?.contact_name || '';
    if (!customerEmail) {
      const { data: v } = await supabase
        .from('active_jobs').select('customer_email, business_name, contact_name').eq('id', jobId).maybeSingle();
      customerEmail = v?.customer_email || null;
      businessName  = businessName || v?.business_name || '';
      contactName   = contactName  || v?.contact_name  || '';
    }

    const { data: item } = await supabase
      .from('job_items').select('product_type, quantity, width_mm, height_mm').eq('job_id', jobId).limit(1).maybeSingle();

    if (!customerEmail) {
      return res.status(422).json({ error: 'No customer email on file for this job — add one before sending the proof.' });
    }
    if (!RESEND_KEY) {
      return res.status(500).json({ error: 'RESEND_API_KEY not configured on this project.' });
    }

    const product = PRODUCT_LABELS[item?.product_type] || item?.product_type || '—';
    const size    = (item?.width_mm && item?.height_mm) ? `${item.width_mm}×${item.height_mm} mm` : '—';
    const qty     = item?.quantity ? Number(item.quantity).toLocaleString('en-AU') : '—';
    const greetName = contactName || businessName || 'there';

    // ── Try to attach the proof file (fetched from its public URL) ─────
    const attachments = [];
    try {
      const fileResp = await fetch(proofUrl);
      if (fileResp.ok) {
        const buf = Buffer.from(await fileResp.arrayBuffer());
        // Resend caps attachments ~40MB; skip if unexpectedly large
        if (buf.length < 20 * 1024 * 1024) {
          attachments.push({ filename, content: buf.toString('base64') });
        }
      }
    } catch (e) {
      console.warn('proof attach fetch failed (will link instead):', e.message);
    }

    const html = `<div style="background:#f4f4f0;padding:24px;font-family:sans-serif"><div style="max-width:560px;margin:0 auto">
      <div style="background:#16181D;border-radius:12px 12px 0 0;padding:28px 32px;text-align:center"><div style="font-size:26px;font-weight:800;color:#fff">Sticky<span style="color:#A78BFA">Sitch</span></div></div>
      <div style="background:#fff;border-radius:0 0 12px 12px;padding:32px;border:1px solid #E5E7EB;border-top:none">
        <h2 style="color:#16181D;font-size:20px;margin:0 0 8px">Your proof is ready to review</h2>
        <p style="color:#6B7280;font-size:14px;margin:0 0 20px">Hi ${esc(greetName)}, your artwork proof for your StickySitch order is ready.</p>
        <div style="background:#F5F3FF;border:1.5px solid #DDD6FE;border-radius:10px;padding:16px;margin-bottom:20px">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#7C3AED;margin-bottom:8px">Order details</div>
          <table style="width:100%;font-size:14px">
            <tr><td style="padding:3px 0;color:#6B7280;width:100px">Product</td><td style="font-weight:600">${esc(product)}</td></tr>
            <tr><td style="padding:3px 0;color:#6B7280">Size</td><td style="font-weight:600">${esc(size)}</td></tr>
            <tr><td style="padding:3px 0;color:#6B7280">Quantity</td><td style="font-weight:600">${esc(qty)}</td></tr>
          </table>
        </div>
        <div style="background:#ECFDF5;border:1.5px solid #86EFAC;border-radius:10px;padding:20px;text-align:center;margin-bottom:20px">
          <p style="color:#166534;font-size:14px;margin:0 0 14px">Review your proof and reply to this email to approve or request changes.</p>
          <a href="${esc(proofUrl)}" style="background:#059669;color:#fff;padding:13px 28px;border-radius:9px;font-weight:700;font-size:15px;text-decoration:none;display:inline-block">View your proof</a>
        </div>
        <div style="background:#FEF3C7;border:1px solid #FCD34D;border-radius:8px;padding:12px 14px;font-size:13px;color:#92400E"><b>Nothing prints until you approve.</b> Please check all text, colours and layout carefully.</div>
        <div style="margin-top:24px;padding-top:20px;border-top:1px solid #E5E7EB;font-size:12px;color:#9CA3AF;text-align:center">StickySitch · Braybrook VIC 3019 · info@stickysitch.com.au</div>
      </div></div></div>`;

    const payload = {
      from: FROM_EMAIL,
      to: customerEmail,
      reply_to: REPLY_EMAIL,
      subject: `Your StickySitch proof is ready to review${businessName ? ' — ' + businessName : ''}`,
      html,
    };
    if (attachments.length) payload.attachments = attachments;

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const detail = await r.text();
      console.error('Resend error:', detail);
      return res.status(502).json({ error: 'Email provider error', detail });
    }

    return res.status(200).json({ ok: true, sent_to: customerEmail });

  } catch (err) {
    console.error('send-proof error:', err);
    return res.status(500).json({ error: err.message || 'Failed to send proof' });
  }
}
