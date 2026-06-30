// api/send-review-requests.js
// Triggered daily by Vercel Cron (see vercel.json)
// Finds jobs dispatched or picked up 2+ days ago that haven't had a review request sent
// Sends a short, no-pressure Google review request

import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend   = new Resend(process.env.RESEND_API_KEY);

const GOOGLE_REVIEW_LINK = 'https://www.google.com/maps/place//data=!4m3!3m2!1s0xa08b8c43d43b1ec1:0x3b28aef77840222f!12e1?source=g.page.m.kd._&laa=lu-desktop-review-solicitation';

export default async function handler(req, res) {
  // Allow manual trigger via GET for testing, cron sends GET too
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify cron secret if set (Vercel cron sends this automatically)
  const authHeader = req.headers['authorization'];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    // Find jobs dispatched/pickedup between 2-3 days ago that haven't had a review sent
    const { data: jobs, error: jobsErr } = await supabase
      .from('jobs')
      .select('id, status, updated_at, review_email_sent, customers(business_name, email)')
      .in('status', ['dispatched', 'pickedup'])
      .eq('review_email_sent', false)
      .lte('updated_at', twoDaysAgo.toISOString())
      .gte('updated_at', threeDaysAgo.toISOString());

    if (jobsErr) throw new Error(jobsErr.message);
    if (!jobs || jobs.length === 0) {
      return res.status(200).json({ message: 'No jobs due for review request', sent: 0 });
    }

    let sentCount = 0;
    const results = [];

    for (const job of jobs) {
      const customerEmail = job.customers?.email;
      const businessName  = job.customers?.business_name || 'there';
      if (!customerEmail) continue;

      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F0EEE8;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F0EEE8;padding:40px 20px"><tr><td align="center">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2DDD5">
<tr><td style="background:#2C2545;padding:28px 32px">
  <div style="font-size:24px;font-weight:800;color:#fff">Sticky<span style="color:#9B8EF0">Sitch</span></div>
</td></tr>
<tr><td style="padding:32px">
  <h1 style="margin:0 0 8px;font-size:21px;font-weight:800;color:#2C2545">How did your order turn out?</h1>
  <p style="margin:0 0 22px;font-size:15px;color:#6B6560;line-height:1.6">
    Hi ${businessName},<br><br>
    Your order <strong>${job.id}</strong> should have landed by now. We hope it looks exactly how you imagined.
  </p>
  <p style="margin:0 0 22px;font-size:15px;color:#6B6560;line-height:1.6">
    If you're happy with how it turned out, we'd really appreciate a quick Google review. It only takes a minute and helps a lot as a small local business.
  </p>
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding-bottom:8px">
    <a href="${GOOGLE_REVIEW_LINK}" style="display:inline-block;background:#6B5CE7;color:#fff;font-size:16px;font-weight:700;padding:15px 32px;border-radius:12px;text-decoration:none">Leave us a review &rarr;</a>
  </td></tr></table>
  <p style="margin:24px 0 0;font-size:13px;color:#9B9692;line-height:1.6;text-align:center">
    Thanks for choosing StickySitch.<br>David and the team
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

      try {
        await resend.emails.send({
          from:    'StickySitch <hello@stickysitch.com.au>',
          to:      customerEmail,
          subject: `How did your StickySitch order turn out?`,
          html,
        });

        await supabase.from('jobs').update({ review_email_sent: true }).eq('id', job.id);
        sentCount++;
        results.push({ job_id: job.id, sent_to: customerEmail });
      } catch (sendErr) {
        console.error(`Failed to send review request for ${job.id}:`, sendErr);
      }
    }

    console.log(`✓ Review requests sent: ${sentCount}/${jobs.length}`);
    return res.status(200).json({ success: true, sent: sentCount, total_eligible: jobs.length, results });

  } catch (err) {
    console.error('send-review-requests error:', err);
    return res.status(500).json({ error: err.message });
  }
}
