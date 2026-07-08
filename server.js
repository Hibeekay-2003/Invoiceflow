/* ============================================================
   InvoiceFlow – server.js
   REST API + static file server
   Data stored in data.json (auto-created on first run)
   Listen on 0.0.0.0 – works locally, on LAN, and on Railway
   ============================================================ */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const nodemailer = require('nodemailer');

const PORT      = process.env.PORT || 7821;   // Railway injects PORT automatically
const BASE      = __dirname;
/* On Railway with a mounted volume at /data, keep data.json there.
   Locally (no DATA_DIR env var), keep it next to server.js as before. */
const DATA_DIR  = process.env.DATA_DIR || BASE;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.js'  : 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png' : 'image/png',
  '.jpg' : 'image/jpeg',
  '.svg' : 'image/svg+xml',
  '.ico' : 'image/x-icon',
};

/* ── Default empty state ─────────────────────────────────── */
const DEFAULT_STATE = {
  invoices:   [],
  quotations: [],
  items:      [],
  customers:  [],
  settings: {
    company: 'Your Company', address: '', email: '', phone: '',
    currency: '₦', taxRate: 7.5, logo: '', footer: 'Thank you for your business!',
    bankDetails: '', tin: '',
    smtp: { host: '', port: '587', user: '', pass: '', from: '' }
  },
  counters: { nextInvoice: 1, nextQuotation: 1 },
};

/* ── Read / write data.json ──────────────────────────────── */
function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeData(data) {
  /* Atomic write: write to a temp file then rename */
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

/* ── Auto-backup on startup ──────────────────────────────── */
function backup() {
  if (!fs.existsSync(DATA_FILE)) return; // nothing to back up yet
  const ts  = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = path.join(BASE, `data_backup_${ts}.json`);
  fs.copyFileSync(DATA_FILE, dst);
  console.log(`  Backup saved → ${path.basename(dst)}`);
}

/* ── Helpers ─────────────────────────────────────────────── */
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => { chunks.push(chunk); });
    req.on('end',  ()    => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ── HTTP server ─────────────────────────────────────────── */
const server = http.createServer(async (req, res) => {
  cors(res);

  /* Pre-flight */
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const urlPath = new URL(req.url, `http://localhost`).pathname;

  /* ── API: GET /api/data ── */
  if (urlPath === '/api/data' && req.method === 'GET') {
    json(res, 200, readData());
    return;
  }

  /* ── API: POST /api/data ── */
  if (urlPath === '/api/data' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);

      /* Safety: keep only known keys */
      const safe = {
        invoices:   Array.isArray(data.invoices)   ? data.invoices   : [],
        quotations: Array.isArray(data.quotations) ? data.quotations : [],
        items:      Array.isArray(data.items)      ? data.items      : [],
        customers:  Array.isArray(data.customers)  ? data.customers  : [],
        settings:   data.settings  || DEFAULT_STATE.settings,
        counters:   data.counters  || DEFAULT_STATE.counters,
      };

      writeData(safe);
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 400, { error: 'Invalid JSON: ' + e.message });
    }
    return;
  }

  /* ── API: POST /api/send-email ── */
  if (urlPath === '/api/send-email' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const { to, subject, html, printHtml, smtp } = data;

      if (!smtp || !smtp.host || !smtp.user || !smtp.pass) {
        json(res, 400, { error: 'Incomplete SMTP settings.' });
        return;
      }

      if (!printHtml) {
        json(res, 400, { error: 'Please HARD REFRESH your browser (Ctrl+F5). Your browser is using an old cached version of the app and failed to send the invoice HTML.' });
        return;
      }

      const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: parseInt(smtp.port) || 587,
        secure: parseInt(smtp.port) === 465,
        auth: {
          user: smtp.user,
          pass: smtp.pass
        },
        tls: { rejectUnauthorized: false }
      });

      // Require puppeteer inline in case it hasn't finished installing yet during boot
      const puppeteer = require('puppeteer');
      
      console.log('[InvoiceFlow] Launching Puppeteer to generate PDF...');
      const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'] // required to launch in containerized hosts like Railway/Docker
      });
      const page = await browser.newPage();
      
      // Inject the local style.css directly into the printHtml so Puppeteer renders it perfectly
      const cssPath = path.join(BASE, 'style.css');
      let cssContent = '';
      try { cssContent = fs.readFileSync(cssPath, 'utf8'); } catch(e) { console.warn('Could not read style.css for PDF'); }
      
      const fullHtml = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>${cssContent}</style>
            <!-- Setup the exact A4 Print Layout -->
            <style>
              body { background: white; margin: 0; padding: 0; }
              .print-area { padding: 0 !important; }
            </style>
          </head>
          <body>
            <div class="print-area" style="display:block;">
              ${printHtml}
            </div>
          </body>
        </html>
      `;

      try {
        fs.writeFileSync(path.join(BASE, 'debug.html'), fullHtml, 'utf8');
      } catch (err) {}

      // Load HTML and wait for network/fonts
      await page.setContent(fullHtml, { waitUntil: 'networkidle0' });
      await page.emulateMediaType('print'); // matches the @media print rules in style.css that reveal .print-area
      
      
      console.log('[InvoiceFlow] Printing to PDF buffer...');
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '0', bottom: '0', left: '0', right: '0' }
      });
      await browser.close();

      const mailOptions = {
        from: smtp.from || smtp.user,
        to: to,
        subject: subject,
        html: html,
        attachments: [
          {
            filename: 'document.pdf',
            content: pdfBuffer,
            contentType: 'application/pdf'
          }
        ]
      };

      console.log('[InvoiceFlow] Sending email with PDF attachment...');
      await transporter.sendMail(mailOptions);
      json(res, 200, { ok: true });
    } catch (e) {
      console.error('[InvoiceFlow] Email send error:', e);
      json(res, 500, { error: e.message });
    }
    return;
  }

  /* ── Static files ── */
  const filePath = (urlPath === '/' ? '/index.html' : urlPath);
  const fullPath = path.join(BASE, filePath);

  /* Security: prevent path traversal outside BASE */
  if (!fullPath.startsWith(BASE + path.sep) && fullPath !== BASE) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  try {
    const content = fs.readFileSync(fullPath);
    const ext     = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

/* ── Start ───────────────────────────────────────────────── */
backup();   // Save a timestamped copy of data.json before we start

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  ✅  InvoiceFlow server is running\n');
  console.log(`  Local:   http://localhost:${PORT}`);

  /* Print LAN IPs */
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  Network: http://${net.address}:${PORT}`);
      }
    }
  }

  if (!process.env.PORT) {
    console.log('\n  For remote access:');
    console.log('  ngrok http --url=<your-static-domain>.ngrok-free.app 7821');
  } else {
    console.log('\n  ☁️  Running on Railway cloud');
  }
  console.log();
});
