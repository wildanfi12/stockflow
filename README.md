# Howell StockFlow

Aplikasi inventaris dan kasir pameran Howell. Frontend memakai HTML, CSS, dan JavaScript vanilla; backend memakai Node.js native HTTP dan `node:sqlite` dengan database SQLite lokal.

## Menjalankan aplikasi lokal

- Gunakan Node.js 22.5 atau lebih baru.
- Jalankan `npm start` atau buka `Buka Howell StockFlow.bat` di Windows.
- Buka `http://127.0.0.1:3001/`.
- Database operasional disimpan pada `DATA_DIR` dan tidak disertakan ke Git. Pada pengembangan lokal, direktori defaultnya `data/`.
- File data sumber produk lokal juga dikecualikan dari Git; backend menyajikan sumber yang tersedia di `DATA_DIR` hanya setelah login.
- API operasional memerlukan akun StockFlow; cookie sesi bersifat `HttpOnly`, `SameSite=Strict`, dan berlaku 12 jam. Untuk deployment publik, isi `PUBLIC_BASE_URL` dengan origin HTTPS yang benar.
- Akun kasir mengikuti nama pengguna masing-masing; backend mengikat penjualan dan rekonsiliasi kasir pada akun yang sedang login. Reset kata sandi dilakukan melalui skrip administrator `scripts/set-user-passwords.js` dengan file kredensial privat.

## Fitur utama

- Dashboard, kasir scanner USB/HID, transaksi dan invoice, rekonsiliasi harian, serta penutupan kasir.
- Katalog SKU, impor Excel, pemeriksaan stok, dan ledger pergerakan inventaris.
- Diskon 20% atau 25% dihitung per harga/unit dan dibulatkan ke atas ke ribuan Rupiah; seluruh nilai uang disimpan sebagai integer.
- Waktu operasional ditampilkan dalam zona WIB.

## GitHub Pages

GitHub Pages hanya menyajikan file statis. Halaman dapat menampilkan pratinjau antarmuka, tetapi tidak dapat menjalankan backend Node.js, SQLite, kasir, atau data operasional. Untuk website publik yang berfungsi, deploy backend Node.js ke layanan hosting yang mendukung penyimpanan persisten untuk SQLite, lalu hubungkan frontend ke server tersebut. Aplikasi lokal tetap berjalan pada komputer kasir.
