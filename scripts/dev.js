/* Local preview server: mirrors vercel.json rewrites and runs /api/apply. No dependencies.
   Usage: npm run dev   (then open http://localhost:3000/vsl)
   Optional: APPLY_WEBHOOK_URL=https://... npm run dev   to test real forwarding. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const apply = require('../api/apply.js');
const routes = { '/': '/vsl.html', '/vsl': '/vsl.html' };
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.json': 'application/json' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/apply') {
    let raw = ''; req.on('data', c => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try { req.body = raw ? JSON.parse(raw) : null; } catch (e) { req.body = raw; }
      res.status = c => { res.statusCode = c; return res; };
      res.json = o => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
      apply(req, res);
    });
    return;
  }
  const rel = routes[url.pathname] || url.pathname;
  const file = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(root) || /[/\\](api|scripts|tests|node_modules|\.git)[/\\]/.test(file.slice(root.length))) { res.statusCode = 404; return res.end('Not found'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.statusCode = 404; return res.end('Not found'); }
    const range = req.headers.range, type = types[path.extname(file)] || 'application/octet-stream';
    if (range && /^bytes=/.test(range)) {
      const [s, e] = range.replace('bytes=', '').split('-'); const start = +s, end = e ? +e : st.size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  });
}).listen(process.env.PORT || 3000, () => console.log('GTME VSL preview on http://localhost:' + (process.env.PORT || 3000) + '/vsl'));
