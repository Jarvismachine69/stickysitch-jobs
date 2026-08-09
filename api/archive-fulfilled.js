// api/archive-fulfilled.js  (job board Vercel repo)
// Fetches all fulfilled Shopify orders, finds matching jobs in Supabase,
// and marks them as dispatched so they fall off the active board.
// ONLY touches jobs with source='shopify'. Manual/email/phone jobs are never changed.
//
// GET /api/archive-fulfilled?secret=stickysitch2024          — dry run (preview only)
// GET /api/archive-fulfilled?secret=stickysitch2024&run=1    — actually apply changes

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SHOP  = process.env.SHOPIFY_STORE_URL;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

async function getAllFulfilledOrderNumbers() {
  const orderNums = [];
  let url = `https://${SHOP}/admin/api/2024-01/orders.json?fulfillment_status=fulfilled&status=any&limit=250&fields=order_number`;

  // Paginate through all fulfilled orders
  while (url) {
    const r = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': TOKEN }
    });
    if (!r.ok) throw new Error('Shopify API error: ' + r.status);

    const data = await r.json();
    (data.orders || []).forEach(o => orderNums.push(String(o.order_number)));

    // Check Link header for next page
    const linkHeader = r.headers.get('Link') || '';
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }

  return orderNums;
}

export default async function handler(req, res) {
  if (req.query.secret !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const dryRun = req.query.run !== '1';

  try {
    // 1. Get all fulfilled order numbers from Shopify
    console.log('Fetching fulfilled orders from Shopify...');
    const fulfilledNums = await getAllFulfilledOrderNumbers();
    console.log(`Found ${fulfilledNums.length} fulfilled orders in Shopify`);

    if (!fulfilledNums.length) {
      return res.json({ message: 'No fulfilled orders found in Shopify', archived: 0 });
    }

    // 2. Find matching active jobs in Supabase — SHOPIFY SOURCE ONLY
    // Match both with and without # prefix (handles old jobs stored as '#1285' and new as '1285')
    const fulfilledWithHash = fulfilledNums.map(n => '#' + n);
    const allSearchNums = [...fulfilledNums, ...fulfilledWithHash];
    const { data: matchedJobs, error } = await supabase
      .from('jobs')
      .select('id, shopify_order_number, status, source')
      .in('shopify_order_number', allSearchNums)
      .eq('source', 'shopify')
      .not('status', 'in', '("dispatched","pickedup","cancelled","refunded")');

    if (error) throw new Error('Supabase query error: ' + error.message);

    if (!matchedJobs || !matchedJobs.length) {
      return res.json({
        message: 'No active Shopify jobs found matching fulfilled orders. Board is already clean.',
        shopify_fulfilled: fulfilledNums.length,
        jobs_to_archive: 0,
        archived: 0,
        dry_run: dryRun,
      });
    }

    const jobIds = matchedJobs.map(j => j.id);
    const preview = matchedJobs.map(j => ({
      job_id: j.id,
      order: '#' + j.shopify_order_number,
      current_status: j.status,
    }));

    if (dryRun) {
      return res.json({
        message: `DRY RUN — ${matchedJobs.length} job(s) would be archived. Add &run=1 to apply.`,
        jobs_to_archive: matchedJobs.length,
        preview,
        dry_run: true,
      });
    }

    // 3. Mark all matched jobs as dispatched
    const { error: updateErr } = await supabase
      .from('jobs')
      .update({ status: 'dispatched' })
      .in('id', jobIds);

    if (updateErr) throw new Error('Update error: ' + updateErr.message);

    console.log(`Archived ${jobIds.length} fulfilled Shopify jobs`);

    return res.json({
      message: `Done. ${jobIds.length} fulfilled Shopify job(s) removed from active board. Manual jobs untouched.`,
      archived: jobIds.length,
      jobs: preview,
      dry_run: false,
    });

  } catch (err) {
    console.error('archive-fulfilled error:', err);
    return res.status(500).json({ error: err.message });
  }
}
