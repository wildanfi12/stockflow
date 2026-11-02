@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js tidak ditemukan. Install Node.js versi 22 atau lebih baru, lalu coba lagi.
  pause
  exit /b 1
)

if not exist "server.js" (
  echo server.js tidak ditemukan. Pastikan file ini dijalankan dari folder proyek Howell StockFlow.
  pause
  exit /b 1
)

echo Menjalankan Howell StockFlow. Biarkan jendela ini tetap terbuka.
set "SALES_REPORT_SOURCE=vps"
set "STOCKFLOW_VPS_SSH_TARGET=stockflow-vps"
node start-local.js
echo.
echo StockFlow berhenti. Catat pesan di atas jika aplikasi belum terbuka.
pause
