// api/send-pickup-notification.js
// Called when team marks a job "Ready for pickup"

import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend   = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { job_id } = req.body;
  if (!job_id) return res.status(400).json({ error: 'job_id required' });

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

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F0EEE8;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F0EEE8;padding:40px 20px"><tr><td align="center">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2DDD5">
<tr><td style="background:#2C2545;padding:28px 32px">
  <div style="font-size:24px;font-weight:800;color:#fff">Sticky<span style="color:#9B8EF0">Sitch</span></div>
</td></tr>
<tr><td style="padding:32px">
  <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#2C2545">Your order is ready! 📦</h1>
  <p style="margin:0 0 24px;font-size:15px;color:#6B6560;line-height:1.6">
    Hi ${businessName},<br><br>
    Great news — your order <strong>${job.id}</strong>${job.shopify_order_number ? ' (' + job.shopify_order_number + ')' : ''} is ready to collect.
  </p>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F0EEE8;border-radius:10px;overflow:hidden;margin-bottom:24px">
  <tr><td style="padding:18px">
    <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9B9692">Pickup location</p>
    <p style="margin:0 0 10px;font-size:15px;font-weight:700;color:#2C2545">84/90 Cranwell Street, Braybrook VIC 3019</p>
    <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9B9692">Pickup hours</p>
    <p style="margin:0;font-size:15px;font-weight:700;color:#2C2545">Monday to Friday, 9am – 3pm</p>
  </td></tr>
  </table>
  <p style="margin:0;font-size:14px;color:#6B6560;line-height:1.6">
    Please bring your order number <strong>${job.id}</strong> when you arrive. If you have any trouble finding us or need to arrange a different time, just reply to this email.
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
      subject: `Your order is ready for pickup — ${job.id}`,
      html,
    });

    await supabase.from('jobs').update({ status: 'pickup' }).eq('id', job_id);
    await supabase.from('job_notes').insert({
      job_id, author_name: 'System', source: 'system',
      content: `Pickup ready email sent to ${customerEmail}.`,
    });

    return res.status(200).json({ success: true, sent_to: customerEmail });
  } catch (err) {
    console.error('send-pickup-notification error:', err);
    return res.status(500).json({ error: err.message });
  }
}
