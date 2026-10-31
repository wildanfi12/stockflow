const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash, scrypt: scryptCallback, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const scrypt = promisify(scryptCallback);

const root = __dirname;
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'howell-stockflow.db'));

// Database Initialization & Migrations
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`);

// 1. Users / Cashiers Table
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'kasir',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
const ensureUser = db.prepare('UPDATE users SET username=?, name=?, role=?, active=1 WHERE id=?');
const userByUsername = db.prepare('SELECT id FROM users WHERE username=?');
const userById = db.prepare('SELECT id FROM users WHERE id=?');
const insertUser = db.prepare('INSERT INTO users (id, username, name, role, active) VALUES (?, ?, ?, ?, 1)');
for (const user of [
  { id: 1, username: 'admin', name: 'Admin', role: 'admin' },
  { id: 2, username: 'faiz', name: 'Faiz', role: 'kasir' },
  { id: 3, username: 'nick', name: 'Nick', role: 'kasir' },
  { id: 4, username: 'aris', name: 'Aris', role: 'kasir' }
]) {
  const existing = userByUsername.get(user.username);
  if (existing) {
    ensureUser.run(user.username, user.name, user.role, existing.id);
  } else if (userById.get(user.id)) {
    // Reuse the legacy cashier row (e.g. the old inactive Kasir 2) without
    // changing any historical sale or closing snapshots.
    ensureUser.run(user.username, user.name, user.role, user.id);
  } else {
    insertUser.run(user.id, user.username, user.name, user.role);
  }
}
// Admin can authenticate, but is intentionally excluded from cashier lists.
db.prepare("UPDATE users SET active=CASE WHEN username IN ('admin','faiz','nick','aris') THEN 1 ELSE 0 END").run();
const userCols = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
if (!userCols.has('password_salt')) db.exec('ALTER TABLE users ADD COLUMN password_salt TEXT');
if (!userCols.has('password_hash')) db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);
DELETE FROM auth_sessions WHERE expires_at <= CAST(strftime('%s','now') AS INTEGER);
`);

// 2. Products Table
const productSql = `CREATE TABLE products_new (
 id INTEGER PRIMARY KEY, sku TEXT NOT NULL UNIQUE, barcode TEXT UNIQUE, name TEXT NOT NULL,
 category TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT 'pcs',
 reference_price INTEGER NOT NULL DEFAULT 0 CHECK(reference_price>=0), sale_price INTEGER NOT NULL DEFAULT 0 CHECK(sale_price>=0),
 stock INTEGER NOT NULL DEFAULT 0 CHECK(stock>=0), min_stock INTEGER NOT NULL DEFAULT 0 CHECK(min_stock>=0),
 location TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 stock_location TEXT NOT NULL DEFAULT 'Gudang utama', panjang TEXT, source_qty INTEGER,
 source_unit_price INTEGER, source_total INTEGER, source_discount_value INTEGER,
 source_qty_font_color TEXT, source_qty_font_color_type TEXT,
 stock_verification_status TEXT NOT NULL DEFAULT 'NOT_FLAGGED', stock_verification_note TEXT NOT NULL DEFAULT '',
 stock_verified_at TEXT, stock_verified_by TEXT, source_file TEXT, source_sheet TEXT, source_row INTEGER,
 source_unit_price_formula TEXT, source_total_formula TEXT, source_discount_formula TEXT, source_import_id INTEGER
);`;

const existingProducts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='products'").get();
if (!existingProducts) {
  db.exec(productSql.replace('products_new', 'products'));
} else {
  const names = new Set(db.prepare('PRAGMA table_info(products)').all().map(c => c.name));
  const add = {
    panjang: 'TEXT',
    stock_location: "TEXT NOT NULL DEFAULT 'Gudang utama'",
    source_qty: 'INTEGER',
    source_unit_price: 'INTEGER',
    source_total: 'INTEGER',
    source_discount_value: 'INTEGER',
    source_qty_font_color: 'TEXT',
    source_qty_font_color_type: 'TEXT',
    stock_verification_status: "TEXT NOT NULL DEFAULT 'NOT_FLAGGED'",
    stock_verification_note: "TEXT NOT NULL DEFAULT ''",
    stock_verified_at: 'TEXT',
    stock_verified_by: 'TEXT',
    source_file: 'TEXT',
    source_sheet: 'TEXT',
    source_row: 'INTEGER',
    source_unit_price_formula: 'TEXT',
    source_total_formula: 'TEXT',
    source_discount_formula: 'TEXT',
    source_import_id: 'INTEGER'
  };
  for (const [name, type] of Object.entries(add)) {
    if (!names.has(name)) db.exec(`ALTER TABLE products ADD COLUMN ${name} ${type}`);
  }
}

// 3. Inventory Movements, Import, Verification, Audit
db.exec(`
CREATE TABLE IF NOT EXISTS inventory_movements (
 id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), kind TEXT NOT NULL CHECK(kind IN ('opening','in','out','adjustment')),
 quantity INTEGER NOT NULL CHECK(quantity>0), balance_after INTEGER NOT NULL CHECK(balance_after>=0), reference TEXT NOT NULL,
 note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, location TEXT NOT NULL DEFAULT '', user_name TEXT NOT NULL DEFAULT 'Admin Howell');
CREATE TABLE IF NOT EXISTS import_batches (
 id INTEGER PRIMARY KEY, source_file TEXT NOT NULL, source_hash TEXT NOT NULL UNIQUE, source_summary_json TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'PREVIEW_PENDING', import_mode TEXT, destination TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, committed_at TEXT);
CREATE TABLE IF NOT EXISTS import_items (
 id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES import_batches(id), source_sheet TEXT NOT NULL, source_row INTEGER NOT NULL,
 sku TEXT NOT NULL, name TEXT NOT NULL, source_qty INTEGER NOT NULL, source_qty_font_color TEXT,
 source_qty_font_color_type TEXT, source_status TEXT NOT NULL, source_unit_price INTEGER, source_total INTEGER,
 source_discount_value INTEGER, unit_price_formula TEXT, total_formula TEXT, discount_formula TEXT, barcode TEXT,
 import_result TEXT NOT NULL DEFAULT 'PENDING', UNIQUE(batch_id,source_sheet,source_row));
CREATE TABLE IF NOT EXISTS verification_history (
 id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), source_qty INTEGER NOT NULL,
 previous_stock INTEGER NOT NULL, verified_stock INTEGER NOT NULL, difference INTEGER NOT NULL,
 user_name TEXT NOT NULL, reason TEXT NOT NULL, verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS audit_logs (
 id INTEGER PRIMARY KEY, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id INTEGER NOT NULL,
 user_name TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);

// 4. Sales Table & Migration
db.exec(`
CREATE TABLE IF NOT EXISTS sales (
 id INTEGER PRIMARY KEY, invoice_no TEXT NOT NULL UNIQUE, sold_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 customer_name TEXT NOT NULL DEFAULT 'Pelanggan', customer_phone TEXT NOT NULL DEFAULT '',
 payment_method TEXT NOT NULL DEFAULT 'Tunai', payment_status TEXT NOT NULL DEFAULT 'LUNAS',
 transaction_status TEXT NOT NULL DEFAULT 'COMPLETED', payment_ref TEXT NOT NULL DEFAULT '',
 subtotal INTEGER NOT NULL CHECK(subtotal>=0), discount INTEGER NOT NULL DEFAULT 0 CHECK(discount>=0), discount_rate INTEGER NOT NULL DEFAULT 0 CHECK(discount_rate IN (0,20,25)), total INTEGER NOT NULL CHECK(total>=0),
 amount_paid INTEGER NOT NULL DEFAULT 0, change_amount INTEGER NOT NULL DEFAULT 0,
 cashier_id INTEGER NOT NULL DEFAULT 1, cashier_name TEXT NOT NULL DEFAULT 'Admin Howell',
 notes TEXT NOT NULL DEFAULT '', user_name TEXT NOT NULL DEFAULT 'Admin Howell', location TEXT NOT NULL DEFAULT 'Pameran');
CREATE TABLE IF NOT EXISTS sale_items (
 id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id), product_id INTEGER NOT NULL REFERENCES products(id),
 sku TEXT NOT NULL, name TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>0), unit_price INTEGER NOT NULL CHECK(unit_price>=0),
 selling_unit_price INTEGER NOT NULL DEFAULT 0 CHECK(selling_unit_price>=0), line_total INTEGER NOT NULL CHECK(line_total>=0), balance_after INTEGER NOT NULL CHECK(balance_after>=0));
CREATE TABLE IF NOT EXISTS payments (
 id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id), payment_method TEXT NOT NULL,
 amount_due INTEGER NOT NULL CHECK(amount_due >= 0), amount_paid INTEGER NOT NULL CHECK(amount_paid >= 0),
 change_amount INTEGER NOT NULL DEFAULT 0 CHECK(change_amount >= 0), payment_status TEXT NOT NULL DEFAULT 'LUNAS',
 payment_ref TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', paid_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 cashier_id INTEGER NOT NULL DEFAULT 1, cashier_name TEXT NOT NULL DEFAULT 'Admin Howell');
CREATE TABLE IF NOT EXISTS cashier_closings (
 id INTEGER PRIMARY KEY, closing_date TEXT NOT NULL, cashier_id INTEGER NOT NULL, cashier_name TEXT NOT NULL,
 opening_cash INTEGER NOT NULL DEFAULT 0,
 system_cash INTEGER NOT NULL DEFAULT 0, actual_cash INTEGER NOT NULL DEFAULT 0, diff_cash INTEGER NOT NULL DEFAULT 0,
 system_qris INTEGER NOT NULL DEFAULT 0, actual_qris INTEGER NOT NULL DEFAULT 0, diff_qris INTEGER NOT NULL DEFAULT 0,
 system_debit_bca INTEGER NOT NULL DEFAULT 0, actual_debit_bca INTEGER NOT NULL DEFAULT 0, diff_debit_bca INTEGER NOT NULL DEFAULT 0,
 system_credit_bca INTEGER NOT NULL DEFAULT 0, actual_credit_bca INTEGER NOT NULL DEFAULT 0, diff_credit_bca INTEGER NOT NULL DEFAULT 0,
 total_system INTEGER NOT NULL DEFAULT 0, total_actual INTEGER NOT NULL DEFAULT 0, total_diff INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'SELESAI', notes TEXT NOT NULL DEFAULT '',
 reconciled_by TEXT NOT NULL DEFAULT 'Admin Howell', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);

const saleItemCols = new Set(db.prepare('PRAGMA table_info(sale_items)').all().map(c => c.name));
if (!saleItemCols.has('selling_unit_price')) db.exec('ALTER TABLE sale_items ADD COLUMN selling_unit_price INTEGER NOT NULL DEFAULT 0');

// Check and add missing columns on sales
const sCols = new Set(db.prepare('PRAGMA table_info(sales)').all().map(c => c.name));
const salesAddCols = {
  customer_phone: "TEXT NOT NULL DEFAULT ''",
  payment_status: "TEXT NOT NULL DEFAULT 'LUNAS'",
  transaction_status: "TEXT NOT NULL DEFAULT 'COMPLETED'",
  payment_ref: "TEXT NOT NULL DEFAULT ''",
  amount_paid: 'INTEGER NOT NULL DEFAULT 0',
  change_amount: 'INTEGER NOT NULL DEFAULT 0',
  cashier_id: 'INTEGER NOT NULL DEFAULT 1',
  cashier_name: "TEXT NOT NULL DEFAULT 'Admin Howell'",
  notes: "TEXT NOT NULL DEFAULT ''",
  updated_at: "TEXT NOT NULL DEFAULT ''",
  discount_rate: 'INTEGER NOT NULL DEFAULT 0',
  share_token: 'TEXT'
};
for (const [col, type] of Object.entries(salesAddCols)) {
  if (!sCols.has(col)) db.exec(`ALTER TABLE sales ADD COLUMN ${col} ${type};`);
}

