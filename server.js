// grblHAL Studio — static server.
// Web Serial API requires a secure context; http://localhost qualifies, so we
// serve the SPA from localhost on a fixed port (matches the 910x project convention).
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 9107;

app.use(express.static(join(__dirname, 'public'), {
  setHeaders(res) {
    // Web Serial needs no special headers, but keep responses uncached in dev.
    res.setHeader('Cache-Control', 'no-store');
  }
}));

app.listen(PORT, () => {
  console.log(`\n  grblHAL Studio  →  http://localhost:${PORT}\n`);
  console.log('  Open in Chrome or Edge (Web Serial API required for machine control).');
});
