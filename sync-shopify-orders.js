// api/sync-shopify-orders.js
// One-time sync: fetches all open/unfulfilled Shopify orders and creates jobs in Supabase.
// Run once after a database reset to backfill all current orders.
// Protect with a secret so it can't be called accidentally.
//
// Call it: GET /api/sync-shopify-orders?secret=YOUR_SYNC_SECRET
// Add SYNC_SECRET to Vercel env vars (any random string you choose).

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const SHOPIFY_STORE = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// ── Product type detection (same as webhook handler) ─────────────────
function detectProductType(item) {
  const text = [
    item.title,
    item.product_type,
    item.vendor,
    (item.properties || []).map(p => `${p.name} ${p.value}`).join(' ')
  ].join(' ').toLowerCase();

  if (text.includes('roll') || text.includes('roll label'))   return 'rolls';
  if (text.includes('sticker sheet') || text.includes('sheet label')) return 'sheets';
  if (text.includes('bumper'))                                return 'bumper';
  if (text.includes('large format') || text.includes('banner') || text.includes('pull up')) return 'large';
  return 'individual';
}

// ── Extract all useful fields from Shopify line item properties ────────
function parseProps(item) {
  const props = (item.properties || []);
  const find = (pattern) => {
    const p = props.find(p => pattern.test(p.name));
    return p ? (p.value || '').trim() : null;
  };
  const widthRaw   = find(/width|w\s*\(/i);
  const heightRaw  = find(/height|h\s*\(/i);
  const qtyProp    = find(/^(qty|quantity|sticker.?count|how.?many|number.?of|pieces|labels|stickers)$/i);
  const artworkUrl = find(/artwork|design.?file|upload|your.?file|file|art$/i);
  return {
    width_mm:     widthRaw  ? parseFloat(widthRaw)  : null,
    height_mm:    heightRaw ? parseFloat(heightRaw) : null,
    qty_override: qtyProp   ? parseInt(qtyProp)     : null,
    artwork_url:  artworkUrl || null,
    shape:        find(/shape|die.?cut|cut.?type/i) || null,
    material:     find(/material|substrate|stock|vinyl|paper|film/i) || null,
    laminate:     find(/laminat|laminate|finish|coat|gloss|matte|soft.?touch/i) || null,
  };
}


// ── Business days calculation ─────────────────────────────────────────
function calcDueDate(placedAt, productType) {
  const days = productType === 'rolls' ? 3 : 2;
  const date = new Date(placedAt);
  let added = 0;
  while (added < days) {
    date.setDate(date.getDate() + 1);
    const dow = date.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return date.toISOString().split('T')[0];
}

// ── Upsert customer ───────────────────────────────────────────────────
async function upsertCustomer(order) {
  const billing  = order.billing_address  || {};
  const shipping = order.shipping_address || {};
  const addr     = shipping.address1 ? shipping : billing;

  const addressFull = [addr.address1, addr.address2, addr.city, addr.province_code, addr.zip]
    .filter(Boolean).join(', ');

  const customerData = {
    email:               order.email || order.contact_email || '',
    business_name:       billing.company || `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim() || 'Unknown',
    contact_name:        `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim() || null,
    phone:               order.phone || billing.phone || shipping.phone || null,
    address_full:        addressFull || null,
    address_street:      addr.address1 || null,
    address_suburb:      addr.city    || null,
    address_state:       addr.province_code || null,
    address_postcode:    addr.zip     || null,
    shopify_customer_id: order.customer?.id?.toString() || null,
  };

  // Try to find existing by shopify_customer_id or email
  let existingId = null;
  if (customerData.shopify_customer_id) {
    const { data } = await supabase.from('customers')
      .select('id, order_count').eq('shopify_customer_id', customerData.shopify_customer_id).maybeSingle();
    if (data) {
      existingId = data.id;
      await supabase.from('customers').update({ ...customerData, order_count: (data.order_count || 0) + 1 }).eq('id', existingId);
    }
  }
  if (!existingId && customerData.email) {
    const { data } = await supabase.from('customers')
      .select('id, order_count').eq('email', customerData.email).maybeSingle();
    if (data) {
      existingId = data.id;
      await supabase.from('customers').update({ ...customerData, order_count: (data.order_count || 0) + 1 }).eq('id', existingId);
    }
  }
  if (!existingId) {
    const { data, error } = await supabase.from('customers')
      .insert({ ...customerData, order_count: 1 }).select('id').single();
    if (error) throw new Error(`Customer error: ${error.message}`);
    existingId = data.id;
  }
  return existingId;
}

// ── Process one Shopify order → create job(s) ────────────────────────
async function processOrder(order) {
  // Skip if already exists in Supabase
  const { data: existing } = await supabase.from('jobs')
    .select('id').eq('shopify_order_id', order.id.toString()).maybeSingle();
  if (existing) return { skipped: true, order_number: order.order_number };

  const customerId = await upsertCustomer(order);
  const placedAt   = order.created_at || new Date().toISOString();
  const orderValue = parseFloat(order.total_price || 0);
  const orderNumber = `#${order.order_number}`;

  // Group line items by product type
  const byType = {};
  for (const item of order.line_items || []) {
    const type = detectProductType(item);
    if (!byType[type]) byType[type] = [];
    byType[type].push(item);
  }

  const types = Object.keys(byType);
  const isMulti = types.length > 1;
  const groupId = isMulti ? `SHOP-${order.id}` : null;
  const ship = order.shipping_address || order.billing_address || {};
  const deliveryAddress = ship.address1
    ? [ship.address1, ship.city, ship.province_code, ship.zip].filter(Boolean).join(', ')
    : null;

  const createdIds = [];

  for (const productType of types) {
    const items   = byType[productType];
    const isRolls = productType === 'rolls';
    const jobValue = isMulti
      ? Math.round((items.length / (order.line_items || []).length) * orderValue * 100) / 100
      : orderValue;

    const { data: job, error: jobErr } = await supabase.from('jobs').insert({
      shopify_order_id:     order.id.toString(),
      shopify_order_number: orderNumber,
      shopify_order_group:  groupId,
      customer_id:          customerId,
      source:               'shopify',
      status:               'new',
      dispatch_method:      ship.address1 ? 'road' : 'pickup',
      delivery_address:     deliveryAddress,
      is_outsourced:        isRolls,
      order_value:          jobValue,
      paid:                 true,
      placed_at:            placedAt,
      due_date:             calcDueDate(placedAt, productType),
      is_parent:            false,
      shopify_order_group:  groupId,
    }).select('id').single();

    if (jobErr) throw new Error(`Job error for order ${orderNumber}: ${jobErr.message}`);
    createdIds.push({ id: job.id, type: productType });

    // Job items
    let jobArtworkUrl = null;
    const jobItems = items.map(item => {
      const p = parseProps(item);
      if (p.artwork_url && !jobArtworkUrl) jobArtworkUrl = p.artwork_url;
      return {
        job_id:       job.id,
        product_type: productType,
        quantity:     p.qty_override || item.quantity,
        width_mm:     p.width_mm,
        height_mm:    p.height_mm,
        shape:        p.shape,
        material:     p.material,
        laminate:     p.laminate,
        unit_price:   parseFloat(item.price || 0),
      };
    });
    await supabase.from('job_items').insert(jobItems);
    if (jobArtworkUrl) {
      await supabase.from('jobs').update({
        artwork_url:      jobArtworkUrl,
        artwork_filename: jobArtworkUrl.split('/').pop().split('?')[0] || 'artwork',
      }).eq('id', job.id);
    }
  }

  // Mark parent/children for split orders
  if (isMulti && createdIds.length > 1) {
    await supabase.from('jobs').update({ is_parent: true }).eq('id', createdIds[0].id);
    for (let i = 1; i < createdIds.length; i++) {
      await supabase.from('jobs').update({ parent_job_id: createdIds[0].id }).eq('id', createdIds[i].id);
    }
  }

  return { created: true, order_number: orderNumber, jobs: createdIds.map(j => j.id) };
}

// ── Main handler ──────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Simple secret check to prevent accidental calls
  const secret = req.query.secret;
  if (process.env.SYNC_SECRET && secret !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Invalid secret. Pass ?secret=YOUR_SYNC_SECRET' });
  }

  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
    return res.status(500).json({ error: 'SHOPIFY_STORE_URL and SHOPIFY_ACCESS_TOKEN env vars required' });
  }

  try {
    const results = { created: [], skipped: [], errors: [] };
    let pageUrl = `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?status=open&fulfillment_status=unfulfilled&limit=250`;

    // Paginate through all open unfulfilled orders
    while (pageUrl) {
      const resp = await fetch(pageUrl, {
        headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
      });

      if (!resp.ok) throw new Error(`Shopify API error: ${resp.status} ${await resp.text()}`);
      const data = await resp.json();
      const orders = data.orders || [];

      console.log(`Processing ${orders.length} orders from this page…`);

      for (const order of orders) {
        try {
          const result = await processOrder(order);
          if (result.skipped) results.skipped.push(result.order_number);
          else results.created.push({ order: result.order_number, jobs: result.jobs });
        } catch (e) {
          console.error(`Error processing order #${order.order_number}:`, e.message);
          results.errors.push({ order: `#${order.order_number}`, error: e.message });
        }
      }

      // Check for next page via Link header
      const linkHeader = resp.headers.get('link') || '';
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      pageUrl = nextMatch ? nextMatch[1] : null;
    }

    console.log(`✓ Sync complete: ${results.created.length} created, ${results.skipped.length} skipped, ${results.errors.length} errors`);
    return res.status(200).json({
      success: true,
      summary: {
        created:  results.created.length,
        skipped:  results.skipped.length,
        errors:   results.errors.length,
      },
      details: results,
    });

  } catch (err) {
    console.error('sync-shopify-orders error:', err);
    return res.status(500).json({ error: err.message });
  }
}