db.exec(`CREATE TABLE IF NOT EXISTS sale_idempotency (
 request_key TEXT PRIMARY KEY,
 payload_hash TEXT NOT NULL,
 response_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);

// Indexes
db.exec(`
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_verification ON products(stock_verification_status,active);
CREATE INDEX IF NOT EXISTS idx_movements_product_date ON inventory_movements(product_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sold_at);
CREATE INDEX IF NOT EXISTS idx_sales_cashier ON sales(cashier_id);
CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(payment_status, transaction_status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_share_token ON sales(share_token) WHERE share_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_sale ON payments(sale_id);
CREATE INDEX IF NOT EXISTS idx_closings_date ON cashier_closings(closing_date);
`);

// Helpers
const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  });
  const payload = type.startsWith('application/json') && !Buffer.isBuffer(body) ? JSON.stringify(body) : body;
  res.end(payload);
};

function requireAdmin(req, res, message = 'Perubahan ini hanya dapat dilakukan administrator.') {
  if (req.authUser?.role === 'admin') return true;
  send(res, 403, { error: message });
  return false;
}

function makeInvoicePdf(sale, items) {
  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 44;
  const ink = '#10263b';
  const muted = '#68798b';
  const line = '#dce4ec';
  const pageOps = [];
  let ops = [];
  let y = 0;

  const rgb = color => {
    const value = color.replace('#', '');
    return [0, 2, 4].map(i => (parseInt(value.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');
  };
  const safe = value => String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[–—−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7e]/g, '');
  const pdfString = value => safe(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const text = (value, x, top, size = 9, font = 'F1', color = ink, align = 'left', width = 0) => {
    const s = safe(value);
    const approx = s.length * size * (font === 'F2' ? 0.56 : 0.52);
    const left = align === 'right' ? Math.max(x, x + width - approx) : x;
    const baseline = pageHeight - top - size;
    ops.push('BT /' + font + ' ' + size + ' Tf ' + rgb(color) + ' rg 1 0 0 1 ' + left.toFixed(2) + ' ' + baseline.toFixed(2) + ' Tm (' + pdfString(s) + ') Tj ET');
  };
  const rect = (x, top, width, height, color) => {
    ops.push(rgb(color) + ' rg ' + x + ' ' + (pageHeight - top - height) + ' ' + width + ' ' + height + ' re f');
  };
  const rule = (x1, top, x2, color = line, thickness = 0.6) => {
    ops.push(rgb(color) + ' RG ' + thickness + ' w ' + x1 + ' ' + (pageHeight - top) + ' m ' + x2 + ' ' + (pageHeight - top) + ' l S');
  };
  const money = value => 'Rp ' + Math.round(Number(value || 0)).toLocaleString('id-ID');
  const time = value => {
    try {
      return new Intl.DateTimeFormat('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
        timeZone: 'Asia/Jakarta'
      }).format(new Date(String(value).replace(' ', 'T') + 'Z')) + ' WIB';
    } catch {
      return safe(value);
    }
  };
  const wrap = (value, maxChars) => {
    const words = safe(value).split(/\s+/);
    const result = [];
    let current = '';
    for (const word of words) {
      if (current && (current + ' ' + word).length > maxChars) {
        result.push(current);
        current = word;
      } else {
        current = current ? current + ' ' + word : word;
      }
    }
    if (current) result.push(current);
    return result.length ? result : [''];
  };

  const drawHeader = firstPage => {
    if (firstPage) {
      // Cropped Howell wordmark is an actual brand asset; PDF image is kept on white.
      ops.push('q 118 0 0 25 ' + margin + ' ' + (pageHeight - 36 - 25) + ' cm /ImLogo Do Q');
      text('HOWELL OFFICIAL STORE', 176, 38, 12, 'F2', ink);
      text('PT Howell Niaga Indonesia - Official Exhibition Store', 176, 55, 8, 'F1', muted);
      text('Kabel Audio Video, Adapter & Aksesoris Premium', 176, 68, 8, 'F1', muted);
      text('INVOICE', 395, 35, 19, 'F2', ink, 'right', 156);
      text(sale.invoice_no, 350, 61, 9, 'F2', ink, 'right', 201);
      text(time(sale.sold_at), 350, 77, 8, 'F1', muted, 'right', 201);
      rule(margin, 106, pageWidth - margin, ink, 1.5);
      y = 121;
      rect(margin, y, pageWidth - margin * 2, 86, '#f5f8fb');
      const col1 = margin + 14;
      const col2 = 306;
      const row = (label, value, x, top, width = 225, color = ink) => {
        text(label.toUpperCase(), x, top, 6.5, 'F2', muted);
        text(value || '-', x, top + 9, 8.5, 'F2', color, 'left', width);
      };
      row('Pelanggan', sale.customer_name || 'Pelanggan', col1, y + 10);
      row('Metode pembayaran', sale.payment_method || '-', col2, y + 10);
      row('WhatsApp pelanggan', sale.customer_phone || '-', col1, y + 34);
      row('Status pembayaran', sale.payment_status === 'LUNAS' ? 'LUNAS' : 'MENUNGGU PEMBAYARAN', col2, y + 34,
        225, sale.payment_status === 'LUNAS' ? '#18804b' : '#a66900');
      row('Kasir bertugas', sale.cashier_name || sale.user_name || '-', col1, y + 58);
      row('Status transaksi', sale.transaction_status === 'CANCELLED' ? 'DIBATALKAN' : 'SELESAI',
        col2, y + 58, 225, sale.transaction_status === 'CANCELLED' ? '#b42318' : '#18804b');
      y += 103;
    } else {
      text('HOWELL OFFICIAL STORE', margin, 34, 10, 'F2', ink);
      text('INVOICE  ' + sale.invoice_no, 310, 34, 9, 'F2', muted, 'right', 241);
      rule(margin, 57, pageWidth - margin, ink, 1);
      y = 72;
    }
  };
  const drawTableHeader = () => {
    const x = margin;
    const top = y;
    const w = pageWidth - margin * 2;
    rect(x, top, w, 23, ink);
    text('NO', x + 8, top + 7, 7, 'F2', '#ffffff');
    text('PRODUK / SKU', x + 32, top + 7, 7, 'F2', '#ffffff');
    text('PANJANG', 298, top + 7, 7, 'F2', '#ffffff', 'left', 46);
    text('QTY', 348, top + 7, 7, 'F2', '#ffffff', 'right', 32);
    text('HARGA / UNIT', 383, top + 7, 7, 'F2', '#ffffff', 'right', 76);
    text('TOTAL', 451, top + 7, 7, 'F2', '#ffffff', 'right', 84);
    y += 23;
  };
  const newPage = () => {
    if (ops.length) pageOps.push(ops.join('\n'));
    ops = [];
    drawHeader(false);
    drawTableHeader();
  };

  drawHeader(true);
  text('RINCIAN BARANG', margin, y, 7, 'F2', muted);
  text((items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0) + ' unit',
    430, y, 7, 'F1', muted, 'right', pageWidth - margin - 430);
  y += 15;
  drawTableHeader();

  (items || []).forEach((item, index) => {
    const productLines = wrap(item.name, 43);
    const rowHeight = Math.max(34, 11 + productLines.length * 10 + 10);
    if (y + rowHeight > pageHeight - 145) newPage();
    const top = y;
    if (index % 2 === 1) rect(margin, top, pageWidth - margin * 2, rowHeight, '#fafbfd');
    text(String(index + 1).padStart(2, '0'), margin + 8, top + 10, 8, 'F1', muted);
    productLines.forEach((part, lineIndex) => {
      text(part, margin + 32, top + 6 + lineIndex * 10, 8.3, lineIndex === 0 ? 'F2' : 'F1', ink);
    });
    const skuTop = top + 8 + productLines.length * 10;
    text(item.sku, margin + 32, skuTop, 7, 'F1', muted);
    text(item.panjang || '-', 298, top + 11, 7.5, 'F1', ink, 'left', 46);
    text(String(item.quantity), 348, top + 11, 8, 'F1', ink, 'right', 32);
    text(money(item.selling_unit_price || item.unit_price), 383, top + 11, 7.5, 'F1', ink, 'right', 76);
    text(money(item.line_total), 466, top + 11, 7.5, 'F2', ink, 'right', 84);
    rule(margin, top + rowHeight, pageWidth - margin, line, 0.45);
    y += rowHeight;
  });

  if (y > pageHeight - 205) newPage();
  const totalUnits = (items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const summaryTop = y + 18;
  const summaryX = 312;
  const summaryW = pageWidth - margin - summaryX;
  const totalColor = sale.transaction_status === 'CANCELLED' ? '#b42318' : ink;
  const totalRow = (label, value, top, opts = {}) => {
    text(label, summaryX, top, opts.size || 8.5, opts.bold ? 'F2' : 'F1', opts.color || ink);
    text(value, summaryX, top, opts.size || 8.5, opts.bold ? 'F2' : 'F1', opts.color || ink, 'right', summaryW);
  };
  text('TERIMA KASIH', margin, summaryTop + 4, 8, 'F2', ink);
  text('Terima kasih telah berbelanja di Howell Official Store.', margin, summaryTop + 19, 7.5, 'F1', muted);
  text('Simpan invoice ini sebagai bukti transaksi dan garansi.', margin, summaryTop + 32, 7.5, 'F1', muted);
  totalRow('Subtotal (' + totalUnits + ' unit)', money(sale.subtotal), summaryTop, { color: muted });
  if (Number(sale.discount) > 0) {
    totalRow(sale.discount_rate ? 'Diskon ' + sale.discount_rate + '%' : 'Diskon transaksi',
      '- ' + money(sale.discount), summaryTop + 16, { color: '#b42318' });
  }
  const totalTop = summaryTop + (Number(sale.discount) > 0 ? 38 : 22);
  rule(summaryX, totalTop - 5, pageWidth - margin, ink, 1.1);
  totalRow('TOTAL TAGIHAN', money(sale.total), totalTop, { bold: true, size: 12, color: totalColor });
  if (sale.payment_method === 'Tunai') {
    totalRow('Uang diterima', money(sale.amount_paid ?? sale.total), totalTop + 23, { size: 8, color: muted });
    totalRow('Kembalian', money(sale.change_amount || 0), totalTop + 37, { size: 8, color: muted });
  }
  y = Math.max(summaryTop + 55, totalTop + (sale.payment_method === 'Tunai' ? 57 : 31));
  rule(margin, y + 12, pageWidth - margin, line, 0.6);
  text('Invoice elektronik Howell StockFlow', margin, y + 22, 7, 'F1', muted);
  text('Nomor invoice: ' + sale.invoice_no, margin, y + 34, 7, 'F1', muted);

  pageOps.push(ops.join('\n'));
  const pageCount = pageOps.length;
  for (let index = 0; index < pageCount; index++) {
    const footerY = 30;
    pageOps[index] += '\n' +
      rgb(muted) + ' RG 0.45 w ' + margin + ' ' + footerY + ' m ' + (pageWidth - margin) + ' ' + footerY + ' l S\n' +
      'BT /F1 7 Tf ' + rgb(muted) + ' rg 1 0 0 1 ' + margin + ' 17' +
      ' Tm (Howell StockFlow  |  ' + pdfString(sale.invoice_no) + ') Tj ET\n' +
      'BT /F1 7 Tf ' + rgb(muted) + ' rg 1 0 0 1 ' + (pageWidth - margin - 58) + ' 17' +
      ' Tm (Halaman ' + (index + 1) + ' / ' + pageCount + ') Tj ET';
  }
  const fontRegular = Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const fontBold = Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const logoPath = path.join(root, 'assets', 'howell-invoice-logo.jpg');
  const logo = fs.readFileSync(logoPath);
  const objects = [null];
  const addObject = body => { objects.push(body); return objects.length - 1; };
  const catalogId = addObject(null);
  const pagesId = addObject(null);
  const regularId = addObject(fontRegular);
  const boldId = addObject(fontBold);
  const logoId = addObject(Buffer.concat([
    Buffer.from('<< /Type /XObject /Subtype /Image /Width 864 /Height 184 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + logo.length + ' >>\nstream\n'),
    logo,
    Buffer.from('\nendstream')
  ]));
  const pageIds = [];
  for (const content of pageOps) {
    const bytes = Buffer.from(content, 'ascii');
    const contentId = addObject(Buffer.concat([
      Buffer.from('<< /Length ' + bytes.length + ' >>\nstream\n'), bytes, Buffer.from('\nendstream')
    ]));
    const pageId = addObject(null);
    pageIds.push(pageId);
    objects[pageId] = Buffer.from(
      '<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 ' + pageWidth + ' ' + pageHeight +
      '] /Resources << /Font << /F1 ' + regularId + ' 0 R /F2 ' + boldId +
      ' 0 R >> /XObject << /ImLogo ' + logoId + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>'
    );
  }
  objects[catalogId] = Buffer.from('<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>');
  objects[pagesId] = Buffer.from('<< /Type /Pages /Kids [' + pageIds.map(id => id + ' 0 R').join(' ') + '] /Count ' + pageCount + ' >>');

  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary')];
  const offsets = [0];
  let position = parts[0].length;
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = position;
    const object = Buffer.concat([Buffer.from(id + ' 0 obj\n'), objects[id], Buffer.from('\nendobj\n')]);
    parts.push(object);
    position += object.length;
  }
  const xrefOffset = position;
  let xref = 'xref\n0 ' + objects.length + '\n0000000000 65535 f \n';
  for (let id = 1; id < objects.length; id++) xref += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
  xref += 'trailer\n<< /Size ' + objects.length + ' /Root ' + catalogId + ' 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF';
  parts.push(Buffer.from(xref, 'ascii'));
  return Buffer.concat(parts);
}

const readBody = req => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', c => {
    s += c;
    if (s.length > 3_000_000) reject(new Error('Permintaan terlalu besar.'));
  });
  req.on('end', () => {
    try {
      resolve(JSON.parse(s || '{}'));
    } catch {
      reject(new Error('Isi permintaan JSON tidak valid.'));
    }
  });
  req.on('error', reject);
});

const validEAN = code => /^\d{13}$/.test(code) && [...code.slice(0, 12)].reduce((sum, n, i) => sum + Number(n) * (i % 2 ? 3 : 1), 0) % 10 === (10 - Number(code[12])) % 10;

const SESSION_SECONDS = 12 * 60 * 60;
const loginAttempts = new Map();
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const passwordDigest = (password, salt) => scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const cookieValue = (req, name) => {
  const part = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
};
const requestOrigin = req => {
  const proto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
  return `${proto}://${req.headers.host}`;
};
const validRequestOrigin = req => {
  const origin = req.headers.origin;
  const expected = process.env.PUBLIC_BASE_URL ? new URL(process.env.PUBLIC_BASE_URL).origin : requestOrigin(req);
  return typeof origin === 'string' && origin === expected;
};
const sessionCookie = (req, token, maxAge = SESSION_SECONDS) => {
  const secure = (process.env.PUBLIC_BASE_URL || '').startsWith('https://') || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return `stockflow_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
};
const authenticatedUser = req => {
  const token = cookieValue(req, 'stockflow_session');
  if (!token || token.length < 40 || token.length > 100) return null;
  return db.prepare(`SELECT u.id,u.username,u.name,u.role,s.token_hash FROM auth_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`).get(tokenHash(token), Math.floor(Date.now() / 1000)) || null;
};
const loginError = { error: 'Nama akun atau kata sandi salah.' };

function generateEAN13() {
  const base = '200' + String(Math.floor(100_000_000 + Math.random() * 900_000_000));
  const sum = [...base].reduce((acc, d, i) => acc + Number(d) * (i % 2 ? 3 : 1), 0);
  const check = (10 - (sum % 10)) % 10;
  return base + check;
}

function toCsv(rows, columns) {
  const header = columns.map(c => `"${String(c.title).replace(/"/g, '""')}"`).join(';');
  const lines = rows.map(r => columns.map(c => {
    let v = c.val(r);
    if (v === null || v === undefined) v = '';
    return `"${String(v).replace(/"/g, '""')}"`;
  }).join(';'));
  return '\uFEFF' + [header, ...lines].join('\r\n');
}

