// grbl.js — grblHAL controller driver over the Web Serial API.
// Handles connection, line-based streaming with ok/error flow control, real-time
// commands (feed-hold !, resume ~, soft-reset 0x18), status polling, jogging, and
// pushing the tool table (G10 L1). Chrome/Edge only; needs http(s) or localhost.

const RT = { STATUS: '?', HOLD: '!', RESUME: '~', RESET: '\x18',
  SAFETY_DOOR: '\x84', JOG_CANCEL: '\x85' };

export class GrblDriver extends EventTarget {
  constructor() {
    super();
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.connected = false;
    this._buf = '';
    this._queue = [];        // pending lines awaiting 'ok'
    this._inflight = 0;      // lines sent, not yet acknowledged
    this._maxInflight = 1;   // conservative ok-per-line streaming
    this._streaming = false;
    this._statusTimer = null;
    this.state = { status: 'Disconnected', mpos: [0, 0, 0], wpos: [0, 0, 0], feed: 0, spindle: 0 };
    this.stats = { sent: 0, total: 0 };
    this.settings = {};      // grblHAL $-settings, e.g. { '130': 300, '20': 1 } (from $$)
  }

  get supported() { return 'serial' in navigator; }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // List ports the user has already granted access to (no native prompt).
  async listPorts() {
    if (!this.supported) return [];
    try { return await navigator.serial.getPorts(); } catch (e) { return []; }
  }

  async connect(baudRate = 115200, port = null) {
    if (!this.supported) throw new Error('Web Serial non supporté — utilise Chrome ou Edge.');
    this.port = port || await navigator.serial.requestPort();
    this.baudRate = baudRate;
    await this.port.open({ baudRate });
    this.writer = this.port.writable.getWriter();
    this.connected = true;
    this.state.status = 'Connecting';
    this.emit('open', {});
    this._readLoop();
    this._statusTimer = setInterval(() => this.realtime(RT.STATUS), 250);
    // gentle greeting; grblHAL replies with a welcome banner
    setTimeout(() => this.realtime(RT.STATUS), 150);
    return true;
  }

  async disconnect() {
    this._streaming = false;
    if (this._statusTimer) clearInterval(this._statusTimer);
    try { if (this.reader) await this.reader.cancel(); } catch (e) {}
    try { if (this.writer) this.writer.releaseLock(); } catch (e) {}
    try { if (this.port) await this.port.close(); } catch (e) {}
    this.connected = false;
    this.state.status = 'Disconnected';
    this.emit('close', {});
    this.emit('state', this.state);
  }

  async _readLoop() {
    const decoder = new TextDecoder();
    try {
      this.reader = this.port.readable.getReader();
      while (this.connected) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this._buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = this._buf.indexOf('\n')) >= 0) {
          const line = this._buf.slice(0, idx).replace(/\r$/, '');
          this._buf = this._buf.slice(idx + 1);
          if (line) this._onLine(line);
        }
      }
    } catch (e) {
      this.emit('error', { message: String(e.message || e) });
    } finally {
      try { this.reader.releaseLock(); } catch (e) {}
    }
  }

  _onLine(line) {
    // status report
    if (line[0] === '<' && line.endsWith('>')) { this._parseStatus(line); return; }
    if (line === 'ok') { this._ack(false); return; }
    if (line.startsWith('error') || line.startsWith('ALARM')) { this._ack(true, line); }
    // $-setting line from a $$ dump, e.g. "$130=300.000"
    const sm = line.match(/^\$(\d+)\s*=\s*(-?[\d.]+)/);
    if (sm) { this.settings[sm[1]] = parseFloat(sm[2]); this.emit('setting', { n: sm[1], value: this.settings[sm[1]] }); }
    this.emit('line', { line });
  }

  _parseStatus(line) {
    const body = line.slice(1, -1);           // strip < >
    const parts = body.split('|');
    this.state.status = parts[0];
    for (const p of parts.slice(1)) {
      const [k, v] = p.split(':');
      if (!v) continue;
      const nums = v.split(',').map(Number);
      if (k === 'MPos') this.state.mpos = nums;
      else if (k === 'WPos') this.state.wpos = nums;
      else if (k === 'FS') { this.state.feed = nums[0]; this.state.spindle = nums[1]; }
      else if (k === 'F') { this.state.feed = nums[0]; }
    }
    // If only MPos is given, derive WPos with WCO when present (kept simple here).
    this.emit('state', this.state);
  }

  _ack(isError, line) {
    if (this._inflight > 0) this._inflight--;
    if (isError) this.emit('error', { message: line });
    this._pump();
  }

  async _write(str) {
    if (!this.writer) return;
    await this.writer.write(new TextEncoder().encode(str));
  }

  realtime(byte) { if (this.connected) this._write(byte); }

  // Queue a normal line (adds newline, waits for ok before the next).
  send(line) {
    const clean = String(line).trim();
    if (!clean) return;
    this._queue.push(clean);
    this.stats.total++;
    this._pump();
  }

  _pump() {
    while (this.connected && this._inflight < this._maxInflight && this._queue.length) {
      const line = this._queue.shift();
      this._inflight++;
      this.stats.sent++;
      this._write(line + '\n');
      this.emit('sent', { line, sent: this.stats.sent, total: this.stats.total });
      if (this._queue.length === 0 && this._streaming) { this._streaming = false; this.emit('streamdone', {}); }
    }
    this.emit('progress', { sent: this.stats.sent, total: this.stats.total, queued: this._queue.length });
  }

  streamProgram(text) {
    const lines = String(text).split(/\r?\n/)
      .map((l) => l.replace(/;.*$/, '').replace(/\(.*?\)/g, '').trim())
      .filter(Boolean);
    this.stats = { sent: 0, total: 0 };
    this._streaming = true;
    for (const l of lines) this.send(l);
  }

  // ---- convenience -------------------------------------------------------
  feedHold() { this.realtime(RT.HOLD); }
  resume() { this.realtime(RT.RESUME); }
  softReset() { this._queue = []; this._inflight = 0; this._streaming = false; this.realtime(RT.RESET); }
  jog(axis, dist, feed = 800) { this.send(`$J=G91 G21 ${axis}${dist} F${feed}`); }
  jogCancel() { this.realtime(RT.JOG_CANCEL); }
  home() { this.send('$H'); }
  unlock() { this.send('$X'); }
  querySettings() { this.send('$$'); }                       // dump all $-settings
  writeSetting(n, v) { this.send(`$${n}=${v}`); this.settings[String(n)] = parseFloat(v); }
  zeroWork(axes = 'XYZ') {
    const map = { X: 'X0', Y: 'Y0', Z: 'Z0' };
    this.send('G10 L20 P1 ' + [...axes].map((a) => map[a]).join(' '));
  }

  // Push the whole tool table using the tools module's G10 emitter.
  pushToolTable(tools, toG10) {
    for (const t of tools) this.send(toG10(t));
    this.emit('line', { line: `; ${tools.length} outils déclarés dans la table grblHAL` });
  }
}

export const grbl = new GrblDriver();
