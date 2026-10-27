// Howell StockFlow 2.1 Enterprise - POS, Cashier Tracking, PDF/WA Invoices, Daily Reconciliation
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupiah = n => 'Rp\u00a0' + Number(n || 0).toLocaleString('id-ID');

function timeFmt(s) {
  if (!s) return '—';
  try {
    const d = new Date(String(s).replace(' ', 'T') + 'Z');
    return new Intl.DateTimeFormat('id-ID', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta'
    }).format(d);
  } catch (e) {
    return String(s);
  }
}

function dateWib(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
  return parts; // Returns YYYY-MM-DD
}

function normalizePhone(raw) {
  let cleaned = String(raw || '').replace(/\D/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('08')) cleaned = '628' + cleaned.slice(2);
  else if (cleaned.startsWith('8')) cleaned = '628' + cleaned.slice(1);
  return cleaned;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Permintaan gagal diproses.');
  return data;
}

let toastTimer;
function notify(message) {
  const node = $('#toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3200);
}

/* ==================== USER & CASHIER SYSTEM ==================== */
let allUsers = [];
let activeUser = { id: 1, name: 'Admin Howell', role: 'admin' };

async function initUsers() {
  try {
    allUsers = await api('/api/users');
    const savedId = Number(localStorage.getItem('howell_active_cashier_id'));
    if (savedId) {
      const found = allUsers.find(u => u.id === savedId && u.active);
      if (found) activeUser = { id: found.id, name: found.name, role: found.role };
    }
    updateUserDisplay();
    populateCashierSelects();
  } catch (e) {
    console.error('Gagal memuat pengguna:', e);
  }
}

function updateUserDisplay() {
  const initials = activeUser.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'HW';
  if ($('#currentCashierName')) $('#currentCashierName').textContent = activeUser.name;
  if ($('#currentCashierRole')) {
    $('#currentCashierRole').textContent = activeUser.role === 'admin'
      ? `Administrator (ID: ${activeUser.id})`
      : `Kasir Aktif (ID: ${activeUser.id})`;
  }
  if ($('#currentAvatar')) $('#currentAvatar').textContent = initials;
  if ($('#topCashierName')) $('#topCashierName').textContent = activeUser.name;
  if ($('#topAvatar')) $('#topAvatar').textContent = initials;
  if ($('#closeReconciledBy') && !$('#closeReconciledBy').value) {
    $('#closeReconciledBy').value = activeUser.name;
  }
}

function populateCashierSelects() {
  const options = allUsers.map(u =>
    `<option value="${u.id}">${esc(u.name)} (${u.role === 'admin' ? 'Admin' : 'Kasir'})</option>`
  ).join('');

  if ($('#saleCashierSelect')) {
    $('#saleCashierSelect').innerHTML = options;
    $('#saleCashierSelect').value = String(activeUser.id);
  }
  if ($('#salesCashierFilter')) {
    $('#salesCashierFilter').innerHTML = '<option value="">Semua Kasir</option>' + options;
  }
  if ($('#closeCashierSelect')) {
    $('#closeCashierSelect').innerHTML = options;
    $('#closeCashierSelect').value = String(activeUser.id);
  }
}

function showUserSwitcherModal() {
  modal('Ganti Kasir Bertugas', `
    <div style="font-size:12px;color:#556575;margin-bottom:12px">
      Pilih akun kasir yang sedang aktif melayani transaksi kasir dan rekonsiliasi operasional:
    </div>
    <div style="display:flex;flex-direction:column;gap:8px" id="userRadioList">
      ${allUsers.map(u => `
        <label style="display:flex;align-items:center;gap:12px;padding:10px 14px;border:1px solid ${u.id === activeUser.id ? 'var(--navy)' : '#e2e8f0'};border-radius:6px;background:${u.id === activeUser.id ? '#f0f5fa' : '#fff'};cursor:pointer">
          <input type="radio" name="selected_user" value="${u.id}" ${u.id === activeUser.id ? 'checked' : ''}>
          <div style="flex:1">
            <b>${esc(u.name)}</b>
            <div style="font-size:10px;color:#718096">${u.role === 'admin' ? 'Administrator Sistem' : 'Staf Kasir Pameran'} · ID: ${u.id}</div>
          </div>
          ${u.id === activeUser.id ? '<span style="font-size:10px;font-weight:700;color:var(--navy);background:#e2ebf5;padding:2px 8px;border-radius:10px">Aktif</span>' : ''}
        </label>
      `).join('')}
    </div>
  `, 'Terapkan Kasir', async d => {
    const selectedId = Number(d.selected_user);
    const chosen = allUsers.find(u => u.id === selectedId);
    if (!chosen) throw new Error('Pilih salah satu kasir.');
    activeUser = { id: chosen.id, name: chosen.name, role: chosen.role };
    localStorage.setItem('howell_active_cashier_id', String(chosen.id));
    updateUserDisplay();
    populateCashierSelects();
    notify(`Beralih ke kasir: ${chosen.name}`);
  });
}

$('#userSwitcher')?.addEventListener('click', showUserSwitcherModal);
$('#topCashierChip')?.addEventListener('click', showUserSwitcherModal);

/* ==================== PAGE NAVIGATION ==================== */
const titles = {
  dashboard: 'Dashboard',
  scan: 'Kasir / Scan Transaksi',
  sales: 'Riwayat Penjualan & Invoice',
  reconciliation: 'Rekonsiliasi Pendapatan Harian',
  closing: 'Penutupan Kasir Harian',
  products: 'Produk & SKU',
  import: 'Import Excel Gudang',
  verification: 'Stok Perlu Verifikasi',
  movements: 'Pergerakan Stok'
};

function showPage(name) {
  $$('.page').forEach(n => n.classList.add('hidden'));
  const target = $('#' + name + 'Page');
  if (target) target.classList.remove('hidden');
  $$('.nav').forEach(n => n.classList.toggle('active', n.dataset.page === name));
  if ($('#crumb')) $('#crumb').textContent = titles[name] || name;

  const loaders = {
    dashboard: loadDashboard,
    scan: () => {
      setTimeout(() => $('#barcodeInput')?.focus(), 80);
      updateCartTotals();
    },
    sales: loadSales,
    reconciliation: () => loadReconciliation(),
    closing: () => loadClosing(),
    products: () => loadProducts($('#productSearch')?.value || ''),
    import: loadImport,
    verification: loadVerification,
    movements: loadMovements
  };
  loaders[name]?.();
}

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-page]');
  if (btn) {
    e.preventDefault();
    showPage(btn.dataset.page);
  }
});

if ($('#today')) {
  $('#today').textContent = new Intl.DateTimeFormat('id-ID', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta'
  }).format(new Date());
}

/* ==================== MODAL SYSTEM ==================== */
function modal(title, body, submitLabel, onSubmit) {
  const host = $('#modalHost');
  host.innerHTML = `
    <div class="modal-backdrop">
      <form class="modal">
        <div class="modal-head">
          <h2>${title}</h2>
          <button type="button" class="modal-close">×</button>
        </div>
        <div class="modal-body">${body}</div>
        <div class="modal-actions">
          <button type="button" class="button secondary modal-close">Batal</button>
          <button class="button primary" type="submit">${submitLabel}</button>
        </div>
      </form>
    </div>`;
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

/* ==================== POS / KASIR / SCAN ==================== */
const cart = new Map();

function updateCartTotals() {
  const rows = [...cart.values()];
  const subtotal = rows.reduce((n, x) => n + x.quantity * x.unit_price, 0);
  const discount = Math.max(0, Number($('#saleDiscount')?.value || 0));
  const total = Math.max(0, subtotal - discount);
  const payment = $('#salePayment')?.value || 'Tunai';
  const cash = Number($('#saleCash')?.value || 0);

  if ($('#cartSubtotal')) $('#cartSubtotal').textContent = rupiah(subtotal);
  if ($('#cartDiscountDisp')) {
    $('#cartDiscountDisp').textContent = '- ' + rupiah(discount);
    if ($('#discountRow')) $('#discountRow').style.display = discount > 0 ? 'flex' : 'none';
  }
  if ($('#cartTotal')) $('#cartTotal').textContent = rupiah(total);

  const cashField = $('#cashField');
  const changeRow = $('#changeRow');
  const edcQrisField = $('#edcQrisField');
  const confirmationField = $('#confirmationField');

  if (payment === 'Tunai') {
    if (cashField) cashField.style.display = 'flex';
    if (changeRow) changeRow.style.display = 'flex';
    if (edcQrisField) edcQrisField.style.display = 'none';
    if (confirmationField) confirmationField.style.display = 'none';

    const change = cash - total;
    if ($('#cartChange')) {
      if (cash > 0) {
        $('#cartChange').textContent = change >= 0 ? rupiah(change) : 'Kurang ' + rupiah(Math.abs(change));
        $('#cartChange').style.color = change >= 0 ? 'var(--green)' : 'var(--red)';
      } else {
        $('#cartChange').textContent = 'Rp\u00a00';
        $('#cartChange').style.color = 'inherit';
      }
    }
  } else {
    if (cashField) cashField.style.display = 'none';
    if (changeRow) changeRow.style.display = 'none';
    if (edcQrisField) edcQrisField.style.display = 'block';
    if (confirmationField) confirmationField.style.display = 'block';
  }

  if ($('#completeSale')) $('#completeSale').disabled = !rows.length;
}

function renderCart() {
  const rows = [...cart.values()];
  if ($('#cartCount')) {
    $('#cartCount').textContent = rows.reduce((n, x) => n + x.quantity, 0) + ' unit · ' + rows.length + ' SKU';
  }
  if ($('#cartRows')) {
    $('#cartRows').innerHTML = rows.length ? rows.map(x => `
      <tr>
        <td>
          <b>${esc(x.name)}</b>
          <br><small class="muted">${esc(x.sku)}${x.panjang ? ` · ${esc(x.panjang)}` : ''}</small>
        </td>
        <td>
          <button class="qty-action" data-qty="${x.id}" data-delta="-1">−</button>
          <span style="font-weight:700;padding:0 4px">${x.quantity}</span>
          <button class="qty-action" data-qty="${x.id}" data-delta="1">+</button>
        </td>
        <td>
          <input class="cart-price" type="number" min="0" step="1000" data-price="${x.id}" value="${x.unit_price}" aria-label="Harga satuan ${esc(x.sku)}">
        </td>
        <td><b>${rupiah(x.unit_price * x.quantity)}</b></td>
        <td><button class="row-action" data-remove="${x.id}" aria-label="Hapus ${esc(x.sku)}">×</button></td>
      </tr>`).join('') : '<tr><td colspan="5" class="empty-row">Scan barcode atau masukkan SKU untuk mulai transaksi.</td></tr>';
  }

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
      $('#scanResult').innerHTML = `
        <div class="empty-result">
          <div>⌕</div>
          <b>Produk tidak ditemukan</b>
          <span>"${esc(code)}" belum terdaftar di katalog produk.</span>
        </div>`;
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
        panjang: p.panjang || '',
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
        <div class="result-meta">${esc(p.sku)}${p.panjang ? ` · ${esc(p.panjang)}` : ''} · ${esc(p.barcode || 'Tanpa barcode')}</div>
        ${flagged ? `<div class="verify-warn">Penanda verifikasi sumber aktif. Transaksi tetap dapat dilanjutkan.</div>` : ''}
        <div class="result-details">
          <div><small>STOK TERSEDIA</small><b>${available} ${esc(p.unit)}</b></div>
          <div><small>HARGA SATUAN</small><b>${rupiah(cart.get(p.id).unit_price)}</b></div>
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
  if (!cart.size) return;
  if (confirm('Kosongkan keranjang belanja?')) {
    cart.clear();
    renderCart();
  }
});

