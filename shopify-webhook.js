// api/shopify-webhook.js
// Receives Shopify orders/paid webhook → creates job in Supabase
// Deploy in your Vercel project alongside index.html

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

// Service role client — bypasses RLS for server-side writes
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Verify Shopify HMAC signature ─────────────────────────────────────
function verifyShopifyWebhook(rawBody, signature) {
  const hash = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');
  return hash === signature;
}

// ── Map Shopify line item → our product type ──────────────────────────
function detectProductType(item) {
  const title = (item.title || '').toLowerCase().trim();
  const ptype = (item.product_type || '').toLowerCase();
  const text  = title + ' ' + ptype + ' ' + (item.vendor || '').toLowerCase();

  // Check if title STARTS WITH the product type (StickySitch format: "sheets | circle | ...")
  if (/^rolls?\b|^roll.?label/i.test(title))           return 'rolls';
  if (/^sheets?\b|^sticker.?sheet/i.test(title))        return 'sheets';
  if (/^bumper/i.test(title))                            return 'bumper';
  if (/^large.?format|^banner|^pull.?up/i.test(title))  return 'large';
  if (/^individual|^die.?cut|^custom.?sticker/i.test(title)) return 'individual';

  // Fallback: search anywhere in combined text
  if (text.includes('roll label') || text.includes('roll labels')) return 'rolls';
  if (text.includes('sticker sheet') || text.includes('sheet label')) return 'sheets';
  if (text.includes('bumper'))        return 'bumper';
  if (text.includes('large format') || text.includes('banner')) return 'large';
  return 'individual';
}

// ── Calculate due date skipping weekends ──────────────────────────────
function calcDueDate(placedAt, productType) {
  const days = productType === 'rolls' ? 3 : 2;
  const date = new Date(placedAt);
  let added = 0;
  while (added < days) {
    date.setDate(date.getDate() + 1);
    const dow = date.getDay();
    if (dow !== 0 && dow !== 6) added++; // skip Sun=0, Sat=6
  }
  return date.toISOString().split('T')[0]; // YYYY-MM-DD
}

// ── Parse specs from StickySitch product title ────────────────────────
// Title format: "sheets | circle | 65 × 65 mm | White Vinyl | Qty 50"
function parseTitleSpecs(item) {
  const title = item.title || '';
  const parts  = title.split('|').map(s => s.trim());
  let shape = null, widthMm = null, heightMm = null,
      material = null, laminate = null, qty = null;
  for (const part of parts) {
    const sizeMatch = part.match(/(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?)\s*mm/i);
    if (sizeMatch) { widthMm = parseFloat(sizeMatch[1]); heightMm = parseFloat(sizeMatch[2]); continue; }
    const qtyMatch = part.match(/qty\s*(\d+)|(\d+)\s*stickers?/i);
    if (qtyMatch) { qty = parseInt(qtyMatch[1] || qtyMatch[2]); continue; }
    // Laminate first (overlaps with material terms like "matte")
    if (/lam(inate)?|soft.?touch|gloss\s+lam|matte\s+lam|no.?lam/i.test(part) ||
        /^(matte|gloss|soft touch|none)$/i.test(part)) { laminate = part; continue; }
    // Material
    if (/vinyl|paper|film|polyprop|kraft|clear|transparent|white|silver|gold|chrome/i.test(part)) { material = part; continue; }
    // Shape — remaining non-type parts
    if (!/^(sheet|roll|sticker|bumper|large|individual)/i.test(part) && part.length > 1) shape = part;
  }
  // Fallback to properties
  const props = (item.properties || []);
  const fp = (re) => { const p = props.find(p => re.test(p.name)); return p ? p.value.trim() : null; };
  if (!widthMm)  { const w = fp(/width/i);   if (w) widthMm  = parseFloat(w); }
  if (!heightMm) { const h = fp(/height/i);  if (h) heightMm = parseFloat(h); }
  if (!material)  material = fp(/material|substrate|vinyl|paper/i);
  if (!laminate)  laminate = fp(/laminat|finish/i);
  if (!shape)     shape    = fp(/shape|die.?cut/i);
  if (!qty)       { const q = fp(/qty|quantity|sticker.?count|how.?many/i); if (q) qty = parseInt(q); }
  const artProp = props.find(p => /artwork|design.?file|upload|your.?file|file$/i.test(p.name));
  return { widthMm, heightMm, shape, material, laminate,
           qty: qty || item.quantity, artworkUrl: artProp ? artProp.value.trim() : null };
}

