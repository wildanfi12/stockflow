const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupiah = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
const timeFmt = s => new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }).format(new Date(String(s).replace(' ', 'T') + 'Z'));

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Permintaan gagal.');
  return data;
}

let toastTimer;
function notify(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2800);
}

const titles = {
  dashboard: 'Dashboard',
  scan: 'Kasir / Scan',
  sales: 'Riwayat penjualan',
  products: 'Produk & SKU',
  import: 'Import Excel',
  verification: 'Stok perlu verifikasi',
  movements: 'Pergerakan stok'
};

function showPage(name) {
  $$('.page').forEach(n => n.classList.add('hidden'));
  $('#' + name + 'Page').classList.remove('hidden');
  $$('.nav').forEach(n => n.classList.toggle('active', n.dataset.page === name));
  $('#crumb').textContent = titles[name] || name;
  ({
    dashboard: loadDashboard,
    products: () => loadProducts($('#productSearch')?.value || ''),
    import: loadImport,
    verification: loadVerification,
    movements: loadMovements,
    sales: loadSales
  })[name]?.();
  if (name === 'scan') setTimeout(() => $('#barcodeInput').focus(), 80);
}

$$('[data-page]').forEach(n => n.addEventListener('click', () => showPage(n.dataset.page)));
$('#today').textContent = new Intl.DateTimeFormat('id-ID', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' }).format(new Date());

function productCard(p) {
  return `<span class="product-thumb">▤</span><span><b>${esc(p.name)}</b><br><small class="muted">${esc(p.category || 'Tanpa kategori')}</small></span>`;
}

function statusChip(s) {
  if (s === 'NEEDS_VERIFICATION') return '<span class="verify-chip">PERLU VERIFIKASI</span>';
  if (s === 'MANUAL_REVIEW') return '<span class="verify-chip">PERIKSA MANUAL</span>';
  if (s === 'VERIFIED') return '<span class="verify-chip done">TERVERIFIKASI</span>';
  return '<span class="verify-chip normal">TIDAK DITANDAI</span>';
}

function quantity(q, flag) {
  return `<span class="qty-cell ${flag ? 'qty-red' : ''}">${Number(q || 0).toLocaleString('id-ID')} pcs</span>`;
}

function sourceMoney(v) {
  return v === null || v === undefined ? '<span class="muted">—</span>' : rupiah(v);
}

/* ==================== MODAL SYSTEM ==================== */
function modal(title, body, submitLabel, onSubmit) {
  const host = $('#modalHost');
  host.innerHTML = `<div class="modal-backdrop"><form class="modal"><div class="modal-head"><h2>${title}</h2><button type="button" class="modal-close">×</button></div><div class="modal-body">${body}</div><div class="modal-actions"><button type="button" class="button secondary modal-close">Batal</button><button class="button primary">${submitLabel}</button></div></form></div>`;
  host.querySelectorAll('.modal-close').forEach(b => b.onclick = () => host.innerHTML = '');
  host.querySelector('.modal-backdrop').onclick = e => { if (e.target.classList.contains('modal-backdrop')) host.innerHTML = ''; };
  host.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    try {
      await onSubmit(data);
      host.innerHTML = '';
    } catch (err) {
      notify(err.message);
    }
  };
}

function showAddProductModal() {
  modal('Tambah Produk Baru', `
    <div class="form-grid">
      <div class="field"><label>SKU *</label><input name="sku" required placeholder="Contoh: AU1208"></div>
      <div class="field">
        <label>Barcode EAN-13</label>
        <div style="display:flex;gap:4px">
          <input id="newBarcode" name="barcode" inputmode="numeric" maxlength="13" placeholder="Opsional / 13 digit" style="flex:1">
          <button type="button" class="button secondary" style="height:35px;padding:0 8px;font-size:10px;white-space:nowrap" id="btnGenEan">Auto EAN</button>
        </div>
      </div>
      <div class="field full"><label>Nama Produk *</label><input name="name" required placeholder="Nama produk lengkap"></div>
      <div class="field"><label>Kategori</label><input name="category" placeholder="Audio, Adapter, dsb"></div>
      <div class="field"><label>Satuan</label><select name="unit"><option>pcs</option><option>box</option><option>roll</option><option>set</option></select></div>
      <div class="field"><label>Harga Referensi (Rp)</label><input name="reference_price" type="number" min="0" value="0"></div>
      <div class="field"><label>Harga Jual (Rp)</label><input name="sale_price" type="number" min="0" value="0"></div>
      <div class="field"><label>Saldo Awal (Unit)</label><input name="stock" type="number" min="0" step="1" value="0"></div>
      <div class="field"><label>Stok Minimum</label><input name="min_stock" type="number" min="0" step="1" value="0"></div>
      <div class="field"><label>Lokasi Rak</label><input name="location" placeholder="Opsional"></div>
      <div class="field"><label>Lokasi Stok</label><input name="stock_location" value="Pameran"></div>
    </div>
  `, 'Simpan Produk', async d => {
    await api('/api/products', { method: 'POST', body: JSON.stringify(d) });
    notify('Produk berhasil disimpan.');
    loadProducts();
    loadDashboard();
  });
  $('#btnGenEan').onclick = async () => {
    try {
      const res = await api('/api/products/generate-ean');
      $('#newBarcode').value = res.barcode;
      notify('Barcode EAN-13 dibuat: ' + res.barcode);
    } catch (e) { notify(e.message); }
  };
}

