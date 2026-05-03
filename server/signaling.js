const http = require("http");
const os = require("os");
const { randomUUID } = require("crypto");

const port = process.env.PORT ? Number(process.env.PORT) : 3000;

/** @type {Map<string, { hostPeerId: string, viewerPeerId: string }>} */
const sessions = new Map();

/** @type {Map<string, import("http").ServerResponse[]>} */
const sseClients = new Map();

/** @type {Map<string, { host: number, viewer: number }>} */
const sseCounts = new Map();

const SESSION_KEY_RE = /^\d{8}$/;

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error("Request too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function validSessionKey(key) {
  return typeof key === "string" && SESSION_KEY_RE.test(key);
}

function getSession(sessionKey) {
  return sessions.get(sessionKey) || null;
}

function bumpSse(sessionKey, role, delta) {
  const cur = sseCounts.get(sessionKey) || { host: 0, viewer: 0 };
  if (role === "host") {
    cur.host = Math.max(0, cur.host + delta);
  } else {
    cur.viewer = Math.max(0, cur.viewer + delta);
  }
  sseCounts.set(sessionKey, cur);
}

function peerRole(sessionKey, peerId) {
  const s = getSession(sessionKey);
  if (!s) return null;
  if (s.hostPeerId === peerId) return "host";
  if (s.viewerPeerId === peerId) return "viewer";
  return null;
}

function handleRegisterHost(req, res) {
  parseJsonBody(req)
    .then((body) => {
      const { sessionKey, hostPeerId, viewerPeerId } = body;
      if (!validSessionKey(sessionKey) || !hostPeerId || !viewerPeerId) {
        sendJson(res, 400, {
          ok: false,
          error: "Need sessionKey (8 digit number), hostPeerId, viewerPeerId"
        });
        return;
      }
      const existing = getSession(sessionKey);
      if (existing) {
        if (existing.hostPeerId !== hostPeerId || existing.viewerPeerId !== viewerPeerId) {
          sendJson(res, 409, { ok: false, error: "Session key already in use with different peers" });
          return;
        }
        sendJson(res, 200, { ok: true, reused: true });
        return;
      }
      sessions.set(sessionKey, { hostPeerId, viewerPeerId });
      sseCounts.set(sessionKey, { host: 0, viewer: 0 });
      sendJson(res, 200, { ok: true });
    })
    .catch((err) => sendJson(res, 400, { ok: false, error: err.message }));
}

function handleRegisterViewer(req, res) {
  parseJsonBody(req)
    .then((body) => {
      const { sessionKey, hostPeerId, viewerPeerId } = body;
      if (!validSessionKey(sessionKey) || !hostPeerId || !viewerPeerId) {
        sendJson(res, 400, {
          ok: false,
          error: "Need sessionKey (8 digit number), hostPeerId, viewerPeerId"
        });
        return;
      }
      const s = getSession(sessionKey);
      if (!s) {
        sendJson(res, 404, { ok: false, error: "Session not found. Ask the host to start first." });
        return;
      }
      if (s.hostPeerId !== hostPeerId || s.viewerPeerId !== viewerPeerId) {
        sendJson(res, 403, { ok: false, error: "Session credentials do not match host setup" });
        return;
      }
      sendJson(res, 200, { ok: true });
    })
    .catch((err) => sendJson(res, 400, { ok: false, error: err.message }));
}

function handleSessionStatus(req, res, url) {
  const sessionKey = url.searchParams.get("sessionKey");
  if (!validSessionKey(sessionKey)) {
    sendJson(res, 400, { ok: false, error: "Invalid sessionKey" });
    return;
  }
  const s = getSession(sessionKey);
  if (!s) {
    sendJson(res, 200, {
      ok: true,
      sessionExists: false,
      hostListening: false,
      viewerListening: false
    });
    return;
  }
  const counts = sseCounts.get(sessionKey) || { host: 0, viewer: 0 };
  sendJson(res, 200, {
    ok: true,
    sessionExists: true,
    hostListening: counts.host > 0,
    viewerListening: counts.viewer > 0,
    hostPeerId: s.hostPeerId,
    viewerPeerId: s.viewerPeerId
  });
}

