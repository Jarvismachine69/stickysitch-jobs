// api/cleanup-pending.js
// Matches unmatched pending_orders to already-existing jobs (by customer email).
// Run once after deploying the pending_orders system to backfill historical records.
// Also attaches artwork URLs to jobs that are missing them.
//
// Call: GET /api/cleanup-pending?secret=stickysitch2024

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.query.secret !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  // 1. Get all unmatched pending orders
  const { data: pending, error: pErr } = await supabase
    .from('pending_orders')
    .select('*')
    .is('matched_job_id', null)
    .order('created_at', { ascending: false });

  if (pErr) return res.status(500).json({ error: pErr.message });
  if (!pending || pending.length === 0) {
    return res.json({ message: 'No unmatched pending orders found.', matched: 0, deleted: 0 });
  }

  console.log(`Found ${pending.length} unmatched pending orders`);

  let matched   = 0;
  let artAdded  = 0;
  let noMatch   = 0;

  for (const p of pending) {
    const email = (p.email || '').toLowerCase().trim();
    if (!email) { noMatch++; continue; }

    // Look up jobs by customer email — find most recent
    const { data: jobs } = await supabase
      .from('jobs')
      .select('id, customer_email, artwork_url, placed_at')
      .eq('customer_email', email)
      .order('placed_at', { ascending: false })
      .limit(5);

    if (!jobs || jobs.length === 0) {
      // No matching job in the system yet — leave as unmatched
      noMatch++;
      continue;
    }

    // Take the most recent job for this customer
    const job = jobs[0];

    // Mark pending record as matched
    await supabase
      .from('pending_orders')
      .update({ matched_job_id: job.id, matched_at: new Date().toISOString() })
      .eq('id', p.id);

    matched++;

    // If the job has no artwork but the pending record does — attach it
    if (!job.artwork_url && p.artwork_url) {
      await supabase
        .from('jobs')
        .update({
          artwork_url:      p.artwork_url,
          artwork_filename: p.artwork_filename || 'artwork',
        })
        .eq('id', job.id);

      artAdded++;
      console.log(`Attached artwork to job ${job.id} from pending ${p.id}`);
    }
  }

  const summary = {
    message:       `Done. ${matched} pending records matched to existing jobs. ${artAdded} artwork URLs attached. ${noMatch} have no matching job yet.`,
    total_pending: pending.length,
    matched,
    artwork_added: artAdded,
    no_match_yet:  noMatch,
  };

  console.log(summary.message);
  return res.json(summary);
}
