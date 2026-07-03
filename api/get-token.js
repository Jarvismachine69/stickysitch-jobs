export default async function handler(req, res) {
  const { code } = req.query;
  const r = await fetch('https://bd3766-4.myshopify.com/admin/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: '31f17ff36255009506f81b78b8f8be2c',
      client_secret: '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',
      code
    })
  });
  const data = await r.json();
  res.json(data);
}
