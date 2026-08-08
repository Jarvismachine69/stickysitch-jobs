// api/sync-artwork.js  (job board Vercel repo)
// Scans Shopify orders for artwork uploads and links them to jobs in Supabase.
// Handles all known Shopify artwork property formats.
//
// GET /api/sync-artwork?secret=stickysitch2024           — all recent orders
// GET /api/sync-artwork?secret=stickysitch2024&order=1285 — single order
// GET /api/sync-artwork?secret=stickysitch2024&missing=1  — only jobs with no artwork

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SHOP   = process.env.SHOPIFY_STORE_URL;
const TOKEN  = process.env.SHOPIFY_ACCESS_TOKEN;
const SECRET = process.env.SYNC_SECRET;

// Broad regex — catches any property that looks like it contains a file/artwork
const ART_NAME_RE = /artwork|art.?file|design|upload|file|image|logo|pdf|print/i;
const CDN_URL_RE  = /^https?:\/\/(cdn\.shopify|files\.shopifycdn|storage\.googleapis|ucarecdn)/i;

function extractArtworkUrl(order) {
  // 1. Check each line item's properties
  for (const item of (order.line_items || [])) {
    for (const prop of (item.properties || [])) {
      const val = (prop.value || '').trim();
      // Match by property name pattern OR by value being a CDN URL
      if (ART_NAME_RE.test(prop.name || '') || CDN_URL_RE.test(val)) {
        if (val && val.startsWith('http')) return { url: val, source: 'line_item_property:' + prop.name };
      }
    }
  }

  // 2. Check order-level note_attributes
  for (const attr of (order.note_attributes || [])) {
    const val = (attr.value || '').trim();
    if (ART_NAME_RE.test(attr.name || '') || CDN_URL_RE.test(val)) {
      if (val && val.startsWith('http')) return { url: val, source: 'note_attribute:' + attr.name };
    }
  }

  // 3. Scan order note freetext for URLs
  const note = order.note || '';
  const urlMatch = note.match(/https?:\/\/(cdn\.shopify|files\.shopifycdn)[^\s"')]+/i);
  if (urlMatch) return { url: urlMatch[0], source: 'order_note' };

  return null;
}

async function fetchShopifyOrders(orderName) {
  let url;
  if (orderName) {
    // Single order by name/number
    const num = String(orderName).replace(/^#/, '');
    url = `https://${SHOP}/admin/api/2024-01/orders.json?name=%23${num}&status=any&limit=1`;
  } else {
    // Recent 250 orders
    url = `https://${SHOP}/admin/api/2024-01/orders.json?status=any&limit=250&order=created_at+desc`;
  }

  const r = await fetch(url, {
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
  });
  if (!r.ok) throw new Error('Shopify API error: ' + r.status);
  const data = await r.json();
  return data.orders || [];
}

export default async function handler(req, res) {
  if (req.query.secret !== SECRET) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const singleOrder = req.query.order || null;
  const missingOnly = req.query.missing === '1';

  try {
    const orders = await fetchShopifyOrders(singleOrder);
    console.log(`Checking ${orders.length} Shopify orders for artwork...`);

    let checked = 0, linked = 0, skipped = 0, noArt = 0;
    const results = [];

    for (const order of orders) {
      checked++;
      const orderNum = String(order.order_number || '').replace(/^#/, '');
      if (!orderNum) continue;

      // Find matching job in Supabase
      const { data: job } = await supabase
        .from('jobs')
        .select('id, artwork_url')
        .eq('shopify_order_number', orderNum)
        .maybeSingle();

      if (!job) { skipped++; continue; }

      // Skip if job already has artwork and we're not forcing
      if (job.artwork_url && missingOnly) { skipped++; continue; }
      if (job.artwork_url && !singleOrder) { skipped++; continue; }

      // Extract artwork from order
      const art = extractArtworkUrl(order);

      if (!art) {
        noArt++;
        results.push({ jobId: job.id, order: orderNum, status: 'no_artwork_in_order' });
        continue;
      }

      // Link artwork to job
      const filename = art.url.split('/').pop().split('?')[0] || 'artwork';
      const { error } = await supabase
        .from('jobs')
        .update({ artwork_url: art.url, artwork_filename: filename })
        .eq('id', job.id);

      if (error) {
        results.push({ jobId: job.id, order: orderNum, status: 'db_error', error: error.message });
      } else {
        linked++;
        console.log(`✓ Linked artwork to ${job.id} (order #${orderNum}) from ${art.source}`);
        results.push({ jobId: job.id, order: orderNum, status: 'linked', url: art.url, source: art.source });
      }
    }

    return res.json({
      message: `Checked ${checked} orders. Linked ${linked} artworks. ${skipped} skipped (already linked or no job). ${noArt} orders had no artwork.`,
      checked, linked, skipped, no_artwork: noArt,
      results: results.filter(r => r.status !== 'skipped').slice(0, 50),
    });

  } catch (err) {
    console.error('sync-artwork error:', err);
    return res.status(500).json({ error: err.message });
  }
}
