// MAIN world. The egress gate: the last thing that runs before bytes leave.
//
// Installed at document_start, before the page's own scripts, so the shims are
// in place when the app captures its references. Every shim can HOLD a payload,
// not merely observe it.
//
// This layer is dumb on purpose. It does not trust that input.js or
// clipboard.js already did their job — it re-scans whatever is actually about
// to be serialized. Classification is UX; this is the guarantee.

(() => {
  const CH = '__anonymice__';
  let NONCE = null;
  const waiting = new Map();
  let id = 0;

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.ch !== CH) return;
    if (d.kind === 'hello-ack') { NONCE = d.nonce; flushHandshake(); return; }
    if (d.kind === 'res' && waiting.has(d.id)) {
      waiting.get(d.id)(d.res);
      waiting.delete(d.id);
    }
  });

  let handshakeWaiters = [];
  function ready() {
    if (NONCE) return Promise.resolve();
    return new Promise((r) => handshakeWaiters.push(r));
  }
  function flushHandshake() { handshakeWaiters.splice(0).forEach((r) => r()); }
  window.postMessage({ ch: CH, kind: 'hello' }, '*');

  async function call(type, payload) {
    await ready();
    const myId = ++id;
    return new Promise((resolve) => {
      waiting.set(myId, resolve);
      window.postMessage({ ch: CH, kind: 'req', id: myId, nonce: NONCE, type, payload }, '*');
      // FAIL CLOSED: no answer within the budget means the request does not go.
      setTimeout(() => {
        if (waiting.has(myId)) { waiting.delete(myId); resolve({ ok: false, error: 'timeout' }); }
      }, 3000);
    });
  }

  // Returns the payload to send, or throws to block it.
  async function gate(url, body, flow = 'F?-egress') {
    if (body == null) return body;
    const text = await stringify(body);
    if (text === null) return body;              // opaque binary — see uploads
    const res = await call('sweep', { url, text, flow, point: '③' });
    if (!res.ok) throw new Error('anonymice: egress blocked (vault or policy unavailable)');
    if (res.blocked) throw new Error('anonymice: endpoint blocked by policy');
    return res.changed ? res.text : body;
  }

  async function stringify(body) {
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof Blob && body.type.startsWith('text/')) return body.text();
    if (body instanceof FormData) return null;   // handled separately
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return null;
    return null;
  }

  // --- fetch -----------------------------------------------------------------
  const _fetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    if (init?.body != null) init = { ...init, body: await gate(url, init.body, 'F3-fetch') };
    else if (input instanceof Request && input.method !== 'GET') {
      const clone = input.clone();
      const body = await gate(url, await clone.text(), 'F3-fetch');
      input = new Request(input, { body });
    }
    return _fetch.call(this, input, init);
  };

  // --- XMLHttpRequest --------------------------------------------------------
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, async = true, ...rest) {
    this.__anonymice = { method, url, async };
    return _open.call(this, method, url, async, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const meta = this.__anonymice || {};
    // A synchronous XHR cannot be held open across an async sweep. Blocked.
    if (meta.async === false) throw new Error('anonymice: synchronous XHR blocked');
    if (body == null) return _send.call(this, body);
    gate(meta.url, body, 'F3-xhr').then(
      (safe) => _send.call(this, safe),
      (err) => { this.dispatchEvent(new Event('error')); console.error(err); }
    );
  };

  // --- WebSocket -------------------------------------------------------------
  // Frames are queued and flushed IN ORDER, so holding one frame for a sweep
  // cannot reorder the collaborative-editing stream.
  const _wsSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    const q = this.__anonymiceQueue || (this.__anonymiceQueue = Promise.resolve());
    this.__anonymiceQueue = q.then(async () => {
      try { _wsSend.call(this, await gate(this.url, data, 'F3-websocket')); }
      catch (e) { console.error(e); this.close(1008, 'anonymice: egress blocked'); }
    });
  };

  // --- sendBeacon ------------------------------------------------------------
  // Synchronous by contract and fires on unload. We cannot hold it, so we
  // swallow it and re-emit via keepalive fetch after the sweep. The caller sees
  // `true`; if the sweep fails the beacon is simply dropped — fail closed.
  const _beacon = navigator.sendBeacon?.bind(navigator);
  if (_beacon) {
    navigator.sendBeacon = function (url, data) {
      gate(url, data, 'F3-sendBeacon').then(
        (safe) => _fetch.call(window, url, { method: 'POST', body: safe, keepalive: true, credentials: 'include' }),
        (e) => console.error('anonymice: beacon dropped', e)
      );
      return true;
    };
  }

  // --- uploads ---------------------------------------------------------------
  // Binary payloads are not parsed in the content script. Policy decides:
  // block, or hand off to the CH gateway for extract → classify → re-emit.
  // Filenames leak too (`Vertrag_Meier_2024.pdf` is content).
  const _fdAppend = FormData.prototype.append;
  FormData.prototype.append = function (name, value, filename) {
    if (value instanceof File || value instanceof Blob) {
      this.__anonymiceHasBinary = true;
    }
    return _fdAppend.call(this, name, value, filename);
  };

  console.debug('[anonymice] chokepoint installed');
})();