async function showEditProductModal(id) {
  try {
    const p = await api('/api/products/' + id);
    modal(`Edit Produk · ${esc(p.sku)}`, `
      <div class="form-grid">
        <div class="field"><label>SKU (Tetap)</label><input value="${esc(p.sku)}" disabled style="background:#f2f4f7"></div>
        <div class="field">
          <label>Barcode EAN-13 (13 digit)</label>
          <div style="display:flex;gap:4px">
            <input id="editBarcode" name="barcode" value="${esc(p.barcode || '')}" inputmode="numeric" maxlength="13" placeholder="Kosong atau 13 digit" style="flex:1">
            <button type="button" class="button secondary" style="height:35px;padding:0 8px;font-size:10px;white-space:nowrap" id="btnGenEanEdit">Auto EAN</button>
          </div>
        </div>
        <div class="field full"><label>Nama Produk *</label><input name="name" required value="${esc(p.name)}"></div>
        <div class="field"><label>Kategori</label><input name="category" value="${esc(p.category || '')}"></div>
        <div class="field"><label>Satuan</label><select name="unit"><option ${p.unit === 'pcs' ? 'selected' : ''}>pcs</option><option ${p.unit === 'box' ? 'selected' : ''}>box</option><option ${p.unit === 'roll' ? 'selected' : ''}>roll</option><option ${p.unit === 'set' ? 'selected' : ''}>set</option></select></div>
        <div class="field"><label>Harga Referensi (Rp)</label><input name="reference_price" type="number" min="0" value="${p.reference_price || 0}"></div>
        <div class="field"><label>Harga Jual (Rp)</label><input name="sale_price" type="number" min="0" value="${p.sale_price || 0}"></div>
        <div class="field"><label>Stok Minimum</label><input name="min_stock" type="number" min="0" step="1" value="${p.min_stock || 0}"></div>
        <div class="field"><label>Lokasi Rak</label><input name="location" value="${esc(p.location || '')}"></div>
        <div class="field full"><label>Lokasi Stok Operasional</label><input name="stock_location" value="${esc(p.stock_location || 'Gudang utama')}"></div>
      </div>
    `, 'Simpan Perubahan', async d => {
      await api('/api/products/' + id, { method: 'PUT', body: JSON.stringify(d) });
      notify('Perubahan produk tersimpan.');
      loadProducts($('#productSearch')?.value || '');
      loadDashboard();
    });
    $('#btnGenEanEdit').onclick = async () => {
      try {
        const res = await api('/api/products/generate-ean');
        $('#editBarcode').value = res.barcode;
        notify('Barcode dibuat: ' + res.barcode);
      } catch (e) { notify(e.message); }
    };
  } catch (e) { notify(e.message); }
}

