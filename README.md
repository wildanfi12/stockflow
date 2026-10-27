# Howell StockFlow

Fondasi aplikasi inventaris Howell dengan UI berbahasa Indonesia, Node.js, dan SQLite. Data produk nyata belum dimasukkan; katalog tetap kosong sampai pengguna mengimpor atau memasukkan katalog Howell yang sudah diverifikasi.

## Menjalankan aplikasi

- Node.js 22.5 atau lebih baru (fitur `node:sqlite` bawaan Node).
- Jalankan `npm start`, lalu buka `http://localhost:3000`.
- Database dibuat otomatis pada `data/howell-stockflow.db`. Folder database tidak perlu dibuat atau disiapkan sebelumnya.
- Set `PORT` untuk mengganti port (default 3000).

## Yang tersedia

- Dashboard dari database dengan total produk, unit, stok minimum, dan ledger terbaru.
- Tambah dan arsipkan produk dengan SKU unik, barcode EAN-13 tervalidasi, harga integer Rupiah, satuan, saldo awal, stok minimum, dan lokasi.
- Pemeriksaan barcode melalui scanner USB/Bluetooth HID (input keyboard berakhiran Enter) atau input manual. Mode cek hanya membaca produk, tidak mengubah stok.
- Catatan barang masuk, keluar, dan penyesuaian positif. Perubahan saldo serta ledger disimpan atomik; barang keluar ditolak jika stok tidak cukup.
- Pencarian produk dan ledger.

Saldo awal yang dimasukkan saat membuat produk tercatat sebagai pergerakan `opening`. Produk yang sudah memiliki ledger diarsipkan, bukan dihapus. Data demo tidak di-seed.

## Batas tahap ini

Ini adalah fondasi produk dan stok, bukan keseluruhan target master prompt. Autentikasi/role, impor CSV/Excel, edit produk, transaksi penjualan/idempotensi, invoice PDF, laporan, ekspor, API WhatsApp, migrasi deployment, dan pengujian otomatis belum tersedia. SQLite berjalan lokal dan belum dikonfigurasi untuk akses multi-instance. Scanner diuji berdasarkan pola HID keyboard, tetapi perlu verifikasi fisik dengan scanner gudang sebelum pemakaian operasional.

## Penjualan pameran

Menu **Kasir / Scan** menerima input scanner USB mode keyboard (Enter menambahkan SKU/barcode ke keranjang). Harga jual harus diisi kasir pada setiap baris sebelum transaksi; kolom HARGA sumber hanya ditampilkan sebagai referensi. Nilai DISC 25% tidak diperlakukan sebagai harga jual, karena Excel berisi nilai dan rumus sumber yang berbeda antar SKU. Stok dan ledger keluar diperbarui atomik setelah kasir menyelesaikan transaksi. Setiap transaksi menyimpan snapshot nama/SKU/harga/qty, invoice, metode pembayaran, total, waktu, dan saldo sesudah penjualan.

Menu **Riwayat penjualan** dapat difilter menurut tanggal. Tombol cetak riwayat dan **Struk PDF** membuka halaman cetak browser; pilih **Save as PDF / Simpan sebagai PDF** pada dialog cetak untuk menyimpan dokumen. Aplikasi tidak menambahkan diskon otomatis ke transaksi.

