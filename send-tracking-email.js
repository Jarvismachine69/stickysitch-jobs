// api/send-tracking-email.js
// Sends our own branded dispatch email (separate from Shopify's native notification)
// Works for both outsourced and in-house road dispatch jobs. Never mentions supplier.

import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend   = new Resend(process.env.RESEND_API_KEY);

// Public tracking URL builders per courier — best-effort, falls back to plain text
function trackingLink(courier, trackingNumber) {
  const c = (courier || '').toLowerCase();
  if (c.includes('startrack')) return `https://startrack.com.au/track-and-trace/?l=${trackingNumber}`;
  if (c.includes('tnt'))       return `https://www.tnt.com/express/en_au/site/tracking.html?searchType=con&cons=${trackingNumber}`;
  if (c.includes('auspost') || c.includes('australia post')) return `https://auspost.com.au/mypost/track/#/details/${trackingNumber}`;
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { job_id, tracking_number, courier } = req.body;
  if (!job_id || !tracking_number) return res.status(400).json({ error: 'job_id and tracking_number required' });

  try {
    const { data: job, error: jobErr } = await supabase
      .from('jobs')
      .select('id, shopify_order_number, customers(business_name, email)')
      .eq('id', job_id)
      .single();

    if (jobErr || !job) throw new Error('Job not found');
    const customerEmail = job.customers?.email;
    const businessName  = job.customers?.business_name || 'there';
    if (!customerEmail) throw new Error('No customer email on this job');

    const link = trackingLink(courier, tracking_number);
    const courierDisplay = courier || 'our courier';

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F0EEE8;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F0EEE8;padding:40px 20px"><tr><td align="center">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2DDD5">
<tr><td style="background:#2C2545;padding:28px 32px">
  <div style="font-size:24px;font-weight:800;color:#fff">Sticky<span style="color:#9B8EF0">Sitch</span></div>
</td></tr>
<tr><td style="padding:32px">
  <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#2C2545">Your order is on its way! 🚚</h1>
  <p style="margin:0 0 24px;font-size:15px;color:#6B6560;line-height:1.6">
    Hi ${businessName},<br><br>
    Your order <strong>${job.id}</strong>${job.shopify_order_number ? ' (' + job.shopify_order_number + ')' : ''} has been dispatched via ${courierDisplay}.
  </p>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F0EEE8;border-radius:10px;overflow:hidden;margin-bottom:24px">
  <tr><td style="padding:18px">
    <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9B9692">Tracking number</p>
    <p style="margin:0;font-size:17px;font-weight:800;color:#2C2545;letter-spacing:0.3px">${tracking_number}</p>
  </td></tr>
  </table>
  ${link ? `
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding-bottom:24px">
    <a href="${link}" style="display:inline-block;background:#6B5CE7;color:#fff;font-size:15px;font-weight:700;padding:14px 30px;border-radius:11px;text-decoration:none">Track your order &rarr;</a>
  </td></tr></table>` : ''}
  <p style="margin:0;font-size:13px;color:#9B9692;line-height:1.6">
    Questions about your delivery? Just reply to this email and we'll help out.
  </p>
</td></tr>
<tr><td style="background:#F0EEE8;padding:20px 32px;border-top:1px solid #E2DDD5">
  <p style="margin:0;font-size:12px;color:#9B9692;line-height:1.6">
    StickySitch &middot; 84/90 Cranwell Street, Braybrook VIC 3019<br>
    <a href="mailto:info@stickysitch.com.au" style="color:#6B5CE7;text-decoration:none">info@stickysitch.com.au</a>
  </p>
</td></tr>
</table></td></tr></table>
</body></html>`;

    await resend.emails.send({
      from:    'StickySitch <hello@stickysitch.com.au>',
      to:      customerEmail,
      subject: `Your order is on its way — ${job.id}`,
      html,
    });

    await supabase.from('jobs').update({
      status: 'dispatched',
      outsource_tracking: tracking_number,
      courier: courier || null,
    }).eq('id', job_id);

    await supabase.from('job_notes').insert({
      job_id, author_name: 'System', source: 'system',
      content: `Dispatch tracking email sent to ${customerEmail}. Tracking: ${tracking_number}.`,
    });

    return res.status(200).json({ success: true, sent_to: customerEmail });
  } catch (err) {
    console.error('send-tracking-email error:', err);
    return res.status(500).json({ error: err.message });
  }
}
