// api/shopify-webhook.js  (job board Vercel repo)
// Receives Shopify orders/paid webhook → creates or updates job in Supabase.
// Handles: draft-order-originated paid orders, idempotency, note_attributes specs,
// pending_orders artwork matching, and multi-item orders.

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Verify Shopify HMAC ──────────────────────────────────────────────
function verifyShopifyWebhook(rawBody, signature) {
  if (!process.env.SHOPIFY_WEBHOOK_SECRET) return true; // skip if not set
  const hash = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');
  return hash === signature;
}

// ── Calculate due date (skip weekends) ──────────────────────────────
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

// ── Detect product type from title ──────────────────────────────────
function detectProductType(item, noteAttrs) {
  const title = (item.title || '').toLowerCase();
  const pt    = (noteAttrs['product type'] || noteAttrs['product'] || '').toLowerCase();
  if (/^rolls?\b|^roll.?label|rolls/i.test(title) || pt === 'rolls')       return 'rolls';
  if (/^sheets?\b|^sticker.?sheet|sheets/i.test(title) || pt === 'sheets') return 'sheets';
  if (/^bumper/i.test(title) || pt === 'bumper')                            return 'bumper';
  if (/^individual|^die.?cut/i.test(title) || pt === 'individual')          return 'individual';
  return 'individual';
}

// ── Normalise laminate string ────────────────────────────────────────
function normaliseLaminate(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (/matte/i.test(s))       return 'Matte';
  if (/gloss/i.test(s))       return 'Gloss';
  if (/soft.?touch/i.test(s)) return 'Soft Touch';
  if (/none|no.?lam/i.test(s)) return 'None';
  return s;
}

// ── Parse all specs from note_attributes + order.note ───────────────
// Shopify stores configurator data in note_attributes (REST) = customAttributes (GraphQL)
function parseOrderSpecs(order) {
  const attrs = {};

  // note_attributes (REST API format used in webhooks)
  (order.note_attributes || []).forEach(a => {
    attrs[a.name.toLowerCase().trim()] = (a.value || '').trim();
  });

  // Also parse order.note freetext (key: value lines)
  (order.note || '').split('\n').forEach(line => {
    const m = line.match(/^([^:]+):\s*(.+)/);
    if (m) attrs[m[1].toLowerCase().trim()] = m[2].trim();
  });

  // Extract size from "40 × 40 mm" format
  const rawSize = attrs['size'] || '';
  let widthMm = null, heightMm = null;
  const sm = rawSize.match(/(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?)/i);
  if (sm) { widthMm = parseFloat(sm[1]); heightMm = parseFloat(sm[2]); }

  // Extract quantity
  const qtyRaw = attrs['quantity'] || '';
  const qty = parseInt(qtyRaw.replace(/[^\d]/g, '')) || null;

  return {
    productType: attrs['product type'] || attrs['product'] || null,
    shape:       attrs['shape']   || null,
    widthMm,
    heightMm,
    material:    attrs['material'] || null,
    laminate:    normaliseLaminate(attrs['laminate'] || attrs['finish'] || null),
    qty,
    artworkStatus: attrs['artwork status'] || null,
    draftOrderRef: attrs['draft order'] || attrs['order reference'] || null,
    estimatedDelivery: attrs['est. delivery'] || attrs['estimated delivery'] || null,
    rawAttrs: attrs,
  };
}

// ── Parse artwork URL from line item properties ──────────────────────
function findArtworkUrl(item) {
  const props = item.properties || [];
  const artProp = props.find(p =>
    /artwork|design.?file|upload|file|art|image|logo|pdf/i.test(p.name || '') ||
    /^https?:\/\/(cdn\.shopify|files\.shopifycdn)/i.test((p.value || '').trim())
  );
  return artProp ? artProp.value.trim() : null;
}