$('#completeSale')?.addEventListener('click', async () => {
  const items = [...cart.values()];
  if (!items.length) return notify('Keranjang belanja masih kosong.');

  const subtotal = items.reduce((n, x) => n + x.quantity * x.unit_price, 0);
  const discount = Math.max(0, Number($('#saleDiscount')?.value || 0));
  const total = Math.max(0, subtotal - discount);
  const paymentMethod = $('#salePayment').value;
  const cash = Number($('#saleCash')?.value || 0);

  if (paymentMethod === 'Tunai' && cash < total) {
    return notify(`Nominal tunai diterima (${rupiah(cash)}) kurang dari total tagihan (${rupiah(total)}).`);
  }

  const cashierId = Number($('#saleCashierSelect')?.value || activeUser.id);
  const selectedCashier = allUsers.find(u => u.id === cashierId) || activeUser;
  const isConfirmed = $('#paymentConfirmed')?.checked ?? true;
  const paymentStatus = (paymentMethod !== 'Tunai' && !isConfirmed) ? 'MENUNGGU_PEMBAYARAN' : 'LUNAS';

  const customerName = $('#saleCustomer')?.value.trim() || 'Pelanggan';
  const customerPhone = $('#salePhone')?.value.trim() || '';
  const paymentRef = $('#salePaymentRef')?.value.trim() || '';
  const notes = $('#saleNotes')?.value.trim() || '';

  const confirmMsg = paymentStatus === 'MENUNGGU_PEMBAYARAN'
    ? `Selesaikan transaksi ${items.length} item (${rupiah(total)}) dengan status MENUNGGU PEMBAYARAN ${paymentMethod}?`
    : `Selesaikan penjualan ${items.length} item (${rupiah(total)}) via ${paymentMethod}?`;

  if (!confirm(confirmMsg)) return;

  try {
    const created = await api('/api/sales', {
      method: 'POST',
      body: JSON.stringify({
        items: items.map(x => ({ product_id: x.id, quantity: x.quantity, unit_price: x.unit_price })),
        customer_name: customerName,
        customer_phone: customerPhone,
        payment_method: paymentMethod,
        payment_status: paymentStatus,
        payment_ref: paymentRef,
        discount,
        amount_paid: paymentMethod === 'Tunai' ? cash : total,
        change_amount: paymentMethod === 'Tunai' ? Math.max(0, cash - total) : 0,
        notes,
        cashier_id: selectedCashier.id,
        user_name: selectedCashier.name
      })
    });

    const sale = await api('/api/sales/' + created.id);

    // Reset Form
    cart.clear();
    renderCart();
    if ($('#saleCustomer')) $('#saleCustomer').value = '';
    if ($('#salePhone')) $('#salePhone').value = '';
    if ($('#saleDiscount')) $('#saleDiscount').value = '0';
    if ($('#saleCash')) $('#saleCash').value = '';
    if ($('#salePaymentRef')) $('#salePaymentRef').value = '';
    if ($('#saleNotes')) $('#saleNotes').value = '';
    if ($('#paymentConfirmed')) $('#paymentConfirmed').checked = true;

    notify('Transaksi berhasil disimpan!');
    showInvoiceModal(sale);
    loadDashboard();
  } catch (e) {
    notify(e.message);
  }
});

/* ==================== PROFESSIONAL INVOICE & PRINT SYSTEM ==================== */
function getPaymentStatusBadge(status) {
  if (status === 'LUNAS') return '<span class="status-badge paid">LUNAS</span>';
  if (status === 'MENUNGGU_PEMBAYARAN') return '<span class="status-badge pending">MENUNGGU PEMBAYARAN</span>';
  if (status === 'DIBATALKAN') return '<span class="status-badge cancelled">DIBATALKAN</span>';
  return `<span class="status-badge">${esc(status)}</span>`;
}

