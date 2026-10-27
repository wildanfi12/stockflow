# Howell StockFlow

Aplikasi inventaris dan kasir pameran Howell. Frontend memakai HTML, CSS, dan JavaScript vanilla; backend memakai Node.js native HTTP dan `node:sqlite` dengan database SQLite lokal.

## Menjalankan aplikasi lokal

- Gunakan Node.js 22.5 atau lebih baru.
- Jalankan `npm start` atau buka `Buka Howell StockFlow.bat` di Windows.
- Buka `http://127.0.0.1:3001/`.
- Database operasional berada di `data/howell-stockflow.db` dan tidak disertakan ke Git.

## Fitur utama

- Dashboard, kasir scanner USB/HID, transaksi dan invoice, rekonsiliasi harian, serta penutupan kasir.
- Katalog SKU, impor Excel, pemeriksaan stok, dan ledger pergerakan inventaris.
- Diskon 20% atau 25% dihitung per harga/unit dan dibulatkan ke atas ke ribuan Rupiah; seluruh nilai uang disimpan sebagai integer.
- Waktu operasional ditampilkan dalam zona WIB.

## GitHub Pages

GitHub Pages hanya menyajikan file statis. Halaman dapat menampilkan pratinjau antarmuka, tetapi tidak dapat menjalankan backend Node.js, SQLite, kasir, atau data operasional. Untuk website publik yang berfungsi, deploy backend Node.js ke layanan hosting yang mendukung penyimpanan persisten untuk SQLite, lalu hubungkan frontend ke server tersebut. Aplikasi lokal tetap berjalan pada komputer kasir.