// ── Upsert customer ──────────────────────────────────────────────────
async function upsertCustomer(order) {
  const billing  = order.billing_address  || {};
  const shipping = order.shipping_address || {};
  const addr     = shipping.address1 ? shipping : billing;

  const addressFull = [addr.address1, addr.city, addr.province_code, addr.zip]
    .filter(Boolean).join(', ');

  const name = `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim();
  const customerData = {
    email:               (order.email || order.contact_email || '').toLowerCase().trim(),
    business_name:       billing.company || name || 'Unknown',
    contact_name:        name || null,
    phone:               order.phone || billing.phone || shipping.phone || null,
    address_full:        addressFull || null,
    shopify_customer_id: order.customer?.id?.toString() || null,
  };

  // Try by Shopify customer ID first
  if (customerData.shopify_customer_id) {
    const { data: ex } = await supabase.from('customers')
      .select('id').eq('shopify_customer_id', customerData.shopify_customer_id).maybeSingle();
    if (ex) {
      await supabase.from('customers').update(customerData).eq('id', ex.id);
      return ex.id;
    }
  }

  // Try by email
  if (customerData.email) {
    const { data: ex } = await supabase.from('customers')
      .select('id').eq('email', customerData.email).maybeSingle();
    if (ex) {
      await supabase.from('customers').update(customerData).eq('id', ex.id);
      return ex.id;
    }
  }

  // Create new customer
  const { data: newCust, error } = await supabase.from('customers')
    .insert({ ...customerData, order_count: 1 }).select('id').single();
  if (error) throw new Error(`Customer insert failed: ${error.message}`);
  return newCust.id;
}

// ── Main handler ─────────────────────────────────────────────────────
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rawBody = await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end',  () => resolve(data));
    req.on('error', reject);
  });

  // HMAC verification
  const signature = req.headers['x-shopify-hmac-sha256'];
  if (signature && !verifyShopifyWebhook(rawBody, signature)) {
    console.error('Webhook HMAC verification failed');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let order;
  try { order = JSON.parse(rawBody); }
  catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }

  const shopifyOrderId = order.id?.toString();
  const orderNumber    = String(order.order_number); // stored WITHOUT # prefix
  const customerEmail  = (order.email || '').toLowerCase().trim();
  const placedAt       = order.created_at || new Date().toISOString();

  console.log(`Webhook received: order #${orderNumber} (${shopifyOrderId}) — ${customerEmail}`);

  try {
    // ── IDEMPOTENCY: return 200 immediately if job already exists ────
    if (shopifyOrderId) {
      const { data: existingJob } = await supabase
        .from('jobs').select('id').eq('shopify_order_id', shopifyOrderId).maybeSingle();
      if (existingJob) {
        console.log(`Order #${orderNumber} already exists as ${existingJob.id} — skipping`);
        return res.status(200).json({ success: true, skipped: true, job: existingJob.id });
      }
    }

    // ── Parse specs from note_attributes (contains configurator data) ─
    const specs = parseOrderSpecs(order);
    const isFromDraftOrder = order.source_name === 'shopify_draft_order';

    // ── Upsert customer ──────────────────────────────────────────────
    const customerId = await upsertCustomer(order);

    // ── Shipping address ─────────────────────────────────────────────
    const ship = order.shipping_address || order.billing_address || {};
    const deliveryAddress = ship.address1
      ? [ship.address1, ship.city, ship.province_code, ship.zip].filter(Boolean).join(', ')
      : null;

    // ── Detect product type ──────────────────────────────────────────
    // For StickySitch, each order is typically one product type
    const items = order.line_items || [];
    const firstItem = items[0] || {};
    const productType = specs.productType || detectProductType(firstItem, specs.rawAttrs);
    const dueDate = calcDueDate(placedAt, productType);

    // ── Find artwork URL from line item properties (if any) ──────────
    let artworkUrl = null;
    let artworkFilename = null;
    for (const item of items) {
      const url = findArtworkUrl(item);
      if (url) { artworkUrl = url; artworkFilename = url.split('/').pop().split('?')[0]; break; }
    }

    // ── Create the job ───────────────────────────────────────────────
    const { data: job, error: jobError } = await supabase.from('jobs').insert({
      shopify_order_id:     shopifyOrderId,
      shopify_order_number: orderNumber,
      customer_id:          customerId,
      source:               'shopify',
      status:               'new',
      dispatch_method:      ship.address1 ? 'road' : 'pickup',
      delivery_address:     deliveryAddress,
      order_value:          parseFloat(order.total_price || 0),
      paid:                 true,
      placed_at:            placedAt,
      due_date:             dueDate,
      artwork_url:          artworkUrl || null,
      artwork_filename:     artworkFilename || null,
    }).select('id').single();

    if (jobError) throw new Error(`Job insert failed: ${jobError.message}`);
    console.log(`Created job ${job.id} for order #${orderNumber}`);

    // ── Create job_items ─────────────────────────────────────────────
    const jobItems = items.map(item => ({
      job_id:       job.id,
      product_type: productType,
      quantity:     specs.qty || item.quantity,
      width_mm:     specs.widthMm || null,
      height_mm:    specs.heightMm || null,
      shape:        specs.shape || null,
      material:     specs.material || null,
      laminate:     specs.laminate || null,
      unit_price:   parseFloat(item.price || 0),
    }));

    const { error: itemsError } = await supabase.from('job_items').insert(jobItems);
    if (itemsError) console.error('job_items insert error:', itemsError.message);

    // ── Match pending_orders by email for artwork linking ────────────
    if (!artworkUrl && customerEmail) {
      const { data: pendingRecords } = await supabase
        .from('pending_orders')
        .select('*')
        .eq('email', customerEmail)
        .is('matched_job_id', null)
        .order('created_at', { ascending: false });

      const pending = pendingRecords || [];
      if (pending.length > 0) {
        // Match by product type if possible, otherwise take most recent
        const match = pending.find(p =>
          !p.product_type || (p.product_type || '').toLowerCase().includes(productType)
        ) || pending[0];

        if (match && match.artwork_url) {
          await supabase.from('jobs').update({
            artwork_url:      match.artwork_url,
            artwork_filename: match.artwork_filename || 'artwork',
          }).eq('id', job.id);

          await supabase.from('pending_orders')
            .update({ matched_job_id: job.id, matched_at: new Date().toISOString() })
            .eq('id', match.id);

          console.log(`✓ Linked artwork from pending_orders ${match.id} to job ${job.id}`);
        }
      }
    }

    return res.status(200).json({ success: true, job: job.id, order: orderNumber });

  } catch (err) {
    console.error(`Webhook error for order #${orderNumber}:`, err.message);
    // Return 200 to prevent Shopify from deleting the webhook subscription on repeated 500s
    // Log the error but acknowledge receipt
    return res.status(200).json({
      success:  false,
      error:    err.message,
      order:    orderNumber,
      _note:    'Returning 200 to prevent webhook deletion. Check Vercel logs.'
    });
  }
}