function handleSignal(req, res) {
  parseJsonBody(req)
    .then((msg) => {
      const { sessionKey, to, from, type, payload } = msg;
      if (!validSessionKey(sessionKey)) {
        sendJson(res, 403, { ok: false, error: "Missing or invalid sessionKey" });
        return;
      }
      if (!to || !from || !type) {
        sendJson(res, 400, { ok: false, error: "Missing fields: to/from/type" });
        return;
      }

      const s = getSession(sessionKey);
      if (!s) {
        sendJson(res, 404, { ok: false, error: "Unknown session" });
        return;
      }
      if (from !== s.hostPeerId && from !== s.viewerPeerId) {
        sendJson(res, 403, { ok: false, error: "from peer not in session" });
        return;
      }
      if (to !== s.hostPeerId && to !== s.viewerPeerId) {
        sendJson(res, 403, { ok: false, error: "to peer not in session" });
        return;
      }

      const targets = sseClients.get(to) || [];
      const envelope = {
        id: randomUUID(),
        to,
        from,
        type,
        payload,
        ts: Date.now()
      };

      for (const client of targets) {
        client.write(`data: ${JSON.stringify(envelope)}\n\n`);
      }

      sendJson(res, 200, { ok: true, delivered: targets.length });
    })
    .catch((err) => {
      sendJson(res, 400, { ok: false, error: err.message });
    });
}

function handleEvents(req, res, url) {
  const id = url.searchParams.get("id");
  const sessionKey = url.searchParams.get("sessionKey");
  if (!id) {
    sendJson(res, 400, { ok: false, error: "Missing id query parameter" });
    return;
  }
  if (!validSessionKey(sessionKey)) {
    sendJson(res, 403, { ok: false, error: "Missing or invalid sessionKey" });
    return;
  }
  const role = peerRole(sessionKey, id);
  if (!role) {
    sendJson(res, 403, { ok: false, error: "Peer not registered for this session" });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*"
  });
  res.write("retry: 1000\n\n");

  bumpSse(sessionKey, role, 1);

  const list = sseClients.get(id) || [];
  list.push(res);
  sseClients.set(id, list);

  req.on("close", () => {
    bumpSse(sessionKey, role, -1);
    const current = sseClients.get(id) || [];
    const filtered = current.filter((client) => client !== res);
    if (filtered.length === 0) {
      sseClients.delete(id);
    } else {
      sseClients.set(id, filtered);
    }
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type"
    });
    res.end();
    return;
  }

  res.setHeader("access-control-allow-origin", "*");

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, sessions: sessions.size, peers: sseClients.size });
    return;
  }

  if (req.method === "GET" && url.pathname === "/session/status") {
    handleSessionStatus(req, res, url);
    return;
  }

  if (req.method === "POST" && url.pathname === "/session/host") {
    handleRegisterHost(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/session/viewer") {
    handleRegisterViewer(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    handleEvents(req, res, url);
    return;
  }

  if (req.method === "POST" && url.pathname === "/signal") {
    handleSignal(req, res);
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
});

function printLanHints(listenPort) {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    if (!list) continue;
    for (const addr of list) {
      const fam = addr.family;
      const v4 = fam === "IPv4" || fam === 4;
      if (v4 && !addr.internal) ips.push(addr.address);
    }
  }
  console.log(`Listening on all IPv4 interfaces, port ${listenPort}`);
  console.log(`This machine: http://127.0.0.1:${listenPort}`);
  if (ips.length === 0) {
    console.log(
      "No LAN IPv4 found (or only loopback). Open firewall TCP",
      listenPort,
      "if peers cannot connect."
    );
    return;
  }
  console.log(
    "Same Wi‑Fi / LAN — set this URL in the extension popup on host and viewer PCs:"
  );
  for (const ip of ips) {
    console.log(`  http://${ip}:${listenPort}`);
  }
}

server.listen(port, "0.0.0.0", () => {
  printLanHints(port);
});