function parsePropsReal(item) {
  const props = (item.properties || []);

  const find = (pattern) => {
    const p = props.find(p => pattern.test(p.name));
    return p ? (p.value || '').trim() : null;
  };

  // Width / height (numeric mm values)
  const widthRaw  = find(/width|w\s*\(/i);
  const heightRaw = find(/height|h\s*\(/i);

  // Actual sticker/label quantity (often stored as a property, not Shopify line qty)
  const qtyProp = find(/^(qty|quantity|sticker.?count|how.?many|number.?of|pieces|labels|stickers)$/i);

  // Artwork / design file URL
  const artworkUrl = find(/artwork|design.?file|upload|your.?file|file|art$/i);

  // Visual properties
  const shape    = find(/shape|die.?cut|cut.?type/i);
  const material = find(/material|substrate|stock|vinyl|paper|film/i);
  const laminate = find(/laminat|laminate|finish|coat|gloss|matte|soft.?touch/i);

  return {
    width_mm:    widthRaw  ? parseFloat(widthRaw)  : null,
    height_mm:   heightRaw ? parseFloat(heightRaw) : null,
    qty_override: qtyProp  ? parseInt(qtyProp)      : null,
    artwork_url:  artworkUrl || null,
    shape:        shape    || null,
    material:     material || null,
    laminate:     laminate || null,
  };
}


// ── Upsert customer from Shopify order ────────────────────────────────
async function upsertCustomer(order) {
  const billing  = order.billing_address  || {};
  const shipping = order.shipping_address || {};
  const addr     = shipping.address1 ? shipping : billing;

  const addressFull = [
    addr.address1, addr.address2,
    addr.city, addr.province_code, addr.zip
  ].filter(Boolean).join(', ');

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

  // Upsert by shopify_customer_id if exists, otherwise by email
  let query = supabase.from('customers');
  let existingId = null;

  if (customerData.shopify_customer_id) {
    const { data: existing } = await supabase
      .from('customers')
      .select('id, order_count')
      .eq('shopify_customer_id', customerData.shopify_customer_id)
      .maybeSingle();

    if (existing) {
      existingId = existing.id;
      await supabase.from('customers')
        .update({ ...customerData, order_count: (existing.order_count || 0) + 1 })
        .eq('id', existingId);
    }
  }

  if (!existingId && customerData.email) {
    const { data: existing } = await supabase
      .from('customers')
      .select('id, order_count')
      .eq('email', customerData.email)
      .maybeSingle();

    if (existing) {
      existingId = existing.id;
      await supabase.from('customers')
        .update({ ...customerData, order_count: (existing.order_count || 0) + 1 })
        .eq('id', existingId);
    }
  }

  if (!existingId) {
    const { data: newCustomer, error } = await supabase
      .from('customers')
      .insert({ ...customerData, order_count: 1 })
      .select('id')
      .single();
    if (error) throw new Error(`Customer insert failed: ${error.message}`);
    existingId = newCustomer.id;
  }

  return existingId;
}

// ── Main handler ──────────────────────────────────────────────────────
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Read raw body for HMAC verification
  const rawBody = await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end',  () => resolve(data));
    req.on('error', reject);
  });

  // Verify webhook authenticity
  const signature = req.headers['x-shopify-hmac-sha256'];
  if (!signature || !verifyShopifyWebhook(rawBody, signature)) {
    console.error('Webhook HMAC verification failed');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let order;
  try {
    order = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  try {
    // ── Upsert customer ───────────────────────────────────────────────
    const customerId = await upsertCustomer(order);

    // ── Group line items by product type ─────────────────────────────
    // Each different product type becomes a separate job (split order)
    const itemsByType = {};
    for (const item of order.line_items || []) {
      const type = detectProductType(item);
      if (!itemsByType[type]) itemsByType[type] = [];
      itemsByType[type].push(item);
    }

    const productTypes = Object.keys(itemsByType);
    const isMultiple   = productTypes.length > 1;
    const placedAt     = order.created_at || new Date().toISOString();
    const orderValue   = parseFloat(order.total_price || 0);
    const orderGroup   = `SHOP-${order.id}`;
    const orderNumber  = `#${order.order_number}`;

    const createdJobIds = [];

    for (const [typeIndex, productType] of productTypes.entries()) {
      const items   = itemsByType[productType];
      const dueDate = calcDueDate(placedAt, productType);
      const isRolls = productType === 'rolls';

      // Shipping address for delivery
      const ship = order.shipping_address || order.billing_address || {};
      const deliveryAddress = ship.address1
        ? [ship.address1, ship.city, ship.province_code, ship.zip].filter(Boolean).join(', ')
        : null;

      // Split value proportionally by line item count if multiple types
      const jobValue = isMultiple
        ? Math.round((items.length / (order.line_items || []).length) * orderValue * 100) / 100
        : orderValue;

      // Create the job (id auto-generated as SS-XXXX by trigger)
      const { data: job, error: jobError } = await supabase
        .from('jobs')
        .insert({
          // id is auto-generated by trigger (SS-XXXX)
          shopify_order_id:     order.id?.toString(),
          shopify_order_number: orderNumber,
          shopify_order_group:  isMultiple ? orderGroup : null,
          customer_id:          customerId,
          source:               'shopify',
          status:               'new',
          dispatch_method:      ship.address1 ? 'road' : 'pickup',
          delivery_address:     deliveryAddress,
          is_outsourced:        isRolls,
          order_value:          jobValue,
          paid:                 true,
          placed_at:            placedAt,
          due_date:             dueDate,
          is_parent:            false,
          // Split orders: first job in group is parent, rest are children
          // We update this after all jobs are created
        })
        .select('id')
        .single();

      if (jobError) throw new Error(`Job insert failed: ${jobError.message}`);
      createdJobIds.push({ id: job.id, type: productType });

      // ── Create job_items for each line item of this type ─────────────
      let jobArtworkUrl = null;
      const jobItems = items.map(item => {
        const p = parseTitleSpecs(item);
        if (p.artworkUrl && !jobArtworkUrl) jobArtworkUrl = p.artworkUrl;
        return {
          job_id:       job.id,
          product_type: productType,
          quantity:     p.qty || item.quantity,
          width_mm:     p.widthMm,
          height_mm:    p.heightMm,
          shape:        p.shape,
          material:     p.material,
          laminate:     p.laminate,
          unit_price:   parseFloat(item.price || 0),
        };
      });

      await supabase.from('job_items').insert(jobItems);

      // Store artwork URL on the job if found in properties
      if (jobArtworkUrl) {
        await supabase.from('jobs').update({
          artwork_url:      jobArtworkUrl,
          artwork_filename: jobArtworkUrl.split('/').pop().split('?')[0] || 'artwork',
        }).eq('id', job.id);
      }
    }

    // ── Handle split orders: mark parent/children ─────────────────────
    if (isMultiple && createdJobIds.length > 1) {
      const parentId = createdJobIds[0].id;
      // Mark first as parent
      await supabase.from('jobs').update({ is_parent: true }).eq('id', parentId);
      // Mark rest as children
      for (let i = 1; i < createdJobIds.length; i++) {
        await supabase.from('jobs')
          .update({ parent_job_id: parentId })
          .eq('id', createdJobIds[i].id);
      }
    }

    console.log(`✓ Order ${orderNumber} created as job(s): ${createdJobIds.map(j => j.id).join(', ')}`);
    return res.status(200).json({
      success: true,
      jobs: createdJobIds.map(j => j.id)
    });

  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