const listProducts = (q = '') => db.prepare(`SELECT * FROM products WHERE active=1 AND (?='' OR sku LIKE ? OR barcode LIKE ? OR name LIKE ? OR category LIKE ?) ORDER BY updated_at DESC`).all(q, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
const latestBatch = () => db.prepare('SELECT * FROM import_batches ORDER BY id DESC LIMIT 1').get();

function importSummary() {
  const b = latestBatch();
  if (!b) return { batch: null, summary: null };
  const base = db.prepare(`SELECT COUNT(*) sku_count,COALESCE(SUM(source_qty),0) total_source_qty,
  SUM(CASE WHEN source_status='NEEDS_VERIFICATION' THEN 1 ELSE 0 END) needs_verification_count,
  SUM(CASE WHEN source_status='NOT_FLAGGED' THEN 1 ELSE 0 END) not_flagged_count,
  SUM(CASE WHEN source_status='MANUAL_REVIEW' THEN 1 ELSE 0 END) manual_review_count,
  SUM(CASE WHEN source_unit_price IS NULL OR source_unit_price<0 THEN 1 ELSE 0 END) price_problem_count,
  SUM(CASE WHEN unit_price_formula IS NOT NULL THEN 1 ELSE 0 END) formula_unit_price_count,
  SUM(CASE WHEN barcode IS NULL OR barcode='' THEN 1 ELSE 0 END) missing_barcode_count FROM import_items WHERE batch_id=?`).get(b.id);
  const dup = db.prepare(`SELECT COUNT(*) n FROM import_items i WHERE i.batch_id=? AND i.sku IN (SELECT sku FROM products WHERE active=1)`).get(b.id).n;
  const internal = db.prepare(`SELECT COUNT(*)-COUNT(DISTINCT sku) n FROM import_items WHERE batch_id=?`).get(b.id).n;
  let parsedSummary = {};
  try { parsedSummary = JSON.parse(b.source_summary_json); } catch {}
  return {
    batch: { id: b.id, source_file: b.source_file, status: b.status, import_mode: b.import_mode, destination: b.destination, created_at: b.created_at, committed_at: b.committed_at },
    summary: { ...base, existing_sku_conflicts: dup, duplicate_sku_count: internal, worksheets: parsedSummary.worksheets, manual_review: parsedSummary.manual_review }
  };
}

const VALID_PAYMENT_METHODS = [
  'Tunai',
  'QRIS',
  'Kartu Debit BCA (EDC)',
  'Kartu Kredit BCA (EDC)'
];

// HTTP Server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      if (!validRequestOrigin(req)) return send(res, 403, { error: 'Asal permintaan tidak valid.' });
      const data = await readBody(req);
      const username = String(data.username || '').trim().toLowerCase().slice(0, 80);
      const password = String(data.password || '');
      if (!username || !password || password.length > 256) return send(res, 401, loginError);
      const now = Date.now();
      for (const [key, value] of loginAttempts) if (value.resetAt <= now) loginAttempts.delete(key);
      const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown').slice(0, 100);
      const attemptKey = `${ip}:${username}`;
      const attempt = loginAttempts.get(attemptKey) || { count: 0, resetAt: now + 15 * 60 * 1000 };
      if (attempt.count >= 10) return send(res, 429, { error: 'Terlalu banyak percobaan. Coba lagi 15 menit kemudian.' });
      attempt.count++;
      loginAttempts.set(attemptKey, attempt);
      const user = db.prepare('SELECT id,username,name,role,active,password_salt,password_hash FROM users WHERE username=?').get(username);
      const salt = user?.password_salt || 'howell-stockflow-invalid-login-salt';
      const actual = await passwordDigest(password, salt);
      const expected = user?.password_hash ? Buffer.from(user.password_hash, 'hex') : Buffer.alloc(64);
      const matched = expected.length === actual.length && timingSafeEqual(expected, actual);
      if (!matched || !user || !user.active || !user.password_hash) return send(res, 401, loginError);
      loginAttempts.delete(attemptKey);
      const token = randomBytes(32).toString('base64url');
      const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
      db.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(tokenHash(token), user.id, expiresAt);
      db.prepare('DELETE FROM auth_sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM auth_sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 5)').run(user.id, user.id);
      res.setHeader('Set-Cookie', sessionCookie(req, token));
      return send(res, 200, { id: user.id, username: user.username, name: user.name, role: user.role, expires_at: expiresAt });
    }

    const invoicePdfMatch = url.pathname.match(/^\/invoice\/([A-Za-z0-9_-]{32,64})\.pdf$/);
    if (req.method === 'GET' && invoicePdfMatch) {
      const sale = db.prepare('SELECT * FROM sales WHERE share_token=?').get(invoicePdfMatch[1]);
      if (!sale) return send(res, 404, 'Invoice tidak ditemukan atau tautan sudah tidak berlaku.', 'text/plain; charset=utf-8');
      const items = db.prepare('SELECT si.*, p.panjang FROM sale_items si LEFT JOIN products p ON p.id=si.product_id WHERE si.sale_id=? ORDER BY si.id').all(sale.id);
      const pdf = makeInvoicePdf(sale, items);
      const disposition = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
      const filename = String(sale.invoice_no || 'Howell-Invoice').replace(/[^A-Za-z0-9_-]/g, '-');
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': pdf.length,
        'Content-Disposition': disposition + '; filename="' + filename + '.pdf"',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(pdf);
    }

    if (url.pathname.startsWith('/api/')) {
      const authUser = authenticatedUser(req);
      if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
        if (!authUser) return send(res, 401, { error: 'Sesi login sudah berakhir. Silakan masuk kembali.' });
        if (!validRequestOrigin(req)) return send(res, 403, { error: 'Asal permintaan tidak valid.' });
        db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(authUser.token_hash);
        res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
        return send(res, 200, { ok: true });
      }
      if (!authUser) return send(res, 401, { error: 'Silakan masuk untuk melanjutkan.' });
      req.authUser = authUser;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !validRequestOrigin(req)) {
        return send(res, 403, { error: 'Asal permintaan tidak valid.' });
      }

      if (req.method === 'GET' && url.pathname === '/api/auth/me') {
        return send(res, 200, { id: authUser.id, username: authUser.username, name: authUser.name, role: authUser.role });
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/change-password') {
        const data = await readBody(req);
        const current = String(data.current_password || ''), next = String(data.new_password || '');
        const user = db.prepare('SELECT password_salt,password_hash FROM users WHERE id=? AND active=1').get(authUser.id);
        const actual = await passwordDigest(current, user.password_salt || 'howell-stockflow-invalid-login-salt');
        const expected = user.password_hash ? Buffer.from(user.password_hash, 'hex') : Buffer.alloc(64);
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return send(res, 401, { error: 'Kata sandi saat ini tidak cocok.' });
        if (next.length < 12 || next.length > 256) return send(res, 400, { error: 'Kata sandi baru harus 12–256 karakter.' });
        const salt = randomBytes(16).toString('hex');
        const hash = (await passwordDigest(next, salt)).toString('hex');
        db.prepare('UPDATE users SET password_salt=?,password_hash=? WHERE id=?').run(salt, hash, authUser.id);
        db.prepare('DELETE FROM auth_sessions WHERE user_id=? AND token_hash<>?').run(authUser.id, authUser.token_hash);
        return send(res, 200, { ok: true });
      }

      // ==================== USERS / CASHIERS ====================
      if (req.method === 'GET' && url.pathname === '/api/users') {
        // Admin may be assigned as the transaction attendant while retaining
        // administrator authorization for protected operations.
        const users = db.prepare("SELECT id, name, role, active FROM users WHERE active=1 AND (role='kasir' OR (role='admin' AND ?='admin')) ORDER BY id").all(req.authUser.role);
        return send(res, 200, users);
      }

      if (req.method === 'GET' && url.pathname === '/assets/howell-logo.png') {
        const logo = path.join(root, 'assets', 'howell-logo.png');
        if (!fs.existsSync(logo)) return send(res, 404, 'Logo tidak ditemukan.', 'text/plain; charset=utf-8');
        return send(res, 200, fs.readFileSync(logo), 'image/png');
      }

      // ==================== SALES EXPORT ====================
      if (req.method === 'GET' && url.pathname === '/api/sales/export') {
        const from = url.searchParams.get('from') || '', to = url.searchParams.get('to') || '';
        const cashierId = req.authUser.role === 'kasir' ? String(req.authUser.id) : (url.searchParams.get('cashier_id') || '');
        const paymentMethod = url.searchParams.get('payment_method') || '';
        const paymentStatus = url.searchParams.get('payment_status') || '';

        const rows = db.prepare(`
          SELECT s.*, COUNT(i.id) item_count, COALESCE(SUM(i.quantity),0) unit_count,
            COALESCE(GROUP_CONCAT(i.sku, ', '), '') sku_list
          FROM sales s
          LEFT JOIN sale_items i ON i.sale_id=s.id
          WHERE (?='' OR date(s.sold_at, '+7 hours')>=date(?))
            AND (?='' OR date(s.sold_at, '+7 hours')<=date(?))
            AND (?='' OR s.cashier_id = ?)
            AND (?='' OR s.payment_method = ?)
            AND (?='' OR s.payment_status = ?)
          GROUP BY s.id
          ORDER BY s.id DESC
        `).all(from, from, to, to, cashierId, cashierId, paymentMethod, paymentMethod, paymentStatus, paymentStatus);

        const csv = toCsv(rows, [
          { title: 'No. Transaksi', val: r => r.id },
          { title: 'No. Invoice', val: r => r.invoice_no },
          { title: 'Waktu Transaksi (WIB)', val: r => r.sold_at },
          { title: 'ID Kasir', val: r => r.cashier_id },
          { title: 'Nama Kasir', val: r => r.cashier_name },
          { title: 'Nama Pelanggan', val: r => r.customer_name },
          { title: 'No. WhatsApp', val: r => r.customer_phone || '' },
          { title: 'Metode Pembayaran', val: r => r.payment_method },
          { title: 'Status Pembayaran', val: r => r.payment_status },
          { title: 'Status Transaksi', val: r => r.transaction_status },
          { title: 'Referensi Pembayaran', val: r => r.payment_ref || '' },
          { title: 'Jumlah SKU', val: r => r.item_count },
          { title: 'SKU Produk', val: r => r.sku_list },
          { title: 'Total Unit', val: r => r.unit_count },
          { title: 'Subtotal (Rp)', val: r => r.subtotal },
          { title: 'Diskon (Rp)', val: r => r.discount },
          { title: 'Total Tagihan (Rp)', val: r => r.total },
          { title: 'Nominal Dibayar (Rp)', val: r => r.amount_paid },
          { title: 'Kembalian (Rp)', val: r => r.change_amount },
          { title: 'Catatan', val: r => r.notes || '' },
          { title: 'Lokasi', val: r => r.location }
        ]);

        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="riwayat-penjualan-howell.csv"'
        });
        return res.end(csv);
      }

      // ==================== LIST SALES ====================
      if (req.method === 'GET' && url.pathname === '/api/sales') {
        const from = url.searchParams.get('from') || '', to = url.searchParams.get('to') || '';
        const cashierId = req.authUser.role === 'kasir' ? String(req.authUser.id) : (url.searchParams.get('cashier_id') || '');
        const paymentMethod = url.searchParams.get('payment_method') || '';
        const paymentStatus = url.searchParams.get('payment_status') || '';
        const transactionStatus = url.searchParams.get('transaction_status') || '';
        const q = url.searchParams.get('q') || '';

        const rows = db.prepare(`
          SELECT s.*, COUNT(i.id) item_count, COALESCE(SUM(i.quantity),0) unit_count,
            COALESCE(GROUP_CONCAT(i.sku, ', '), '') sku_list
          FROM sales s
          LEFT JOIN sale_items i ON i.sale_id=s.id
          WHERE (?='' OR date(s.sold_at, '+7 hours')>=date(?))
            AND (?='' OR date(s.sold_at, '+7 hours')<=date(?))
            AND (?='' OR s.cashier_id = ?)
            AND (?='' OR s.payment_method = ?)
            AND (?='' OR s.payment_status = ?)
            AND (?='' OR s.transaction_status = ?)
            AND (?='' OR s.invoice_no LIKE ? OR s.customer_name LIKE ? OR s.cashier_name LIKE ? OR s.payment_ref LIKE ?)
          GROUP BY s.id
          ORDER BY s.id DESC
        `).all(
          from, from, to, to,
          cashierId, cashierId,
          paymentMethod, paymentMethod,
          paymentStatus, paymentStatus,
          transactionStatus, transactionStatus,
          q, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`
        );
        return send(res, 200, rows.map(({ share_token, ...row }) => row));
      }

      const shareLinkMatch = url.pathname.match(/^\/api\/sales\/(\d+)\/share-link$/);
      if (req.method === 'POST' && shareLinkMatch) {
        const id = Number(shareLinkMatch[1]);
        const sale = db.prepare('SELECT id, invoice_no, share_token, cashier_id FROM sales WHERE id=?').get(id);
        if (!sale) return send(res, 404, { error: 'Transaksi tidak ditemukan.' });
        if (req.authUser.role === 'kasir' && sale.cashier_id !== req.authUser.id) return send(res, 404, { error: 'Transaksi tidak ditemukan.' });
        const token = sale.share_token || randomBytes(32).toString('base64url');
        if (!sale.share_token) db.prepare('UPDATE sales SET share_token=? WHERE id=?').run(token, id);
        const configuredOrigin = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
        const forwardedProto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
        const requestOrigin = configuredOrigin || (forwardedProto + '://' + req.headers.host);
        return send(res, 200, {
          invoice_no: sale.invoice_no,
          url: requestOrigin + '/invoice/' + token + '.pdf'
        });
      }

      // ==================== SINGLE SALE DETAIL ====================
      const saleMatch = url.pathname.match(/^\/api\/sales\/(\d+)$/);
      if (req.method === 'GET' && saleMatch) {
        const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(Number(saleMatch[1]));
        if (!sale) return send(res, 404, { error: 'Transaksi tidak ditemukan.' });
        if (req.authUser.role === 'kasir' && sale.cashier_id !== req.authUser.id) return send(res, 404, { error: 'Transaksi tidak ditemukan.' });
        const items = db.prepare(`
          SELECT si.*, p.panjang, p.category
          FROM sale_items si
          LEFT JOIN products p ON p.id = si.product_id
          WHERE si.sale_id=?
          ORDER BY si.id
        `).all(sale.id);
        const payments = db.prepare('SELECT * FROM payments WHERE sale_id=? ORDER BY id').all(sale.id);
        const { share_token, ...publicSale } = sale;
        return send(res, 200, { ...publicSale, items, payments });
      }

      // ==================== CREATE SALE ====================
      if (req.method === 'POST' && url.pathname === '/api/sales') {
        const data = await readBody(req);
        const items = Array.isArray(data.items) ? data.items : [];
        if (!items.length || items.length > 150) {
          return send(res, 400, { error: 'Scan minimal satu produk sebelum menyelesaikan transaksi.' });
        }

        const customerName = String(data.customer_name || 'Pelanggan').trim() || 'Pelanggan';
        const customerPhone = String(data.customer_phone || '').trim();
        const paymentMethod = String(data.payment_method || 'Tunai').trim();
        if (!VALID_PAYMENT_METHODS.includes(paymentMethod)) {
          return send(res, 400, { error: `Metode pembayaran tidak valid. Pilihan: ${VALID_PAYMENT_METHODS.join(', ')}` });
        }

        // Cashier handling: verify ID and lookup name
        const cashierId = req.authUser.role === 'kasir' ? req.authUser.id : Number(data.cashier_id || 0);
        const userObj = db.prepare("SELECT * FROM users WHERE id=? AND active=1 AND role IN ('admin','kasir')").get(cashierId);
        if (!userObj) return send(res, 400, { error: 'Pilih Admin atau salah satu kasir yang aktif.' });
        const cashierName = userObj.name;

        // Payment status & verification
        const paymentStatus = String(data.payment_status || 'LUNAS').trim().toUpperCase();
        if (!['LUNAS', 'MENUNGGU_PEMBAYARAN'].includes(paymentStatus)) {
          return send(res, 400, { error: 'Status pembayaran tidak valid.' });
        }
        if (paymentMethod === 'Tunai' && paymentStatus !== 'LUNAS') {
          return send(res, 400, { error: 'Transaksi tunai harus berstatus LUNAS.' });
        }

        const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
        if (idempotencyKey && !/^[A-Za-z0-9_-]{16,64}$/.test(idempotencyKey)) {
          return send(res, 400, { error: 'Kunci transaksi tidak valid. Silakan muat ulang dan coba kembali.' });
        }
        const payloadHash = idempotencyKey
          ? createHash('sha256').update(JSON.stringify(data)).digest('hex')
          : null;

        const paymentRef = String(data.payment_ref || '').trim();
        const notes = String(data.notes || '').trim();

        db.exec('BEGIN IMMEDIATE');
        try {
          if (idempotencyKey) {
            const previous = db.prepare('SELECT payload_hash,response_json FROM sale_idempotency WHERE request_key=?').get(idempotencyKey);
            if (previous) {
              if (previous.payload_hash !== payloadHash) throw new Error('Kunci transaksi ini sudah dipakai untuk isi keranjang berbeda. Mulai transaksi baru.');
              const response = JSON.parse(previous.response_json);
              db.exec('COMMIT');
              return send(res, 201, response);
            }
          }

          const prepared = [];
          for (const item of items) {
            const id = Number(item.product_id), qty = Number(item.quantity);
            if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1) {
              throw new Error('Produk dan jumlah unit harus valid.');
            }
            const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(id);
            if (!p) throw new Error(`Produk dengan ID ${id} tidak ditemukan atau sudah tidak aktif.`);
            const price = Number(p.sale_price > 0 ? p.sale_price : (p.source_unit_price ?? 0));
            if (!Number.isSafeInteger(price) || price <= 0) {
              throw new Error(`Harga jual SKU ${p.sku} belum tersedia. Lengkapi harga produk sebelum transaksi.`);
            }
            if (item.unit_price !== undefined && (!Number.isSafeInteger(Number(item.unit_price)) || Number(item.unit_price) !== price)) {
              throw new Error(`Harga SKU ${p.sku} berubah atau tidak sesuai katalog. Muat ulang produk sebelum melanjutkan.`);
            }
            const existing = prepared.find(x => x.p.id === id);
            if (existing) {
              existing.qty += qty;
              existing.line += qty * price;
              if (existing.price !== price) throw new Error('Harga SKU yang sama harus seragam dalam satu transaksi.');
              continue;
            }
            prepared.push({ p, qty, price, line: qty * price });
          }

          for (const x of prepared) {
            if (x.qty > x.p.stock) {
              throw new Error(`Stok ${x.p.sku} (${x.p.name}) tidak mencukupi. Tersedia di sistem: ${x.p.stock} ${x.p.unit}.`);
            }
          }

          const subtotal = prepared.reduce((n, x) => n + x.line, 0);
          if (!Number.isSafeInteger(subtotal)) throw new Error('Total nilai transaksi melebihi kapasitas yang didukung.');
          const discountRate = Number(data.discount_rate || 0);
          if (![0, 20, 25].includes(discountRate)) throw new Error('Pilih diskon 0%, 20%, atau 25%.');
          for (const x of prepared) {
            const price = BigInt(x.price);
            x.sellingPrice = discountRate === 0 ? x.price : Number((((price * BigInt(100 - discountRate)) + 99999n) / 100000n) * 1000n);
            x.netLine = x.sellingPrice * x.qty;
          }
          const total = prepared.reduce((sum, x) => sum + x.netLine, 0);
          const discount = subtotal - total;
          if (!Number.isSafeInteger(discount) || discount < 0 || !Number.isSafeInteger(total)) {
            throw new Error('Total transaksi tidak valid. Periksa harga dan pembulatan diskon produk.');
          }

          let amountPaid = 0;
          let changeAmount = 0;
          if (paymentMethod === 'Tunai') {
            amountPaid = Number(data.amount_paid ?? 0);
            if (!Number.isSafeInteger(amountPaid) || amountPaid < total) {
              throw new Error('Nominal uang tunai harus berupa Rupiah bulat dan minimal sebesar total tagihan.');
            }
            changeAmount = amountPaid - total;
          } else {
            amountPaid = paymentStatus === 'LUNAS' ? total : 0;
          }

          const now = new Date();
          const invoice = `HWF-${now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${String(Date.now()).slice(-5)}`;
          const shareToken = randomBytes(32).toString('base64url');

          const saleInsert = db.prepare(`
            INSERT INTO sales (
              invoice_no, customer_name, customer_phone, payment_method, payment_status,
              transaction_status, payment_ref, subtotal, discount, discount_rate, total, amount_paid,
              change_amount, cashier_id, cashier_name, notes, user_name, location, share_token
            ) VALUES (?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pameran', ?)
          `);

          const saleRes = saleInsert.run(
            invoice, customerName, customerPhone, paymentMethod, paymentStatus,
            paymentRef, subtotal, discount, discountRate, total, amountPaid,
            changeAmount, cashierId, cashierName, notes, req.authUser.name, shareToken
          );
          const saleId = Number(saleRes.lastInsertRowid);

          // Insert sale items & deduct stock atomik
          const itemInsert = db.prepare(`
            INSERT INTO sale_items (sale_id, product_id, sku, name, quantity, unit_price, selling_unit_price, line_total, balance_after)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          const updateStock = db.prepare(`UPDATE products SET stock=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`);
          const moveInsert = db.prepare(`
            INSERT INTO inventory_movements (product_id, kind, quantity, balance_after, reference, note, location, user_name)
            VALUES (?, 'out', ?, ?, ?, ?, ?, ?)
          `);

          for (const x of prepared) {
            const balance = x.p.stock - x.qty;
            updateStock.run(balance, x.p.id);
            itemInsert.run(saleId, x.p.id, x.p.sku, x.p.name, x.qty, x.price, x.sellingPrice, x.netLine, balance);
            moveInsert.run(x.p.id, x.qty, balance, invoice, `Penjualan kasir ${invoice} (${cashierName})`, x.p.stock_location || 'Pameran', req.authUser.name);
          }

          // Insert payment record
          db.prepare(`
            INSERT INTO payments (
              sale_id, payment_method, amount_due, amount_paid, change_amount,
              payment_status, payment_ref, note, cashier_id, cashier_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(saleId, paymentMethod, total, amountPaid, changeAmount, paymentStatus, paymentRef, notes, cashierId, cashierName);

          // Audit log
          db.prepare(`
            INSERT INTO audit_logs (action, entity, entity_id, user_name, details)
            VALUES ('CREATE_SALE', 'sale', ?, ?, ?)
          `).run(saleId, req.authUser.name, JSON.stringify({
            invoice_no: invoice,
            cashier_id: cashierId,
            cashier_name: cashierName,
            total,
            payment_method: paymentMethod,
            payment_status: paymentStatus,
            payment_ref: paymentRef,
            item_count: prepared.length
          }));

          const response = { id: saleId, invoice_no: invoice, payment_status: paymentStatus, total };
          if (idempotencyKey) {
            db.prepare('INSERT INTO sale_idempotency(request_key,payload_hash,response_json) VALUES(?,?,?)')
              .run(idempotencyKey, payloadHash, JSON.stringify(response));
          }

          db.exec('COMMIT');
          return send(res, 201, response);
        } catch (e) {
          db.exec('ROLLBACK');
          return send(res, 409, { error: e.message || 'Transaksi gagal disimpan.' });
        }
      }

      // ==================== CONFIRM PAYMENT ====================
      const confirmMatch = url.pathname.match(/^\/api\/sales\/(\d+)\/confirm-payment$/);
      if (req.method === 'POST' && confirmMatch) {
        const id = Number(confirmMatch[1]);
        const data = await readBody(req);
        const ref = String(data.payment_ref || '').trim();
        const user = req.authUser.name;

        db.exec('BEGIN IMMEDIATE');
        try {
          const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(id);
          if (!sale) throw new Error('Transaksi tidak ditemukan.');
          if (req.authUser.role === 'kasir' && sale.cashier_id !== req.authUser.id) throw new Error('Transaksi tidak ditemukan.');
          if (sale.transaction_status === 'CANCELLED') throw new Error('Transaksi sudah dibatalkan; pembayaran tidak dapat dikonfirmasi.');
          if (sale.payment_status === 'LUNAS') throw new Error('Pembayaran transaksi ini sudah berstatus LUNAS.');

          db.prepare(`UPDATE sales SET payment_status='LUNAS', payment_ref=?, amount_paid=total, change_amount=0, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(ref || sale.payment_ref, id);
          db.prepare(`UPDATE payments SET payment_status='LUNAS', payment_ref=?, amount_paid=amount_due, change_amount=0, paid_at=CURRENT_TIMESTAMP WHERE sale_id=?`).run(ref || sale.payment_ref, id);

          db.prepare(`
            INSERT INTO audit_logs (action, entity, entity_id, user_name, details)
            VALUES ('CONFIRM_PAYMENT', 'sale', ?, ?, ?)
          `).run(id, user, JSON.stringify({ invoice_no: sale.invoice_no, payment_ref: ref || sale.payment_ref }));

          db.exec('COMMIT');
          return send(res, 200, { ok: true, id, payment_status: 'LUNAS' });
        } catch (e) {
          db.exec('ROLLBACK');
          return send(res, 409, { error: e.message || 'Konfirmasi pembayaran gagal.' });
        }
      }

      // ==================== CANCEL SALE ====================
      const cancelMatch = url.pathname.match(/^\/api\/sales\/(\d+)\/cancel$/);
      if (req.method === 'POST' && cancelMatch) {
        const id = Number(cancelMatch[1]);
        const data = await readBody(req);
        const reason = String(data.reason || '').trim();
        if (!reason) return send(res, 400, { error: 'Alasan pembatalan transaksi wajib diisi.' });
        const user = req.authUser.name;

        db.exec('BEGIN IMMEDIATE');
        try {
          const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(id);
          if (!sale) throw new Error('Transaksi tidak ditemukan.');
          if (req.authUser.role === 'kasir' && sale.cashier_id !== req.authUser.id) throw new Error('Transaksi tidak ditemukan.');
          if (sale.transaction_status === 'CANCELLED') throw new Error('Transaksi ini sudah dibatalkan sebelumnya.');

          // Restore inventory stock atomik
          const items = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(id);
          for (const item of items) {
            const p = db.prepare('SELECT * FROM products WHERE id=?').get(item.product_id);
            if (p) {
              const newBalance = p.stock + item.quantity;
              db.prepare('UPDATE products SET stock=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(newBalance, p.id);
              db.prepare(`
                INSERT INTO inventory_movements (product_id, kind, quantity, balance_after, reference, note, location, user_name)
                VALUES (?, 'adjustment', ?, ?, ?, ?, ?, ?)
              `).run(p.id, item.quantity, newBalance, `BATAL-${sale.invoice_no}`, `Pengembalian stok pembatalan transaksi (${sale.invoice_no}): ${reason}`, p.stock_location || 'Pameran', user);
            }
          }

          db.prepare(`UPDATE sales SET transaction_status='CANCELLED', payment_status='DIBATALKAN', notes=? WHERE id=?`).run(`${sale.notes ? sale.notes + ' | ' : ''}Dibatalkan: ${reason}`, id);
          db.prepare(`UPDATE payments SET payment_status='DIBATALKAN', note=? WHERE sale_id=?`).run(`Dibatalkan: ${reason}`, id);

          db.prepare(`
            INSERT INTO audit_logs (action, entity, entity_id, user_name, details)
            VALUES ('CANCEL_SALE', 'sale', ?, ?, ?)
          `).run(id, user, JSON.stringify({ invoice_no: sale.invoice_no, reason }));

          db.exec('COMMIT');
          return send(res, 200, { ok: true, id, status: 'CANCELLED' });
        } catch (e) {
          db.exec('ROLLBACK');
          return send(res, 409, { error: e.message || 'Pembatalan transaksi gagal.' });
        }
      }

      // ==================== CORRECT CASHIER (ADMIN) ====================
      const correctMatch = url.pathname.match(/^\/api\/sales\/(\d+)\/correct-cashier$/);
      if (req.method === 'POST' && correctMatch) {
        if (req.authUser.role !== 'admin') return send(res, 403, { error: 'Koreksi kasir hanya dapat dilakukan administrator.' });
        const id = Number(correctMatch[1]);
        const data = await readBody(req);
        const newCashierId = Number(data.cashier_id);
        const adminUser = req.authUser.name;
        const reason = String(data.reason || '').trim();
        if (!reason) return send(res, 400, { error: 'Alasan koreksi data kasir wajib dicatat untuk audit log.' });

        const userObj = db.prepare("SELECT * FROM users WHERE id=? AND active=1 AND role='kasir'").get(newCashierId);
        if (!userObj) return send(res, 404, { error: 'Data kasir baru tidak ditemukan.' });

        db.exec('BEGIN IMMEDIATE');
        try {
          const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(id);
          if (!sale) throw new Error('Transaksi tidak ditemukan.');
          const oldName = sale.cashier_name;

          db.prepare(`UPDATE sales SET cashier_id=?, cashier_name=? WHERE id=?`).run(userObj.id, userObj.name, id);
          db.prepare(`UPDATE payments SET cashier_id=?, cashier_name=? WHERE sale_id=?`).run(userObj.id, userObj.name, id);

          db.prepare(`
            INSERT INTO audit_logs (action, entity, entity_id, user_name, details)
            VALUES ('CORRECT_CASHIER', 'sale', ?, ?, ?)
          `).run(id, adminUser, JSON.stringify({
            invoice_no: sale.invoice_no,
            old_cashier: oldName,
            new_cashier_id: userObj.id,
            new_cashier_name: userObj.name,
            reason
          }));

          db.exec('COMMIT');
          return send(res, 200, { ok: true, id, cashier_name: userObj.name });
        } catch (e) {
          db.exec('ROLLBACK');
          return send(res, 409, { error: e.message || 'Koreksi kasir gagal.' });
        }
      }

      // ==================== DAILY RECONCILIATION ====================
      if (req.method === 'GET' && url.pathname === '/api/reconciliation') {
        const dateParam = url.searchParams.get('date') || '';
        // If not provided, calculate today in WIB (UTC+7)
        const targetDate = dateParam || db.prepare("SELECT date('now', '+7 hours') d").get().d;
        const cashierFilter = req.authUser.role === 'kasir' ? String(req.authUser.id) : (url.searchParams.get('cashier_id') || '');

        // Summary of completed sales
        const salesStats = db.prepare(`
          SELECT
            COUNT(*) total_transactions,
            COALESCE(SUM(total), 0) total_sales,
            COALESCE(SUM(CASE WHEN payment_status='LUNAS' THEN total ELSE 0 END), 0) total_confirmed_payments,
            COALESCE(SUM(CASE WHEN payment_status='MENUNGGU_PEMBAYARAN' THEN total ELSE 0 END), 0) total_pending_payments
          FROM sales
          WHERE date(sold_at, '+7 hours') = ?
            AND transaction_status = 'COMPLETED'
            AND (?='' OR cashier_id = ?)
        `).get(targetDate, cashierFilter, cashierFilter);

        // Cancelled / Returns
        const cancelStats = db.prepare(`
          SELECT
            COUNT(*) cancel_count,
            COALESCE(SUM(total), 0) cancel_total
          FROM sales
          WHERE date(sold_at, '+7 hours') = ?
            AND transaction_status = 'CANCELLED'
            AND (?='' OR cashier_id = ?)
        `).get(targetDate, cashierFilter, cashierFilter);

        // Breakdown by 4 payment methods (only LUNAS & COMPLETED)
        const methodRows = db.prepare(`
          SELECT
            payment_method,
            COUNT(*) count,
            COALESCE(SUM(total), 0) total
          FROM sales
          WHERE date(sold_at, '+7 hours') = ?
            AND transaction_status = 'COMPLETED'
            AND payment_status = 'LUNAS'
            AND (?='' OR cashier_id = ?)
          GROUP BY payment_method
        `).all(targetDate, cashierFilter, cashierFilter);

        const methodMap = {};
        for (const m of VALID_PAYMENT_METHODS) {
          methodMap[m] = { count: 0, total: 0 };
        }
        for (const r of methodRows) {
          if (methodMap[r.payment_method]) {
            methodMap[r.payment_method] = { count: r.count, total: r.total };
          } else {
            // Map legacy
            if (r.payment_method.includes('Debit')) methodMap['Kartu Debit BCA (EDC)'].total += r.total;
            else if (r.payment_method.includes('Kredit')) methodMap['Kartu Kredit BCA (EDC)'].total += r.total;
            else if (r.payment_method === 'QRIS') methodMap['QRIS'].total += r.total;
            else methodMap['Tunai'].total += r.total;
          }
        }

        // Latest cashier closing for this date
        const closing = db.prepare(`
          SELECT * FROM cashier_closings
          WHERE closing_date = ?
            AND (?='' OR cashier_id = ?)
          ORDER BY id DESC LIMIT 1
        `).get(targetDate, cashierFilter, cashierFilter);

        const status = closing ? closing.status : 'BELUM_DIREKONSILIASI';

        return send(res, 200, {
          operational_date: targetDate,
          total_transactions: salesStats.total_transactions,
          total_sales: salesStats.total_sales,
          total_confirmed_payments: salesStats.total_confirmed_payments,
          total_pending_payments: salesStats.total_pending_payments,
          total_cancelled_count: cancelStats.cancel_count,
          total_cancelled_amount: cancelStats.cancel_total,
          methods: [
            { method: 'Tunai', count: methodMap['Tunai'].count, total: methodMap['Tunai'].total },
            { method: 'QRIS', count: methodMap['QRIS'].count, total: methodMap['QRIS'].total },
            { method: 'Kartu Debit BCA (EDC)', count: methodMap['Kartu Debit BCA (EDC)'].count, total: methodMap['Kartu Debit BCA (EDC)'].total },
            { method: 'Kartu Kredit BCA (EDC)', count: methodMap['Kartu Kredit BCA (EDC)'].count, total: methodMap['Kartu Kredit BCA (EDC)'].total }
          ],
          closing,
          status
        });
      }

      // ==================== SUBMIT CASHIER CLOSING ====================
      if (req.method === 'POST' && url.pathname === '/api/reconciliation/close') {
        const d = await readBody(req);
        const closingDate = String(d.closing_date || '').trim();
        const dateObject = new Date(closingDate + 'T00:00:00Z');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(closingDate) || !Number.isFinite(dateObject.getTime()) || dateObject.toISOString().slice(0, 10) !== closingDate) {
          return send(res, 400, { error: 'Tanggal operasional penutupan tidak valid.' });
        }

        const cashierId = req.authUser.role === 'kasir' ? req.authUser.id : Number(d.cashier_id || 0);
        const cashier = db.prepare("SELECT name FROM users WHERE id=? AND active=1 AND role IN ('admin','kasir')").get(cashierId);
        if (!cashier) return send(res, 400, { error: 'Pilih Admin atau salah satu kasir yang aktif.' });
        const cashierName = cashier.name;
        const openingCash = Number(d.opening_cash ?? 0);
        const actualCash = Number(d.actual_cash ?? 0);
        const actualQris = Number(d.actual_qris ?? 0);
        const actualDebit = Number(d.actual_debit_bca ?? 0);
        const actualCredit = Number(d.actual_credit_bca ?? 0);
        if (![openingCash, actualCash, actualQris, actualDebit, actualCredit].every(value => Number.isSafeInteger(value) && value >= 0)) {
          return send(res, 400, { error: 'Nominal penutupan harus berupa Rupiah bulat nol atau lebih.' });
        }
        const notes = String(d.notes || '').trim();
        const reconciledBy = req.authUser.name;

        db.exec('BEGIN IMMEDIATE');
        try {
          const existingClosing = db.prepare('SELECT id FROM cashier_closings WHERE closing_date=? AND cashier_id=?').get(closingDate, cashierId);
          if (existingClosing) {
            db.exec('ROLLBACK');
            return send(res, 409, { error: 'Penutupan kasir untuk tanggal ini sudah tersimpan.' });
          }

          // Recalculate paid system totals on the server while holding the write lock.
          const methodRows = db.prepare(`
            SELECT payment_method,COALESCE(SUM(total),0) total FROM sales
            WHERE date(sold_at,'+7 hours')=? AND transaction_status='COMPLETED'
              AND payment_status='LUNAS' AND cashier_id=? GROUP BY payment_method
          `).all(closingDate, cashierId);
          let systemCash = 0, systemQris = 0, systemDebit = 0, systemCredit = 0;
          for (const row of methodRows) {
            if (row.payment_method === 'QRIS') systemQris += row.total;
            else if (row.payment_method.includes('Debit')) systemDebit += row.total;
            else if (row.payment_method.includes('Kredit')) systemCredit += row.total;
            else systemCash += row.total;
          }
          const diffCash = actualCash - systemCash;
          const diffQris = actualQris - systemQris;
          const diffDebit = actualDebit - systemDebit;
          const diffCredit = actualCredit - systemCredit;
          const totalSystem = systemCash + systemQris + systemDebit + systemCredit;
          const totalActual = actualCash + actualQris + actualDebit + actualCredit;
          const totalDiff = totalActual - totalSystem;
          if (![systemCash, systemQris, systemDebit, systemCredit, totalSystem, totalActual, totalDiff].every(Number.isSafeInteger)) {
            throw new Error('Total penutupan melebihi batas Rupiah integer yang didukung.');
          }
          if (totalDiff !== 0 && !notes) {
            db.exec('ROLLBACK');
            return send(res, 400, { error: 'Terdapat selisih rekonsiliasi. Catatan penjelasan selisih wajib diisi.' });
          }
          const status = totalDiff === 0 ? 'SELESAI' : 'SELESAI_DENGAN_SELISIH';

          const insertClosing = db.prepare(`
            INSERT INTO cashier_closings (
              closing_date, cashier_id, cashier_name, opening_cash,
              system_cash, actual_cash, diff_cash,
              system_qris, actual_qris, diff_qris,
              system_debit_bca, actual_debit_bca, diff_debit_bca,
              system_credit_bca, actual_credit_bca, diff_credit_bca,
              total_system, total_actual, total_diff,
              status, notes, reconciled_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          const resClose = insertClosing.run(
            closingDate, cashierId, cashierName, openingCash,
            systemCash, actualCash, diffCash,
            systemQris, actualQris, diffQris,
            systemDebit, actualDebit, diffDebit,
            systemCredit, actualCredit, diffCredit,
            totalSystem, totalActual, totalDiff,
            status, notes, reconciledBy
          );
          const closingId = Number(resClose.lastInsertRowid);

          db.prepare(`
            INSERT INTO audit_logs (action, entity, entity_id, user_name, details)
            VALUES ('CASHIER_CLOSING', 'cashier_closing', ?, ?, ?)
          `).run(closingId, reconciledBy, JSON.stringify({
            closing_date: closingDate,
            cashier_name: cashierName,
            total_system: totalSystem,
            total_actual: totalActual,
            total_diff: totalDiff,
            status
          }));

          db.exec('COMMIT');
          return send(res, 201, { id: closingId, status, total_diff: totalDiff });
        } catch (e) {
          db.exec('ROLLBACK');
          return send(res, 409, { error: e.message || 'Penutupan kasir gagal disimpan.' });
        }
      }

      // ==================== LIST CLOSINGS ====================
      if (req.method === 'GET' && url.pathname === '/api/reconciliation/closings') {
        const rows = req.authUser.role === 'kasir'
          ? db.prepare(`SELECT * FROM cashier_closings WHERE cashier_id=? ORDER BY closing_date DESC, id DESC LIMIT 100`).all(req.authUser.id)
          : db.prepare(`SELECT * FROM cashier_closings ORDER BY closing_date DESC, id DESC LIMIT 100`).all();
        return send(res, 200, rows);
      }

      // ==================== RECONCILIATION EXPORT ====================
      if (req.method === 'GET' && url.pathname === '/api/reconciliation/export') {
        const rows = req.authUser.role === 'kasir'
          ? db.prepare(`SELECT * FROM cashier_closings WHERE cashier_id=? ORDER BY closing_date DESC, id DESC`).all(req.authUser.id)
          : db.prepare(`SELECT * FROM cashier_closings ORDER BY closing_date DESC, id DESC`).all();
        const csv = toCsv(rows, [
          { title: 'Tanggal', val: r => r.closing_date },
          { title: 'Nama Kasir', val: r => r.cashier_name },
          { title: 'Saldo Awal Kas', val: r => r.opening_cash },
          { title: 'Tunai Sistem (Rp)', val: r => r.system_cash },
          { title: 'Tunai Aktual (Rp)', val: r => r.actual_cash },
          { title: 'Selisih Tunai', val: r => r.diff_cash },
          { title: 'QRIS Sistem (Rp)', val: r => r.system_qris },
          { title: 'QRIS Aktual (Rp)', val: r => r.actual_qris },
          { title: 'Selisih QRIS', val: r => r.diff_qris },
          { title: 'Debit BCA Sistem (Rp)', val: r => r.system_debit_bca },
          { title: 'Debit BCA Aktual (Rp)', val: r => r.actual_debit_bca },
          { title: 'Selisih Debit BCA', val: r => r.diff_debit_bca },
          { title: 'Kredit BCA Sistem (Rp)', val: r => r.system_credit_bca },
          { title: 'Kredit BCA Aktual (Rp)', val: r => r.actual_credit_bca },
          { title: 'Selisih Kredit BCA', val: r => r.diff_credit_bca },
          { title: 'Total Sistem (Rp)', val: r => r.total_system },
          { title: 'Total Aktual (Rp)', val: r => r.total_actual },
          { title: 'Total Selisih (Rp)', val: r => r.total_diff },
          { title: 'Status', val: r => r.status },
          { title: 'Catatan Selisih', val: r => r.notes },
          { title: 'Direkonsiliasi Oleh', val: r => r.reconciled_by },
          { title: 'Waktu Input', val: r => r.created_at }
        ]);
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="rekonsiliasi-penutupan-kasir.csv"'
        });
        return res.end(csv);
      }

      // ==================== PRODUCTS APIS ====================
      if (req.method === 'GET' && url.pathname === '/api/products/export') {
        const rows = listProducts(url.searchParams.get('q') || '');
        const csv = toCsv(rows, [
          { title: 'SKU', val: r => r.sku },
          { title: 'Barcode', val: r => r.barcode || '' },
          { title: 'Nama Produk', val: r => r.name },
          { title: 'Panjang', val: r => r.panjang || '' },
          { title: 'Kategori', val: r => r.category || '' },
          { title: 'Satuan', val: r => r.unit || 'pcs' },
          { title: 'Stok Operasional', val: r => r.stock },
          { title: 'Stok Minimum', val: r => r.min_stock },
          { title: 'Harga Referensi (Rp)', val: r => r.reference_price },
          { title: 'Harga Jual (Rp)', val: r => r.sale_price },
          { title: 'Lokasi Rak', val: r => r.location || '' },
          { title: 'Lokasi Stok', val: r => r.stock_location || '' },
          { title: 'QTY Sumber Excel', val: r => r.source_qty ?? '' },
          { title: 'Harga Sumber Excel', val: r => r.source_unit_price ?? '' },
          { title: 'Status Verifikasi', val: r => r.stock_verification_status }
        ]);
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="katalog-produk-howell.csv"'
        });
        return res.end(csv);
      }

      if (req.method === 'GET' && url.pathname === '/api/products/generate-ean') {
        let code = '';
        for (let i = 0; i < 100; i++) {
          code = generateEAN13();
          if (!db.prepare('SELECT 1 FROM products WHERE barcode=?').get(code)) break;
        }
        return send(res, 200, { barcode: code });
      }

      const prodDetailMatch = url.pathname.match(/^\/api\/products\/(\d+)$/);
      if (req.method === 'GET' && prodDetailMatch) {
        const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(Number(prodDetailMatch[1]));
        if (!p) return send(res, 404, { error: 'Produk tidak ditemukan.' });
        return send(res, 200, p);
      }

      if ((req.method === 'PUT' || req.method === 'POST') && prodDetailMatch && !url.pathname.endsWith('/verify')) {
        if (!requireAdmin(req, res, 'Perubahan produk dan harga hanya dapat dilakukan administrator.')) return;
        const id = Number(prodDetailMatch[1]);
        const p = await readBody(req);
        const barcode = String(p.barcode || '').trim() || null;
        if (barcode && !validEAN(barcode)) return send(res, 400, { error: 'Barcode harus berupa EAN-13 dengan check digit yang valid.' });
        const existing = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(id);
        if (!existing) return send(res, 404, { error: 'Produk tidak ditemukan.' });

        const name = String(p.name || existing.name).trim();
        if (!name) return send(res, 400, { error: 'Nama produk tidak boleh kosong.' });
        const category = p.category !== undefined ? String(p.category).trim() : existing.category;
        const unit = p.unit !== undefined ? String(p.unit).trim() : existing.unit;
        const panjang = p.panjang !== undefined ? String(p.panjang).trim() : existing.panjang;
        const refPrice = p.reference_price !== undefined ? Number(p.reference_price) : existing.reference_price;
        const salePrice = p.sale_price !== undefined ? Number(p.sale_price) : existing.sale_price;
        const minStock = p.min_stock !== undefined ? Number(p.min_stock) : existing.min_stock;
        const location = p.location !== undefined ? String(p.location).trim() : existing.location;
        const stockLocation = p.stock_location !== undefined ? String(p.stock_location).trim() : existing.stock_location;

        if (!Number.isSafeInteger(refPrice) || refPrice < 0 || !Number.isSafeInteger(salePrice) || salePrice < 0 || !Number.isSafeInteger(minStock) || minStock < 0) {
          return send(res, 400, { error: 'Harga dan stok minimum harus bilangan bulat ≥ 0.' });
        }

        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare(`UPDATE products SET name=?,category=?,unit=?,barcode=?,panjang=?,reference_price=?,sale_price=?,min_stock=?,location=?,stock_location=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
            .run(name, category, unit, barcode, panjang, refPrice, salePrice, minStock, location, stockLocation, id);
          db.prepare("INSERT INTO audit_logs(action,entity,entity_id,user_name,details) VALUES('UPDATE_PRODUCT','product',?,?,?)")
            .run(id, req.authUser.name, JSON.stringify({ name, barcode, panjang, salePrice, refPrice }));
          db.exec('COMMIT');
          return send(res, 200, { ok: true, id });
        } catch (e) {
          db.exec('ROLLBACK');
          if (String(e.message).includes('UNIQUE')) return send(res, 409, { error: 'Barcode sudah digunakan oleh produk lain.' });
          throw e;
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/products') {
        return send(res, 200, listProducts(url.searchParams.get('q') || ''));
      }

      if (req.method === 'POST' && url.pathname === '/api/products') {
        if (!requireAdmin(req, res, 'Penambahan produk dan stok awal hanya dapat dilakukan administrator.')) return;
        const p = await readBody(req), barcode = String(p.barcode || '').trim() || null;
        if (!p.sku?.trim() || !p.name?.trim()) return send(res, 400, { error: 'SKU dan nama produk wajib diisi.' });
        if (barcode && !validEAN(barcode)) return send(res, 400, { error: 'Barcode harus berupa EAN-13 dengan check digit yang valid.' });
        const qty = Number(p.stock || 0);
        if (!Number.isSafeInteger(qty) || qty < 0) return send(res, 400, { error: 'Stok harus berupa bilangan bulat aman nol atau lebih.' });
        const rp = Number(p.reference_price || 0), sp = Number(p.sale_price || 0);
        if (!Number.isSafeInteger(rp) || rp < 0 || !Number.isSafeInteger(sp) || sp < 0) return send(res, 400, { error: 'Harga harus berupa Rupiah bulat nol atau lebih.' });
        const minStock = Number(p.min_stock || 0);
        if (!Number.isSafeInteger(minStock) || minStock < 0) return send(res, 400, { error: 'Stok minimum harus berupa bilangan bulat aman nol atau lebih.' });

        db.exec('BEGIN IMMEDIATE');
        try {
          const result = db.prepare(`INSERT INTO products(sku,barcode,name,category,unit,panjang,reference_price,sale_price,stock,min_stock,location,stock_location) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(p.sku.trim(), barcode, p.name.trim(), p.category || '', p.unit || 'pcs', p.panjang || '', rp, sp, qty, minStock, p.location || '', p.stock_location || 'Gudang utama');
          if (qty) {
            db.prepare("INSERT INTO inventory_movements(product_id,kind,quantity,balance_after,reference,note,location,user_name) VALUES(?,'opening',?,?,'SALDO-AWAL','Saldo awal dari pembuatan produk',?,?)")
              .run(result.lastInsertRowid, qty, qty, p.stock_location || 'Gudang utama', req.authUser.name);
          }
          db.exec('COMMIT');
          return send(res, 201, { id: Number(result.lastInsertRowid) });
        } catch (e) {
          db.exec('ROLLBACK');
          if (String(e.message).includes('UNIQUE')) return send(res, 409, { error: 'SKU atau barcode sudah digunakan.' });
          throw e;
        }
      }

      const productDeleteMatch = url.pathname.match(/^\/api\/products\/(\d+)$/);
      if (req.method === 'DELETE' && productDeleteMatch) {
        if (!requireAdmin(req, res, 'Pengarsipan produk hanya dapat dilakukan administrator.')) return;
        const id = Number(productDeleteMatch[1]);
        const used = db.prepare('SELECT 1 FROM inventory_movements WHERE product_id=? LIMIT 1').get(id);
        if (used) db.prepare('UPDATE products SET active=0 WHERE id=?').run(id);
        else db.prepare('DELETE FROM products WHERE id=?').run(id);
        return send(res, 200, { ok: true });
      }

      // ==================== DASHBOARD API ====================
      if (req.method === 'GET' && url.pathname === '/api/dashboard') {
        const totals = db.prepare(`SELECT COUNT(*) products,COALESCE(SUM(stock),0) units,COALESCE(SUM(CASE WHEN stock<=min_stock THEN 1 ELSE 0 END),0) low_stock,COALESCE(SUM(CASE WHEN stock_verification_status IN ('NEEDS_VERIFICATION','MANUAL_REVIEW') THEN 1 ELSE 0 END),0) verification_count FROM products WHERE active=1`).get();
        const movements = db.prepare('SELECT m.*,p.sku,p.name,p.unit FROM inventory_movements m JOIN products p ON p.id=m.product_id ORDER BY m.created_at DESC,m.id DESC LIMIT 8').all();
        const imp = importSummary();
        const pending = imp.batch?.status === 'PREVIEW_PENDING';
        const source = imp.summary;

        // Today's completed sales
        const todaySales = db.prepare(`
          SELECT COUNT(*) count, COALESCE(SUM(total), 0) total
          FROM sales
          WHERE date(sold_at, '+7 hours') = date('now', '+7 hours')
            AND transaction_status = 'COMPLETED'
        `).get();

        return send(res, 200, {
          ...totals,
          today_sales_count: todaySales.count,
          today_sales_total: todaySales.total,
          source_flagged_count: pending ? (source?.needs_verification_count || 0) : totals.verification_count,
          source_import_count: pending ? (source?.sku_count || 0) : 0,
          source_total_qty: pending ? (source?.total_source_qty || 0) : 0,
          movements,
          lowProducts: db.prepare('SELECT sku,name,stock,min_stock,unit,source_qty,source_qty_font_color,stock_verification_status,stock_location FROM products WHERE active=1 AND stock<=min_stock ORDER BY stock LIMIT 6').all()
        });
      }

      // ==================== MOVEMENTS API ====================
      if (req.method === 'GET' && url.pathname === '/api/movements') {
        return send(res, 200, db.prepare('SELECT m.*,p.sku,p.name,p.unit FROM inventory_movements m JOIN products p ON p.id=m.product_id ORDER BY m.created_at DESC,m.id DESC LIMIT 200').all());
      }

      if (req.method === 'POST' && url.pathname === '/api/movements') {
        if (!requireAdmin(req, res, 'Pergerakan stok manual hanya dapat dicatat administrator.')) return;
        const m = await readBody(req), qty = Number(m.quantity), kind = m.kind;
        if (!Number.isSafeInteger(m.product_id) || !Number.isSafeInteger(qty) || qty <= 0 || !['in', 'out', 'adjustment'].includes(kind)) {
          return send(res, 400, { error: 'Produk, jenis, dan jumlah pergerakan wajib valid.' });
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(m.product_id);
          if (!p) { db.exec('ROLLBACK'); return send(res, 404, { error: 'Produk tidak ditemukan.' }); }
          const balance = kind === 'in' ? p.stock + qty : p.stock - qty;
          if (!Number.isSafeInteger(balance)) { db.exec('ROLLBACK'); return send(res, 400, { error: 'Jumlah pergerakan melebihi batas stok integer yang didukung.' }); }
          if (balance < 0) { db.exec('ROLLBACK'); return send(res, 409, { error: `Stok tidak mencukupi. Stok saat ini ${p.stock} ${p.unit}.` }); }
          db.prepare('UPDATE products SET stock=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(balance, p.id);
          db.prepare('INSERT INTO inventory_movements(product_id,kind,quantity,balance_after,reference,note,location,user_name) VALUES(?,?,?,?,?,?,?,?)').run(p.id, kind, qty, balance, (m.reference || '').trim() || 'STK-' + Date.now(), m.note || '', p.stock_location, req.authUser.name);
          db.exec('COMMIT');
          return send(res, 201, { balance });
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      }

      // ==================== IMPORT APIS ====================
      if (req.method === 'GET' && url.pathname === '/api/import/summary') return send(res, 200, importSummary());
      if (req.method === 'GET' && url.pathname === '/api/import/items') {
        const b = latestBatch();
        if (!b) return send(res, 200, []);
        const status = url.searchParams.get('status') || '';
        return send(res, 200, db.prepare(`SELECT * FROM import_items WHERE batch_id=? AND (?='' OR source_status=? OR import_result=?) ORDER BY source_row`).all(b.id, status, status, status));
      }

      if (req.method === 'POST' && url.pathname === '/api/import/commit') {
        if (!requireAdmin(req, res, 'Penerapan impor Excel hanya dapat dilakukan administrator.')) return;
        const data = await readBody(req), b = latestBatch();
        if (!b || b.status !== 'PREVIEW_PENDING') return send(res, 409, { error: 'Tidak ada pratinjau impor yang menunggu konfirmasi.' });
        if (!['opening', 'exhibition', 'catalog_only'].includes(data.mode)) return send(res, 400, { error: 'Pilih mode impor terlebih dahulu.' });
        const destination = String(data.destination || '').trim();
        if (data.mode !== 'catalog_only' && !destination) return send(res, 400, { error: 'Isi lokasi tujuan untuk stok saldo awal atau stok pameran.' });
        if (data.duplicate_policy !== 'skip') return send(res, 400, { error: 'Pilih kebijakan lewati SKU duplikat.' });

        const items = db.prepare('SELECT * FROM import_items WHERE batch_id=? ORDER BY source_row').all(b.id);
        let imported = 0, skipped = 0, qtyApplied = 0;
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const item of items) {
            if (db.prepare('SELECT 1 FROM products WHERE sku=? AND active=1').get(item.sku)) {
              db.prepare("UPDATE import_items SET import_result='DUPLICATE_SKIPPED' WHERE id=?").run(item.id);
              skipped++;
              continue;
            }
            const quantity = data.mode === 'catalog_only' ? 0 : item.source_qty;
            const stockLocation = data.mode === 'catalog_only' ? '' : destination;
            const insert = db.prepare(`
              INSERT INTO products(sku,barcode,name,category,unit,panjang,reference_price,sale_price,stock,min_stock,location,stock_location,source_qty,source_unit_price,source_total,source_discount_value,source_qty_font_color,source_qty_font_color_type,stock_verification_status,source_file,source_sheet,source_row,source_unit_price_formula,source_total_formula,source_discount_formula,source_import_id)
              VALUES(?,NULL,?,'Pameran','pcs','',?,?,?,0,'',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            `).run(item.sku, item.name, Number(item.source_unit_price || 0), 0, quantity, stockLocation, item.source_qty, item.source_unit_price, item.source_total, item.source_discount_value, item.source_qty_font_color, item.source_qty_font_color_type, item.source_status, b.source_file, item.source_sheet, item.source_row, item.unit_price_formula, item.total_formula, item.discount_formula, b.id);
            const productId = Number(insert.lastInsertRowid);
            if (quantity > 0) {
              const kind = data.mode === 'opening' ? 'opening' : 'in';
              db.prepare('INSERT INTO inventory_movements(product_id,kind,quantity,balance_after,reference,note,location,user_name) VALUES(?,?,?,?,?,?,?,?)')
                .run(productId, kind, quantity, quantity, `IMP-${b.id}-${item.source_row}`, data.mode === 'opening' ? 'Saldo awal dari file pameran' : 'Alokasi stok ke lokasi pameran', destination, req.authUser.name);
              qtyApplied += quantity;
            }
            db.prepare("UPDATE import_items SET import_result='IMPORTED' WHERE id=?").run(item.id);
            imported++;
          }
          db.prepare("UPDATE import_batches SET status='COMMITTED',import_mode=?,destination=?,committed_at=CURRENT_TIMESTAMP WHERE id=?").run(data.mode, destination, b.id);
          db.prepare("INSERT INTO audit_logs(action,entity,entity_id,user_name,details) VALUES('IMPORT_PRODUCTS','import_batch',?,?,?)").run(b.id, req.authUser.name, JSON.stringify({ mode: data.mode, destination, imported, skipped, qtyApplied }));
          db.exec('COMMIT');
          return send(res, 200, { imported, skipped, qtyApplied, mode: data.mode, destination });
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      }

      // ==================== VERIFICATION APIS ====================
      if (req.method === 'GET' && url.pathname === '/api/verification') {
        return send(res, 200, db.prepare(`SELECT * FROM products WHERE active=1 AND stock_verification_status IN ('NEEDS_VERIFICATION','MANUAL_REVIEW') ORDER BY CASE stock_verification_status WHEN 'MANUAL_REVIEW' THEN 0 ELSE 1 END,sku`).all());
      }

      const verifyMatch = url.pathname.match(/^\/api\/products\/(\d+)\/verify$/);
      if (req.method === 'POST' && verifyMatch) {
        if (!requireAdmin(req, res, 'Verifikasi dan penyesuaian stok hanya dapat dilakukan administrator.')) return;
        const data = await readBody(req), id = Number(verifyMatch[1]), actual = Number(data.actual_stock), user = req.authUser.name, reason = String(data.reason || '').trim();
        if (!Number.isInteger(actual) || actual < 0 || !reason) return send(res, 400, { error: 'Jumlah hasil pemeriksaan harus bilangan bulat ≥ 0 dan alasan wajib diisi.' });
        db.exec('BEGIN IMMEDIATE');
        try {
          const p = db.prepare("SELECT * FROM products WHERE id=? AND active=1 AND stock_verification_status IN ('NEEDS_VERIFICATION','MANUAL_REVIEW')").get(id);
          if (!p) { db.exec('ROLLBACK'); return send(res, 409, { error: 'Produk tidak ditemukan atau sudah diverifikasi.' }); }
          const diff = actual - p.stock;
          db.prepare("UPDATE products SET stock=?,stock_verification_status='VERIFIED',stock_verification_note=?,stock_verified_at=CURRENT_TIMESTAMP,stock_verified_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(actual, reason, user, id);
          db.prepare('INSERT INTO verification_history(product_id,source_qty,previous_stock,verified_stock,difference,user_name,reason) VALUES(?,?,?,?,?,?,?)').run(id, p.source_qty ?? p.stock, p.stock, actual, diff, user, reason);
          db.prepare("INSERT INTO audit_logs(action,entity,entity_id,user_name,details) VALUES('VERIFY_STOCK','product',?,?,?)").run(id, user, JSON.stringify({ source_qty: p.source_qty, previous_stock: p.stock, verified_stock: actual, difference: diff, reason }));
          if (diff !== 0) db.prepare("INSERT INTO inventory_movements(product_id,kind,quantity,balance_after,reference,note,location,user_name) VALUES(?,'adjustment',?,?,?,?,?,?)").run(id, Math.abs(diff), actual, `VER-${id}-${Date.now()}`, `Hasil verifikasi fisik (${diff > 0 ? '+' : ''}${diff}). ${reason}`, p.stock_location, user);
          db.exec('COMMIT');
          return send(res, 200, { id, previous_stock: p.stock, source_qty: p.source_qty, verified_stock: actual, difference: diff, status: 'VERIFIED' });
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      }

      return send(res, 404, { error: 'Endpoint tidak ditemukan.' });
    }

    // Static Files Handler
    if (url.pathname.startsWith('/data/')) {
      if (!authenticatedUser(req)) return send(res, 401, { error: 'Silakan masuk untuk melanjutkan.' });
      if (url.pathname !== '/data/current-exhibition-source.json') return send(res, 404, 'Not found', 'text/plain');
      const sourcePath = path.join(dataDir, 'current-exhibition-source.json');
      if (!fs.existsSync(sourcePath)) return send(res, 404, 'Data sumber tidak tersedia.', 'text/plain; charset=utf-8');
      return send(res, 200, fs.readFileSync(sourcePath), 'application/json; charset=utf-8');
    }
    if (/\.(?:db|db-wal|db-shm|pem|key|env)$/i.test(url.pathname) || /^\/(?:work|scripts|\.git)(?:\/|$)/i.test(url.pathname)) {
      return send(res, 404, 'Not found', 'text/plain');
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const full = path.resolve(root, file);
    if (!full.startsWith(root + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
    const ext = path.extname(full);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml'
    };
    if (!fs.existsSync(full)) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, fs.readFileSync(full), types[ext] || 'application/octet-stream');
  } catch (e) {
    console.error('Server Error:', e);
    return send(res, 500, { error: 'Terjadi kesalahan pada server.' });
  }
});

process.on('uncaughtException', err => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));

const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => console.log(`Howell StockFlow berjalan di http://${host}:${port}`));

