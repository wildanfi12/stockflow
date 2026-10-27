const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const root = __dirname;
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'howell-stockflow.db'));
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
db.exec(`PRAGMA journal_mode=WAL;`);
const existingProducts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='products'").get();
if (!existingProducts) db.exec(productSql.replace('products_new', 'products'));
else {
  const cols = db.prepare('PRAGMA table_info(products)').all();
  if (cols.some(c => c.name === 'barcode' && c.notnull === 1)) {
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
    try {
      db.exec(productSql);
      db.exec(`INSERT INTO products_new(id,sku,barcode,name,category,unit,reference_price,sale_price,stock,min_stock,location,active,created_at,updated_at)
        SELECT id,sku,NULLIF(barcode,''),name,category,unit,reference_price,sale_price,stock,min_stock,location,active,created_at,updated_at FROM products;`);
      db.exec('DROP TABLE products; ALTER TABLE products_new RENAME TO products; COMMIT; PRAGMA foreign_keys=ON;');
    } catch (e) { db.exec('ROLLBACK; PRAGMA foreign_keys=ON;'); throw e; }
  }
  const names = new Set(db.prepare('PRAGMA table_info(products)').all().map(c=>c.name));
  const add = {panjang:'TEXT',stock_location:"TEXT NOT NULL DEFAULT 'Gudang utama'",source_qty:'INTEGER',source_unit_price:'INTEGER',source_total:'INTEGER',source_discount_value:'INTEGER',source_qty_font_color:'TEXT',source_qty_font_color_type:'TEXT',stock_verification_status:"TEXT NOT NULL DEFAULT 'NOT_FLAGGED'",stock_verification_note:"TEXT NOT NULL DEFAULT ''",stock_verified_at:'TEXT',stock_verified_by:'TEXT',source_file:'TEXT',source_sheet:'TEXT',source_row:'INTEGER',source_unit_price_formula:'TEXT',source_total_formula:'TEXT',source_discount_formula:'TEXT',source_import_id:'INTEGER'};
  for (const [name,type] of Object.entries(add)) if(!names.has(name)) db.exec(`ALTER TABLE products ADD COLUMN ${name} ${type}`);
}
db.exec(`PRAGMA foreign_keys=ON;
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
CREATE TABLE IF NOT EXISTS sales (
 id INTEGER PRIMARY KEY, invoice_no TEXT NOT NULL UNIQUE, sold_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 customer_name TEXT NOT NULL DEFAULT 'Pelanggan', payment_method TEXT NOT NULL DEFAULT 'Tunai',
 subtotal INTEGER NOT NULL CHECK(subtotal>=0), discount INTEGER NOT NULL DEFAULT 0 CHECK(discount>=0), total INTEGER NOT NULL CHECK(total>=0),
 user_name TEXT NOT NULL DEFAULT 'Admin Howell', location TEXT NOT NULL DEFAULT 'Pameran');
CREATE TABLE IF NOT EXISTS sale_items (
 id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id), product_id INTEGER NOT NULL REFERENCES products(id),
 sku TEXT NOT NULL, name TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>0), unit_price INTEGER NOT NULL CHECK(unit_price>=0),
 line_total INTEGER NOT NULL CHECK(line_total>=0), balance_after INTEGER NOT NULL CHECK(balance_after>=0));
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_verification ON products(stock_verification_status,active);
CREATE INDEX IF NOT EXISTS idx_movements_product_date ON inventory_movements(product_id, created_at);
CREATE INDEX IF NOT EXISTS idx_import_items_status ON import_items(batch_id,source_status);`);
for (const c of db.prepare('PRAGMA table_info(inventory_movements)').all().map(c=>c.name)) {}
const movementCols=new Set(db.prepare('PRAGMA table_info(inventory_movements)').all().map(c=>c.name));
if(!movementCols.has('location')) db.exec("ALTER TABLE inventory_movements ADD COLUMN location TEXT NOT NULL DEFAULT ''");
if(!movementCols.has('user_name')) db.exec("ALTER TABLE inventory_movements ADD COLUMN user_name TEXT NOT NULL DEFAULT 'Admin Howell'");

