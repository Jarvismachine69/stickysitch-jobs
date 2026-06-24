// api/shopify-webhook.js
// Receives Shopify orders/paid webhook -> creates job in Supabase
// Deploy in your Vercel project alongside index.html

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

// Service role client -- bypasses RLS for server-side writes
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Verify Shopify HMAC signature
function verifyShopifyWebhook(rawBody, signature) {
  const hash = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');
  return hash === signature;
}

// Map Shopify line item to our product type
function detectProductType(item) {
  const text = [
    item.title,
    item.product_type,
    item.vendor,
    (item.properties || []).map(p => p.name + ' ' + p.value).join(' ')
  ].join(' ').toLowerCase();

  if (text.includes('roll') || text.includes('roll label')) return 'rolls';
  if (text.includes('sticker sheet') || text.includes('sheet label')) return 'sheets';
  if (text.includes('bumper')) return 'bumper';
  if (text.includes('large format') || text.includes('banner') ||
      text.includes('pull up') || text.includes('pull-up')) return 'large';
  return 'individual';
}

// Calculate due date skipping weekends
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

// Parse size from line item properties
function parseSize(item) {
  const props = (item.properties || []);
  const widthProp  = props.find(p => /width/i.test(p.name));
  const heightProp = props.find(p => /height/i.test(p.name));
  return {
    width_mm:  widthProp  ? parseFloat(widthProp.value)  : null,
    height_mm: heightProp ? parseFloat(heightProp.value) : null,
  };
}

// Upsert customer from Shopify order
async function upsertCustomer(order) {
  const billing  = order.billing_address  || {};
  const shipping = order.shipping_address || {};
  const addr = shipping.address1 ? shipping : billing;

  const addressFull = [
    addr.address1, addr.address2,
    addr.city, addr.province_code, addr.zip
  ].filter(Boolean).join(', ');

  const customerData = {
    email:               order.email || order.contact_email || '',
    business_name:       billing.company || (((order.customer && order.customer.first_name) || '') + ' ' + ((order.customer && order.customer.last_name) || '')).trim() || 'Unknown',
    contact_name:        (((order.customer && order.customer.first_name) || '') + ' ' + ((order.customer && order.customer.last_name) || '')).trim() || null,
    phone:               order.phone || billing.phone || shipping.phone || null,
    address_full:        addressFull || null,
    address_street:      addr.address1      || null,
    address_suburb:      addr.city          || null,
    address_state:       addr.province_code || null,
    address_postcode:    addr.zip           || null,
    shopify_customer_id: (order.customer && order.customer.id) ? order.customer.id.toString() : null,
  };

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
    if (error) throw new Error('Customer insert failed: ' + error.message);
    existingId = newCustomer.id;
  }

  return existingId;
}

// Main handler
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end',  () => resolve(data));
    req.on('error', reject);
  });

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
    const customerId = await upsertCustomer(order);

    const itemsByType = {};
    for (const item of order.line_items || []) {
      const type = detectProductType(item);
      if (!itemsByType[type]) itemsByType[type] = [];
      itemsByType[type].push(item);
    }

    const productTypes  = Object.keys(itemsByType);
    const isMultiple    = productTypes.length > 1;
    const placedAt      = order.created_at || new Date().toISOString();
    const orderValue    = parseFloat(order.total_price || 0);
    const orderGroup    = 'SHOP-' + order.id;
    const orderNumber   = '#' + order.order_number;

    const createdJobIds = [];

    for (const [typeIndex, productType] of productTypes.entries()) {
      const items   = itemsByType[productType];
      const dueDate = calcDueDate(placedAt, productType);
      const isRolls = productType === 'rolls';

      const ship = order.shipping_address || order.billing_address || {};
      const deliveryAddress = ship.address1
        ? [ship.address1, ship.city, ship.province_code, ship.zip].filter(Boolean).join(', ')
        : null;

      const jobValue = isMultiple
        ? Math.round((items.length / (order.line_items || []).length) * orderValue * 100) / 100
        : orderValue;

      const { data: job, error: jobError } = await supabase
        .from('jobs')
        .insert({
          shopify_order_id:     order.id ? order.id.toString() : null,
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
        })
        .select('id')
        .single();

      if (jobError) throw new Error('Job insert failed: ' + jobError.message);
      createdJobIds.push({ id: job.id, type: productType });

      const jobItems = items.map(item => {
        const size = parseSize(item);
        return {
          job_id:       job.id,
          product_type: productType,
          quantity:     item.quantity,
          width_mm:     size.width_mm,
          height_mm:    size.height_mm,
          unit_price:   parseFloat(item.price || 0),
        };
      });

      await supabase.from('job_items').insert(jobItems);
    }

    if (isMultiple && createdJobIds.length > 1) {
      const parentId = createdJobIds[0].id;
      await supabase.from('jobs').update({ is_parent: true }).eq('id', parentId);
      for (let i = 1; i < createdJobIds.length; i++) {
        await supabase.from('jobs')
          .update({ parent_job_id: parentId })
          .eq('id', createdJobIds[i].id);
      }
    }

    console.log('Order ' + orderNumber + ' created as job(s): ' + createdJobIds.map(j => j.id).join(', '));
    return res.status(200).json({
      success: true,
      jobs: createdJobIds.map(j => j.id)
    });

  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
