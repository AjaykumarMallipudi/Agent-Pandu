// Waits until the API answers (any HTTP response) so Vite doesn't log proxy errors while the server boots.
import http from 'node:http';

const url = process.env.API_URL ?? 'http://127.0.0.1:4000';
const deadline = Date.now() + 60_000;

function ping() {
  return new Promise((resolve) => {
    const req = http.get(`${url}/api/health`, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => req.destroy());
  });
}

while (!(await ping())) {
  if (Date.now() > deadline) {
    console.warn(`API at ${url} not reachable after 60s; starting the web app anyway.`);
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
