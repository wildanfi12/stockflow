const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const host = '127.0.0.1';

function isPortFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

function responds(port) {
  return new Promise(resolve => {
    const req = http.get({ hostname: host, port, path: '/', timeout: 1500 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(res.statusCode === 200 && body.includes('Howell StockFlow')));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function openBrowser(url) {
  const opener = spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], {
    windowsHide: true,
    stdio: 'ignore'
  });
  opener.on('error', error => console.error('Tidak dapat membuka browser otomatis:', error.message));
}

async function main() {
  let port;
  let alreadyRunning = false;

  for (let candidate = 3001; candidate <= 3010; candidate++) {
    if (await responds(candidate)) {
      port = candidate;
      alreadyRunning = true;
      break;
    }
    if (await isPortFree(candidate)) {
      port = candidate;
      break;
    }
  }

  if (!port) throw new Error('Port 3001–3010 sedang dipakai. Tutup aplikasi StockFlow lama atau minta bantuan IT.');

  const url = `http://${host}:${port}/`;
  if (alreadyRunning) {
    console.log(`Howell StockFlow sudah aktif di ${url}`);
    openBrowser(url);
    return;
  }

  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: { ...process.env, HOST: host, PORT: String(port) },
    stdio: 'inherit',
    windowsHide: false
  });
  server.on('error', error => console.error('Gagal menjalankan server:', error.message));

  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (server.exitCode !== null) break;
    if (await responds(port)) {
      ready = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  if (!ready) {
    server.kill();
    throw new Error('Server tidak merespons. Lihat pesan error server di atas.');
  }

  console.log(`StockFlow siap di ${url}`);
  openBrowser(url);
  server.on('exit', (code, signal) => {
    console.log(`Server berhenti (code=${code}, signal=${signal}).`);
    process.exitCode = code || 0;
  });
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
