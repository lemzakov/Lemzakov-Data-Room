const { getRuntimeConfig } = require('../lib/config');
const syncHandler = require('./sync');

module.exports = async function handler(req, res) {
  if (req.method === 'GET' && !req.query.run) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Secret Refresh</title></head>
  <body>
    <h1>Manual HTML Sync</h1>
    <form method="GET" action="/secret-refresh">
      <input type="hidden" name="run" value="1" />
      <label>Secret: <input type="password" name="secret" /></label>
      <button type="submit">Sync now</button>
    </form>
  </body>
</html>`);
  }

  const cfg = getRuntimeConfig();
  if (cfg.syncSecret && req.query.secret !== cfg.syncSecret) {
    return res.status(401).send('Unauthorized');
  }

  return syncHandler(req, res);
};
