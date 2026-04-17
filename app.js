/* ============================================================
   InvoiceFlow – app.js
   Full SPA: Dashboard | Invoices | Quotations | Items | Settings
   Persistence: Firebase Firestore (cloud, always-on, free)
   ============================================================ */

'use strict';

/* ─────────────────────────────────────────────
   1. FIREBASE / FIRESTORE STORAGE HELPERS
   `window.db` is set in index.html before this
   script loads (Firebase compat SDK).
───────────────────────────────────────────── */

const FS_DOC = () => window.db.collection('invoiceflow').doc('appState');

/* Push the entire state to Firestore (fire & forget) */
function persist(/*key – kept for compat, ignored*/) {
  FS_DOC().set({
    invoices:   state.invoices,
    quotations: state.quotations,
    items:      state.items,
    customers:  state.customers,
    settings:   state.settings,
    counters:   state.counters,
  }).catch(e => console.warn('[InvoiceFlow] save failed:', e));
}

/* Load all data from Firestore, merge into state */
async function fetchState() {
  try {
    const snap = await FS_DOC().get();
    if (!snap.exists) return;          // First run — no data yet
    const data = snap.data();
    state.invoices   = data.invoices   || [];
    state.quotations = data.quotations || [];
    state.items      = data.items      || [];
    state.customers  = data.customers  || [];
    state.settings   = Object.assign({}, DEFAULT_SETTINGS, data.settings);
    state.counters   = data.counters   || { nextInvoice: 1, nextQuotation: 1 };
  } catch(e) {
    console.warn('[InvoiceFlow] load failed (using defaults):', e);
  }
}

/* ── One-time data migration: import a local data.json into Firestore ── */
window.importDataFromJSON = function() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const safe = {
        invoices:   Array.isArray(data.invoices)   ? data.invoices   : [],
        quotations: Array.isArray(data.quotations) ? data.quotations : [],
        items:      Array.isArray(data.items)      ? data.items      : [],
        customers:  Array.isArray(data.customers)  ? data.customers  : [],
        settings:   data.settings  || DEFAULT_SETTINGS,
        counters:   data.counters  || { nextInvoice: 1, nextQuotation: 1 },
      };
      await FS_DOC().set(safe);
      // Reload state from what we just wrote
      state.invoices   = safe.invoices;
      state.quotations = safe.quotations;
      state.items      = safe.items;
      state.customers  = safe.customers;
      state.settings   = Object.assign({}, DEFAULT_SETTINGS, safe.settings);
      state.counters   = safe.counters;
      document.getElementById('sidebar-company-name').textContent = state.settings.company || 'Your Company';
      toast(`✅ Imported ${safe.invoices.length} invoices, ${safe.quotations.length} quotations, ${safe.items.length} items, ${safe.customers.length} customers.`, 'success');
      renderView(state.currentView);
    } catch(err) {
      toast('Import failed: ' + err.message, 'error');
      console.error(err);
    }
  };
  input.click();
};

/* ─────────────────────────────────────────────
   2. STATE  (populated async from server on load)
───────────────────────────────────────────── */
const DEFAULT_SETTINGS = {
  company: 'Your Company', address: '', email: '', phone: '',
  currency: '₦', taxRate: 7.5, logo: '', footer: 'Thank you for your business!',
  bankDetails: '', tin: '',
};

let state = {
  invoices:    [],
  quotations:  [],
  items:       [],
  customers:   [],
  settings:    { ...DEFAULT_SETTINGS },
  counters:    { nextInvoice: 1, nextQuotation: 1 },
  activeFilter: 'all',
  currentView:  'dashboard',
};


/* ─────────────────────────────────────────────
   3. COUNTERS / NUMBER GENERATION
───────────────────────────────────────────── */
function genNumber(type) {
  const pad = n => String(n).padStart(4, '0');
  let num;
  if (type === 'invoice') {
    num = `INV-${pad(state.counters.nextInvoice)}`;
    state.counters.nextInvoice++;
  } else {
    num = `QUO-${pad(state.counters.nextQuotation)}`;
    state.counters.nextQuotation++;
  }
  persist('counters');
  return num;
}

/* ─────────────────────────────────────────────
   4. CALCULATIONS
───────────────────────────────────────────── */
function calcLines(lines, taxRate) {
  const subtotal = lines.reduce((s, l) => s + (parseFloat(l.qty)||0)*(parseFloat(l.unitPrice)||0), 0);
  const tax      = subtotal * (parseFloat(taxRate)||0) / 100;
  return { subtotal, tax, total: subtotal + tax };
}

function fmtMoney(n) {
  const c = state.settings.currency || '$';
  return `${c}${parseFloat(n||0).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}`;
}