async function showNewStockModal() {
  try {
    const list = await api('/api/products');
    if (!list.length) return notify('Belum ada produk aktif.');
    modal('Catat Pergerakan Stok', `
      <div class="form-grid">
        <div class="field full">
          <label>Pilih Produk *</label>
          <select name="product_id" required>
            ${list.map(p => `<option value="${p.id}">${esc(p.sku)} — ${esc(p.name)} (Stok: ${p.stock} ${esc(p.unit)})</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Jenis Pergerakan *</label>
          <select name="kind">
            <option value="in">Barang Masuk (Restock / Tambah)</option>
            <option value="out">Barang Keluar (Pengeluaran)</option>
            <option value="adjustment">Penyesuaian Fisik</option>
          </select>
        </div>
        <div class="field">
          <label>Jumlah Unit *</label>
          <input name="quantity" type="number" min="1" step="1" required placeholder="Minimal 1">
        </div>
        <div class="field">
          <label>Nomor Referensi</label>
          <input name="reference" placeholder="PO, Surat Jalan, dsb">
        </div>
        <div class="field">
          <label>Catatan</label>
          <input name="note" placeholder="Keterangan opsional">
        </div>
      </div>
    `, 'Konfirmasi Catat Stok', async d => {
      await api('/api/movements', {
        method: 'POST',
        body: JSON.stringify({ ...d, product_id: Number(d.product_id), quantity: Number(d.quantity) })
      });
      notify('Pergerakan stok berhasil dicatat.');
      loadDashboard();
      loadMovements();
    });
  } catch (e) { notify(e.message); }
}

$$('[data-action="add-product"]').forEach(b => b.onclick = showAddProductModal);
$$('[data-action="new-stock"]').forEach(b => b.onclick = showNewStockModal);

/* ==================== DASHBOARD ==================== */
async function loadDashboard() {
  try {
    const d = await api('/api/dashboard');
    $('#statProducts').textContent = d.products.toLocaleString('id-ID');
    $('#statUnits').textContent = d.units.toLocaleString('id-ID');
    $('#statLow').textContent = d.low_stock.toLocaleString('id-ID');
    $('#statVerify').textContent = d.source_flagged_count.toLocaleString('id-ID');
    $('#statMoves').textContent = d.movements.filter(m => new Date(String(m.created_at).replace(' ', 'T') + 'Z').toDateString() === new Date().toDateString()).length.toLocaleString('id-ID');

    $('#lowRows').innerHTML = d.lowProducts.length ? d.lowProducts.map(p => `
      <tr>
        <td><div class="product-cell">${productCard(p)}</div></td>
        <td>${esc(p.sku)}</td>
        <td>${p.stock} ${esc(p.unit)}</td>
        <td>${p.min_stock} ${esc(p.unit)}</td>
        <td>${statusChip(p.stock_verification_status)}</td>
      </tr>`).join('') : '<tr><td colspan="5" class="empty-row">Belum ada produk yang perlu direstock.</td></tr>';

    if (d.source_flagged_count) {
      $('.note-bar b').textContent = `${d.source_flagged_count} SKU perlu verifikasi`;
      $('.note-bar p').textContent = 'Penanda merah QTY sumber tetap tersimpan hingga verifikasi fisik.';
    }

    $('#activityList').innerHTML = d.movements.length ? d.movements.map(m => `
      <div class="activity">
        <span class="activity-icon ${m.kind === 'out' ? 'out' : ''}">${m.kind === 'in' ? '↓' : m.kind === 'out' ? '↑' : '＋'}</span>
        <div>
          <b>${m.kind === 'in' ? 'Barang masuk' : m.kind === 'out' ? 'Barang keluar' : m.kind === 'opening' ? 'Saldo awal' : 'Penyesuaian'} · ${esc(m.name)}</b>
          <p>${esc(m.sku)} · ${m.kind === 'out' ? '-' : '+'}${m.quantity} ${esc(m.unit)} · saldo ${m.balance_after}</p>
          <time>${timeFmt(m.created_at)} WIB · ${esc(m.location || '')}</time>
        </div>
      </div>`).join('') : '<div class="no-data">Belum ada aktivitas.</div>';
  } catch (e) { notify(e.message); }
}

/* ==================== PRODUK & SKU ==================== */
async function loadProducts(q = '') {
  try {
    const rows = await api('/api/products?q=' + encodeURIComponent(q));
    $('#productCount').textContent = rows.length + ' produk';
    $('#productRows').innerHTML = rows.length ? rows.map(p => `
      <tr>
        <td><div class="product-cell">${productCard(p)}</div></td>
        <td><b>${esc(p.sku)}</b></td>
        <td>${esc(p.barcode || '—')}</td>
        <td>${p.source_qty == null ? `${p.stock} ${esc(p.unit)}` : `Stok ${p.stock} ${esc(p.unit)}<br>${quantity(p.source_qty, p.stock_verification_status === 'NEEDS_VERIFICATION')}<small class="sub-label">QTY sumber Excel</small>${p.stock_verification_status === 'NEEDS_VERIFICATION' ? `<small class="sub-label">${statusChip(p.stock_verification_status)}</small>` : ''}`}</td>
        <td>${sourceMoney(p.source_unit_price)}</td>
        <td>${sourceMoney(p.source_total)}</td>
        <td>${sourceMoney(p.source_discount_value)}</td>
        <td>
          <div class="row-actions-group">
            <button class="edit-btn" title="Edit produk" data-edit="${p.id}">Edit</button>
            <button class="row-action" title="Arsipkan produk" data-archive="${p.id}">×</button>
          </div>
        </td>
      </tr>`).join('') : '<tr><td colspan="8" class="empty-row">Belum ada produk sesuai pencarian.</td></tr>';

    $$('[data-edit]').forEach(b => b.onclick = () => showEditProductModal(b.dataset.edit));
    $$('[data-archive]').forEach(b => b.onclick = async () => {
      if (!confirm('Arsipkan SKU ini? Data riwayat ledger tetap tersimpan.')) return;
      try {
        await api('/api/products/' + b.dataset.archive, { method: 'DELETE' });
        notify('Produk diarsipkan.');
        loadProducts($('#productSearch').value);
        loadDashboard();
      } catch (e) { notify(e.message); }
    });
  } catch (e) { notify(e.message); }
}

$('#productSearch')?.addEventListener('input', e => loadProducts(e.target.value));
$('#exportProducts')?.addEventListener('click', () => {
  const q = $('#productSearch')?.value || '';
  window.open('/api/products/export' + (q ? '?q=' + encodeURIComponent(q) : ''), '_blank');
});

/* ==================== IMPORT EXCEL ==================== */
function renderImportRows(rows) {
  $('#importRows').innerHTML = rows.length ? rows.map(p => `
    <tr>
      <td>${p.source_row}</td>
      <td><b>${esc(p.sku)}</b></td>
      <td>${esc(p.name)}</td>
      <td>${quantity(p.source_qty, p.source_status === 'NEEDS_VERIFICATION')}<small class="sub-label">${esc(p.source_qty_font_color || p.source_qty_font_color_type || '')}</small></td>
      <td>${rupiah(p.source_unit_price)}</td>
      <td>${rupiah(p.source_total)}</td>
      <td>${rupiah(p.source_discount_value)}</td>
      <td>${statusChip(p.source_status)}</td>
    </tr>`).join('') : '<tr><td colspan="8" class="empty-row">Data sumber tidak tersedia.</td></tr>';
}

async function loadImport() {
  try {
    const d = await api('/api/import/summary'), s = d.summary;
    if (!s) return;
    const cards = [
      ['SKU', s.sku_count, 'Produk terdeteksi'],
      ['Total QTY', Number(s.total_source_qty).toLocaleString('id-ID'), 'Unit sumber'],
      ['QTY merah', s.needs_verification_count, 'PERLU VERIFIKASI'],
      ['Pemeriksaan manual', s.manual_review_count, 'Warna/data tidak pasti']
    ];
    $('#importSummaryCards').innerHTML = cards.map((c, i) => `
      <article class="stat-card">
        <div class="stat-top"><span>${c[0]}</span><span class="stat-icon ${i === 2 ? 'red' : 'navy'}">${i === 2 ? '!' : '▤'}</span></div>
        <strong class="${i === 2 ? 'qty-red' : ''}">${c[1]}</strong>
        <small>${c[2]}</small>
      </article>`).join('');

    $('#importFileName').textContent = `${d.batch.source_file} · ${d.batch.status === 'COMMITTED' ? 'sudah diterapkan' : 'menunggu konfirmasi'}`;
    const rows = await api('/api/import/items');
    renderImportRows(rows);

    $('#importFilter').onchange = () => renderImportRows(rows.filter(r => !$('#importFilter').value || r.source_status === $('#importFilter').value));
    $('#commitImport').disabled = d.batch.status === 'COMMITTED';
    $('#commitImport').textContent = d.batch.status === 'COMMITTED' ? 'Impor sudah diterapkan' : 'Konfirmasi impor';

    if (d.batch.status === 'COMMITTED') {
      $('#importMode').value = d.batch.import_mode || 'opening';
      $('#importMode').disabled = true;
      $('#importDestination').value = d.batch.destination || '';
      $('#importDestination').disabled = true;
    }
  } catch (e) { notify(e.message); }
}

$('#commitImport')?.addEventListener('click', async () => {
  const mode = $('#importMode').value;
  const destination = $('#importDestination').value.trim();
  const duplicatePolicy = $('#duplicatePolicy').value;
  if (!mode) return notify('Pilih mode impor terlebih dahulu.');
  if (mode !== 'catalog_only' && !destination) return notify('Isi lokasi tujuan untuk stok saldo awal atau stok pameran.');
  if (!confirm(`Konfirmasi impor data ke database dengan mode "${mode}" dan lokasi "${destination || 'katalog saja'}"?`)) return;
  try {
    const res = await api('/api/import/commit', {
      method: 'POST',
      body: JSON.stringify({ mode, destination, duplicate_policy: duplicatePolicy })
    });
    notify(`Impor berhasil: ${res.imported} produk diproses, ${res.skipped} dilewati.`);
    loadImport();
    loadDashboard();
    loadProducts();
  } catch (e) { notify(e.message); }
});

/* ==================== VERIFIKASI STOK ==================== */
async function loadVerification() {
  try {
    const rows = await api('/api/verification');
    $('#verificationCount').textContent = `${rows.length} SKU`;
    $('#verificationRows').innerHTML = rows.length ? rows.map(p => `
      <tr>
        <td><b>${esc(p.sku)}</b><br>${esc(p.name)}</td>
        <td>${quantity(p.source_qty, true)}</td>
        <td>${p.stock} ${esc(p.unit)}</td>
        <td>${esc(p.stock_location)}</td>
        <td>${statusChip(p.stock_verification_status)}</td>
        <td><button class="button secondary" data-verify="${p.id}">Verifikasi</button></td>
      </tr>`).join('') : '<tr><td colspan="6" class="empty-row">Tidak ada SKU yang menunggu verifikasi fisik.</td></tr>';

    $$('[data-verify]').forEach(b => b.onclick = () => verifyProduct(rows.find(p => p.id === Number(b.dataset.verify))));
  } catch (e) { notify(e.message); }
}

async function verifyProduct(p) {
  const actual = prompt(`QTY fisik untuk ${p.sku} (QTY sumber ${p.source_qty}, saldo sistem ${p.stock}):`);
  if (actual === null) return;
  const quantity = Number(actual);
  if (!Number.isInteger(quantity) || quantity < 0) return notify('Isi jumlah unit bulat nol atau lebih.');
  const reason = prompt('Catatan / alasan hasil pemeriksaan fisik:');
  if (!reason?.trim()) return notify('Catatan verifikasi wajib diisi.');
  if (!confirm(`Simpan hasil verifikasi ${quantity} pcs untuk ${p.sku}?`)) return;
  try {
    await api(`/api/products/${p.id}/verify`, {
      method: 'POST',
      body: JSON.stringify({ actual_stock: quantity, reason, user_name: 'Admin Howell' })
    });
    notify('Verifikasi tersimpan; riwayat dan penyesuaian ledger tercatat.');
    loadVerification();
    loadProducts();
    loadDashboard();
  } catch (e) { notify(e.message); }
}

/* ==================== PERGERAKAN STOK ==================== */
let cachedMovements = [];
function renderMovementRows(rows) {
  $('#movementRows').innerHTML = rows.length ? rows.map(m => `
    <tr>
      <td>${timeFmt(m.created_at)} WIB</td>
      <td><b>${esc(m.name)}</b><br>${esc(m.sku)}</td>
      <td>${m.kind === 'in' ? 'Masuk' : m.kind === 'out' ? 'Keluar' : m.kind === 'opening' ? 'Saldo awal' : 'Penyesuaian'}</td>
      <td>${m.kind === 'out' ? '-' : '+'}${m.quantity} ${esc(m.unit)}</td>
      <td>${m.balance_after} ${esc(m.unit)}</td>
      <td>${esc(m.reference)}</td>
      <td>${esc(m.location)} · ${esc(m.note)}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty-row">Belum ada pergerakan stok sesuai pencarian.</td></tr>';
}

async function loadMovements() {
  try {
    cachedMovements = await api('/api/movements');
    const q = $('#movementSearch')?.value.toLowerCase().trim() || '';
    const filtered = q ? cachedMovements.filter(m => `${m.sku} ${m.name} ${m.reference} ${m.note} ${m.location}`.toLowerCase().includes(q)) : cachedMovements;
    renderMovementRows(filtered);
  } catch (e) { notify(e.message); }
}

$('#movementSearch')?.addEventListener('input', e => {
  const q = e.target.value.toLowerCase().trim();
  const filtered = q ? cachedMovements.filter(m => `${m.sku} ${m.name} ${m.reference} ${m.note} ${m.location}`.toLowerCase().includes(q)) : cachedMovements;
  renderMovementRows(filtered);
});

/* ==================== KASIR / SCAN ==================== */
const cart = new Map();

function updateCartTotals() {
  const rows = [...cart.values()];
  const subtotal = rows.reduce((n, x) => n + x.quantity * x.unit_price, 0);
  const discount = Math.max(0, Number($('#saleDiscount')?.value || 0));
  const total = Math.max(0, subtotal - discount);
  const payment = $('#salePayment')?.value || 'Tunai';
  const cash = Number($('#saleCash')?.value || 0);

  $('#cartSubtotal').textContent = rupiah(subtotal);
  if ($('#cartDiscountDisp')) {
    $('#cartDiscountDisp').textContent = '- ' + rupiah(discount);
    $('#discountRow').style.display = discount > 0 ? 'flex' : 'none';
  }
  $('#cartTotal').textContent = rupiah(total);

  if (payment === 'Tunai') {
    $('#cashField').style.display = 'flex';
    $('#changeRow').style.display = 'flex';
    const change = cash - total;
    $('#cartChange').textContent = change >= 0 ? rupiah(change) : 'Kurang ' + rupiah(Math.abs(change));
    $('#cartChange').style.color = change >= 0 ? 'var(--green)' : 'var(--red)';
  } else {
    $('#cashField').style.display = 'none';
    $('#changeRow').style.display = 'none';
  }
  $('#completeSale').disabled = !rows.length;
}

function renderCart() {
  const rows = [...cart.values()];
  $('#cartCount').textContent = rows.reduce((n, x) => n + x.quantity, 0) + ' unit · ' + rows.length + ' SKU';
  $('#cartRows').innerHTML = rows.length ? rows.map(x => `
    <tr>
      <td><b>${esc(x.name)}</b><br><small>${esc(x.sku)}</small></td>
      <td>
        <button class="qty-action" data-qty="${x.id}" data-delta="-1">−</button>
        ${x.quantity}
        <button class="qty-action" data-qty="${x.id}" data-delta="1">+</button>
      </td>
      <td><input class="cart-price" type="number" min="0" step="1" data-price="${x.id}" value="${x.unit_price}" aria-label="Harga satuan ${esc(x.sku)}"></td>
      <td>${rupiah(x.unit_price * x.quantity)}</td>
      <td><button class="row-action" data-remove="${x.id}" aria-label="Hapus ${esc(x.sku)}">×</button></td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty-row">Scan barcode atau masukkan SKU untuk mulai transaksi.</td></tr>';

  $$('[data-qty]').forEach(b => b.onclick = () => {
    const x = cart.get(Number(b.dataset.qty));
    if (x) {
      x.quantity = Math.max(0, x.quantity + Number(b.dataset.delta));
      if (!x.quantity) cart.delete(x.id);
      renderCart();
    }
  });

  $$('[data-remove]').forEach(b => b.onclick = () => {
    cart.delete(Number(b.dataset.remove));
    renderCart();
  });

  $$('[data-price]').forEach(i => i.onchange = () => {
    const x = cart.get(Number(i.dataset.price)), v = Number(i.value);
    if (!Number.isSafeInteger(v) || v < 0) {
      notify('Harga harus berupa nominal bulat 0 atau lebih.');
      i.value = x.unit_price;
      return;
    }
    x.unit_price = v;
    renderCart();
  });

  updateCartTotals();
}

$('#salePayment')?.addEventListener('change', updateCartTotals);
$('#saleDiscount')?.addEventListener('input', updateCartTotals);
$('#saleCash')?.addEventListener('input', updateCartTotals);

async function scan() {
  const input = $('#barcodeInput'), code = input.value.trim();
  if (!code) return;
  input.value = '';
  try {
    const rows = await api('/api/products?q=' + encodeURIComponent(code));
    const p = rows.find(x => x.barcode === code) || rows.find(x => x.sku.toLowerCase() === code.toLowerCase());
    if (!p) {
      $('#scanResult').innerHTML = `<div class="empty-result"><div>⌕</div><b>Produk tidak ditemukan</b><span>"${esc(code)}" belum terdaftar · stok tidak berubah</span></div>`;
      return;
    }
    const item = cart.get(p.id), available = p.stock - (item?.quantity || 0);
    if (available < 1) {
      $('#scanResult').innerHTML = `<div class="verify-warn">Stok ${esc(p.sku)} tidak mencukupi. Saldo saat ini ${p.stock} ${esc(p.unit)}.</div>`;
      notify('Stok produk di sistem sudah habis.');
      return;
    }
    if (item) {
      item.quantity++;
    } else {
      const initPrice = p.sale_price > 0 ? p.sale_price : (p.source_unit_price || 0);
      cart.set(p.id, {
        id: p.id,
        sku: p.sku,
        name: p.name,
        stock: p.stock,
        unit: p.unit,
        quantity: 1,
        unit_price: initPrice
      });
    }
    renderCart();

    const flagged = p.stock_verification_status === 'NEEDS_VERIFICATION';
    $('#scanResult').innerHTML = `
      <div class="result-card">
        <div class="eyebrow">DITAMBAHKAN KE KERANJANG</div>
        <h2>${esc(p.name)}</h2>
        <div class="result-meta">${esc(p.sku)} · ${esc(p.barcode || 'Barcode belum diset')}</div>
        ${flagged ? `<div class="verify-warn">${statusChip(p.stock_verification_status)} · QTY berpenanda merah Excel. Transaksi tetap dapat dilanjutkan.</div>` : ''}
        <div class="result-details">
          <div><small>STOK TERSEDIA</small><b>${available} ${esc(p.unit)} · ${esc(p.stock_location)}</b></div>
          <div><small>HARGA SATUAN KERANJANG</small><b>${rupiah(cart.get(p.id).unit_price)}</b></div>
          <div><small>JUMLAH DI KERANJANG</small><b>${cart.get(p.id).quantity} ${esc(p.unit)}</b></div>
          <div><small>LOKASI RAK</small><b>${esc(p.location || '—')}</b></div>
        </div>
      </div>`;
  } catch (e) {
    notify(e.message);
  } finally {
    input.focus();
  }
}

$('#scanButton')?.addEventListener('click', scan);
$('#barcodeInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    scan();
  }
});
$('#clearCart')?.addEventListener('click', () => {
  cart.clear();
  renderCart();
});

/* ==================== PRINT & RECEIPT ==================== */
function openPrint(title, body) {
  const w = window.open('', '_blank');
  if (!w) return notify('Izinkan pop-up peramban untuk mencetak dokumen.');
  w.document.write(`<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
@page { size: auto; margin: 10mm; }
* { box-sizing: border-box; }
body { font: 12px 'Courier New', Courier, monospace; color: #111; margin: 0; padding: 10px; max-width: 320px; }
.header { text-align: center; border-bottom: 1px dashed #444; padding-bottom: 10px; margin-bottom: 10px; }
.brand { font-size: 16px; font-weight: bold; letter-spacing: 1px; }
.meta { font-size: 11px; margin: 8px 0; }
.meta div { display: flex; justify-content: space-between; }
table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 11px; }
th { text-align: left; border-bottom: 1px dashed #444; padding: 4px 0; }
td { padding: 4px 0; }
td.num, th.num { text-align: right; }
.totals { border-top: 1px dashed #444; padding-top: 8px; margin-top: 6px; }
.totals div { display: flex; justify-content: space-between; margin: 3px 0; }
.totals .grand { font-size: 14px; font-weight: bold; margin-top: 5px; border-top: 1px solid #111; padding-top: 4px; }
.footer { text-align: center; margin-top: 18px; font-size: 10px; border-top: 1px dashed #444; padding-top: 8px; }
.no-print { margin: 15px 0; width: 100%; padding: 8px; background: #071a2b; color: white; border: 0; border-radius: 4px; font-family: sans-serif; cursor: pointer; }
@media print { .no-print { display: none; } body { padding: 0; } }
</style>
</head>
<body>
${body}
<button class="no-print" onclick="window.print()">Cetak / Simpan PDF</button>
</body>
</html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 350);
}

function printReceipt(s) {
  const items = s.items.map(i => `
    <tr>
      <td colspan="3"><b>${esc(i.name)}</b><br><small>${esc(i.sku)}</small></td>
    </tr>
    <tr>
      <td>${i.quantity} × ${rupiah(i.unit_price)}</td>
      <td class="num" colspan="2">${rupiah(i.line_total)}</td>
    </tr>`).join('');

  openPrint(`Struk ${s.invoice_no}`, `
    <div class="header">
      <div class="brand">HOWELL STOCKFLOW</div>
      <div style="font-size:10px;margin-top:2px">Official Exhibition Store</div>
    </div>
    <div class="meta">
      <div><span>No. Invoice:</span><b>${esc(s.invoice_no)}</b></div>
      <div><span>Waktu:</span><span>${timeFmt(s.sold_at)} WIB</span></div>
      <div><span>Pelanggan:</span><span>${esc(s.customer_name)}</span></div>
      <div><span>Metode:</span><span>${esc(s.payment_method)}</span></div>
      <div><span>Lokasi:</span><span>${esc(s.location)}</span></div>
      <div><span>Kasir:</span><span>${esc(s.user_name)}</span></div>
    </div>
    <table>
      <thead><tr><th colspan="3">Daftar Barang</th></tr></thead>
      <tbody>${items}</tbody>
    </table>
    <div class="totals">
      <div><span>Subtotal:</span><span>${rupiah(s.subtotal)}</span></div>
      ${s.discount > 0 ? `<div><span>Diskon:</span><span>- ${rupiah(s.discount)}</span></div>` : ''}
      <div class="grand"><span>TOTAL:</span><span>${rupiah(s.total)}</span></div>
    </div>
    <div class="footer">
      <p>Terima kasih atas kunjungan Anda.<br>Barang yang sudah dibeli tidak dapat ditukar kecuali perjanjian.</p>
    </div>`);
}

$('#completeSale')?.addEventListener('click', async () => {
  const items = [...cart.values()];
  if (!items.length) return;
  const subtotal = items.reduce((n, x) => n + x.quantity * x.unit_price, 0);
  const discount = Math.max(0, Number($('#saleDiscount')?.value || 0));
  const total = Math.max(0, subtotal - discount);
  const payment = $('#salePayment').value;
  const cash = Number($('#saleCash')?.value || 0);

  if (payment === 'Tunai' && cash > 0 && cash < total) {
    return notify(`Uang tunai diterima (${rupiah(cash)}) kurang dari total tagihan (${rupiah(total)}).`);
  }

  if (!confirm(`Selesaikan penjualan ${items.reduce((n, x) => n + x.quantity, 0)} unit dengan total ${rupiah(total)}?`)) return;

  try {
    const created = await api('/api/sales', {
      method: 'POST',
      body: JSON.stringify({
        items: items.map(x => ({ product_id: x.id, quantity: x.quantity, unit_price: x.unit_price })),
        customer_name: $('#saleCustomer').value.trim() || 'Pelanggan',
        payment_method: payment,
        discount,
        user_name: 'Admin Howell'
      })
    });
    const sale = await api('/api/sales/' + created.id);
    cart.clear();
    renderCart();
    $('#saleCustomer').value = '';
    $('#saleDiscount').value = '0';
    $('#saleCash').value = '';
    notify('Penjualan tersimpan; stok dan ledger berhasil diperbarui.');
    printReceipt(sale);
    loadDashboard();
  } catch (e) { notify(e.message); }
});

/* ==================== RIWAYAT PENJUALAN ==================== */
async function loadSales() {
  try {
    const qs = new URLSearchParams({ from: $('#salesFrom').value, to: $('#salesTo').value });
    const rows = await api('/api/sales?' + qs);
    $('#salesCount').textContent = rows.length + ' transaksi';
    $('#salesRows').innerHTML = rows.length ? rows.map(s => `
      <tr>
        <td>${timeFmt(s.sold_at)} WIB</td>
        <td><b>${esc(s.invoice_no)}</b></td>
        <td>${esc(s.customer_name)}</td>
        <td>${s.item_count} SKU · ${s.unit_count} unit</td>
        <td>${esc(s.payment_method)}</td>
        <td><b>${rupiah(s.total)}</b></td>
        <td><button class="button secondary" data-receipt="${s.id}">Struk PDF</button></td>
      </tr>`).join('') : '<tr><td colspan="7" class="empty-row">Belum ada transaksi penjualan pada rentang tanggal ini.</td></tr>';

    $$('[data-receipt]').forEach(b => b.onclick = async () => {
      try {
        printReceipt(await api('/api/sales/' + b.dataset.receipt));
      } catch (e) { notify(e.message); }
    });
  } catch (e) { notify(e.message); }
}

$('#filterSales')?.addEventListener('click', loadSales);

$('#exportSales')?.addEventListener('click', () => {
  const qs = new URLSearchParams({ from: $('#salesFrom')?.value || '', to: $('#salesTo')?.value || '' });
  window.open('/api/sales/export?' + qs, '_blank');
});

$('#printSalesHistory')?.addEventListener('click', async () => {
  try {
    const qs = new URLSearchParams({ from: $('#salesFrom').value, to: $('#salesTo').value });
    const rows = await api('/api/sales?' + qs);
    const total = rows.reduce((n, s) => n + s.total, 0);
    const body = rows.map(s => `
      <tr>
        <td>${timeFmt(s.sold_at)} WIB</td>
        <td>${esc(s.invoice_no)}</td>
        <td>${esc(s.customer_name)}</td>
        <td>${esc(s.payment_method)}</td>
        <td class="num">${s.unit_count}</td>
        <td class="num">${rupiah(s.total)}</td>
      </tr>`).join('');

    const w = window.open('', '_blank');
    if (!w) return notify('Izinkan pop-up peramban.');
    w.document.write(`<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<title>Laporan Penjualan Howell</title>
<style>
@page { size: A4 landscape; margin: 14mm; }
body { font: 12px Arial, sans-serif; color: #182330; margin: 0; padding: 20px; }
h1 { font-size: 20px; margin: 0 0 5px; }
.muted { color: #697783; }
.brand { font-weight: 800; letter-spacing: 2px; color: #071a2b; margin-bottom: 20px; }
table { width: 100%; border-collapse: collapse; margin-top: 16px; }
th { text-align: left; background: #f2f4f6; font-size: 11px; padding: 8px; border-bottom: 1px solid #dfe4e8; }
td { padding: 8px; border-bottom: 1px solid #dfe4e8; font-size: 11px; }
td.num, th.num { text-align: right; }
.total-box { margin-top: 20px; margin-left: auto; width: 300px; display: flex; justify-content: space-between; font-size: 16px; font-weight: bold; border-top: 2px solid #071a2b; padding-top: 8px; }
.no-print { margin: 20px 0; padding: 8px 15px; background: #071a2b; color: #fff; border: 0; border-radius: 4px; cursor: pointer; }
@media print { .no-print { display: none; } body { padding: 0; } }
</style>
</head>
<body>
<div class="brand">HOWELL STOCKFLOW</div>
<h1>REKAPITULASI PENJUALAN PAMERAN</h1>
<p class="muted">Periode: ${$('#salesFrom').value || 'Semua'} s/d ${$('#salesTo').value || 'Hari ini'} · Total ${rows.length} transaksi</p>
<table>
  <thead>
    <tr><th>Waktu</th><th>Invoice</th><th>Pelanggan</th><th>Pembayaran</th><th class="num">Unit</th><th class="num">Total (Rp)</th></tr>
  </thead>
  <tbody>${body || '<tr><td colspan="6" style="text-align:center">Tidak ada transaksi.</td></tr>'}</tbody>
</table>
<div class="total-box">
  <span>TOTAL OMSET</span>
  <span>${rupiah(total)}</span>
</div>
<button class="no-print" onclick="window.print()">Cetak / Simpan PDF</button>
</body>
</html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 350);
  } catch (e) { notify(e.message); }
});

/* ==================== INISIALISASI ==================== */
loadDashboard();
