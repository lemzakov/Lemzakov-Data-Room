const { getRuntimeConfig } = require('../lib/config');
const { readHtml } = require('../lib/storage');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  const slug = (req.query.slug || '').toString().toLowerCase().trim();
  if (!slug) {
    return res.status(400).send('Missing HTML slug');
  }

  try {
    const { storagePrefix } = getRuntimeConfig();
    const html = await readHtml(storagePrefix, slug);
    if (!html) {
      return res.status(404).send('HTML file not found');
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (error) {
    console.error('Failed to load HTML');
    return res.status(500).send('Failed to load HTML');
  }
};