function fmtShort(n) {
  const c = state.settings.currency || '$';
  const v = parseFloat(n || 0);
  if (v >= 1_000_000_000) return `${c}${(v / 1_000_000_000).toFixed(v % 1_000_000_000 === 0 ? 0 : 1)}B`;
  if (v >= 1_000_000)     return `${c}${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1_000)         return `${c}${(v / 1_000).toFixed(v % 1_000 === 0 ? 0 : 1)}K`;
  return `${c}${v.toFixed(2)}`;
}

function today() { return new Date().toISOString().split('T')[0]; }
function addDays(d, n) { const dt = new Date(d); dt.setDate(dt.getDate()+n); return dt.toISOString().split('T')[0]; }
function fmtDate(d) { if (!d) return '—'; const [y,m,dy] = d.split('-'); return `${dy}/${m}/${y}`; }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

/* ─────────────────────────────────────────────
   5. CRUD – INVOICES
───────────────────────────────────────────── */
function saveInvoice(data) {
  const { subtotal, tax, total } = calcLines(data.lineItems || [], data.taxRate);
  const record = { ...data, subtotal, tax, total, updatedAt: new Date().toISOString() };
  const idx = state.invoices.findIndex(x => x.id === record.id);
  if (idx >= 0) state.invoices[idx] = record;
  else { record.id = uid(); record.number = genNumber('invoice'); record.createdAt = record.updatedAt; state.invoices.unshift(record); }
  persist('invoices');
  return record;
}

function deleteInvoice(id) { state.invoices = state.invoices.filter(x => x.id !== id); persist('invoices'); }

/* ─────────────────────────────────────────────
   6. CRUD – QUOTATIONS
───────────────────────────────────────────── */
function saveQuotation(data) {
  const { subtotal, tax, total } = calcLines(data.lineItems || [], data.taxRate);
  const record = { ...data, subtotal, tax, total, updatedAt: new Date().toISOString() };
  const idx = state.quotations.findIndex(x => x.id === record.id);
  if (idx >= 0) state.quotations[idx] = record;
  else { record.id = uid(); record.number = genNumber('quotation'); record.createdAt = record.updatedAt; state.quotations.unshift(record); }
  persist('quotations');
  return record;
}

function deleteQuotation(id) { state.quotations = state.quotations.filter(x => x.id !== id); persist('quotations'); }

function convertQuotationToInvoice(qid) {
  const q = state.quotations.find(x => x.id === qid);
  if (!q) return;
  const inv = saveInvoice({
    date: today(), dueDate: addDays(today(), 30),
    status: 'draft',
    client: { ...q.client },
    lineItems: q.lineItems.map(l => ({ ...l })),
    taxRate: q.taxRate,
    notes: q.notes,
    fromQuotation: q.number,
  });
  const qi = state.quotations.findIndex(x => x.id === qid);
  state.quotations[qi].status = 'converted';
  state.quotations[qi].convertedToInvoiceId = inv.id;
  persist('quotations');
  return inv;
}

/* ─────────────────────────────────────────────
   7. CRUD – ITEMS CATALOG
───────────────────────────────────────────── */
function saveItem(data) {
  const record = { ...data, updatedAt: new Date().toISOString() };
  const idx = state.items.findIndex(x => x.id === record.id);
  if (idx >= 0) state.items[idx] = record;
  else { record.id = uid(); record.createdAt = record.updatedAt; state.items.push(record); }
  persist('items');
  return record;
}

function deleteItem(id) { state.items = state.items.filter(x => x.id !== id); persist('items'); }

/* ─────────────────────────────────────────────
   8. DASHBOARD STATS
───────────────────────────────────────────── */
function getDashboardStats() {
  const totalInvoiced  = state.invoices.reduce((s,i) => s + (i.total||0), 0);
  const totalPaid      = state.invoices.filter(i => i.status==='paid').reduce((s,i) => s + (i.total||0), 0);
  const totalOutstanding = state.invoices.filter(i => ['sent','overdue','draft'].includes(i.status)).reduce((s,i) => s + (i.total||0), 0);
  const totalQuoted    = state.quotations.reduce((s,q) => s + (q.total||0), 0);
  const quotedAccepted = state.quotations.filter(q => q.status==='accepted'||q.status==='converted').reduce((s,q) => s + (q.total||0), 0);
  return { totalInvoiced, totalPaid, totalOutstanding, totalQuoted, quotedAccepted,
    invCount: state.invoices.length, quotCount: state.quotations.length, itemCount: state.items.length };
}

/* ─────────────────────────────────────────────
   9. TOAST
───────────────────────────────────────────── */
function toast(msg, type='info') {
  const icons = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>',
    error:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type]||icons.info}</span><span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => { el.style.opacity='0'; el.style.transform='translateX(20px)'; el.style.transition='all 0.3s'; setTimeout(()=>el.remove(), 300); }, 3000);
}

/* ─────────────────────────────────────────────
   10. MODAL ENGINE
───────────────────────────────────────────── */
function openModal({ title, body, footer, wide=false }) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = body;
  document.getElementById('modal-footer').innerHTML = footer || '';
  const modal = document.getElementById('modal');
  modal.className = 'modal' + (wide ? ' modal-wide' : '');
  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal() { document.getElementById('modal-overlay').classList.remove('open'); }

/* ─────────────────────────────────────────────
   11. NAVIGATION
───────────────────────────────────────────── */
const VIEW_TITLES = { dashboard:'Dashboard', invoices:'Invoices', quotations:'Quotations', items:'Items / Products', customers:'Customers', settings:'Settings' };

function navigate(view) {
  // Only reset filter when switching to a different view
  if (state.currentView !== view) {
    state.activeFilter = 'all';
  }
  state.currentView = view;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  document.getElementById('page-title').textContent = VIEW_TITLES[view] || view;
  renderView(view);
}

function renderView(view) {
  const vc = document.getElementById('view-container');
  const ta = document.getElementById('topbar-actions');
  ta.innerHTML = '';
  if (view === 'dashboard')   { renderDashboard(vc); }
  else if (view === 'invoices')   { renderInvoicesView(vc, ta); }
  else if (view === 'quotations') { renderQuotationsView(vc, ta); }
  else if (view === 'items')      { renderItemsView(vc, ta); }
  else if (view === 'customers')  { renderCustomersView(vc, ta); }
  else if (view === 'settings')   { renderSettingsView(vc, ta); }
}

/* ─────────────────────────────────────────────
   12. SHARED: LINE-ITEM BUILDER
───────────────────────────────────────────── */
function lineItemsHTML(lines=[]) {
  const rows = lines.map((l,i) => lineItemRow(l,i)).join('');
  return `
  <div class="line-items-header">
    <span>Item / Description</span><span>Unit</span><span>Qty</span><span>Unit Price</span><span></span>
  </div>
  <div id="line-items-body">${rows}</div>
  <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center">
    <button class="btn btn-ghost btn-sm" id="add-line-btn" type="button">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Add Line
    </button>
    <label class="btn btn-ghost btn-sm" style="cursor:pointer;margin:0" title="Import rows from Excel (.xlsx/.xls/.csv). Columns: Description, Unit, Qty, Unit Price">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:#22c55e"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>
      Import from Excel
      <input type="file" id="excel-import-input" accept=".xlsx,.xls,.csv" style="display:none" onchange="importExcelLines(this)" />
    </label>
    <span id="excel-import-status" style="font-size:0.78rem;color:var(--text-muted)"></span>
  </div>
  <div class="totals-section" id="doc-totals-section"></div>`;
}

function lineItemRow(l={}, i=0) {
  const itemOptions = state.items.map(it =>
    `<option value="${it.id}" ${l.itemId===it.id?'selected':''}>${it.name}</option>`
  ).join('');
  return `<div class="line-item-row" data-idx="${i}">
    <div style="display:flex;gap:6px;flex-direction:column">
      <select class="li-item-select" onchange="applyItemDefaults(this,${i})">
        <option value="">— Custom —</option>${itemOptions}
      </select>
      <input type="text" class="li-desc" placeholder="Description" value="${esc(l.description||l.name||'')}" style="font-size:0.78rem;padding:6px 10px;" />
    </div>
    <input type="text"   class="li-unit"  placeholder="pcs" value="${esc(l.unit||'')}" style="width:70px;" />
    <input type="number" class="li-qty"   placeholder="1"   value="${l.qty||''}"       min="0" step="any" oninput="updateLineTotals()" />
    <input type="number" class="li-price" placeholder="0.00" value="${l.unitPrice||''}" min="0" step="any" oninput="updateLineTotals()" />
    <button class="line-item-del" type="button" onclick="removeLineItem(this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  </div>`;
}

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

window.applyItemDefaults = function(sel, i) {
  const item = state.items.find(it => it.id === sel.value);
  if (!item) return;
  const row = sel.closest('.line-item-row');
  row.querySelector('.li-desc').value  = item.name;
  row.querySelector('.li-unit').value  = item.unit || '';
  row.querySelector('.li-price').value = item.defaultPrice || '';
  updateLineTotals();
};

window.removeLineItem = function(btn) {
  btn.closest('.line-item-row').remove();
  updateLineTotals();
};

window.updateLineTotals = function() {
  const lines = collectLineItems();
  const taxRate = parseFloat(document.getElementById('doc-tax-rate')?.value||0);
  const { subtotal, tax, total } = calcLines(lines, taxRate);
  const sec = document.getElementById('doc-totals-section');
  if (sec) sec.innerHTML = `
    <div class="total-row"><span class="total-label">Subtotal</span><span class="total-value">${fmtMoney(subtotal)}</span></div>
    <div class="total-row"><span class="total-label">Tax (${taxRate}%)</span><span class="total-value">${fmtMoney(tax)}</span></div>
    <div class="total-row grand"><span class="total-label">Total</span><span class="total-value">${fmtMoney(total)}</span></div>`;
};

function collectLineItems() {
  return [...document.querySelectorAll('.line-item-row')].map(row => {
    const qty = parseFloat(row.querySelector('.li-qty').value)||0;
    const unitPrice = parseFloat(row.querySelector('.li-price').value)||0;
    return {
      itemId: row.querySelector('.li-item-select')?.value || '',
      description: row.querySelector('.li-desc').value,
      name: row.querySelector('.li-desc').value,
      unit: row.querySelector('.li-unit').value,
      qty, unitPrice,
      total: qty * unitPrice,
    };
  });
}

window.addLineItem = function() {
  const body = document.getElementById('line-items-body');
  const i = body.querySelectorAll('.line-item-row').length;
  const div = document.createElement('div');
  div.innerHTML = lineItemRow({}, i);
  body.appendChild(div.firstElementChild);
  updateLineTotals();
};

/* ─────────────────────────────────────────────
   EXCEL / CSV IMPORT FOR LINE ITEMS
   Expected columns (any order, case-insensitive):
   Description | Name, Unit, Qty | Quantity, Unit Price | Price
───────────────────────────────────────────── */
window.importExcelLines = function(input) {
  const file = input.files[0];
  if (!file) return;
  const statusEl = document.getElementById('excel-import-status');
  statusEl.textContent = 'Parsing…';

  const isCsv = file.name.toLowerCase().endsWith('.csv');

  const processWorkbook = (wb) => {
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows  = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows.length) { statusEl.textContent = 'No data found in file.'; return; }

    // Normalise header keys
    const norm = s => String(s).toLowerCase().replace(/[^a-z]/g,'');
    const find = (row, ...aliases) => {
      for (const k of Object.keys(row)) {
        if (aliases.some(a => norm(k) === a)) return String(row[k]).trim();
      }
      return '';
    };

    const body = document.getElementById('line-items-body');
    let added = 0;
    rows.forEach(row => {
      const desc  = find(row, 'description','name','item','product','service');
      const unit  = find(row, 'unit','uom','measure');
      const qty   = parseFloat(find(row, 'qty','quantity','amount','count')) || 0;
      const price = parseFloat(find(row, 'unitprice','price','rate','cost','unitrate')) || 0;
      if (!desc && !qty && !price) return; // skip blank rows
      const lineData = { description: desc, name: desc, unit, qty, unitPrice: price };
      const i = body.querySelectorAll('.line-item-row').length;
      const div = document.createElement('div');
      div.innerHTML = lineItemRow(lineData, i);
      body.appendChild(div.firstElementChild);
      added++;
    });

    updateLineTotals();
    statusEl.textContent = `✓ ${added} row${added!==1?'s':''} imported`;
    setTimeout(() => { statusEl.textContent = ''; }, 4000);
    // Reset input so same file can be re-imported
    input.value = '';
  };

  if (isCsv) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'string' });
        processWorkbook(wb);
      } catch(err) { statusEl.textContent = 'Failed to parse CSV.'; console.error(err); }
    };
    reader.readAsText(file);
  } else {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb   = XLSX.read(data, { type: 'array' });
        processWorkbook(wb);
      } catch(err) { statusEl.textContent = 'Failed to parse file.'; console.error(err); }
    };
    reader.readAsArrayBuffer(file);
  }
};

