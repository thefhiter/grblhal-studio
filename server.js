// grblHAL Studio — static server.
// Web Serial API requires a secure context; http://localhost qualifies, so we
// serve the SPA from localhost on a fixed port (matches the 910x project convention).
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 9107;

const noCache = (res) => res.setHeader('Cache-Control', 'no-store');

// Embed the CNC Build Plate Studio (sibling project) at /plate, so its 3D build
// plate can be iframed same-origin inside the Studio. We reuse its own ?embedded
// boot + window.plateStudioLoadGcode/Clear/SetSpindlePos host hooks — the exact
// bridge it already exposes for ioSender's WebView2 "3D Plate" tab.
const plateDir = join(__dirname, '..', 'cnc-plate-studio', 'public');
const plateAvailable = existsSync(join(plateDir, 'index.html'));
if (plateAvailable) {
  app.use('/plate', express.static(plateDir, { setHeaders: noCache }));
}

app.use(express.static(join(__dirname, 'public'), { setHeaders: noCache }));

app.listen(PORT, () => {
  console.log(`\n  grblHAL Studio  →  http://localhost:${PORT}\n`);
  console.log('  Open in Chrome or Edge (Web Serial API required for machine control).');
  console.log(plateAvailable
    ? `  3D Plate embedded  →  http://localhost:${PORT}/plate/`
    : '  (cnc-plate-studio not found beside grblhal-studio — the 3D Plate tab shows a hint)');
});
