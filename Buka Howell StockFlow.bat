@echo off
setlocal
cd /d "%~dp0"
start "Howell StockFlow" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:3000"
npm start