function showInvoiceModal(s) {
  const host = $('#modalHost');
  const itemsRows = (s.items || []).map((it, idx) => `
    <tr>
      <td style="text-align:center">${idx + 1}</td>
      <td><b>${esc(it.sku)}</b></td>
      <td>${esc(it.name)}</td>
      <td style="text-align:center">${esc(it.panjang || '—')}</td>
      <td style="text-align:center"><b>${it.quantity}</b></td>
      <td class="num">${rupiah(it.unit_price)}</td>
      <td class="num"><b>${rupiah(it.line_total)}</b></td>
    </tr>
  `).join('');

  host.innerHTML = `
    <div class="modal-backdrop">
      <div class="invoice-modal-content">
        <div class="invoice-paper" id="invoicePaperArea">
          <!-- Header -->
          <div class="invoice-top">
            <div class="inv-brand-box">
              <div class="inv-mark">
                <i></i><i style="height:12px"></i><i></i>
              </div>
              <div class="inv-company">
                <h2>HOWELL OFFICIAL STORE</h2>
                <p>PT Howell Niaga Indonesia · Official Exhibition Store</p>
                <p style="color:#8a99a8">Kabel Audio Video, Adapter & Aksesoris Premium</p>
              </div>
            </div>
            <div class="inv-meta-right">
              <h1 class="inv-title">INVOICE</h1>
              <div class="inv-no">${esc(s.invoice_no)}</div>
              <div style="font-size:10px;color:#788696;margin-top:4px">${timeFmt(s.sold_at)} WIB</div>
            </div>
          </div>

          <!-- Transaction details -->
          <div class="inv-details-grid">
            <div>
              <small>Kasir yang Memproses</small>
              <b>${esc(s.cashier_name || s.user_name || 'Admin Howell')} <span style="font-weight:400;color:#718096">(ID: ${s.cashier_id || 1})</span></b>
            </div>
            <div>
              <small>Nama Pelanggan</small>
              <b>${esc(s.customer_name || 'Pelanggan Tunai')}</b>
            </div>
            <div>
              <small>Metode Pembayaran</small>
              <b>${esc(s.payment_method)}</b>
            </div>
            <div>
              <small>No. WhatsApp / Telepon</small>
              <b>${esc(s.customer_phone || '—')}</b>
            </div>
            <div>
              <small>Status Pembayaran</small>
              <div>${getPaymentStatusBadge(s.payment_status)}</div>
            </div>
            <div>
              <small>Status Transaksi</small>
              <b style="color:${s.transaction_status === 'CANCELLED' ? 'var(--red)' : 'var(--green)'}">${s.transaction_status === 'CANCELLED' ? 'DIBATALKAN' : 'SELESAI (COMPLETED)'}</b>
            </div>
            ${s.payment_ref ? `
              <div style="grid-column:span 2">
                <small>Referensi Pembayaran / Approval Code EDC / QRIS</small>
                <b style="font-family:monospace;letter-spacing:1px">${esc(s.payment_ref)}</b>
              </div>
            ` : ''}
            ${s.notes ? `
              <div style="grid-column:span 2">
                <small>Catatan Transaksi</small>
                <span style="color:#4a5568">${esc(s.notes)}</span>
              </div>
            ` : ''}
          </div>

          <!-- Items Table -->
          <table class="invoice-items-table">
            <thead>
              <tr>
                <th style="width:30px;text-align:center">NO</th>
                <th style="width:90px">SKU</th>
                <th>NAMA BARANG</th>
                <th style="width:65px;text-align:center">PANJANG</th>
                <th style="width:50px;text-align:center">QTY</th>
                <th class="num" style="width:105px">HARGA</th>
                <th class="num" style="width:115px">SUBTOTAL</th>
              </tr>
            </thead>
            <tbody>
              ${itemsRows}
            </tbody>
          </table>

          <!-- Totals -->
          <div class="inv-totals-box">
            <div class="inv-tot-line">
              <span>Subtotal (${(s.items || []).reduce((n, x) => n + x.quantity, 0)} unit):</span>
              <b>${rupiah(s.subtotal)}</b>
            </div>
            ${s.discount > 0 ? `
              <div class="inv-tot-line" style="color:var(--red)">
                <span>Diskon Transaksi:</span>
                <b>- ${rupiah(s.discount)}</b>
              </div>
            ` : ''}
            <div class="inv-tot-line grand">
              <span>TOTAL TAGIHAN:</span>
              <span>${rupiah(s.total)}</span>
            </div>
            ${s.payment_method === 'Tunai' ? `
              <div class="inv-tot-line" style="margin-top:6px;font-size:11px">
                <span>Tunai Diterima:</span>
                <span>${rupiah(s.amount_paid || s.total)}</span>
              </div>
              <div class="inv-tot-line" style="font-size:11px">
                <span>Kembalian:</span>
                <span>${rupiah(s.change_amount || 0)}</span>
              </div>
            ` : ''}
          </div>

          <!-- Footer terms -->
          <div class="inv-footer">
            <p><b>Terima kasih telah berbelanja di Howell Official Store.</b></p>
            <p>Invoice ini sah diterbitkan secara elektronik oleh sistem Howell StockFlow. Simpan invoice ini untuk bukti garansi produk resmi Howell.</p>
          </div>
        </div>

        <!-- WhatsApp Helper Notification (Hidden by default, shown upon WA share) -->
        <div id="waHelperBox" style="display:none;margin:0 30px">
          <div class="wa-helper-card">
            <b>WhatsApp Berhasil Dibuka!</b>
            Format pesan transaksi sudah disiapkan di tab WhatsApp. Untuk melampirkan berkas invoice asli, klik tombol <b>"Download PDF"</b> di samping lalu kirimkan berkas PDF yang terunduh kepada pelanggan.
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="inv-actions-footer">
          <div class="inv-btn-group">
            <button class="button secondary" id="btnPreviewInvoice" title="Tampilkan tampilan penuh invoice">👁 <span>Preview</span></button>
            <button class="button secondary wa-open-btn" id="btnShareWhatsApp" title="Kirim rincian invoice via WhatsApp">📱 <span>Share via WhatsApp</span></button>
          </div>
          <div class="inv-btn-group">
            <button class="button secondary" id="btnReprintInvoice" title="Cetak ulang struk / invoice">↻ <span>Cetak Ulang</span></button>
            <button class="button secondary" id="btnDownloadPdf" title="Simpan sebagai dokumen PDF">⤓ <span>Download PDF</span></button>
            <button class="button primary" id="btnPrintInvoice">🖨 <span>Print Invoice</span></button>
            <button class="button secondary" id="btnCloseInvoiceModal">Tutup</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // Bind Actions
  $('#btnCloseInvoiceModal').onclick = () => host.innerHTML = '';
  host.querySelector('.modal-backdrop').onclick = e => {
    if (e.target.classList.contains('modal-backdrop')) host.innerHTML = '';
  };

  $('#btnPrintInvoice').onclick = () => printInvoiceDocument(s, 'A4');
  $('#btnDownloadPdf').onclick = () => printInvoiceDocument(s, 'PDF');
  $('#btnReprintInvoice').onclick = () => printInvoiceDocument(s, 'A4');

  $('#btnPreviewInvoice').onclick = () => {
    const paper = $('#invoicePaperArea');
    if (paper) {
      paper.scrollIntoView({ behavior: 'smooth', block: 'start' });
      paper.style.transition = 'box-shadow 0.3s ease';
      paper.style.boxShadow = '0 0 0 3px var(--yellow)';
      setTimeout(() => paper.style.boxShadow = 'none', 1200);
    }
  };

  $('#btnShareWhatsApp').onclick = () => shareInvoiceWhatsApp(s);
}

function shareInvoiceWhatsApp(s) {
  let phone = normalizePhone(s.customer_phone);
  if (!phone || phone.length < 9) {
    const promptVal = prompt('Masukkan nomor WhatsApp pelanggan (contoh: 08123456789):', s.customer_phone || '');
    if (!promptVal) return;
    phone = normalizePhone(promptVal);
    if (!phone || phone.length < 9) {
      return notify('Nomor WhatsApp tidak valid. Gunakan format nomor seluler Indonesia.');
    }
  }

  const itemsText = (s.items || []).map((it, idx) =>
    `${idx + 1}. ${it.name}${it.panjang ? ` (${it.panjang})` : ''} [${it.sku}] - ${it.quantity}x @ ${rupiah(it.unit_price)} = ${rupiah(it.line_total)}`
  ).join('\n');

  const message = [
    `*HOWELL OFFICIAL STORE*`,
    `PT Howell Niaga Indonesia`,
    ``,
    `Halo *${s.customer_name || 'Pelanggan'}*, terima kasih telah berbelanja di official booth Howell!`,
    ``,
    `Berikut rincian transaksi pembelian Anda:`,
    `📄 *No. Invoice:* ${s.invoice_no}`,
    `📅 *Tanggal:* ${timeFmt(s.sold_at)} WIB`,
    `👤 *Kasir:* ${s.cashier_name || s.user_name || 'Admin'}`,
    `💳 *Metode Bayar:* ${s.payment_method}`,
    `📌 *Status Pembayaran:* ${s.payment_status}`,
    s.payment_ref ? `🔑 *Ref/Approval:* ${s.payment_ref}` : '',
    ``,
    `*DAFTAR BARANG:*`,
    itemsText,
    `━━━━━━━━━━━━━━━━━━━━`,
    `Subtotal: ${rupiah(s.subtotal)}`,
    s.discount > 0 ? `Diskon: - ${rupiah(s.discount)}` : '',
    `*TOTAL PEMBAYARAN: ${rupiah(s.total)}*`,
    `━━━━━━━━━━━━━━━━━━━━`,
    s.payment_method === 'Tunai' ? `Tunai Diterima: ${rupiah(s.amount_paid || s.total)}\nKembalian: ${rupiah(s.change_amount || 0)}\n` : '',
    `Simpan bukti invoice ini untuk klaim garansi resmi Howell.`,
    `Untuk berkas PDF lengkap, staf kasir kami dapat mengirimkannya melalui chat ini.`
  ].filter(line => line !== '').join('\n');

  const waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  window.open(waUrl, '_blank');

  const helperBox = $('#waHelperBox');
  if (helperBox) helperBox.style.display = 'block';
  notify('Jendela WhatsApp telah dibuka.');
}

function printInvoiceDocument(s, mode = 'A4') {
  const w = window.open('', '_blank');
  if (!w) return notify('Izinkan pop-up browser untuk mencetak / menyimpan PDF invoice.');

  const itemsRows = (s.items || []).map((it, idx) => `
    <tr>
      <td style="text-align:center">${idx + 1}</td>
      <td><b>${esc(it.sku)}</b></td>
      <td>${esc(it.name)}</td>
      <td style="text-align:center">${esc(it.panjang || '—')}</td>
      <td style="text-align:center"><b>${it.quantity}</b></td>
      <td class="num">${rupiah(it.unit_price)}</td>
      <td class="num"><b>${rupiah(it.line_total)}</b></td>
    </tr>
  `).join('');

  const docTitle = `Invoice-${s.invoice_no}`;

  w.document.write(`<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<title>${esc(docTitle)}</title>
<style>
  @page { size: A4 portrait; margin: 15mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #182330; margin: 0; padding: 20px; font-size: 11px; }
  .inv-header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #071a2b; padding-bottom: 14px; margin-bottom: 14px; }
  .inv-brand { display: flex; align-items: center; gap: 10px; }
  .inv-mark { width: 32px; height: 32px; background: #071a2b; border-radius: 6px; display: flex; align-items: center; justify-content: center; gap: 2px; }
  .inv-mark i { width: 3px; height: 16px; background: #f5c518; border-radius: 1px; }
  .inv-comp h2 { margin: 0; font-size: 16px; font-weight: 800; color: #071a2b; letter-spacing: 0.5px; }
  .inv-comp p { margin: 2px 0 0; font-size: 10px; color: #687786; }
  .inv-right { text-align: right; }
  .inv-right h1 { margin: 0 0 4px; font-size: 22px; font-weight: 800; color: #071a2b; }
  .inv-right .no { font-size: 12px; font-weight: 700; color: #2d3748; }
  .inv-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 14px; margin-bottom: 16px; }
  .inv-grid div { display: flex; flex-direction: column; gap: 2px; }
  .inv-grid small { font-size: 9px; text-transform: uppercase; color: #718096; font-weight: 600; }
  .inv-grid b { font-size: 11px; color: #1a202c; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 11px; }
  th { background: #f1f5f9; padding: 8px 6px; text-align: left; font-size: 10px; border-bottom: 1px solid #cbd5e1; }
  td { padding: 8px 6px; border-bottom: 1px solid #e2e8f0; }
  td.num, th.num { text-align: right; }
  .totals-wrap { display: flex; justify-content: flex-end; margin-top: 14px; }
  .totals-box { width: 280px; }
  .tot-line { display: flex; justify-content: space-between; padding: 3px 0; }
  .tot-line.grand { font-size: 14px; font-weight: 800; border-top: 2px solid #071a2b; margin-top: 6px; padding-top: 6px; color: #071a2b; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-weight: 700; font-size: 10px; }
  .badge.paid { background: #e6f7ec; color: #117335; border: 1px solid #b7ebc6; }
  .badge.pending { background: #fef7e6; color: #b7791f; border: 1px solid #fbd38d; }
  .badge.cancelled { background: #feebed; color: #c53030; border: 1px solid #feb2b2; }
  .footer { margin-top: 30px; border-top: 1px dashed #cbd5e1; padding-top: 10px; font-size: 10px; color: #718096; text-align: center; }
  .no-print-bar { background: #071a2b; color: #fff; padding: 10px 16px; border-radius: 6px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; }
  .no-print-bar button { background: #f5c518; color: #071a2b; border: 0; padding: 6px 14px; border-radius: 4px; font-weight: 700; cursor: pointer; }
  @media print {
    .no-print-bar { display: none; }
    body { padding: 0; }
  }
</style>
</head>
<body>
  <div class="no-print-bar">
    <span><b>Preview Cetak & Simpan PDF:</b> ${esc(s.invoice_no)}</span>
    <button onclick="window.print()">🖨 Cetak Sekarang / Simpan PDF</button>
  </div>

  <div class="inv-header">
    <div class="inv-brand">
      <div class="inv-mark"><i></i><i style="height:10px"></i><i></i></div>
      <div class="inv-comp">
        <h2>HOWELL OFFICIAL STORE</h2>
        <p>PT Howell Niaga Indonesia · Exhibition Store</p>
      </div>
    </div>
    <div class="inv-right">
      <h1>INVOICE</h1>
      <div class="no">${esc(s.invoice_no)}</div>
      <div style="font-size:10px;color:#718096;margin-top:2px">${timeFmt(s.sold_at)} WIB</div>
    </div>
  </div>

  <div class="inv-grid">
    <div>
      <small>Kasir yang Memproses</small>
      <b>${esc(s.cashier_name || s.user_name || 'Admin')} (ID: ${s.cashier_id || 1})</b>
    </div>
    <div>
      <small>Pelanggan</small>
      <b>${esc(s.customer_name || 'Pelanggan')}</b>
    </div>
    <div>
      <small>No. WhatsApp</small>
      <b>${esc(s.customer_phone || '—')}</b>
    </div>
    <div>
      <small>Metode Pembayaran</small>
      <b>${esc(s.payment_method)}</b>
    </div>
    <div>
      <small>Status Pembayaran</small>
      <div><span class="badge ${s.payment_status === 'LUNAS' ? 'paid' : s.payment_status === 'MENUNGGU_PEMBAYARAN' ? 'pending' : 'cancelled'}">${esc(s.payment_status)}</span></div>
    </div>
    <div>
      <small>Referensi / Approval Code</small>
      <b>${esc(s.payment_ref || '—')}</b>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:30px;text-align:center">NO</th>
        <th style="width:90px">SKU</th>
        <th>NAMA BARANG</th>
        <th style="width:70px;text-align:center">PANJANG</th>
        <th style="width:50px;text-align:center">QTY</th>
        <th class="num" style="width:110px">HARGA</th>
        <th class="num" style="width:120px">SUBTOTAL</th>
      </tr>
    </thead>
    <tbody>
      ${itemsRows}
    </tbody>
  </table>

  <div class="totals-wrap">
    <div class="totals-box">
      <div class="tot-line">
        <span>Subtotal:</span>
        <b>${rupiah(s.subtotal)}</b>
      </div>
      ${s.discount > 0 ? `
        <div class="tot-line" style="color:#c53030">
          <span>Diskon:</span>
          <b>- ${rupiah(s.discount)}</b>
        </div>
      ` : ''}
      <div class="tot-line grand">
        <span>TOTAL:</span>
        <span>${rupiah(s.total)}</span>
      </div>
      ${s.payment_method === 'Tunai' ? `
        <div class="tot-line" style="font-size:10px">
          <span>Uang Diterima:</span>
          <span>${rupiah(s.amount_paid || s.total)}</span>
        </div>
        <div class="tot-line" style="font-size:10px">
          <span>Kembalian:</span>
          <span>${rupiah(s.change_amount || 0)}</span>
        </div>
      ` : ''}
    </div>
  </div>

  <div class="footer">
    <p>Terima kasih atas pembelian Anda di Howell Official Store. Bukti transaksi ini sah dan dikeluarkan secara sistem oleh Howell StockFlow.</p>
  </div>
</body>
</html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 350);
}

/* ==================== RIWAYAT PENJUALAN ==================== */
let currentSalesList = [];

async function loadSales() {
  try {
    const params = new URLSearchParams();
    const fromVal = $('#salesFrom')?.value || '';
    const toVal = $('#salesTo')?.value || '';
    const cashierVal = $('#salesCashierFilter')?.value || '';
    const methodVal = $('#salesMethodFilter')?.value || '';
    const statusVal = $('#salesStatusFilter')?.value || '';
    const searchVal = $('#salesSearch')?.value.trim() || '';

    if (fromVal) params.set('from', fromVal);
    if (toVal) params.set('to', toVal);
    if (cashierVal) params.set('cashier_id', cashierVal);
    if (methodVal) params.set('payment_method', methodVal);
    if (statusVal) params.set('payment_status', statusVal);
    if (searchVal) params.set('q', searchVal);

    currentSalesList = await api('/api/sales?' + params.toString());

    if ($('#salesCount')) {
      $('#salesCount').textContent = `${currentSalesList.length} transaksi`;
    }

    const completedTotal = currentSalesList
      .filter(s => s.payment_status === 'LUNAS' && s.transaction_status === 'COMPLETED')
      .reduce((n, s) => n + s.total, 0);

    if ($('#salesGrandTotal')) {
      $('#salesGrandTotal').textContent = `Total Omset Lunas: ${rupiah(completedTotal)}`;
    }

    if ($('#salesRows')) {
      $('#salesRows').innerHTML = currentSalesList.length ? currentSalesList.map(s => `
        <tr class="${s.transaction_status === 'CANCELLED' ? 'row-cancelled' : ''}">
          <td>
            <b>${timeFmt(s.sold_at)} WIB</b>
          </td>
          <td>
            <b style="color:var(--navy)">${esc(s.invoice_no)}</b>
            ${s.payment_ref ? `<br><small class="muted">Ref: ${esc(s.payment_ref)}</small>` : ''}
          </td>
          <td>
            <b>${esc(s.cashier_name || s.user_name || '—')}</b>
            <br><small class="muted">ID: ${s.cashier_id || 1}</small>
          </td>
          <td>
            <b>${esc(s.customer_name || 'Pelanggan')}</b>
            ${s.customer_phone ? `<br><small class="muted">📱 ${esc(s.customer_phone)}</small>` : ''}
          </td>
          <td>
            <b>${s.item_count} SKU</b> · ${s.unit_count} unit
          </td>
          <td>
            <span class="method-tag">${esc(s.payment_method)}</span>
          </td>
          <td>
            <b>${rupiah(s.total)}</b>
          </td>
          <td>
            ${getPaymentStatusBadge(s.payment_status)}
            ${s.transaction_status === 'CANCELLED' ? '<br><small style="color:var(--red);font-weight:700">DIBATALKAN</small>' : ''}
          </td>
          <td>
            <div class="row-actions-group">
              <button class="button secondary" style="padding:3px 8px;font-size:10px" data-invoice="${s.id}" title="Lihat & cetak invoice">Invoice</button>
              ${s.payment_status === 'MENUNGGU_PEMBAYARAN' && s.transaction_status !== 'CANCELLED' ? `
                <button class="button primary" style="padding:3px 8px;font-size:10px;background:var(--green)" data-confirm="${s.id}" title="Konfirmasi pembayaran QRIS / EDC">Konfirmasi Lunas</button>
              ` : ''}
              ${activeUser.role === 'admin' && s.transaction_status !== 'CANCELLED' ? `
                <button class="button secondary" style="padding:3px 6px;font-size:10px" data-correct-cashier="${s.id}" title="Koreksi kasir transaksi">Ubah Kasir</button>
              ` : ''}
              ${s.transaction_status !== 'CANCELLED' ? `
                <button class="row-action" data-cancel="${s.id}" title="Batalkan transaksi & kembalikan stok" style="color:var(--red)">✕</button>
              ` : ''}
            </div>
          </td>
        </tr>
      `).join('') : '<tr><td colspan="9" class="empty-row">Belum ada data transaksi sesuai filter.</td></tr>';
    }

    // Bind row action listeners
    $$('[data-invoice]').forEach(b => b.onclick = async () => {
      try {
        const sale = await api('/api/sales/' + b.dataset.invoice);
        showInvoiceModal(sale);
      } catch (e) {
        notify(e.message);
      }
    });

    $$('[data-confirm]').forEach(b => b.onclick = async () => {
      const id = b.dataset.confirm;
      const ref = prompt('Masukkan Kode Approval EDC / Ref ID QRIS (Opsional):');
      if (ref === null) return;
      try {
        await api(`/api/sales/${id}/confirm-payment`, {
          method: 'POST',
          body: JSON.stringify({ payment_ref: ref.trim(), user_name: activeUser.name })
        });
        notify('Pembayaran transaksi berhasil dikonfirmasi LUNAS.');
        loadSales();
        loadDashboard();
      } catch (e) {
        notify(e.message);
      }
    });

    $$('[data-cancel]').forEach(b => b.onclick = async () => {
      const id = b.dataset.cancel;
      const reason = prompt('Masukkan alasan pembatalan transaksi (stok akan otomatis dikembalikan):');
      if (!reason?.trim()) {
        if (reason !== null) notify('Alasan pembatalan wajib diisi.');
        return;
      }
      if (!confirm('Yakin membatalkan transaksi ini? Stok seluruh produk dalam invoice ini akan dikembalikan ke saldo pameran.')) return;
      try {
        await api(`/api/sales/${id}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ reason: reason.trim(), user_name: activeUser.name, cashier_id: activeUser.id })
        });
        notify('Transaksi dibatalkan. Stok barang berhasil dikembalikan.');
        loadSales();
        loadDashboard();
      } catch (e) {
        notify(e.message);
      }
    });

    $$('[data-correct-cashier]').forEach(b => b.onclick = () => {
      const id = b.dataset.correctCashier;
      const optionsHtml = allUsers.map(u => `<option value="${u.id}">${esc(u.name)} (${u.role})</option>`).join('');
      modal('Koreksi Data Kasir Transaksi', `
        <div class="field full">
          <label>Pilih Kasir yang Seharusnya Memproses Transaksi *</label>
          <select name="new_cashier_id">${optionsHtml}</select>
        </div>
        <div class="field full">
          <label>Alasan Koreksi Kasir (Audit Trail) *</label>
          <input name="reason" required placeholder="Contoh: Kasir lupa mengganti shift saat melayani">
        </div>
      `, 'Simpan Koreksi', async d => {
        await api(`/api/sales/${id}/correct-cashier`, {
          method: 'POST',
          body: JSON.stringify({
            cashier_id: Number(d.new_cashier_id),
            reason: d.reason.trim(),
            user_name: activeUser.name
          })
        });
        notify('Data kasir transaksi berhasil dikoreksi.');
        loadSales();
      });
    });

  } catch (e) {
    notify(e.message);
  }
}

// Quick Date Chips in Riwayat Penjualan
$$('.sales-filter-bar .chip-btn').forEach(b => b.onclick = () => {
  $$('.sales-filter-bar .chip-btn').forEach(c => c.classList.remove('active'));
  b.classList.add('active');
  const period = b.dataset.period;
  const todayStr = dateWib();

  if (period === 'today') {
    $('#salesFrom').value = todayStr;
    $('#salesTo').value = todayStr;
  } else if (period === 'yesterday') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const yestStr = dateWib(d);
    $('#salesFrom').value = yestStr;
    $('#salesTo').value = yestStr;
  } else {
    $('#salesFrom').value = '';
    $('#salesTo').value = '';
  }
  loadSales();
});

$('#filterSales')?.addEventListener('click', loadSales);
$('#salesSearch')?.addEventListener('input', () => {
  clearTimeout(window._searchSalesTimer);
  window._searchSalesTimer = setTimeout(loadSales, 300);
});

$('#exportSales')?.addEventListener('click', () => {
  const qs = new URLSearchParams({
    from: $('#salesFrom')?.value || '',
    to: $('#salesTo')?.value || '',
    cashier_id: $('#salesCashierFilter')?.value || '',
    payment_method: $('#salesMethodFilter')?.value || '',
    payment_status: $('#salesStatusFilter')?.value || '',
    q: $('#salesSearch')?.value || ''
  });
  window.open('/api/sales/export?' + qs.toString(), '_blank');
});

$('#printSalesHistory')?.addEventListener('click', () => {
  if (!currentSalesList.length) return notify('Tidak ada transaksi untuk dicetak.');
  const fromStr = $('#salesFrom')?.value || 'Semua';
  const toStr = $('#salesTo')?.value || 'Hari Ini';
  const total = currentSalesList.filter(s => s.payment_status === 'LUNAS').reduce((n, s) => n + s.total, 0);

  const rowsHtml = currentSalesList.map((s, idx) => `
    <tr>
      <td style="text-align:center">${idx + 1}</td>
      <td>${timeFmt(s.sold_at)} WIB</td>
      <td><b>${esc(s.invoice_no)}</b></td>
      <td>${esc(s.cashier_name || '—')}</td>
      <td>${esc(s.customer_name || 'Pelanggan')}</td>
      <td>${esc(s.payment_method)}</td>
      <td style="text-align:center">${esc(s.payment_status)}</td>
      <td class="num">${rupiah(s.total)}</td>
    </tr>
  `).join('');

  const w = window.open('', '_blank');
  if (!w) return notify('Izinkan pop-up browser untuk mencetak rekap.');
  w.document.write(`<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<title>Rekapitulasi Penjualan Howell</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font-family: sans-serif; font-size: 11px; color: #111; padding: 15px; }
  .header { display: flex; justify-content: space-between; border-bottom: 2px solid #071a2b; padding-bottom: 10px; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  th { background: #f1f5f9; padding: 6px; text-align: left; border-bottom: 1px solid #cbd5e1; }
  td { padding: 6px; border-bottom: 1px solid #e2e8f0; }
  td.num, th.num { text-align: right; }
  .totals { margin-top: 15px; text-align: right; font-size: 14px; font-weight: bold; }
  @media print { .no-print { display: none; } }
</style>
</head>
<body>
  <div class="header">
    <div>
      <h2 style="margin:0;color:#071a2b">HOWELL OFFICIAL STORE</h2>
      <p style="margin:3px 0;color:#555">Rekapitulasi Riwayat Transaksi Penjualan</p>
      <small>Periode: ${esc(fromStr)} s/d ${esc(toStr)} · Dicetak: ${new Date().toLocaleString('id-ID')} WIB</small>
    </div>
    <button class="no-print" onclick="window.print()" style="padding:6px 12px;background:#071a2b;color:#fff;border:0;border-radius:4px;cursor:pointer">Cetak / Simpan PDF</button>
  </div>
  <table>
    <thead>
      <tr>
        <th style="width:30px;text-align:center">NO</th>
        <th>WAKTU</th>
        <th>INVOICE</th>
        <th>KASIR</th>
        <th>PELANGGAN</th>
        <th>METODE BAYAR</th>
        <th style="text-align:center">STATUS</th>
        <th class="num">TOTAL</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <div class="totals">
    TOTAL OMSET TERKONFIRMASI: ${rupiah(total)}
  </div>
</body>
</html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 350);
});

/* ==================== REKONSILIASI PENDAPATAN HARIAN ==================== */
let currentReconData = null;

async function loadReconciliation(targetDate) {
  try {
    const todayStr = dateWib();
    const date = targetDate || $('#reconDate')?.value || todayStr;
    if ($('#reconDate')) $('#reconDate').value = date;

    currentReconData = await api(`/api/reconciliation?date=${encodeURIComponent(date)}`);
    const d = currentReconData;

    // Status Badge
    const badge = $('#reconStatusBadge');
    if (badge) {
      if (d.status === 'SELESAI') {
        badge.className = 'status-badge done';
        badge.textContent = 'SELESAI REKONSILIASI';
      } else if (d.status === 'SELESAI_DENGAN_SELISIH') {
        badge.className = 'status-badge diff';
        badge.textContent = 'SELESAI DENGAN SELISIH';
      } else {
        badge.className = 'status-badge pending';
        badge.textContent = 'BELUM DIREKONSILIASI';
      }
    }

    // 8 Stat Cards
    if ($('#rcTotalSales')) $('#rcTotalSales').textContent = rupiah(d.total_sales);
    if ($('#rcTxCount')) $('#rcTxCount').textContent = `${d.total_transactions} transaksi tercatat`;
    if ($('#rcConfirmedPayments')) $('#rcConfirmedPayments').textContent = rupiah(d.total_confirmed_payments);

    const methods = d.methods || [];
    const getMethod = mName => methods.find(m => m.method === mName) || { count: 0, total: 0 };
    const mCash = getMethod('Tunai');
    const mQris = getMethod('QRIS');
    const mDebit = getMethod('Kartu Debit BCA (EDC)');
    const mCredit = getMethod('Kartu Kredit BCA (EDC)');

    if ($('#rcCash')) $('#rcCash').textContent = rupiah(mCash.total);
    if ($('#rcCashCount')) $('#rcCashCount').textContent = `${mCash.count} transaksi tunai`;

    if ($('#rcQris')) $('#rcQris').textContent = rupiah(mQris.total);
    if ($('#rcQrisCount')) $('#rcQrisCount').textContent = `${mQris.count} transaksi QRIS`;

    if ($('#rcDebit')) $('#rcDebit').textContent = rupiah(mDebit.total);
    if ($('#rcDebitCount')) $('#rcDebitCount').textContent = `${mDebit.count} transaksi debit`;

    if ($('#rcCredit')) $('#rcCredit').textContent = rupiah(mCredit.total);
    if ($('#rcCreditCount')) $('#rcCreditCount').textContent = `${mCredit.count} transaksi kredit`;

    if ($('#rcCancelled')) $('#rcCancelled').textContent = rupiah(d.total_cancelled_amount);
    if ($('#rcCancelledCount')) $('#rcCancelledCount').textContent = `${d.total_cancelled_count} transaksi dibatalkan`;

    if ($('#rcDiff')) {
      if (d.closing) {
        $('#rcDiff').textContent = rupiah(d.closing.total_diff);
        $('#rcDiff').style.color = d.closing.total_diff === 0 ? 'var(--green)' : 'var(--red)';
        if ($('#rcDiffLabel')) $('#rcDiffLabel').textContent = d.closing.total_diff === 0 ? 'Cocok (Nol Selisih)' : 'Terdapat Selisih Fisik';
      } else {
        $('#rcDiff').textContent = 'Rp\u00a00';
        $('#rcDiff').style.color = 'inherit';
        if ($('#rcDiffLabel')) $('#rcDiffLabel').textContent = 'Menunggu penutupan kasir';
      }
    }

    // Table rows
    const reconRowsHtml = `
      <tr>
        <td><b>Cash / Tunai</b><br><small class="muted">Penerimaan fisik laci kasir</small></td>
        <td class="num"><b>${mCash.count}</b></td>
        <td class="num"><b>${rupiah(mCash.total)}</b></td>
        <td>Uang fisik kasir wajib dihitung saat tutup</td>
      </tr>
      <tr>
        <td><b>QRIS</b><br><small class="muted">Pembayaran QRIS Dynamic / Static</small></td>
        <td class="num"><b>${mQris.count}</b></td>
        <td class="num"><b>${rupiah(mQris.total)}</b></td>
        <td>Validasi notifikasi settlement penyedia QRIS</td>
      </tr>
      <tr>
        <td><b>Kartu Debit BCA (EDC)</b><br><small class="muted">Kartu debit mesin EDC BCA</small></td>
        <td class="num"><b>${mDebit.count}</b></td>
        <td class="num"><b>${rupiah(mDebit.total)}</b></td>
        <td>Bandingkan dengan struk audit report EDC</td>
      </tr>
      <tr>
        <td><b>Kartu Kredit BCA (EDC)</b><br><small class="muted">Kartu kredit mesin EDC BCA</small></td>
        <td class="num"><b>${mCredit.count}</b></td>
        <td class="num"><b>${rupiah(mCredit.total)}</b></td>
        <td>Bandingkan dengan struk audit report EDC</td>
      </tr>
    `;

    if ($('#reconMethodRows')) $('#reconMethodRows').innerHTML = reconRowsHtml;
    const totalMethodTx = mCash.count + mQris.count + mDebit.count + mCredit.count;
    const totalMethodAmount = mCash.total + mQris.total + mDebit.total + mCredit.total;

    if ($('#rcTotalTxFoot')) $('#rcTotalTxFoot').innerHTML = `<b>${totalMethodTx}</b>`;
    if ($('#rcTotalAmountFoot')) $('#rcTotalAmountFoot').innerHTML = `<b>${rupiah(totalMethodAmount)}</b>`;

    // Closing summary panel
    const closingPanel = $('#closingSummaryContent');
    if (closingPanel) {
      if (d.closing) {
        closingPanel.innerHTML = `
          <div class="closing-summary-card">
            <div class="closing-row">
              <span class="muted">Tanggal Operasional:</span>
              <b>${esc(d.closing.closing_date)}</b>
            </div>
            <div class="closing-row">
              <span class="muted">Kasir yang Bertugas:</span>
              <b>${esc(d.closing.cashier_name)} (ID: ${d.closing.cashier_id})</b>
            </div>
            <div class="closing-row">
              <span class="muted">Modal / Saldo Awal:</span>
              <b>${rupiah(d.closing.opening_cash)}</b>
            </div>
            <div class="closing-row">
              <span class="muted">Total Sistem:</span>
              <b>${rupiah(d.closing.total_system)}</b>
            </div>
            <div class="closing-row">
              <span class="muted">Total Aktual Dihitung:</span>
              <b>${rupiah(d.closing.total_actual)}</b>
            </div>
            <div class="closing-row">
              <span class="muted">Total Selisih:</span>
              <b style="color:${d.closing.total_diff === 0 ? 'var(--green)' : 'var(--red)'}">${rupiah(d.closing.total_diff)}</b>
            </div>
            <div class="closing-row">
              <span class="muted">Status Penutupan:</span>
              <b>${esc(d.closing.status)}</b>
            </div>
            <div class="closing-row">
              <span class="muted">Waktu Penutupan:</span>
              <span>${timeFmt(d.closing.closed_at)} WIB</span>
            </div>
            <div class="closing-row">
              <span class="muted">Direkonsiliasi Oleh:</span>
              <b>${esc(d.closing.reconciled_by || '—')}</b>
            </div>
            ${d.closing.notes ? `
              <div style="margin-top:8px;padding:8px 10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:4px">
                <small class="muted" style="display:block;font-size:9px;text-transform:uppercase">Catatan Kasir:</small>
                <span>${esc(d.closing.notes)}</span>
              </div>
            ` : ''}
          </div>
        `;
      } else {
        closingPanel.innerHTML = `
          <div style="text-align:center;padding:25px 15px">
            <div style="font-size:28px;margin-bottom:8px">⏳</div>
            <b style="color:#2d3748">Belum Ada Penutupan Kasir</b>
            <p style="font-size:11px;color:#718096;margin:6px 0 16px">Sesi kasir untuk tanggal ${esc(date)} belum ditutup atau direkonsiliasi.</p>
            <button class="button primary" data-page="closing">Buka Form Penutupan Kasir</button>
          </div>
        `;
      }
    }

  } catch (e) {
    notify(e.message);
  }
}

// Recon Date picker listeners
$('#reconApply')?.addEventListener('click', () => loadReconciliation($('#reconDate')?.value));
$('#reconToday')?.addEventListener('click', () => {
  const todayStr = dateWib();
  $('#reconDate').value = todayStr;
  loadReconciliation(todayStr);
});
$('#reconYesterday')?.addEventListener('click', () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const yestStr = dateWib(d);
  $('#reconDate').value = yestStr;
  loadReconciliation(yestStr);
});

$('#exportReconCsv')?.addEventListener('click', () => {
  const date = $('#reconDate')?.value || dateWib();
  window.open(`/api/reconciliation/export?date=${encodeURIComponent(date)}`, '_blank');
});

$('#btnCetakRekapHarian')?.addEventListener('click', () => {
  if (!currentReconData) return notify('Memuat data rekonsiliasi...');
  const d = currentReconData;
  const methods = d.methods || [];
  const getMethod = mName => methods.find(m => m.method === mName) || { count: 0, total: 0 };
  const mCash = getMethod('Tunai');
  const mQris = getMethod('QRIS');
  const mDebit = getMethod('Kartu Debit BCA (EDC)');
  const mCredit = getMethod('Kartu Kredit BCA (EDC)');

  const w = window.open('', '_blank');
  if (!w) return notify('Izinkan pop-up browser.');

  w.document.write(`<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<title>Laporan Rekonsiliasi Pendapatan Harian - ${d.operational_date}</title>
<style>
  @page { size: A4 portrait; margin: 15mm; }
  body { font-family: sans-serif; font-size: 11px; color: #111; padding: 20px; }
  .header { display: flex; justify-content: space-between; border-bottom: 2px solid #071a2b; padding-bottom: 12px; margin-bottom: 15px; }
  table { width: 100%; border-collapse: collapse; margin-top: 14px; }
  th { background: #f1f5f9; padding: 8px; text-align: left; font-size: 10px; border-bottom: 1px solid #cbd5e1; }
  td { padding: 8px; border-bottom: 1px solid #e2e8f0; }
  td.num, th.num { text-align: right; }
  .box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px; margin-top: 15px; }
  .sign-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 50px; text-align: center; }
  .sign-line { border-top: 1px solid #333; margin-top: 50px; padding-top: 4px; font-weight: bold; }
  @media print { .no-print { display: none; } }
</style>
</head>
<body>
  <div class="header">
    <div>
      <h2 style="margin:0;color:#071a2b">HOWELL OFFICIAL STORE</h2>
      <p style="margin:3px 0;color:#555">PT Howell Niaga Indonesia · Laporan Rekonsiliasi Harian</p>
      <small>Tanggal Operasional: <b>${d.operational_date}</b> · Status: <b>${d.status}</b></small>
    </div>
    <button class="no-print" onclick="window.print()" style="padding:6px 14px;background:#071a2b;color:#fff;border:0;border-radius:4px;cursor:pointer">Cetak / PDF</button>
  </div>

  <table>
    <thead>
      <tr>
        <th>METODE PEMBAYARAN</th>
        <th class="num">JUMLAH TRANSAKSI</th>
        <th class="num">TOTAL SISTEM</th>
        <th>STATUS REKONSILIASI</th>
      </tr>
    </thead>
    <tbody>
      <tr><td>Cash / Tunai</td><td class="num">${mCash.count}</td><td class="num">${rupiah(mCash.total)}</td><td>Uang Fisik Laci</td></tr>
      <tr><td>QRIS</td><td class="num">${mQris.count}</td><td class="num">${rupiah(mQris.total)}</td><td>Settlement Provider</td></tr>
      <tr><td>Kartu Debit BCA (EDC)</td><td class="num">${mDebit.count}</td><td class="num">${rupiah(mDebit.total)}</td><td>Audit Report EDC BCA</td></tr>
      <tr><td>Kartu Kredit BCA (EDC)</td><td class="num">${mCredit.count}</td><td class="num">${rupiah(mCredit.total)}</td><td>Audit Report EDC BCA</td></tr>
    </tbody>
    <tfoot>
      <tr style="font-weight:bold;background:#f8fafc">
        <td>TOTAL PENERIMAAN</td>
        <td class="num">${mCash.count + mQris.count + mDebit.count + mCredit.count}</td>
        <td class="num">${rupiah(mCash.total + mQris.total + mDebit.total + mCredit.total)}</td>
        <td>100% Database Terverifikasi</td>
      </tr>
    </tfoot>
  </table>

  ${d.closing ? `
    <div class="box">
      <h3 style="margin:0 0 8px;font-size:12px">Hasil Penutupan Kasir Fisik:</h3>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
        <div>Total Sistem: <b>${rupiah(d.closing.total_system)}</b></div>
        <div>Total Aktual Fisik: <b>${rupiah(d.closing.total_actual)}</b></div>
        <div>Selisih: <b style="color:${d.closing.total_diff === 0 ? 'green' : 'red'}">${rupiah(d.closing.total_diff)}</b></div>
      </div>
      ${d.closing.notes ? `<p style="margin:8px 0 0;font-size:10px;color:#555"><b>Catatan Penjelasan:</b> ${esc(d.closing.notes)}</p>` : ''}
    </div>
  ` : '<div class="box"><p style="margin:0;color:#718096">Catatan: Sesi penutupan kasir fisik belum diselesaikan pada tanggal ini.</p></div>'}

  <div class="sign-grid">
    <div>
      <p>Kasir Bertugas</p>
      <div class="sign-line">${esc(d.closing?.cashier_name || 'Kasir Bertugas')}</div>
    </div>
    <div>
      <p>Supervisor / Rekonsiliator</p>
      <div class="sign-line">${esc(d.closing?.reconciled_by || 'Supervisor Howell')}</div>
    </div>
  </div>
</body>
</html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 350);
});

/* ==================== PENUTUPAN KASIR HARIAN ==================== */
let systemClosingTotals = { cash: 0, qris: 0, debit: 0, credit: 0, total: 0 };

async function loadClosing() {
  try {
    const todayStr = dateWib();
    if ($('#closeDate') && !$('#closeDate').value) $('#closeDate').value = todayStr;
    const date = $('#closeDate')?.value || todayStr;
    const cashierId = $('#closeCashierSelect')?.value || activeUser.id;

    const data = await api(`/api/reconciliation?date=${encodeURIComponent(date)}&cashier_id=${encodeURIComponent(cashierId)}`);
    const methods = data.methods || [];
    const getMethod = mName => methods.find(m => m.method === mName) || { count: 0, total: 0 };

    systemClosingTotals = {
      cash: getMethod('Tunai').total,
      qris: getMethod('QRIS').total,
      debit: getMethod('Kartu Debit BCA (EDC)').total,
      credit: getMethod('Kartu Kredit BCA (EDC)').total,
      total: getMethod('Tunai').total + getMethod('QRIS').total + getMethod('Kartu Debit BCA (EDC)').total + getMethod('Kartu Kredit BCA (EDC)').total
    };

    if ($('#sysCashDisp')) $('#sysCashDisp').textContent = rupiah(systemClosingTotals.cash);
    if ($('#sysQrisDisp')) $('#sysQrisDisp').textContent = rupiah(systemClosingTotals.qris);
    if ($('#sysDebitDisp')) $('#sysDebitDisp').textContent = rupiah(systemClosingTotals.debit);
    if ($('#sysCreditDisp')) $('#sysCreditDisp').textContent = rupiah(systemClosingTotals.credit);
    if ($('#sysTotalDisp')) $('#sysTotalDisp').innerHTML = `<b>${rupiah(systemClosingTotals.total)}</b>`;

    // If already closed, prefill actual values
    if (data.closing) {
      if ($('#actCash')) $('#actCash').value = data.closing.actual_cash;
      if ($('#actQris')) $('#actQris').value = data.closing.actual_qris;
      if ($('#actDebit')) $('#actDebit').value = data.closing.actual_debit_bca;
      if ($('#actCredit')) $('#actCredit').value = data.closing.actual_credit_bca;
      if ($('#closeOpeningCash')) $('#closeOpeningCash').value = data.closing.opening_cash;
      if ($('#closeNotes')) $('#closeNotes').value = data.closing.notes || '';
      if ($('#closeReconciledBy')) $('#closeReconciledBy').value = data.closing.reconciled_by || activeUser.name;
    }

    calculateClosingVariance();
    loadClosingHistory();
  } catch (e) {
    notify(e.message);
  }
}

function calculateClosingVariance() {
  const actCash = Number($('#actCash')?.value || 0);
  const actQris = Number($('#actQris')?.value || 0);
  const actDebit = Number($('#actDebit')?.value || 0);
  const actCredit = Number($('#actCredit')?.value || 0);

  const diffCash = actCash - systemClosingTotals.cash;
  const diffQris = actQris - systemClosingTotals.qris;
  const diffDebit = actDebit - systemClosingTotals.debit;
  const diffCredit = actCredit - systemClosingTotals.credit;

  const totalActual = actCash + actQris + actDebit + actCredit;
  const totalDiff = totalActual - systemClosingTotals.total;

  if ($('#diffCashDisp')) {
    $('#diffCashDisp').textContent = rupiah(diffCash);
    $('#diffCashDisp').style.color = diffCash === 0 ? 'inherit' : (diffCash > 0 ? 'var(--green)' : 'var(--red)');
  }
  if ($('#diffQrisDisp')) {
    $('#diffQrisDisp').textContent = rupiah(diffQris);
    $('#diffQrisDisp').style.color = diffQris === 0 ? 'inherit' : (diffQris > 0 ? 'var(--green)' : 'var(--red)');
  }
  if ($('#diffDebitDisp')) {
    $('#diffDebitDisp').textContent = rupiah(diffDebit);
    $('#diffDebitDisp').style.color = diffDebit === 0 ? 'inherit' : (diffDebit > 0 ? 'var(--green)' : 'var(--red)');
  }
  if ($('#diffCreditDisp')) {
    $('#diffCreditDisp').textContent = rupiah(diffCredit);
    $('#diffCreditDisp').style.color = diffCredit === 0 ? 'inherit' : (diffCredit > 0 ? 'var(--green)' : 'var(--red)');
  }

  if ($('#actTotalDisp')) $('#actTotalDisp').innerHTML = `<b>${rupiah(totalActual)}</b>`;
  if ($('#diffTotalDisp')) {
    $('#diffTotalDisp').innerHTML = `<b>${rupiah(totalDiff)}</b>`;
    $('#diffTotalDisp').style.color = totalDiff === 0 ? 'inherit' : (totalDiff > 0 ? 'var(--green)' : 'var(--red)');
  }

  const alertBox = $('#varianceAlert');
  const alertDiff = $('#alertDiffValue');
  const notesLabel = $('#notesLabel');

  if (totalDiff !== 0) {
    if (alertBox) alertBox.style.display = 'flex';
    if (alertDiff) alertDiff.textContent = rupiah(totalDiff);
    if (notesLabel) notesLabel.innerHTML = 'Catatan Rekonsiliasi / Penjelasan Selisih <b style="color:var(--red)">*(Wajib diisi jika terdapat selisih)</b>:';
  } else {
    if (alertBox) alertBox.style.display = 'none';
    if (notesLabel) notesLabel.textContent = 'Catatan Rekonsiliasi / Penjelasan Selisih:';
  }
}

['#actCash', '#actQris', '#actDebit', '#actCredit'].forEach(sel => {
  $(sel)?.addEventListener('input', calculateClosingVariance);
});

$('#closeDate')?.addEventListener('change', loadClosing);
$('#closeCashierSelect')?.addEventListener('change', loadClosing);
$('#btnSyncSystemValues')?.addEventListener('click', loadClosing);

$('#btnSaveClosing')?.addEventListener('click', async () => {
  const date = $('#closeDate')?.value;
  if (!date) return notify('Pilih tanggal operasional.');

  const cashierId = Number($('#closeCashierSelect')?.value || activeUser.id);
  const selectedCashier = allUsers.find(u => u.id === cashierId) || activeUser;
  const openingCash = Math.max(0, Number($('#closeOpeningCash')?.value || 0));

  const actCash = Number($('#actCash')?.value || 0);
  const actQris = Number($('#actQris')?.value || 0);
  const actDebit = Number($('#actDebit')?.value || 0);
  const actCredit = Number($('#actCredit')?.value || 0);

  const totalActual = actCash + actQris + actDebit + actCredit;
  const totalDiff = totalActual - systemClosingTotals.total;
  const notes = $('#closeNotes')?.value.trim() || '';

  if (totalDiff !== 0 && !notes) {
    $('#closeNotes')?.focus();
    return notify(`Terdapat selisih rekonsiliasi (${rupiah(totalDiff)}). Anda wajib mengisi penjelasan selisih sebelum menyimpan penutupan.`);
  }

  const confirmMsg = totalDiff === 0
    ? `Selesaikan penutupan kasir tanggal ${date}? Data cocok dengan sistem (${rupiah(totalActual)}).`
    : `Selesaikan penutupan kasir tanggal ${date} dengan SELISIH ${rupiah(totalDiff)}?`;

  if (!confirm(confirmMsg)) return;

  try {
    const res = await api('/api/reconciliation/close', {
      method: 'POST',
      body: JSON.stringify({
        closing_date: date,
        cashier_id: selectedCashier.id,
        cashier_name: selectedCashier.name,
        opening_cash: openingCash,
        system_cash: systemClosingTotals.cash,
        actual_cash: actCash,
        system_qris: systemClosingTotals.qris,
        actual_qris: actQris,
        system_debit_bca: systemClosingTotals.debit,
        actual_debit_bca: actDebit,
        system_credit_bca: systemClosingTotals.credit,
        actual_credit_bca: actCredit,
        notes,
        reconciled_by: $('#closeReconciledBy')?.value.trim() || activeUser.name
      })
    });

    notify(`Penutupan kasir berhasil disimpan! Status: ${res.status}`);
    loadClosing();
    loadReconciliation(date);
  } catch (e) {
    notify(e.message);
  }
});

async function loadClosingHistory() {
  try {
    const list = await api('/api/reconciliation/closings');
    const rowsNode = $('#closingHistoryRows');
    if (!rowsNode) return;

    rowsNode.innerHTML = list.length ? list.map(c => `
      <tr>
        <td><b>${esc(c.closing_date)}</b><br><small class="muted">${timeFmt(c.closed_at)} WIB</small></td>
        <td><b>${esc(c.cashier_name)}</b><br><small class="muted">Supervisor: ${esc(c.reconciled_by || '—')}</small></td>
        <td class="num">${rupiah(c.total_system)}</td>
        <td class="num"><b>${rupiah(c.total_actual)}</b></td>
        <td class="num" style="color:${c.total_diff === 0 ? 'var(--green)' : 'var(--red)'};font-weight:700">${rupiah(c.total_diff)}</td>
        <td>
          <span class="status-badge ${c.status === 'SELESAI' ? 'done' : 'diff'}">${esc(c.status)}</span>
          ${c.notes ? `<br><small class="muted" title="${esc(c.notes)}">${esc(c.notes.slice(0, 30))}${c.notes.length > 30 ? '...' : ''}</small>` : ''}
        </td>
      </tr>
    `).join('') : '<tr><td colspan="6" class="empty-row">Belum ada riwayat penutupan kasir.</td></tr>';
  } catch (e) {
    console.error('Gagal memuat riwayat penutupan:', e);
  }
}

$('#btnExportClosingsCsv')?.addEventListener('click', async () => {
  try {
    const list = await api('/api/reconciliation/closings');
    if (!list.length) return notify('Belum ada riwayat penutupan untuk diekspor.');

    const headers = ['ID', 'Tanggal Operasional', 'Kasir', 'Saldo Awal', 'Total Sistem', 'Total Aktual', 'Selisih', 'Status', 'Catatan', 'Supervisor', 'Waktu Ditutup'];
    const rows = list.map(c => [
      c.id, c.closing_date, `"${c.cashier_name}"`, c.opening_cash, c.total_system, c.total_actual, c.total_diff, c.status, `"${(c.notes || '').replace(/"/g, '""')}"`, `"${c.reconciled_by || ''}"`, c.closed_at
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Riwayat_Penutupan_Kasir_Howell_${dateWib()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    notify('Berkas CSV riwayat penutupan kasir berhasil diunduh.');
  } catch (e) {
    notify(e.message);
  }
});

/* ==================== DASHBOARD & LAINNYA ==================== */
function productCard(p) {
  return `<span class="product-thumb">▤</span><span><b>${esc(p.name)}</b><br><small class="muted">${esc(p.category || 'Tanpa kategori')}${p.panjang ? ` · ${esc(p.panjang)}` : ''}</small></span>`;
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

async function loadDashboard() {
  try {
    const d = await api('/api/dashboard');
    if ($('#statProducts')) $('#statProducts').textContent = d.products.toLocaleString('id-ID');
    if ($('#statUnits')) $('#statUnits').textContent = d.units.toLocaleString('id-ID');
    if ($('#statLow')) $('#statLow').textContent = d.low_stock.toLocaleString('id-ID');
    if ($('#statVerify')) $('#statVerify').textContent = d.source_flagged_count.toLocaleString('id-ID');
    if ($('#statMoves')) {
      const todayMoves = d.movements.filter(m => new Date(String(m.created_at).replace(' ', 'T') + 'Z').toDateString() === new Date().toDateString());
      $('#statMoves').textContent = todayMoves.length.toLocaleString('id-ID');
    }

    if ($('#lowRows')) {
      $('#lowRows').innerHTML = d.lowProducts.length ? d.lowProducts.map(p => `
        <tr>
          <td><div class="product-cell">${productCard(p)}</div></td>
          <td><b>${esc(p.sku)}</b></td>
          <td>${p.stock} ${esc(p.unit)}</td>
          <td>${p.min_stock} ${esc(p.unit)}</td>
          <td>${statusChip(p.stock_verification_status)}</td>
        </tr>`).join('') : '<tr><td colspan="5" class="empty-row">Belum ada produk yang perlu restock.</td></tr>';
    }

    if ($('#activityList')) {
      $('#activityList').innerHTML = d.movements.length ? d.movements.map(m => `
        <div class="activity">
          <span class="activity-icon ${m.kind === 'out' ? 'out' : ''}">${m.kind === 'in' ? '↓' : m.kind === 'out' ? '↑' : '＋'}</span>
          <div>
            <b>${m.kind === 'in' ? 'Barang masuk' : m.kind === 'out' ? 'Barang keluar' : m.kind === 'opening' ? 'Saldo awal' : 'Penyesuaian'} · ${esc(m.name)}</b>
            <p>${esc(m.sku)} · ${m.kind === 'out' ? '-' : '+'}${m.quantity} ${esc(m.unit)} · saldo ${m.balance_after}</p>
            <time>${timeFmt(m.created_at)} WIB · ${esc(m.location || '')} (${esc(m.user_name || 'Admin')})</time>
          </div>
        </div>`).join('') : '<div class="no-data">Belum ada aktivitas stok terbaru.</div>';
    }
  } catch (e) {
    notify(e.message);
  }
}

/* ==================== PRODUK & SKU ==================== */
async function loadProducts(q = '') {
  try {
    const rows = await api('/api/products?q=' + encodeURIComponent(q));
    if ($('#productCount')) $('#productCount').textContent = rows.length + ' produk';
    if ($('#productRows')) {
      $('#productRows').innerHTML = rows.length ? rows.map(p => `
        <tr>
          <td><div class="product-cell">${productCard(p)}</div></td>
          <td><b>${esc(p.sku)}</b></td>
          <td>${esc(p.barcode || '—')}</td>
          <td>${p.source_qty == null ? `${p.stock} ${esc(p.unit)}` : `Stok ${p.stock} ${esc(p.unit)}<br>${quantity(p.source_qty, p.stock_verification_status === 'NEEDS_VERIFICATION')}<small class="sub-label">QTY sumber Excel</small>`}</td>
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
    }

    $$('[data-edit]').forEach(b => b.onclick = () => showEditProductModal(b.dataset.edit));
    $$('[data-archive]').forEach(b => b.onclick = async () => {
      if (!confirm('Arsipkan SKU ini? Data riwayat pergerakan tetap tersimpan.')) return;
      try {
        await api('/api/products/' + b.dataset.archive, { method: 'DELETE' });
        notify('Produk berhasil diarsipkan.');
        loadProducts($('#productSearch')?.value || '');
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
      <div class="field"><label>Panjang (Opsional)</label><input name="panjang" placeholder="Contoh: 1.5m, 3m"></div>
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
          <label>Barcode EAN-13</label>
          <div style="display:flex;gap:4px">
            <input id="editBarcode" name="barcode" value="${esc(p.barcode || '')}" inputmode="numeric" maxlength="13" placeholder="Kosong atau 13 digit" style="flex:1">
            <button type="button" class="button secondary" style="height:35px;padding:0 8px;font-size:10px;white-space:nowrap" id="btnGenEanEdit">Auto EAN</button>
          </div>
        </div>
        <div class="field full"><label>Nama Produk *</label><input name="name" required value="${esc(p.name)}"></div>
        <div class="field"><label>Panjang</label><input name="panjang" value="${esc(p.panjang || '')}" placeholder="Contoh: 1.5m, 3m"></div>
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
      notify('Perubahan produk berhasil disimpan.');
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

/* ==================== IMPORT EXCEL ==================== */
function renderImportRows(rows) {
  if (!$('#importRows')) return;
  $('#importRows').innerHTML = rows.length ? rows.map(p => `
    <tr>
      <td>${p.source_row}</td>
      <td><b>${esc(p.sku)}</b></td>
      <td>${esc(p.name)}</td>
      <td>${quantity(p.source_qty, p.source_status === 'NEEDS_VERIFICATION')}<small class="sub-label">${esc(p.source_qty_font_color || '')}</small></td>
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
    if ($('#importSummaryCards')) {
      $('#importSummaryCards').innerHTML = cards.map((c, i) => `
        <article class="stat-card">
          <div class="stat-top"><span>${c[0]}</span><span class="stat-icon ${i === 2 ? 'red' : 'navy'}">${i === 2 ? '!' : '▤'}</span></div>
          <strong class="${i === 2 ? 'qty-red' : ''}">${c[1]}</strong>
          <small>${c[2]}</small>
        </article>`).join('');
    }

    if ($('#importFileName')) {
      $('#importFileName').textContent = `${d.batch.source_file} · ${d.batch.status === 'COMMITTED' ? 'sudah diterapkan' : 'menunggu konfirmasi'}`;
    }
    const rows = await api('/api/import/items');
    renderImportRows(rows);

    if ($('#importFilter')) {
      $('#importFilter').onchange = () => renderImportRows(rows.filter(r => !$('#importFilter').value || r.source_status === $('#importFilter').value));
    }
    if ($('#commitImport')) {
      $('#commitImport').disabled = d.batch.status === 'COMMITTED';
      $('#commitImport').textContent = d.batch.status === 'COMMITTED' ? 'Impor sudah diterapkan' : 'Konfirmasi impor';
    }

    if (d.batch.status === 'COMMITTED') {
      if ($('#importMode')) {
        $('#importMode').value = d.batch.import_mode || 'opening';
        $('#importMode').disabled = true;
      }
      if ($('#importDestination')) {
        $('#importDestination').value = d.batch.destination || '';
        $('#importDestination').disabled = true;
      }
    }
  } catch (e) { notify(e.message); }
}

$('#commitImport')?.addEventListener('click', async () => {
  const mode = $('#importMode')?.value;
  const destination = $('#importDestination')?.value.trim();
  const duplicatePolicy = $('#duplicatePolicy')?.value;
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
    if ($('#verificationCount')) $('#verificationCount').textContent = `${rows.length} SKU`;
    if ($('#verificationRows')) {
      $('#verificationRows').innerHTML = rows.length ? rows.map(p => `
        <tr>
          <td><b>${esc(p.sku)}</b><br>${esc(p.name)}</td>
          <td>${quantity(p.source_qty, true)}</td>
          <td>${p.stock} ${esc(p.unit)}</td>
          <td>${esc(p.stock_location)}</td>
          <td>${statusChip(p.stock_verification_status)}</td>
          <td><button class="button secondary" data-verify="${p.id}">Verifikasi</button></td>
        </tr>`).join('') : '<tr><td colspan="6" class="empty-row">Tidak ada SKU yang menunggu verifikasi fisik.</td></tr>';
    }

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
      body: JSON.stringify({ actual_stock: quantity, reason, user_name: activeUser.name })
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
  if (!$('#movementRows')) return;
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

/* ==================== INISIALISASI APLIKASI ==================== */
(async function init() {
  await initUsers();
  loadDashboard();
})();
