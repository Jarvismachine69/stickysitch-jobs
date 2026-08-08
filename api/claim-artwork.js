// api/claim-artwork.js  (job board Vercel repo)
// Accepts a forwarded artwork email (multipart), extracts the attachment,
// uploads it to Supabase Storage, and links it to the matching job by customer email.
//
// POST with multipart form:
//   email_from:  customer email address
//   email_body:  email text (optional, for AI spec extraction)
//   artwork:     the file attachment

import { createClient } from '@supabase/supabase-js';
import formidable from 'formidable';
import fs from 'fs';

export const config = { api: { bodyParser: false } };

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({ maxFileSize: 100 * 1024 * 1024 });
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      const f = {};
      for (const [k, v] of Object.entries(fields)) f[k] = Array.isArray(v) ? v[0] : v;
      resolve({ fields: f, files });
    });
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (req.query.secret !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'Unauthorised' });

  try {
    const { fields, files } = await parseForm(req);
    const customerEmail = (fields.email_from || '').toLowerCase().trim();
    const artFile = files.artwork?.[0] || files.artwork;

    if (!customerEmail) return res.status(400).json({ error: 'email_from is required' });
    if (!artFile)       return res.status(400).json({ error: 'artwork file is required' });

    // Find most recent job for this customer email
    const { data: job } = await supabase
      .from('jobs')
      .select('id, artwork_url, customer_email')
      .eq('customer_email', customerEmail)
      .order('placed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!job) {
      return res.status(404).json({
        error: `No job found for email ${customerEmail}. The Shopify order may not have synced yet.`
      });
    }

    // Upload artwork to Supabase Storage
    const ext      = (artFile.originalFilename || artFile.newFilename || 'file').split('.').pop();
    const filename = artFile.originalFilename || `artwork.${ext}`;
    const path     = `${job.id}/${Date.now()}_${filename}`;
    const buffer   = fs.readFileSync(artFile.filepath);

    const { error: uploadErr } = await supabase.storage
      .from('artwork')
      .upload(path, buffer, { contentType: artFile.mimetype || 'application/octet-stream', upsert: false });

    if (uploadErr) throw new Error('Upload failed: ' + uploadErr.message);

    const { data: { publicUrl } } = supabase.storage.from('artwork').getPublicUrl(path);

    // Link to job (if job already has artwork, save as proof version instead)
    if (job.artwork_url) {
      await supabase.from('proofs').insert({
        job_id: job.id, file_url: publicUrl, filename, status: 'artwork'
      });
    } else {
      await supabase.from('jobs').update({
        artwork_url: publicUrl, artwork_filename: filename
      }).eq('id', job.id);
    }

    return res.json({
      ok: true,
      message: `Artwork linked to ${job.id} (${customerEmail})`,
      job_id: job.id,
      artwork_url: publicUrl,
      already_had_artwork: !!job.artwork_url,
    });

  } catch (err) {
    console.error('claim-artwork error:', err);
    return res.status(500).json({ error: err.message });
  }
}