/* ─────────────────────────────────────────────
   13. DOCUMENT FORM (shared inv/quot)
───────────────────────────────────────────── */
function docFormHTML(type, doc={}) {
  const isInv = type==='invoice';
  const dateLabel = isInv ? 'Invoice Date' : 'Quotation Date';
  const date2Label = isInv ? 'Due Date' : 'Expiry Date';
  const date2Field = isInv ? 'dueDate' : 'expiryDate';
  const defTax = doc.taxRate !== undefined ? doc.taxRate : state.settings.taxRate;
  const statuses = isInv
    ? ['draft','sent','paid','overdue']
    : ['draft','sent','accepted','declined'];
  const statusOpts = statuses.map(s => `<option value="${s}" ${doc.status===s?'selected':''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('');

  const customerOptions = state.customers.map(c =>
    `<option value="${c.id}" ${doc.customerId===c.id?'selected':''}>${esc(c.name)}${c.email?` — ${esc(c.email)}`:''}</option>`
  ).join('');

  const customerSelect = state.customers.length ? `
  <div class="form-group" style="flex:1 1 100%">
    <label>Choose Saved Customer</label>
    <select id="doc-customer-select" onchange="selectCustomerForDoc(this)">
      <option value="">— Select saved customer —</option>
      ${customerOptions}
    </select>
  </div>
  ` : '';

  return `
  <div class="form-row">
    <div class="form-group">
      <label>${dateLabel}</label>
      <input type="date" id="doc-date" value="${doc.date||today()}" />
    </div>
    <div class="form-group">
      <label>${date2Label}</label>
      <input type="date" id="doc-date2" value="${doc[date2Field]||addDays(today(),30)}" />
    </div>
    <div class="form-group">
      <label>Status</label>
      <select id="doc-status">${statusOpts}</select>
    </div>
  </div>

  <h4 style="font-size:0.85rem;font-weight:700;color:var(--text-secondary);margin-bottom:12px;text-transform:uppercase;letter-spacing:0.05em;">Client Details</h4>
  <div class="form-row">
    ${customerSelect}
  </div>
  <div class="form-row">
    <div class="form-group">
      <label>Client Name</label>
      <input type="text" id="client-name" placeholder="Acme Corp" value="${esc(doc.client?.name||'')}" />
    </div>
    <div class="form-group">
      <label>Client Email</label>
      <input type="email" id="client-email" placeholder="client@example.com" value="${esc(doc.client?.email||'')}" />
    </div>
  </div>
  <div class="form-row">
    <div class="form-group" style="flex:1 1 60%">
      <label>Billing Address</label>
      <textarea id="client-address" rows="2" placeholder="123 Street, City, Country">${esc(doc.client?.address||'')}</textarea>
    </div>
    <div class="form-group" style="flex:1 1 40%">
      <label>Shipping Address</label>
      <textarea id="client-shipping" rows="2" placeholder="Shipping address (optional)">${esc(doc.client?.shippingAddress||'')}</textarea>
    </div>
  </div>

  <hr class="divider" />
  <h4 style="font-size:0.85rem;font-weight:700;color:var(--text-secondary);margin-bottom:12px;text-transform:uppercase;letter-spacing:0.05em;">Line Items</h4>
  ${lineItemsHTML(doc.lineItems||[])}

  <div class="form-row mt-16">
    <div class="form-group">
      <label>Tax Rate (%)</label>
      <input type="number" id="doc-tax-rate" value="${defTax}" min="0" max="100" step="0.1" oninput="updateLineTotals()" />
    </div>
    <div class="form-group">
      <label>Notes</label>
      <input type="text" id="doc-notes" value="${esc(doc.notes||state.settings.footer||'')}" placeholder="Payment terms, notes..." />
    </div>
  </div>`;
}

function collectDocForm(type, existing={}) {
  const isInv = type==='invoice';
  const lines = collectLineItems();
  const taxRate = parseFloat(document.getElementById('doc-tax-rate')?.value||0);
  const { subtotal, tax, total } = calcLines(lines, taxRate);
  return {
    ...existing,
    date:     document.getElementById('doc-date').value,
    [isInv ? 'dueDate' : 'expiryDate']: document.getElementById('doc-date2').value,
    status:   document.getElementById('doc-status').value,
    customerId: document.getElementById('doc-customer-select')?.value || '',
    client: {
      name:    document.getElementById('client-name').value,
      email:   document.getElementById('client-email').value,
      address: document.getElementById('client-address').value,
      shippingAddress: document.getElementById('client-shipping')?.value || '',
    },
    lineItems: lines,
    taxRate, subtotal, tax, total,
    notes: document.getElementById('doc-notes').value,
  };
}

window.selectCustomerForDoc = function(sel) {
  const customer = state.customers.find(c => c.id === sel.value);
  if (!customer) return;
  document.getElementById('client-name').value = customer.name || '';
  document.getElementById('client-email').value = customer.email || '';
  document.getElementById('client-address').value = customer.billingAddress || customer.address || '';
  document.getElementById('client-shipping').value = customer.shippingAddress || '';
};

/* ─────────────────────────────────────────────
   14. PRINT / DOCUMENT VIEW
───────────────────────────────────────────── */
function buildDocHTML(doc, type) {
  const isInv = type === 'invoice';
  const s = state.settings;

  // ── Header logo area ──────────────────────────────────────────
  const logoBlock = s.logo
    ? `<img class="oi-logo" src="${s.logo}" alt="${esc(s.company)}" />`
    : '';

  const date2Label = isInv ? 'INVOICE DATE' : 'QUOTE DATE';
  const date2      = isInv ? doc.dueDate     : doc.expiryDate;

  // number label differs
  const numLabel = isInv ? 'INVOICE #' : 'QUOTE #';

  // ── Line rows ─────────────────────────────────────────────────
  const rows = (doc.lineItems||[]).map(l => `
    <tr>
      <td class="oi-td-qty">${l.qty}</td>
      <td class="oi-td-desc">${esc(l.description||l.name||'')}</td>
      <td class="oi-td-price">${parseFloat(l.unitPrice||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
      <td class="oi-td-amount">${parseFloat(l.total||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
    </tr>`).join('');

  // ── VAT row (only if tax > 0) ─────────────────────────────────
  const taxRow = (doc.taxRate && doc.tax)
    ? `<div class="oi-sub-row"><span>V.A.T ${doc.taxRate}%</span><span>${parseFloat(doc.tax||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>`
    : '';

  // ── Bank / thank-you footer (invoices only) ───────────────────
  const bankInfo = (isInv && (s.tin || s.bankDetails))
    ? `<div class="oi-bank">
         ${s.tin        ? `<div>TIN: ${esc(s.tin)}</div>` : ''}
         ${s.bankDetails ? esc(s.bankDetails).replace(/\n/g,'<br>') : ''}
       </div>`
    : '';

  const footer = isInv
    ? `<div class="oi-footer">
         <div class="oi-thankyou">Thank you</div>
         ${bankInfo}
       </div>`
    : (s.footer ? `<div class="oi-footer-simple">${esc(s.footer)}</div>` : '');

  return `<div class="oi-doc-wrap"><div class="oi-doc">
    <!-- ── TOP HEADER ── -->
    <div class="oi-top">
      <div class="oi-top-left">
        <div class="oi-title">${isInv ? 'INVOICE' : 'QUOTE'}</div>
        <div class="oi-company-name">${esc(s.company)}</div>
        <div class="oi-company-addr">${esc(s.address||'')}</div>
      </div>
      <div class="oi-top-right">
        ${logoBlock}
      </div>
    </div>

    <!-- ── BILL TO + DOC META ── -->
    <div class="oi-meta-row">
      <div class="oi-bill">
        <div class="oi-bill-label">BILL TO</div>
        <div class="oi-bill-name">${esc(doc.client?.name||'—')}</div>
        <div class="oi-bill-addr">${doc.client?.address ? esc(doc.client.address).replace(/\n/g,'<br>') : ''}</div>
        ${doc.client?.shippingAddress ? `<div class="oi-shipping-label">SHIP TO</div><div class="oi-shipping-addr">${esc(doc.client.shippingAddress).replace(/\n/g,'<br>')}</div>` : ''}
      </div>
      <div class="oi-docinfo">
        <div class="oi-docinfo-row">
          <span class="oi-di-label">${numLabel}</span>
          <span class="oi-di-val">${esc(doc.number||'')}</span>
        </div>
        <div class="oi-docinfo-row">
          <span class="oi-di-label">${date2Label}</span>
          <span class="oi-di-val">${fmtDate(doc.date)}</span>
        </div>
        ${doc.fromQuotation ? `<div class="oi-docinfo-row"><span class="oi-di-label">FROM QUOTE</span><span class="oi-di-val">${esc(doc.fromQuotation)}</span></div>` : ''}
      </div>
    </div>

    <!-- ── LINE ITEMS TABLE ── -->
    <div class="oi-table-wrap">
      <table class="oi-table">
        <thead>
          <tr>
            <th class="oi-th-qty">QTY</th>
            <th class="oi-th-desc">DESCRIPTION</th>
            <th class="oi-th-price">UNIT PRICE</th>
            <th class="oi-th-amount">AMOUNT</th>
          </tr>
        </thead>
        <tbody>${rows||'<tr><td colspan="4" style="text-align:center;padding:20px;color:#999">No items</td></tr>'}</tbody>
      </table>
    </div>

    <!-- ── TOTALS ── -->
    <div class="oi-totals">
      <div class="oi-sub-row"><span>Subtotal</span><span>${parseFloat(doc.subtotal||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>
      ${taxRow}
      <div class="oi-total-row">
        <span>TOTAL</span>
        <span>${s.currency}${parseFloat(doc.total||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
      </div>
    </div>

    ${doc.notes ? `<div class="oi-notes">${esc(doc.notes)}</div>` : ''}

    <!-- ── FOOTER ── -->
    ${footer}
  </div></div>`;
}

/* Print-specific HTML builder - always uses full-size desktop layout */
function buildPrintHTML(doc, type) {
  const isInv = type === 'invoice';
  const s = state.settings;

  // ── Header logo area ──────────────────────────────────────────
  const logoBlock = s.logo
    ? `<img class="oi-logo" src="${s.logo}" alt="${esc(s.company)}" />`
    : '';

  const date2Label = isInv ? 'INVOICE DATE' : 'QUOTE DATE';
  const date2      = isInv ? doc.dueDate     : doc.expiryDate;

  // number label differs
  const numLabel = isInv ? 'INVOICE #' : 'QUOTE #';

  // ── Line rows ─────────────────────────────────────────────────
  const rows = (doc.lineItems||[]).map(l => `
    <tr>
      <td class="oi-td-qty">${l.qty}</td>
      <td class="oi-td-desc">${esc(l.description||l.name||'')}</td>
      <td class="oi-td-price">${parseFloat(l.unitPrice||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
      <td class="oi-td-amount">${parseFloat(l.total||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
    </tr>`).join('');

  // ── VAT row (only if tax > 0) ─────────────────────────────────
  const taxRow = (doc.taxRate && doc.tax)
    ? `<div class="oi-sub-row"><span>V.A.T ${doc.taxRate}%</span><span>${parseFloat(doc.tax||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>`
    : '';

  // ── Bank / thank-you footer (invoices only) ───────────────────
  const bankInfo = (isInv && (s.tin || s.bankDetails))
    ? `<div class="oi-bank">
         ${s.tin        ? `<div>TIN: ${esc(s.tin)}</div>` : ''}
         ${s.bankDetails ? esc(s.bankDetails).replace(/\n/g,'<br>') : ''}
       </div>`
    : '';

  const footer = isInv
    ? `<div class="oi-footer">
         <div class="oi-thankyou">Thank you</div>
         ${bankInfo}
       </div>`
    : (s.footer ? `<div class="oi-footer-simple">${esc(s.footer)}</div>` : '');

  // Return HTML without the mobile-responsive wrapper - direct print layout
  return `<div class="oi-doc">
    <!-- ── TOP HEADER ── -->
    <div class="oi-top">
      <div class="oi-top-left">
        <div class="oi-title">${isInv ? 'INVOICE' : 'QUOTE'}</div>
        <div class="oi-company-name">${esc(s.company)}</div>
        <div class="oi-company-addr">${esc(s.address||'')}</div>
      </div>
      <div class="oi-top-right">
        ${logoBlock}
      </div>
    </div>

    <!-- ── BILL TO + DOC META ── -->
    <div class="oi-meta-row">
      <div class="oi-bill">
        <div class="oi-bill-label">BILL TO</div>
        <div class="oi-bill-name">${esc(doc.client?.name||'—')}</div>
        <div class="oi-bill-addr">${doc.client?.address ? esc(doc.client.address).replace(/\n/g,'<br>') : ''}</div>
        ${doc.client?.shippingAddress ? `<div class="oi-shipping-label">SHIP TO</div><div class="oi-shipping-addr">${esc(doc.client.shippingAddress).replace(/\n/g,'<br>')}</div>` : ''}
      </div>
      <div class="oi-docinfo">
        <div class="oi-docinfo-row">
          <span class="oi-di-label">${numLabel}</span>
          <span class="oi-di-val">${esc(doc.number||'')}</span>
        </div>
        <div class="oi-docinfo-row">
          <span class="oi-di-label">${date2Label}</span>
          <span class="oi-di-val">${fmtDate(doc.date)}</span>
        </div>
        ${doc.fromQuotation ? `<div class="oi-docinfo-row"><span class="oi-di-label">FROM QUOTE</span><span class="oi-di-val">${esc(doc.fromQuotation)}</span></div>` : ''}
      </div>
    </div>

    <!-- ── LINE ITEMS TABLE ── -->
    <div class="oi-table-wrap">
      <table class="oi-table">
        <thead>
          <tr>
            <th class="oi-th-qty">QTY</th>
            <th class="oi-th-desc">DESCRIPTION</th>
            <th class="oi-th-price">UNIT PRICE</th>
            <th class="oi-th-amount">AMOUNT</th>
          </tr>
        </thead>
        <tbody>${rows||'<tr><td colspan="4" style="text-align:center;padding:20px;color:#999">No items</td></tr>'}</tbody>
      </table>
    </div>

    <!-- ── TOTALS ── -->
    <div class="oi-totals">
      <div class="oi-sub-row"><span>Subtotal</span><span>${parseFloat(doc.subtotal||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>
      ${taxRow}
      <div class="oi-total-row">
        <span>TOTAL</span>
        <span>${s.currency}${parseFloat(doc.total||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
      </div>
    </div>

    ${doc.notes ? `<div class="oi-notes">${esc(doc.notes)}</div>` : ''}

    <!-- ── FOOTER ── -->
    ${footer}
  </div>`;
}

window.printDoc = function(id, type) {
  const doc = type==='invoice' ? state.invoices.find(x=>x.id===id) : state.quotations.find(x=>x.id===id);
  if (!doc) return;
  const area = document.getElementById('print-area');
  const previousTitle = document.title;
  document.title = doc.number || (type==='invoice' ? 'Invoice' : 'Quotation');
  window.onafterprint = () => {
    document.title = previousTitle;
    window.onafterprint = null;
  };
  area.innerHTML = buildPrintHTML(doc, type);
  window.print();
};

window.viewDoc = function(id, type) {
  const doc = type==='invoice' ? state.invoices.find(x=>x.id===id) : state.quotations.find(x=>x.id===id);
  if (!doc) return;
  openModal({
    title: `${type==='invoice'?'Invoice':'Quotation'} – ${doc.number}`,
    body: buildDocHTML(doc, type),
    footer: `<button class="btn btn-secondary" onclick="closeModal()">Close</button>
             <button class="btn btn-primary" onclick="printDoc('${id}','${type}')">\n               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>\n               Print / PDF</button>`,
    wide: true,
  });
  // Remove modal-body padding so the grey doc-wrap fills edge to edge
  const modalBody = document.getElementById('modal-body');
  modalBody.style.padding = '0';
  modalBody.style.overflow = 'auto';
  modalBody.classList.add('no-padding');
};

/* ─────────────────────────────────────────────
   15. DASHBOARD VIEW
───────────────────────────────────────────── */
function renderDashboard(vc) {
  const s = getDashboardStats();
  const recentInv  = [...state.invoices].slice(0,3);
  const recentQuot = [...state.quotations].slice(0,3);

  const invRows = recentInv.map(i => `<tr>
    <td><span class="doc-number-chip">${esc(i.number)}</span></td>
    <td>${esc(i.client?.name||'—')}</td>
    <td>${fmtDate(i.date)}</td>
    <td>${fmtMoney(i.total)}</td>
    <td><span class="badge badge-${i.status}">${i.status}</span></td>
    <td><div class="td-actions">
      <button class="btn btn-ghost btn-sm" onclick="viewDoc('${i.id}','invoice')">View</button>
    </div></td>
  </tr>`).join('') || `<tr><td colspan="6"><div class="empty-state" style="padding:20px"><p>No invoices yet</p></div></td></tr>`;

  const quotRows = recentQuot.map(q => `<tr>
    <td><span class="doc-number-chip">${esc(q.number)}</span></td>
    <td>${esc(q.client?.name||'—')}</td>
    <td>${fmtDate(q.date)}</td>
    <td>${fmtMoney(q.total)}</td>
    <td><span class="badge badge-${q.status}">${q.status}</span></td>
    <td><div class="td-actions">
      <button class="btn btn-ghost btn-sm" onclick="viewDoc('${q.id}','quotation')">View</button>
    </div></td>
  </tr>`).join('') || `<tr><td colspan="6"><div class="empty-state" style="padding:20px"><p>No quotations yet</p></div></td></tr>`;

  vc.innerHTML = `
  <div class="kpi-grid">
    <div class="kpi-card indigo">
      <div class="kpi-label">Total Invoiced</div>
      <div class="kpi-value">${fmtShort(s.totalInvoiced)}</div>
      <div class="kpi-sub">${s.invCount} invoice${s.invCount!==1?'s':''}</div>
    </div>
    <div class="kpi-card green">
      <div class="kpi-label">Total Paid</div>
      <div class="kpi-value">${fmtShort(s.totalPaid)}</div>
      <div class="kpi-sub">Collected revenue</div>
    </div>
    <div class="kpi-card amber">
      <div class="kpi-label">Outstanding</div>
      <div class="kpi-value">${fmtShort(s.totalOutstanding)}</div>
      <div class="kpi-sub">Awaiting payment</div>
    </div>
    <div class="kpi-card blue">
      <div class="kpi-label">Total Quoted</div>
      <div class="kpi-value">${fmtShort(s.totalQuoted)}</div>
      <div class="kpi-sub">${s.quotCount} quotation${s.quotCount!==1?'s':''}</div>
    </div>
    <div class="kpi-card teal">
      <div class="kpi-label">Quotes Accepted</div>
      <div class="kpi-value">${fmtShort(s.quotedAccepted)}</div>
      <div class="kpi-sub">Accepted / Converted</div>
    </div>
  </div>

  <div class="dash-grid">
    <div>
      <div class="section-header"><span class="section-title">Recent Invoices</span>
        <button class="btn btn-ghost btn-sm" onclick="navigate('invoices')">View All</button></div>
      <div class="table-wrap">
        <table><thead><tr><th>Number</th><th>Client</th><th>Date</th><th>Amount</th><th>Status</th><th></th></tr></thead>
        <tbody>${invRows}</tbody></table>
      </div>
    </div>
    <div>
      <div class="section-header"><span class="section-title">Recent Quotations</span>
        <button class="btn btn-ghost btn-sm" onclick="navigate('quotations')">View All</button></div>
      <div class="table-wrap">
        <table><thead><tr><th>Number</th><th>Client</th><th>Date</th><th>Amount</th><th>Status</th><th></th></tr></thead>
        <tbody>${quotRows}</tbody></table>
      </div>
    </div>
  </div>`;
}

/* ─────────────────────────────────────────────
   16. INVOICES VIEW
───────────────────────────────────────────── */
function renderInvoicesView(vc, ta) {
  ta.innerHTML = `<button class="btn btn-primary" id="new-invoice-btn">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    New Invoice</button>`;

  const filters = ['all','draft','sent','paid','overdue'];
  const filtered = state.activeFilter === 'all' ? state.invoices : state.invoices.filter(x=>x.status===state.activeFilter);

  const rows = filtered.map(i => `<tr>
    <td><span class="doc-number-chip">${esc(i.number)}</span></td>
    <td>${esc(i.client?.name||'—')}</td>
    <td>${esc(i.client?.email||'—')}</td>
    <td>${fmtDate(i.date)}</td>
    <td>${fmtDate(i.dueDate)}</td>
    <td style="text-align:right;font-weight:600">${fmtMoney(i.total)}</td>
    <td><span class="badge badge-${i.status}">${i.status}</span></td>
    <td><div class="td-actions">
      <button class="btn btn-ghost btn-sm" onclick="viewDoc('${i.id}','invoice')">View</button>
      <button class="btn btn-ghost btn-sm" onclick="editInvoice('${i.id}')">Edit</button>
      <button class="btn btn-danger btn-sm" onclick="confirmDeleteInvoice('${i.id}')">Delete</button>
    </div></td>
  </tr>`).join('') || `<tr><td colspan="8"><div class="empty-state">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>
    <h3>No invoices</h3><p>Create your first invoice to get started</p></div></td></tr>`;

  vc.innerHTML = `
  <div class="filter-bar">
    ${filters.map(f=>`<button class="filter-btn${state.activeFilter===f?' active':''}" onclick="setFilter('${f}','invoices')">${f.charAt(0).toUpperCase()+f.slice(1)}</button>`).join('')}
  </div>
  <div class="table-wrap">
    <table><thead><tr><th>Number</th><th>Client</th><th>Email</th><th>Date</th><th>Due</th><th>Amount</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody></table>
  </div>`;

  document.getElementById('new-invoice-btn').addEventListener('click', () => openInvoiceForm());
}

window.editInvoice = function(id) {
  const inv = state.invoices.find(x=>x.id===id);
  if (inv) openInvoiceForm(inv);
};

window.confirmDeleteInvoice = function(id) {
  const inv = state.invoices.find(x=>x.id===id);
  openModal({
    title: 'Delete Invoice',
    body: `<p style="color:var(--text-secondary)">Delete <strong>${esc(inv?.number)}</strong>? This cannot be undone.</p>`,
    footer: `<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
             <button class="btn btn-danger" onclick="doDeleteInvoice('${id}')">Delete</button>`,
  });
};

window.doDeleteInvoice = function(id) {
  deleteInvoice(id);
  closeModal();
  toast('Invoice deleted', 'info');
  renderInvoicesView(document.getElementById('view-container'), document.getElementById('topbar-actions'));
};

function openInvoiceForm(inv={}) {
  const isEdit = !!inv.id;
  openModal({
    title: isEdit ? `Edit ${inv.number}` : 'New Invoice',
    body: docFormHTML('invoice', inv),
    footer: `<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
             <button class="btn btn-primary" onclick="submitInvoiceForm('${inv.id||''}')">
               ${isEdit?'Save Changes':'Create Invoice'}</button>`,
    wide: true,
  });
  document.getElementById('add-line-btn').addEventListener('click', addLineItem);
  updateLineTotals();
}

window.submitInvoiceForm = function(existingId) {
  const existing = existingId ? state.invoices.find(x=>x.id===existingId) : {};
  const data = collectDocForm('invoice', existing||{});
  if (!data.client?.name) { toast('Client name is required', 'error'); return; }
  const saved = saveInvoice(data);
  closeModal();
  toast(`Invoice ${saved.number} saved!`, 'success');
  renderInvoicesView(document.getElementById('view-container'), document.getElementById('topbar-actions'));
};

/* ─────────────────────────────────────────────
   17. QUOTATIONS VIEW
───────────────────────────────────────────── */
function renderQuotationsView(vc, ta) {
  ta.innerHTML = `<button class="btn btn-primary" id="new-quot-btn">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    New Quotation</button>`;

  const filters = ['all','draft','sent','accepted','declined','converted'];
  const filtered = state.activeFilter === 'all' ? state.quotations : state.quotations.filter(x=>x.status===state.activeFilter);

  const rows = filtered.map(q => `<tr>
    <td><span class="doc-number-chip">${esc(q.number)}</span></td>
    <td>${esc(q.client?.name||'—')}</td>
    <td>${esc(q.client?.email||'—')}</td>
    <td>${fmtDate(q.date)}</td>
    <td>${fmtDate(q.expiryDate)}</td>
    <td style="text-align:right;font-weight:600">${fmtMoney(q.total)}</td>
    <td><span class="badge badge-${q.status}">${q.status}</span></td>
    <td><div class="td-actions">
      <button class="btn btn-ghost btn-sm" onclick="viewDoc('${q.id}','quotation')">View</button>
      <button class="btn btn-ghost btn-sm" onclick="editQuot('${q.id}')">Edit</button>
      ${q.status!=='converted'?`<button class="btn btn-success btn-sm" onclick="doConvert('${q.id}')">→ Invoice</button>`:''}
      <button class="btn btn-danger btn-sm" onclick="confirmDeleteQuot('${q.id}')">Delete</button>
    </div></td>
  </tr>`).join('') || `<tr><td colspan="8"><div class="empty-state">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
    <h3>No quotations</h3><p>Create your first quotation to get started</p></div></td></tr>`;

  vc.innerHTML = `
  <div class="filter-bar">
    ${filters.map(f=>`<button class="filter-btn${state.activeFilter===f?' active':''}" onclick="setFilter('${f}','quotations')">${f.charAt(0).toUpperCase()+f.slice(1)}</button>`).join('')}
  </div>
  <div class="table-wrap">
    <table><thead><tr><th>Number</th><th>Client</th><th>Email</th><th>Date</th><th>Expiry</th><th>Amount</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody></table>
  </div>`;

  document.getElementById('new-quot-btn').addEventListener('click', () => openQuotForm());
}

window.editQuot = function(id) { const q = state.quotations.find(x=>x.id===id); if(q) openQuotForm(q); };

window.doConvert = function(id) {
  const q = state.quotations.find(x=>x.id===id);
  openModal({
    title: 'Convert to Invoice',
    body: `<p style="color:var(--text-secondary)">Convert <strong>${esc(q?.number)}</strong> to a new invoice? The quotation will be marked as <em>converted</em>.</p>`,
    footer: `<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
             <button class="btn btn-success" onclick="confirmConvert('${id}')">Convert</button>`,
  });
};

window.confirmConvert = function(id) {
  const inv = convertQuotationToInvoice(id);
  closeModal();
  toast(`Invoice ${inv.number} created from quotation!`, 'success');
  renderQuotationsView(document.getElementById('view-container'), document.getElementById('topbar-actions'));
};

window.confirmDeleteQuot = function(id) {
  const q = state.quotations.find(x=>x.id===id);
  openModal({
    title: 'Delete Quotation',
    body: `<p style="color:var(--text-secondary)">Delete <strong>${esc(q?.number)}</strong>? This cannot be undone.</p>`,
    footer: `<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
             <button class="btn btn-danger" onclick="doDeleteQuot('${id}')">Delete</button>`,
  });
};

window.doDeleteQuot = function(id) {
  deleteQuotation(id);
  closeModal();
  toast('Quotation deleted', 'info');
  renderQuotationsView(document.getElementById('view-container'), document.getElementById('topbar-actions'));
};

function openQuotForm(q={}) {
  const isEdit = !!q.id;
  openModal({
    title: isEdit ? `Edit ${q.number}` : 'New Quotation',
    body: docFormHTML('quotation', q),
    footer: `<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
             <button class="btn btn-primary" onclick="submitQuotForm('${q.id||''}')">
               ${isEdit?'Save Changes':'Create Quotation'}</button>`,
    wide: true,
  });
  document.getElementById('add-line-btn').addEventListener('click', addLineItem);
  updateLineTotals();
}

window.submitQuotForm = function(existingId) {
  const existing = existingId ? state.quotations.find(x=>x.id===existingId) : {};
  const data = collectDocForm('quotation', existing||{});
  if (!data.client?.name) { toast('Client name is required', 'error'); return; }
  const saved = saveQuotation(data);
  closeModal();
  toast(`Quotation ${saved.number} saved!`, 'success');
  renderQuotationsView(document.getElementById('view-container'), document.getElementById('topbar-actions'));
};

/* ─────────────────────────────────────────────
   18. ITEMS VIEW
───────────────────────────────────────────── */
function renderItemsView(vc, ta) {
  ta.innerHTML = `<button class="btn btn-primary" id="new-item-btn">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    New Item</button>`;

  const cards = state.items.map(it => `
    <div class="item-card">
      <div class="item-card-name">${esc(it.name)}</div>
      <div class="item-card-desc">${esc(it.description||'')}</div>
      <div class="item-card-meta">
        <span class="item-unit-badge">${esc(it.unit||'unit')}</span>
        <span class="item-price">${fmtMoney(it.defaultPrice||0)}</span>
      </div>
      <div class="td-actions mt-8">
        <button class="btn btn-ghost btn-sm" onclick="editItem('${it.id}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="confirmDeleteItem('${it.id}')">Delete</button>
      </div>
    </div>`).join('') || `<div class="empty-state" style="grid-column:1/-1">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
      <h3>No items yet</h3><p>Add products or services to reuse in documents</p></div>`;

  vc.innerHTML = `<div class="items-grid">${cards}</div>`;
  document.getElementById('new-item-btn').addEventListener('click', () => openItemForm());
}

function renderCustomersView(vc, ta) {
  ta.innerHTML = `<button class="btn btn-primary" id="new-customer-btn">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
    New Customer</button>`;

  const query = document.getElementById('customer-search-input')?.value.trim().toLowerCase() || '';
  const filtered = (state.customers || [])
    .filter(c => !query || [c.name, c.email, c.phone, c.billingAddress, c.shippingAddress]
      .some(v => String(v||'').toLowerCase().includes(query)))
    .sort((a,b) => a.name.localeCompare(b.name));

  const rows = filtered.map(c => `<tr>
    <td><strong>${esc(c.name)}</strong></td>
    <td>${esc(c.email||'—')}</td>
    <td>${esc(c.phone||'—')}</td>
    <td>${esc(c.billingAddress?.split('\n')[0] || '—')}</td>
    <td>${esc(c.shippingAddress?.split('\n')[0] || '—')}</td>
    <td><div class="td-actions">
      <button class="btn btn-ghost btn-sm" onclick="openCustomerForm('${c.id}')">Edit</button>
      <button class="btn btn-danger btn-sm" onclick="confirmDeleteCustomer('${c.id}')">Delete</button>
    </div></td>
  </tr>`).join('') || `<tr><td colspan="6"><div class="empty-state"><h3>No customers found</h3><p>Save frequently used contacts here.</p></div></td></tr>`;

  vc.innerHTML = `
  <div class="customer-toolbar" style="display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center;margin-bottom:18px;">
    <div style="flex:1;min-width:220px;max-width:420px;">
      <input id="customer-search-input" type="search" placeholder="Search customers…" value="${esc(query)}" oninput="renderCustomersView(document.getElementById('view-container'), document.getElementById('topbar-actions'))" />
    </div>
  </div>
  <div class="table-wrap">
    <table><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Billing</th><th>Shipping</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody></table>
  </div>`;

  document.getElementById('new-customer-btn').addEventListener('click', () => openCustomerForm());
}

function customerFormHTML(c={}) {
  return `
  <div class="form-row">
    <div class="form-group"><label>Name *</label><input type="text" id="cust-name" value="${esc(c.name||'')}" /></div>
    <div class="form-group"><label>Email</label><input type="email" id="cust-email" value="${esc(c.email||'')}" /></div>
  </div>
  <div class="form-row">
    <div class="form-group"><label>Phone</label><input type="text" id="cust-phone" value="${esc(c.phone||'')}" /></div>
    <div class="form-group"><label>City</label><input type="text" id="cust-city" value="${esc(c.city||'')}" /></div>
  </div>
  <div class="form-group"><label>Billing Address</label><textarea id="cust-billing" rows="3" placeholder="123 Street, City, Country">${esc(c.billingAddress||c.address||'')}</textarea></div>
  <div class="form-group"><label>Shipping Address</label><textarea id="cust-shipping" rows="3" placeholder="Shipping address (optional)">${esc(c.shippingAddress||'')}</textarea></div>`;
}

window.openCustomerForm = function(id='') {
  const customer = id ? state.customers.find(c => c.id === id) : {};
  openModal({
    title: id ? `Edit customer: ${esc(customer.name||'')}` : 'New Customer',
    body: customerFormHTML(customer),
    footer: `<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
             <button class="btn btn-primary" onclick="submitCustomerForm('${id}')">${id ? 'Save Customer' : 'Add Customer'}</button>`,
    wide: true,
  });
};

window.submitCustomerForm = function(existingId) {
  const name = document.getElementById('cust-name')?.value.trim();
  if (!name) { toast('Customer name is required', 'error'); return; }
  const customer = {
    id: existingId || '',
    name,
    email: document.getElementById('cust-email')?.value.trim() || '',
    phone: document.getElementById('cust-phone')?.value.trim() || '',
    city: document.getElementById('cust-city')?.value.trim() || '',
    billingAddress: document.getElementById('cust-billing')?.value.trim() || '',
    shippingAddress: document.getElementById('cust-shipping')?.value.trim() || '',
  };
  saveCustomer(customer);
  closeModal();
  toast('Customer saved!', 'success');
  renderCustomersView(document.getElementById('view-container'), document.getElementById('topbar-actions'));
};

function saveCustomer(data) {
  if (!data.name) return;
  if (data.id) {
    const idx = state.customers.findIndex(x => x.id === data.id);
    if (idx >= 0) state.customers[idx] = data;
    else state.customers.push(data);
  } else {
    data.id = uid();
    state.customers.push(data);
  }
  persist();
}

window.confirmDeleteCustomer = function(id) {
  const c = state.customers.find(x => x.id === id);
  openModal({
    title: 'Delete Customer',
    body: `<p style="color:var(--text-secondary)">Delete <strong>${esc(c?.name)}</strong> from contacts?</p>`,
    footer: `<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
             <button class="btn btn-danger" onclick="doDeleteCustomer('${id}')">Delete</button>`,
  });
};

window.doDeleteCustomer = function(id) {
  state.customers = state.customers.filter(x => x.id !== id);
  persist();
  closeModal();
  toast('Customer deleted', 'info');
  renderCustomersView(document.getElementById('view-container'), document.getElementById('topbar-actions'));
};

function deleteCustomer(id) {
  state.customers = state.customers.filter(x => x.id !== id);
  persist();
}

function itemFormHTML(it={}) {
  return `
  <div class="form-row">
    <div class="form-group"><label>Name *</label><input type="text" id="item-name" value="${esc(it.name||'')}" placeholder="Web Design" /></div>
    <div class="form-group"><label>Unit</label><input type="text" id="item-unit" value="${esc(it.unit||'')}" placeholder="hour / pcs / project" /></div>
  </div>
  <div class="form-row">
    <div class="form-group"><label>Default Price</label><input type="number" id="item-price" value="${it.defaultPrice||''}" min="0" step="any" placeholder="0.00" /></div>
  </div>
  <div class="form-group"><label>Description</label><textarea id="item-desc" rows="2" placeholder="Optional description">${esc(it.description||'')}</textarea></div>`;
}

function openItemForm(it={}) {
  const isEdit = !!it.id;
  openModal({
    title: isEdit ? 'Edit Item' : 'New Item',
    body: itemFormHTML(it),
    footer: `<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
             <button class="btn btn-primary" onclick="submitItemForm('${it.id||''}')">
               ${isEdit?'Save Changes':'Add Item'}</button>`,
  });
}

window.editItem = function(id) { const it = state.items.find(x=>x.id===id); if(it) openItemForm(it); };

window.submitItemForm = function(existingId) {
  const name = document.getElementById('item-name').value.trim();
  if (!name) { toast('Item name is required', 'error'); return; }
  const existing = existingId ? state.items.find(x=>x.id===existingId) : {};
  saveItem({
    ...(existing||{}),
    name,
    unit:         document.getElementById('item-unit').value.trim(),
    defaultPrice: parseFloat(document.getElementById('item-price').value)||0,
    description:  document.getElementById('item-desc').value.trim(),
  });
  closeModal();
  toast('Item saved!', 'success');
  renderItemsView(document.getElementById('view-container'), document.getElementById('topbar-actions'));
};

window.confirmDeleteItem = function(id) {
  const it = state.items.find(x=>x.id===id);
  openModal({
    title: 'Delete Item',
    body: `<p style="color:var(--text-secondary)">Delete <strong>${esc(it?.name)}</strong> from catalog?</p>`,
    footer: `<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
             <button class="btn btn-danger" onclick="doDeleteItem('${id}')">Delete</button>`,
  });
};

window.doDeleteItem = function(id) {
  deleteItem(id);
  closeModal();
  toast('Item deleted', 'info');
  renderItemsView(document.getElementById('view-container'), document.getElementById('topbar-actions'));
};

/* ─────────────────────────────────────────────
   19. SETTINGS VIEW
───────────────────────────────────────────── */
function renderSettingsView(vc, ta) {
  const s = state.settings;
  ta.innerHTML = `<button class="btn btn-primary" onclick="saveSettings()">Save Settings</button>
                     <button class="btn btn-secondary" onclick="clearAppData()">Clear Data</button>`;

  const logoPreview = s.logo
    ? `<img class="logo-preview" src="${s.logo}" alt="Logo" /><br><button class="btn btn-danger btn-sm mt-8" type="button" onclick="removeLogo()">Remove Logo</button>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:36px;height:36px;margin-bottom:8px;opacity:0.4"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg><div class="logo-upload-hint">Click or drag &amp; drop your logo<br><small>PNG, JPG, SVG – max 2MB</small></div>`;

  vc.innerHTML = `
  <div class="settings-grid">
    <div class="card">
      <h3 style="font-size:0.95rem;font-weight:700;margin-bottom:20px">Company Information</h3>
      <div class="form-group"><label>Company Name</label><input type="text" id="s-company" value="${esc(s.company||'')}" /></div>
      <div class="form-group"><label>Address</label><textarea id="s-address" rows="3">${esc(s.address||'')}</textarea></div>
      <div class="form-row">
        <div class="form-group"><label>Email</label><input type="email" id="s-email" value="${esc(s.email||'')}" /></div>
        <div class="form-group"><label>Phone</label><input type="text" id="s-phone" value="${esc(s.phone||'')}" /></div>
      </div>
      <div class="form-group"><label>TIN / Tax ID Number</label><input type="text" id="s-tin" value="${esc(s.tin||'')}" placeholder="e.g. 32263666-0001" /></div>
      <div class="form-group"><label>Bank Details (shown on invoices)</label><textarea id="s-bank" rows="3" placeholder="ACCT NAME: YOUR COMPANY LTD&#10;ACCT NO: 0123456789">${esc(s.bankDetails||'')}</textarea></div>
    </div>

    <div class="card">
      <h3 style="font-size:0.95rem;font-weight:700;margin-bottom:20px">Company Logo</h3>
      <div class="logo-upload-area" id="logo-upload-area">
        <input type="file" id="logo-file-input" accept="image/*" />
        <div id="logo-preview-wrap">${logoPreview}</div>
      </div>
    </div>

    <div class="card">
      <h3 style="font-size:0.95rem;font-weight:700;margin-bottom:20px">Document Defaults</h3>
      <div class="form-row">
        <div class="form-group">
          <label>Currency Symbol</label>
          <input type="text" id="s-currency" value="${esc(s.currency||'$')}" style="max-width:80px" />
        </div>
        <div class="form-group">
          <label>Default Tax Rate (%)</label>
          <input type="number" id="s-tax" value="${s.taxRate||0}" min="0" max="100" step="0.1" />
        </div>
      </div>
      <div class="form-group"><label>Footer / Notes</label><textarea id="s-footer" rows="2">${esc(s.footer||'')}</textarea></div>
    </div>

    <div class="card">
      <h3 style="font-size:0.95rem;font-weight:700;margin-bottom:16px">Document Counters</h3>
      <p style="font-size:0.83rem;color:var(--text-secondary);margin-bottom:16px">Adjust starting numbers for new documents. Only increase these values — decreasing may cause duplicate numbers.</p>
      <div class="form-row">
        <div class="form-group">
          <label>Next Invoice #</label>
          <input type="number" id="s-next-inv" value="${state.counters.nextInvoice}" min="1" step="1" />
        </div>
        <div class="form-group">
          <label>Next Quotation #</label>
          <input type="number" id="s-next-quot" value="${state.counters.nextQuotation}" min="1" step="1" />
        </div>
      </div>
    </div>

    <div class="card">
      <h3 style="font-size:0.95rem;font-weight:700;margin-bottom:16px">Data Management</h3>
      <p style="font-size:0.83rem;color:var(--text-secondary);margin-bottom:16px">Import your old <code style="background:rgba(255,255,255,0.06);padding:1px 5px;border-radius:4px">data.json</code> to migrate existing data. Export creates a local backup of all your cloud data.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn-secondary" id="btn-import-data" onclick="importDataFromJSON()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px;margin-right:6px;vertical-align:-2px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Import data.json
        </button>
        <button class="btn btn-ghost" id="btn-export-data" onclick="exportDataToJSON()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px;margin-right:6px;vertical-align:-2px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Export Backup
        </button>
      </div>
    </div>

  </div>`;

  // Logo file input handler
  document.getElementById('logo-file-input').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast('Logo file must be under 2MB', 'error'); return; }
    const reader = new FileReader();
    reader.onload = ev => {
      state.settings.logo = ev.target.result;
      document.getElementById('logo-preview-wrap').innerHTML =
        `<img class="logo-preview" src="${ev.target.result}" alt="Logo" /><br><button class="btn btn-danger btn-sm mt-8" type="button" onclick="removeLogo()">Remove Logo</button>`;
      toast('Logo uploaded! Click Save Settings to keep it.', 'info');
    };
    reader.readAsDataURL(file);
  });

  // Drag & drop
  const area = document.getElementById('logo-upload-area');
  area.addEventListener('dragover', e => { e.preventDefault(); area.classList.add('drag-over'); });
  area.addEventListener('dragleave', () => area.classList.remove('drag-over'));
  area.addEventListener('drop', e => {
    e.preventDefault(); area.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      document.getElementById('logo-file-input').files = e.dataTransfer.files;
      document.getElementById('logo-file-input').dispatchEvent(new Event('change'));
    }
  });
}

window.removeLogo = function() {
  state.settings.logo = '';
  document.getElementById('logo-preview-wrap').innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:36px;height:36px;margin-bottom:8px;opacity:0.4"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg><div class="logo-upload-hint">Click or drag &amp; drop your logo<br><small>PNG, JPG, SVG – max 2MB</small></div>`;
  toast('Logo removed. Click Save Settings to confirm.', 'info');
};

window.saveSettings = function() {
  state.settings = {
    ...state.settings,
    company:     document.getElementById('s-company').value.trim() || 'Your Company',
    address:     document.getElementById('s-address').value.trim(),
    email:       document.getElementById('s-email').value.trim(),
    phone:       document.getElementById('s-phone').value.trim(),
    currency:    document.getElementById('s-currency').value.trim() || '$',
    taxRate:     parseFloat(document.getElementById('s-tax').value)||0,
    footer:      document.getElementById('s-footer').value.trim(),
    tin:         document.getElementById('s-tin')?.value.trim() || '',
    bankDetails: document.getElementById('s-bank')?.value.trim() || '',
  };
  state.counters.nextInvoice   = Math.max(1, parseInt(document.getElementById('s-next-inv').value)||1);
  state.counters.nextQuotation = Math.max(1, parseInt(document.getElementById('s-next-quot').value)||1);
  persist('settings');
  persist('counters');
  document.getElementById('sidebar-company-name').textContent = state.settings.company;
  toast('Settings saved!', 'success');
};

window.clearAppData = function() {
  if (!confirm('This will DELETE all invoices, quotations, items, and counters (settings will remain). Continue?')) return;
  state.invoices = [];
  state.quotations = [];
  state.items = [];
  state.counters = { nextInvoice: 1, nextQuotation: 1 };
  persist();
  toast('All data cleared (settings preserved).', 'success');
  renderView(state.currentView);
};

window.exportDataToJSON = function() {
  const payload = {
    invoices:   state.invoices,
    quotations: state.quotations,
    items:      state.items,
    customers:  state.customers,
    settings:   state.settings,
    counters:   state.counters,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: `invoiceflow-backup-${new Date().toISOString().slice(0,10)}.json` });
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast('Backup downloaded!', 'success');
};


/* ─────────────────────────────────────────────
   20. FILTER HELPER
───────────────────────────────────────────── */
window.setFilter = function(f, view) {
  state.activeFilter = f;
  navigate(view);
};

/* ─────────────────────────────────────────────
   21. WIRE UP & INIT
───────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  /* Show loading overlay while we fetch data from server */
  const vc = document.getElementById('view-container');
  if (vc) vc.innerHTML = '<div style="text-align:center;padding:80px;color:var(--text-secondary)">Loading data…</div>';

  /* ── Load all data from server ── */
  await fetchState();

  // Sidebar navigation
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); navigate(el.dataset.view); });
  });

  // Modal close
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });

  // ── Sidebar toggle: mobile = overlay, desktop = collapse ──
  const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
  const mobileOverlay    = document.getElementById('mobile-nav-overlay');

  const isMobile = () => window.innerWidth <= 768;

  /* Desktop: persist collapsed state in localStorage */
  const applyCollapsed = (collapsed) => {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    localStorage.setItem('ig_sidebar_collapsed', collapsed ? '1' : '0');
  };

  /* Mobile: slide-in overlay */
  const openMobileNav  = () => document.body.classList.add('mobile-nav-open');
  const closeMobileNav = () => document.body.classList.remove('mobile-nav-open');

  /* Restore desktop collapsed state on load (only on desktop) */
  if (!isMobile() && localStorage.getItem('ig_sidebar_collapsed') === '1') {
    applyCollapsed(true);
  }

  sidebarToggleBtn.addEventListener('click', () => {
    if (isMobile()) {
      document.body.classList.contains('mobile-nav-open') ? closeMobileNav() : openMobileNav();
    } else {
      applyCollapsed(!document.body.classList.contains('sidebar-collapsed'));
    }
  });

  /* Close mobile nav when tapping the dark backdrop */
  if (mobileOverlay) {
    mobileOverlay.addEventListener('click', closeMobileNav);
  }

  /* Close mobile nav when navigating to a view */
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => { if (isMobile()) closeMobileNav(); });
  });

  // ── Theme toggle (stays in localStorage – it's per-user UI pref) ──
  const themeBtn  = document.getElementById('theme-toggle-btn');
  const moonIcon  = document.getElementById('theme-icon-moon');
  const sunIcon   = document.getElementById('theme-icon-sun');
  const applyTheme = (light) => {
    document.body.classList.toggle('light', light);
    moonIcon.style.display = light  ? 'none'  : '';
    sunIcon.style.display  = light  ? ''      : 'none';
    localStorage.setItem('ig_theme', light ? 'light' : 'dark');
  };
  applyTheme(localStorage.getItem('ig_theme') === 'light');
  themeBtn.addEventListener('click', () => {
    applyTheme(!document.body.classList.contains('light'));
  });

  // Initialize sidebar company name
  document.getElementById('sidebar-company-name').textContent = state.settings.company || 'Your Company';

  // Start on dashboard
  navigate('dashboard');

  // Auto-save on unload so data isn't lost if the tab/window crashes or closes
  window.addEventListener('beforeunload', () => {
    persist();
  });

  // Save on visibility change (e.g. when user switches tabs) to minimize loss
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persist();
  });

  // ── Background sync: poll every 15 s so changes from other users appear ──
  setInterval(async () => {
    const viewBefore = state.currentView;
    await fetchState();
    // Skip re-rendering if modal is open OR if editing settings (to preserve form input)
    if (!document.getElementById('modal-overlay').classList.contains('open') && viewBefore !== 'settings') {
      document.getElementById('sidebar-company-name').textContent = state.settings.company || 'Your Company';
      renderView(viewBefore);
    }
  }, 15_000);
});