const seedPath=path.join(dataDir,'import-source.json');
if(fs.existsSync(seedPath)) {
  const source=JSON.parse(fs.readFileSync(seedPath,'utf8'));
  let batch=db.prepare('SELECT id FROM import_batches WHERE source_hash=?').get(source.source_sha256);
  if(!batch) {
    const result=db.prepare('INSERT INTO import_batches(source_file,source_hash,source_summary_json) VALUES(?,?,?)').run(source.source_file,source.source_sha256,JSON.stringify({summary:source.summary,worksheets:source.worksheets,manual_review:source.manual_review}));
    const batchId=Number(result.lastInsertRowid);
    const insert=db.prepare(`INSERT INTO import_items(batch_id,source_sheet,source_row,sku,name,source_qty,source_qty_font_color,source_qty_font_color_type,source_status,source_unit_price,source_total,source_discount_value,unit_price_formula,total_formula,discount_formula,barcode) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.exec('BEGIN IMMEDIATE');
    try {
      for(const p of source.products) insert.run(batchId,p.source_sheet,p.source_row,p.sku,p.name,p.source_qty,p.source_qty_font_color_rgb|| (p.source_qty_font_color_indexed!=null?'INDEXED:'+p.source_qty_font_color_indexed:p.source_qty_font_color_theme!=null?'THEME:'+p.source_qty_font_color_theme:null),p.source_qty_font_color_type,p.source_status,p.source_unit_price,p.source_total,p.source_discount_value,p.unit_price_formula,p.total_formula,p.discount_formula,null);
      db.exec('COMMIT');
    } catch(e){db.exec('ROLLBACK');throw e;}
  }
}

const send = (res,status,body,type='application/json; charset=utf-8') => { res.writeHead(status,{'Content-Type':type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}); res.end(type.startsWith('application/json')?JSON.stringify(body):body); };
const readBody = req => new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c;if(s.length>2_000_000)reject(new Error('Permintaan terlalu besar.'))});req.on('end',()=>{try{resolve(JSON.parse(s||'{}'))}catch{reject(new Error('Isi permintaan tidak valid.'))}});req.on('error',reject)});
const validEAN = code => /^\d{13}$/.test(code) && [...code.slice(0,12)].reduce((sum,n,i)=>sum+Number(n)*(i%2?3:1),0)%10===(10-Number(code[12]))%10;
function generateEAN13() {
  const base = '200' + String(Math.floor(100_000_000 + Math.random() * 900_000_000));
  const sum = [...base].reduce((acc, d, i) => acc + Number(d) * (i % 2 ? 3 : 1), 0);
  const check = (10 - (sum % 10)) % 10;
  return base + check;
}
function toCsv(rows, columns) {
  const header = columns.map(c => `"${String(c.title).replace(/"/g, '""')}"`).join(',');
  const lines = rows.map(r => columns.map(c => {
    let v = c.val(r);
    if (v === null || v === undefined) v = '';
    return `"${String(v).replace(/"/g, '""')}"`;
  }).join(','));
  return '\uFEFF' + [header, ...lines].join('\r\n');
}
const listProducts = (q='') => db.prepare(`SELECT * FROM products WHERE active=1 AND (?='' OR sku LIKE ? OR barcode LIKE ? OR name LIKE ? OR category LIKE ?) ORDER BY updated_at DESC`).all(q,`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`);
const latestBatch = () => db.prepare('SELECT * FROM import_batches ORDER BY id DESC LIMIT 1').get();
function importSummary() {
 const b=latestBatch(); if(!b) return {batch:null,summary:null};
 const base=db.prepare(`SELECT COUNT(*) sku_count,COALESCE(SUM(source_qty),0) total_source_qty,
 SUM(CASE WHEN source_status='NEEDS_VERIFICATION' THEN 1 ELSE 0 END) needs_verification_count,
 SUM(CASE WHEN source_status='NOT_FLAGGED' THEN 1 ELSE 0 END) not_flagged_count,
 SUM(CASE WHEN source_status='MANUAL_REVIEW' THEN 1 ELSE 0 END) manual_review_count,
 SUM(CASE WHEN source_unit_price IS NULL OR source_unit_price<0 THEN 1 ELSE 0 END) price_problem_count,
 SUM(CASE WHEN unit_price_formula IS NOT NULL THEN 1 ELSE 0 END) formula_unit_price_count,
 SUM(CASE WHEN barcode IS NULL OR barcode='' THEN 1 ELSE 0 END) missing_barcode_count FROM import_items WHERE batch_id=?`).get(b.id);
 const dup=db.prepare(`SELECT COUNT(*) n FROM import_items i WHERE i.batch_id=? AND i.sku IN (SELECT sku FROM products WHERE active=1)`).get(b.id).n;
 const internal=db.prepare(`SELECT COUNT(*)-COUNT(DISTINCT sku) n FROM import_items WHERE batch_id=?`).get(b.id).n;
 return {batch:{id:b.id,source_file:b.source_file,status:b.status,import_mode:b.import_mode,destination:b.destination,created_at:b.created_at,committed_at:b.committed_at},summary:{...base,existing_sku_conflicts:dup,duplicate_sku_count:internal,worksheets:JSON.parse(b.source_summary_json).worksheets,manual_review:JSON.parse(b.source_summary_json).manual_review}};
}
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');
 try {
  if(url.pathname.startsWith('/api/')) {
   if(req.method==='GET'&&url.pathname==='/api/sales/export') {
    const from=url.searchParams.get('from')||'',to=url.searchParams.get('to')||'';
    const rows=db.prepare(`SELECT s.*,COUNT(i.id) item_count,COALESCE(SUM(i.quantity),0) unit_count FROM sales s LEFT JOIN sale_items i ON i.sale_id=s.id WHERE (?='' OR date(s.sold_at)>=date(?)) AND (?='' OR date(s.sold_at)<=date(?)) GROUP BY s.id ORDER BY s.id DESC`).all(from,from,to,to);
    const csv=toCsv(rows,[
     {title:'Invoice',val:r=>r.invoice_no},
     {title:'Waktu',val:r=>r.sold_at},
     {title:'Pelanggan',val:r=>r.customer_name},
     {title:'Pembayaran',val:r=>r.payment_method},
     {title:'Jumlah SKU',val:r=>r.item_count},
     {title:'Total Unit',val:r=>r.unit_count},
     {title:'Subtotal (Rp)',val:r=>r.subtotal},
     {title:'Diskon (Rp)',val:r=>r.discount},
     {title:'Total (Rp)',val:r=>r.total},
     {title:'Kasir',val:r=>r.user_name},
     {title:'Lokasi',val:r=>r.location}
    ]);
    res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="riwayat-penjualan.csv"'});
    return res.end(csv);
   }
   if(req.method==='GET'&&url.pathname==='/api/sales') {
    const from=url.searchParams.get('from')||'',to=url.searchParams.get('to')||'';
    const rows=db.prepare(`SELECT s.*,COUNT(i.id) item_count,COALESCE(SUM(i.quantity),0) unit_count FROM sales s LEFT JOIN sale_items i ON i.sale_id=s.id WHERE (?='' OR date(s.sold_at)>=date(?)) AND (?='' OR date(s.sold_at)<=date(?)) GROUP BY s.id ORDER BY s.id DESC`).all(from,from,to,to);
    return send(res,200,rows);
   }
   const saleMatch=url.pathname.match(/^\/api\/sales\/(\d+)$/);
   if(req.method==='GET'&&saleMatch) {
    const sale=db.prepare('SELECT * FROM sales WHERE id=?').get(Number(saleMatch[1]));
    if(!sale)return send(res,404,{error:'Transaksi tidak ditemukan.'});
    return send(res,200,{...sale,items:db.prepare('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id').all(sale.id)});
   }
   if(req.method==='POST'&&url.pathname==='/api/sales') {
    const data=await readBody(req),items=Array.isArray(data.items)?data.items:[],user=String(data.user_name||'Admin Howell').trim(),customer=String(data.customer_name||'Pelanggan').trim()||'Pelanggan',payment=String(data.payment_method||'Tunai').trim();
    if(!items.length||items.length>100)return send(res,400,{error:'Scan minimal satu produk sebelum menyelesaikan penjualan.'});
    if(!['Tunai','QRIS','Transfer','Kartu'].includes(payment))return send(res,400,{error:'Metode pembayaran tidak valid.'});
    db.exec('BEGIN IMMEDIATE');
    try {
     const prepared=[];
     for(const item of items) {
      const id=Number(item.product_id),qty=Number(item.quantity),price=Number(item.unit_price);
      if(!Number.isInteger(id)||!Number.isInteger(qty)||qty<1||!Number.isSafeInteger(price)||price<0)throw new Error('Jumlah dan harga setiap barang harus valid.');
      const p=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(id);
      if(!p)throw new Error('Produk tidak ditemukan atau sudah tidak aktif.');
      const existing=prepared.find(x=>x.p.id===id);if(existing){existing.qty+=qty;existing.line+=qty*price;if(existing.price!==price)throw new Error('Harga SKU yang sama harus seragam dalam satu invoice.');continue;}
      prepared.push({p,qty,price,line:qty*price});
     }
     for(const x of prepared)if(x.qty>x.p.stock)throw new Error(`Stok ${x.p.sku} tidak mencukupi. Tersedia ${x.p.stock} ${x.p.unit}.`);
     const subtotal=prepared.reduce((n,x)=>n+x.line,0);if(!Number.isSafeInteger(subtotal))throw new Error('Total transaksi melebihi batas yang didukung.');
     const invoice=`HWF-${new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,14)}-${String(Date.now()).slice(-5)}`;
     const discount=Math.max(0,Number(data.discount||0)); const total=Math.max(0,subtotal-discount); const saleId=Number(db.prepare('INSERT INTO sales(invoice_no,customer_name,payment_method,subtotal,discount,total,user_name,location) VALUES(?,?,?,?,?,?,?,?)').run(invoice,customer,payment,subtotal,discount,total,user,'Pameran').lastInsertRowid);
     for(const x of prepared){const balance=x.p.stock-x.qty;db.prepare('UPDATE products SET stock=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(balance,x.p.id);db.prepare('INSERT INTO sale_items(sale_id,product_id,sku,name,quantity,unit_price,line_total,balance_after) VALUES(?,?,?,?,?,?,?,?)').run(saleId,x.p.id,x.p.sku,x.p.name,x.qty,x.price,x.line,balance);db.prepare('INSERT INTO inventory_movements(product_id,kind,quantity,balance_after,reference,note,location,user_name) VALUES(? ,\'out\',?,?,?,?,?,?)').run(x.p.id,x.qty,balance,invoice,`Penjualan ${invoice}`,x.p.stock_location,user);}
     db.prepare("INSERT INTO audit_logs(action,entity,entity_id,user_name,details) VALUES('CREATE_SALE','sale',?,?,?)").run(saleId,user,JSON.stringify({invoice_no:invoice,total:subtotal,item_count:prepared.length}));
     db.exec('COMMIT');return send(res,201,{id:saleId,invoice_no:invoice});
    }catch(e){db.exec('ROLLBACK');return send(res,409,{error:e.message||'Penjualan gagal disimpan.'});}
   }
   if(req.method==='GET'&&url.pathname==='/api/products/export') {
    const rows=listProducts(url.searchParams.get('q')||'');
    const csv=toCsv(rows,[
     {title:'SKU',val:r=>r.sku},
     {title:'Barcode',val:r=>r.barcode||''},
     {title:'Nama Produk',val:r=>r.name},
     {title:'Kategori',val:r=>r.category||''},
     {title:'Satuan',val:r=>r.unit||'pcs'},
     {title:'Stok Operasional',val:r=>r.stock},
     {title:'Stok Minimum',val:r=>r.min_stock},
     {title:'Harga Referensi (Rp)',val:r=>r.reference_price},
     {title:'Harga Jual (Rp)',val:r=>r.sale_price},
     {title:'Lokasi Rak',val:r=>r.location||''},
     {title:'Lokasi Stok',val:r=>r.stock_location||''},
     {title:'QTY Sumber Excel',val:r=>r.source_qty??''},
     {title:'Harga Sumber Excel',val:r=>r.source_unit_price??''},
     {title:'Status Verifikasi',val:r=>r.stock_verification_status}
    ]);
    res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="katalog-produk-howell.csv"'});
    return res.end(csv);
   }
   if(req.method==='GET'&&url.pathname==='/api/products/generate-ean') {
    let code='';
    for(let i=0;i<100;i++){
     code=generateEAN13();
     if(!db.prepare('SELECT 1 FROM products WHERE barcode=?').get(code))break;
    }
    return send(res,200,{barcode:code});
   }
   const prodDetailMatch=url.pathname.match(/^\/api\/products\/(\d+)$/);
   if(req.method==='GET'&&prodDetailMatch) {
    const p=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(Number(prodDetailMatch[1]));
    if(!p)return send(res,404,{error:'Produk tidak ditemukan.'});
    return send(res,200,p);
   }
   if((req.method==='PUT'||req.method==='POST')&&prodDetailMatch&&!url.pathname.endsWith('/verify')) {
    const id=Number(prodDetailMatch[1]);
    const p=await readBody(req);
    const barcode=String(p.barcode||'').trim()||null;
    if(barcode&&!validEAN(barcode))return send(res,400,{error:'Barcode harus berupa EAN-13 dengan check digit yang valid.'});
    const existing=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(id);
    if(!existing)return send(res,404,{error:'Produk tidak ditemukan.'});
    const name=String(p.name||existing.name).trim();
    if(!name)return send(res,400,{error:'Nama produk tidak boleh kosong.'});
    const category=p.category!==undefined?String(p.category).trim():existing.category;
    const unit=p.unit!==undefined?String(p.unit).trim():existing.unit;
    const refPrice=p.reference_price!==undefined?Number(p.reference_price):existing.reference_price;
    const salePrice=p.sale_price!==undefined?Number(p.sale_price):existing.sale_price;
    const minStock=p.min_stock!==undefined?Number(p.min_stock):existing.min_stock;
    const location=p.location!==undefined?String(p.location).trim():existing.location;
    const stockLocation=p.stock_location!==undefined?String(p.stock_location).trim():existing.stock_location;
    if(!Number.isSafeInteger(refPrice)||refPrice<0||!Number.isSafeInteger(salePrice)||salePrice<0||!Number.isInteger(minStock)||minStock<0){
     return send(res,400,{error:'Harga dan stok minimum harus bilangan bulat ≥ 0.'});
    }
    db.exec('BEGIN IMMEDIATE');
    try {
     db.prepare(`UPDATE products SET name=?,category=?,unit=?,barcode=?,reference_price=?,sale_price=?,min_stock=?,location=?,stock_location=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
       .run(name,category,unit,barcode,refPrice,salePrice,minStock,location,stockLocation,id);
     db.prepare("INSERT INTO audit_logs(action,entity,entity_id,user_name,details) VALUES('UPDATE_PRODUCT','product',?,?,?)")
       .run(id,String(p.user_name||'Admin Howell'),JSON.stringify({name,barcode,salePrice,refPrice}));
     db.exec('COMMIT');
     return send(res,200,{ok:true,id});
    } catch(e){
     db.exec('ROLLBACK');
     if(String(e.message).includes('UNIQUE'))return send(res,409,{error:'Barcode sudah digunakan oleh produk lain.'});
     throw e;
    }
   }
   if(req.method==='GET'&&url.pathname==='/api/products') return send(res,200,listProducts(url.searchParams.get('q')||''));
   if(req.method==='GET'&&url.pathname==='/api/dashboard') {
    const totals=db.prepare(`SELECT COUNT(*) products,COALESCE(SUM(stock),0) units,COALESCE(SUM(CASE WHEN stock<=min_stock THEN 1 ELSE 0 END),0) low_stock,COALESCE(SUM(CASE WHEN stock_verification_status IN ('NEEDS_VERIFICATION','MANUAL_REVIEW') THEN 1 ELSE 0 END),0) verification_count FROM products WHERE active=1`).get();
    const movements=db.prepare('SELECT m.*,p.sku,p.name,p.unit FROM inventory_movements m JOIN products p ON p.id=m.product_id ORDER BY m.id DESC LIMIT 8').all();
    const imp=importSummary(); const pending=imp.batch?.status==='PREVIEW_PENDING'; const source=imp.summary;
    return send(res,200,{...totals,source_flagged_count:pending?(source?.needs_verification_count||0):totals.verification_count,source_import_count:pending?(source?.sku_count||0):0,source_total_qty:pending?(source?.total_source_qty||0):0,movements,lowProducts:db.prepare('SELECT sku,name,stock,min_stock,unit,source_qty,source_qty_font_color,stock_verification_status,stock_location FROM products WHERE active=1 AND stock<=min_stock ORDER BY stock LIMIT 6').all()});
   }
   if(req.method==='GET'&&url.pathname==='/api/movements') return send(res,200,db.prepare('SELECT m.*,p.sku,p.name,p.unit FROM inventory_movements m JOIN products p ON p.id=m.product_id ORDER BY m.id DESC LIMIT 200').all());
   if(req.method==='GET'&&url.pathname==='/api/import/summary') return send(res,200,importSummary());
   if(req.method==='GET'&&url.pathname==='/api/import/items') {
    const b=latestBatch(); if(!b)return send(res,200,[]); const status=url.searchParams.get('status')||'';
    return send(res,200,db.prepare(`SELECT * FROM import_items WHERE batch_id=? AND (?='' OR source_status=? OR import_result=?) ORDER BY source_row`).all(b.id,status,status,status));
   }
   if(req.method==='GET'&&url.pathname==='/api/verification') return send(res,200,db.prepare(`SELECT * FROM products WHERE active=1 AND stock_verification_status IN ('NEEDS_VERIFICATION','MANUAL_REVIEW') ORDER BY CASE stock_verification_status WHEN 'MANUAL_REVIEW' THEN 0 ELSE 1 END,sku`).all());
   if(req.method==='POST'&&url.pathname==='/api/import/commit') {
    const data=await readBody(req),b=latestBatch();
    if(!b||b.status!=='PREVIEW_PENDING')return send(res,409,{error:'Tidak ada pratinjau impor yang menunggu konfirmasi.'});
    if(!['opening','exhibition','catalog_only'].includes(data.mode))return send(res,400,{error:'Pilih mode impor terlebih dahulu.'});
    const destination=String(data.destination||'').trim(); if(data.mode!=='catalog_only'&&!destination)return send(res,400,{error:'Isi lokasi tujuan untuk stok saldo awal atau stok pameran.'});
    if(data.duplicate_policy!=='skip')return send(res,400,{error:'Pilih kebijakan lewati SKU duplikat.'});
    const items=db.prepare('SELECT * FROM import_items WHERE batch_id=? ORDER BY source_row').all(b.id); let imported=0,skipped=0,qtyApplied=0;
    db.exec('BEGIN IMMEDIATE');
    try {
     for(const item of items) {
      if(db.prepare('SELECT 1 FROM products WHERE sku=? AND active=1').get(item.sku)) {db.prepare("UPDATE import_items SET import_result='DUPLICATE_SKIPPED' WHERE id=?").run(item.id);skipped++;continue;}
      const quantity=data.mode==='catalog_only'?0:item.source_qty;
      const stockLocation=data.mode==='catalog_only'?'':destination;
      const sale=0;
      const insert=db.prepare(`INSERT INTO products(sku,barcode,name,category,unit,reference_price,sale_price,stock,min_stock,location,stock_location,source_qty,source_unit_price,source_total,source_discount_value,source_qty_font_color,source_qty_font_color_type,stock_verification_status,source_file,source_sheet,source_row,source_unit_price_formula,source_total_formula,source_discount_formula,source_import_id) VALUES(?,NULL,?,'Pameran','pcs',?,?,?,0,'',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(item.sku,item.name,Number(item.source_unit_price||0),sale,quantity,stockLocation,item.source_qty,item.source_unit_price,item.source_total,item.source_discount_value,item.source_qty_font_color,item.source_qty_font_color_type,item.source_status,b.source_file,item.source_sheet,item.source_row,item.unit_price_formula,item.total_formula,item.discount_formula,b.id);
      const productId=Number(insert.lastInsertRowid);
      if(quantity>0) {const kind=data.mode==='opening'?'opening':'in';db.prepare('INSERT INTO inventory_movements(product_id,kind,quantity,balance_after,reference,note,location,user_name) VALUES(?,?,?,?,?,?,?,?)').run(productId,kind,quantity,quantity,`IMP-${b.id}-${item.source_row}`,data.mode==='opening'?'Saldo awal dari file pameran':'Alokasi stok ke lokasi pameran',destination,String(data.user_name||'Admin Howell'));qtyApplied+=quantity;}
      db.prepare("UPDATE import_items SET import_result='IMPORTED' WHERE id=?").run(item.id); imported++;
     }
     db.prepare("UPDATE import_batches SET status='COMMITTED',import_mode=?,destination=?,committed_at=CURRENT_TIMESTAMP WHERE id=?").run(data.mode,destination,b.id);
     db.prepare("INSERT INTO audit_logs(action,entity,entity_id,user_name,details) VALUES('IMPORT_PRODUCTS','import_batch',?,?,?)").run(b.id,String(data.user_name||'Admin Howell'),JSON.stringify({mode:data.mode,destination,imported,skipped,qtyApplied}));
     db.exec('COMMIT'); return send(res,200,{imported,skipped,qtyApplied,mode:data.mode,destination});
    } catch(e){db.exec('ROLLBACK');throw e;}
   }
   const verifyMatch=url.pathname.match(/^\/api\/products\/(\d+)\/verify$/);
   if(req.method==='POST'&&verifyMatch) {
    const data=await readBody(req),id=Number(verifyMatch[1]),actual=Number(data.actual_stock),user=String(data.user_name||'Admin Howell').trim(),reason=String(data.reason||'').trim();
    if(!Number.isInteger(actual)||actual<0||!reason)return send(res,400,{error:'Jumlah hasil pemeriksaan harus bilangan bulat ≥ 0 dan alasan wajib diisi.'});
    db.exec('BEGIN IMMEDIATE');
    try {
     const p=db.prepare("SELECT * FROM products WHERE id=? AND active=1 AND stock_verification_status IN ('NEEDS_VERIFICATION','MANUAL_REVIEW')").get(id);
     if(!p){db.exec('ROLLBACK');return send(res,409,{error:'Produk tidak ditemukan atau sudah diverifikasi.'});}
     const diff=actual-p.stock;
     db.prepare("UPDATE products SET stock=?,stock_verification_status='VERIFIED',stock_verification_note=?,stock_verified_at=CURRENT_TIMESTAMP,stock_verified_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(actual,reason,user,id);
     db.prepare('INSERT INTO verification_history(product_id,source_qty,previous_stock,verified_stock,difference,user_name,reason) VALUES(?,?,?,?,?,?,?)').run(id,p.source_qty??p.stock,p.stock,actual,diff,user,reason);
     db.prepare("INSERT INTO audit_logs(action,entity,entity_id,user_name,details) VALUES('VERIFY_STOCK','product',?,?,?)").run(id,user,JSON.stringify({source_qty:p.source_qty,previous_stock:p.stock,verified_stock:actual,difference:diff,reason}));
     if(diff!==0)db.prepare("INSERT INTO inventory_movements(product_id,kind,quantity,balance_after,reference,note,location,user_name) VALUES(?,'adjustment',?,?,?,?,?,?)").run(id,Math.abs(diff),actual,`VER-${id}-${Date.now()}`,`Hasil verifikasi fisik (${diff>0?'+':''}${diff}). ${reason}`,p.stock_location,user);
     db.exec('COMMIT');return send(res,200,{id,previous_stock:p.stock,source_qty:p.source_qty,verified_stock:actual,difference:diff,status:'VERIFIED'});
    }catch(e){db.exec('ROLLBACK');throw e;}
   }
   if(req.method==='POST'&&url.pathname==='/api/products') {
    const p=await readBody(req),barcode=String(p.barcode||'').trim()||null;
    if(!p.sku?.trim()||!p.name?.trim())return send(res,400,{error:'SKU dan nama produk wajib diisi.'});
    if(barcode&&!validEAN(barcode))return send(res,400,{error:'Barcode harus berupa EAN-13 dengan check digit yang valid.'});
    const qty=Number(p.stock||0);if(!Number.isInteger(qty)||qty<0)return send(res,400,{error:'Stok harus berupa bilangan bulat nol atau lebih.'});
    const rp=Number(p.reference_price||0),sp=Number(p.sale_price||0);if(!Number.isSafeInteger(rp)||rp<0||!Number.isSafeInteger(sp)||sp<0)return send(res,400,{error:'Harga harus berupa Rupiah bulat nol atau lebih.'});
    db.exec('BEGIN IMMEDIATE');try{const result=db.prepare('INSERT INTO products(sku,barcode,name,category,unit,reference_price,sale_price,stock,min_stock,location,stock_location) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(p.sku.trim(),barcode,p.name.trim(),p.category||'',p.unit||'pcs',rp,sp,qty,Number(p.min_stock||0),p.location||'',p.stock_location||'Gudang utama');if(qty)db.prepare("INSERT INTO inventory_movements(product_id,kind,quantity,balance_after,reference,note,location) VALUES(?,'opening',?,?,'SALDO-AWAL','Saldo awal dari pembuatan produk',?)").run(result.lastInsertRowid,qty,qty,p.stock_location||'Gudang utama');db.exec('COMMIT');return send(res,201,{id:Number(result.lastInsertRowid)})}catch(e){db.exec('ROLLBACK');if(String(e.message).includes('UNIQUE'))return send(res,409,{error:'SKU atau barcode sudah digunakan.'});throw e;}
   }
   if(req.method==='POST'&&url.pathname==='/api/movements') {
    const m=await readBody(req),qty=Number(m.quantity),kind=m.kind;if(!Number.isInteger(m.product_id)||!Number.isInteger(qty)||qty<=0||!['in','out','adjustment'].includes(kind))return send(res,400,{error:'Produk, jenis, dan jumlah pergerakan wajib valid.'});
    db.exec('BEGIN IMMEDIATE');try{const p=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(m.product_id);if(!p){db.exec('ROLLBACK');return send(res,404,{error:'Produk tidak ditemukan.'});}const balance=kind==='in'?p.stock+qty:p.stock-qty;if(balance<0){db.exec('ROLLBACK');return send(res,409,{error:`Stok tidak mencukupi. Stok saat ini ${p.stock} ${p.unit}.`});}db.prepare('UPDATE products SET stock=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(balance,p.id);db.prepare('INSERT INTO inventory_movements(product_id,kind,quantity,balance_after,reference,note,location,user_name) VALUES(?,?,?,?,?,?,?,?)').run(p.id,kind,qty,balance,(m.reference||'').trim()||'STK-'+Date.now(),m.note||'',p.stock_location,String(m.user_name||'Admin Howell'));db.exec('COMMIT');return send(res,201,{balance})}catch(e){db.exec('ROLLBACK');throw e;}
   }
   if(req.method==='DELETE'&&url.pathname.startsWith('/api/products/')){const id=Number(url.pathname.split('/').pop()),used=db.prepare('SELECT 1 FROM inventory_movements WHERE product_id=? LIMIT 1').get(id);if(used)db.prepare('UPDATE products SET active=0 WHERE id=?').run(id);else db.prepare('DELETE FROM products WHERE id=?').run(id);return send(res,200,{ok:true});}
   return send(res,404,{error:'Endpoint tidak ditemukan.'});
  }
  const file=url.pathname==='/'?'index.html':url.pathname.slice(1),full=path.resolve(root,file);if(!full.startsWith(root+path.sep))return send(res,403,'Forbidden','text/plain');
  const ext=path.extname(full),types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'};if(!fs.existsSync(full))return send(res,404,'Not found','text/plain');return send(res,200,fs.readFileSync(full),types[ext]||'application/octet-stream');
 }catch(e){console.error(e);return send(res,500,{error:'Terjadi kesalahan server.'});}
});
const port=Number(process.env.PORT||3000);server.listen(port,'127.0.0.1',()=>console.log(`Howell StockFlow berjalan di http://127.0.0.1:${port}`));
