let SIGNALING_URL = "http://localhost:3000";
const videoEl = document.getElementById("remoteVideo");
const statusTextEl = document.getElementById("statusText");
const statusDotEl = document.getElementById("statusDot");
const bannerEl = document.getElementById("banner");
const reconnectBtn = document.getElementById("reconnectBtn");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const videoStageEl = document.getElementById("videoStage");
const sessionPillEl = document.getElementById("sessionPill");
const signalingFootnoteEl = document.getElementById("signalingFootnote");

const query = new URLSearchParams(window.location.search);

function getInitialParams() {
  let sessionKey = query.get("sessionKey") || "";

  try {
    const raw = sessionStorage.getItem("remoteControlViewer");
    if (raw) {
      const saved = JSON.parse(raw);
      if (!sessionKey && saved.sessionKey) sessionKey = saved.sessionKey;
    }
  } catch {
    /* ignore */
  }

  return { sessionKey };
}

let { sessionKey } = getInitialParams();
let peerId = sessionKey ? `viewer-${sessionKey}` : "";
let targetId = sessionKey ? `host-${sessionKey}` : "";

function syncSessionChrome() {
  if (sessionPillEl) {
    if (sessionKey && /^\d{8}$/.test(sessionKey)) {
      sessionPillEl.textContent = sessionKey;
      sessionPillEl.classList.remove("empty");
      sessionPillEl.title = `Session ${sessionKey}`;
    } else {
      sessionPillEl.textContent = "No code";
      sessionPillEl.classList.add("empty");
      sessionPillEl.title = "";
    }
  }
  if (signalingFootnoteEl) {
    signalingFootnoteEl.innerHTML = `Signaling <code>${SIGNALING_URL}</code> · set in signaling-config.js`;
  }
}

let pc = null;
let controlChannel = null;
let signalEvents = null;
let connectGeneration = 0;
let pendingRemoteIceCandidates = [];

function serializeIceCandidate(candidate) {
  if (!candidate) return null;
  if (typeof candidate.toJSON === "function") return candidate.toJSON();
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment
  };
}

async function applyIceCandidate(peerConnection, raw) {
  if (!peerConnection) return;
  try {
    if (raw == null) {
      await peerConnection.addIceCandidate(null);
      return;
    }
    await peerConnection.addIceCandidate(raw);
  } catch (err) {
    console.warn("ICE candidate skipped:", err?.message || String(err));
  }
}

async function flushIceCandidateQueue(peerConnection) {
  if (!peerConnection || pendingRemoteIceCandidates.length === 0) return;
  const batch = pendingRemoteIceCandidates.splice(
    0,
    pendingRemoteIceCandidates.length
  );
  for (const raw of batch) {
    await applyIceCandidate(peerConnection, raw);
  }
}

function persistViewerSession() {
  try {
    sessionStorage.setItem(
      "remoteControlViewer",
      JSON.stringify({ sessionKey })
    );
  } catch {
    /* ignore */
  }
  void chrome.storage.local.set({ sessionKey });
}

/** Long timeout: cheap hosts return slowly when asleep; wakeup pages are often HTML, not JSON. */
const SIGNALING_FETCH_MS = 120000;

async function fetchSessionStatusProbe(key) {
  const base = String(SIGNALING_URL || "").replace(/\/+$/, "");
  const url = `${base}/session/status?sessionKey=${encodeURIComponent(key)}`;
  const init =
    typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.timeout === "function"
      ? { signal: AbortSignal.timeout(SIGNALING_FETCH_MS) }
      : {};
  try {
    const r = await fetch(url, init);
    const text = await r.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        return { transient: true, status: r.status };
      }
    }
    return { transient: false, ok: r.ok, data, status: r.status };
  } catch {
    return { transient: true };
  }
}

function coldStartMessaging() {
  const u = SIGNALING_URL || "";
  const hosted =
    /onrender\.com|render\.com|railway|fly\.dev|^\s*https:\/\//i.test(u);
  return hosted
    ? " Hosted signaling may be waking up — first response can take 30–120s."
    : "";
}

function unreachableMessaging() {
  const base = String(SIGNALING_URL || "").replace(/\/+$/, "");
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(base);
  return local
    ? ` Cannot reach signaling at ${SIGNALING_URL}. Run node server/signaling.js locally and match signaling-config.js on host and viewer.`
    : ` Cannot reach signaling at ${SIGNALING_URL}. Confirm ${base}/health in a browser returns JSON and reload the extension. For Render free tier, retry after waking the service.${coldStartMessaging()}`;
}

function setBanner(kind, message) {
  if (!message) {
    bannerEl.className = "";
    bannerEl.textContent = "";
    bannerEl.classList.remove("show");
    return;
  }
  bannerEl.className = `show ${kind}`;
  bannerEl.textContent = message;
}

function setStatus(text, dot = "busy") {
  statusTextEl.innerHTML = text;
  statusDotEl.className = dot;
}

async function postSignal(message) {
  const res = await fetch(`${SIGNALING_URL}/signal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionKey, ...message })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Signal failed (${res.status})`);
  }
  return data;
}

function applyRemoteCursor(css) {
  if (!videoEl) return;
  let c = String(css ?? "").trim();
  if (!c) {
    videoEl.style.cursor = "";
    return;
  }
  if (/url\s*\(/i.test(c)) {
    c = "default";
  }
  videoEl.style.cursor = c;
}

function syncFullscreenLabel() {
  if (!fullscreenBtn || !videoStageEl) return;
  fullscreenBtn.textContent =
    document.fullscreenElement === videoStageEl ? "Exit fullscreen" : "Fullscreen";
}

async function toggleVideoFullscreen() {
  if (!videoStageEl) return;
  try {
    if (document.fullscreenElement === videoStageEl) {
      await document.exitFullscreen();
    } else {
      await videoStageEl.requestFullscreen();
    }
  } catch (err) {
    console.warn("Fullscreen:", err);
  }
}

document.addEventListener("fullscreenchange", syncFullscreenLabel);

function closePeer() {
  applyRemoteCursor("");
  pendingRemoteIceCandidates = [];
  if (videoStageEl && document.fullscreenElement === videoStageEl) {
    void document.exitFullscreen().catch(() => {});
  }
  if (signalEvents) {
    signalEvents.close();
    signalEvents = null;
  }
  if (controlChannel) {
    try {
      controlChannel.close();
    } catch {
      /* ignore */
    }
    controlChannel = null;
  }
  if (pc) {
    try {
      pc.close();
    } catch {
      /* ignore */
    }
    pc = null;
  }
  if (videoEl.srcObject) {
    videoEl.srcObject.getTracks().forEach((t) => t.stop());
    videoEl.srcObject = null;
  }
}

function attachSignalListener(gen) {
  if (signalEvents) {
    signalEvents.close();
    signalEvents = null;
  }
  const events = new EventSource(
    `${SIGNALING_URL}/events?id=${encodeURIComponent(peerId)}&sessionKey=${encodeURIComponent(sessionKey)}`
  );
  signalEvents = events;
  events.onerror = () => {
    if (gen !== connectGeneration) return;
    setBanner(
      "error",
      "Lost connection to signaling server. Check signaling-config.js and that the node server is reachable."
    );
    setStatus("<strong>Offline</strong> — check signaling server.", "bad");
  };
  events.onmessage = async (event) => {
    if (gen !== connectGeneration || !pc) return;
    const msg = JSON.parse(event.data);

    if (msg.type === "answer") {
      if (pc.signalingState !== "have-local-offer") {
        return;
      }
      try {
        await pc.setRemoteDescription(msg.payload);
        await flushIceCandidateQueue(pc);
        setBanner("", "");
        setStatus(`<strong>Connected</strong> — host <span class="mono">${msg.from}</span>`, "ok");
      } catch (err) {
        console.error(err);
        pendingRemoteIceCandidates = [];
        setBanner("error", "Handshake failed. Click Reconnect or refresh the host page.");
        setStatus("<strong>Error</strong> — could not apply answer.", "bad");
      }
      return;
    }

    if (msg.type === "candidate") {
      if (!pc.remoteDescription) {
        pendingRemoteIceCandidates.push(msg.payload);
        return;
      }
      await applyIceCandidate(pc, msg.payload);
    }
  };
}

function wireControls() {
  /**
   * Map pointer to remote coords. Accounts for object-fit: letterboxing inside the video element
   * (using the full rect before caused clicks to land offset from what you see).
   */
  function pointPayload(e) {
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    if (!vw || !vh) return null;
    const rect = videoEl.getBoundingClientRect();
    const rw = rect.width;
    const rh = rect.height;
    if (rw <= 0 || rh <= 0) return null;

    const scale = Math.min(rw / vw, rh / vh);
    const dispW = vw * scale;
    const dispH = vh * scale;
    const offLeft = rect.left + (rw - dispW) / 2;
    const offTop = rect.top + (rh - dispH) / 2;

    let nx = (e.clientX - offLeft) / dispW;
    let ny = (e.clientY - offTop) / dispH;
    nx = Math.max(0, Math.min(1, nx));
    ny = Math.max(0, Math.min(1, ny));

    const x = Math.round(nx * vw);
    const y = Math.round(ny * vh);
    return {
      x,
      y,
      nx: Number(nx.toFixed(5)),
      ny: Number(ny.toFixed(5))
    };
  }

  function modifiersFrom(e) {
    return {
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey
    };
  }

  function sendControl(payload) {
    if (!controlChannel || controlChannel.readyState !== "open") return;
    controlChannel.send(JSON.stringify(payload));
  }

  let moveRaf = null;
  let latestMoveEvent = null;
  videoEl.addEventListener("mousemove", (e) => {
    if (!controlChannel || controlChannel.readyState !== "open") return;
    latestMoveEvent = e;
    if (moveRaf !== null) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = null;
      const ev = latestMoveEvent;
      latestMoveEvent = null;
      if (!ev || !controlChannel || controlChannel.readyState !== "open") return;
      const p = pointPayload(ev);
      if (!p) return;
      sendControl({
        type: "move",
        ...p,
        buttons: ev.buttons,
        ...modifiersFrom(ev)
      });
    });
  });

  videoEl.addEventListener("pointerdown", (e) => {
    if (typeof videoEl.setPointerCapture !== "function") return;
    try {
      videoEl.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });
  videoEl.addEventListener("pointerup", (e) => {
    if (typeof videoEl.releasePointerCapture !== "function") return;
    try {
      videoEl.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });

  videoEl.addEventListener("mousedown", (e) => {
    const p = pointPayload(e);
    if (!p) return;
    e.preventDefault();
    /* Hover/open menus update from move; priming avoids presses hitting the wrong target. */
    sendControl({
      type: "move",
      ...p,
      buttons: 0,
      ...modifiersFrom(e)
    });
    sendControl({
      type: "mousedown",
      ...p,
      button: e.button,
      buttons: e.buttons,
      ...modifiersFrom(e)
    });
  });

  videoEl.addEventListener("mouseup", (e) => {
    const p = pointPayload(e);
    if (!p) return;
    e.preventDefault();
    sendControl({
      type: "mouseup",
      ...p,
      button: e.button,
      buttons: e.buttons,
      ...modifiersFrom(e)
    });
  });

  videoEl.addEventListener("click", (e) => {
    const p = pointPayload(e);
    if (!p) return;
    e.preventDefault();
    sendControl({
      type: "click",
      ...p,
      button: e.button,
      buttons: e.buttons,
      detail: e.detail,
      ...modifiersFrom(e)
    });
  });

  videoEl.addEventListener("dblclick", (e) => {
    const p = pointPayload(e);
    if (!p) return;
    e.preventDefault();
    sendControl({
      type: "dblclick",
      ...p,
      button: e.button,
      ...modifiersFrom(e)
    });
  });

  videoEl.addEventListener("contextmenu", (e) => {
    const p = pointPayload(e);
    if (!p) return;
    e.preventDefault();
    sendControl({
      type: "move",
      ...p,
      buttons: 0,
      ...modifiersFrom(e)
    });
    sendControl({
      type: "contextmenu",
      ...p,
      button: 2,
      buttons: e.buttons,
      ...modifiersFrom(e)
    });
  });

  videoEl.addEventListener(
    "wheel",
    (e) => {
      if (!controlChannel || controlChannel.readyState !== "open") return;
      const p = pointPayload(e);
      if (!p) return;
      e.preventDefault();
      sendControl({
        type: "wheel",
        ...p,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaZ: e.deltaZ,
        deltaMode: e.deltaMode,
        ...modifiersFrom(e)
      });
    },
    { passive: false }
  );

  window.addEventListener("keydown", (e) => {
    if (!controlChannel || controlChannel.readyState !== "open") return;
    const payload = {
      type: "key",
      action: "down",
      key: e.key,
      code: e.code,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      repeat: !!e.repeat
    };
    controlChannel.send(JSON.stringify(payload));
    /* Route shortcuts (Cmd/Ctrl+A etc.) to remote tab; suppress local viewer chrome stealing keys. */
    if (!e.metaKey || e.key.length === 1) {
      e.preventDefault();
    }
  });

  window.addEventListener("keyup", (e) => {
    if (!controlChannel || controlChannel.readyState !== "open") return;
    const payload = {
      type: "key",
      action: "up",
      key: e.key,
      code: e.code,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      repeat: false
    };
    controlChannel.send(JSON.stringify(payload));
    if (!e.metaKey || e.key.length === 1) {
      e.preventDefault();
    }
  });
}

async function registerViewerSession() {
  const base = String(SIGNALING_URL || "").replace(/\/+$/, "");
  const res = await fetch(`${base}/session/viewer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionKey,
      hostPeerId: targetId,
      viewerPeerId: peerId
    })
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 404) {
    if (data.hint) {
      throw new Error(
        `${data.error || "Not found"} — ${data.hint} (check ${base}/health)`
      );
    }
    throw new Error("SESSION_MISSING");
  }
  if (!res.ok) {
    throw new Error(data.error || `Viewer registration failed (${res.status})`);
  }
}

async function waitForSessionRegistration(timeoutMs = 180000) {
  const start = Date.now();
  setBanner("info", "Waiting for host session to be created…");
  setStatus("<strong>Waiting</strong> — host must open host page first.", "busy");

  while (Date.now() - start < timeoutMs) {
    const result = await fetchSessionStatusProbe(sessionKey);
    if (result.transient) {
      setBanner(
        "info",
        `Contacting signaling…${coldStartMessaging()}`.trim()
      );
      await new Promise((r) => setTimeout(r, 2500));
      continue;
    }
    if (!result.ok || !result.data || result.data.ok === false) {
      await new Promise((r) => setTimeout(r, 600));
      continue;
    }
    if (result.data.sessionExists) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const lastProbe = await fetchSessionStatusProbe(sessionKey);
  if (lastProbe.transient) {
    setBanner("error", unreachableMessaging());
    setStatus("<strong>Offline</strong> — signaling unreachable.", "bad");
    return false;
  }

  setBanner("error", "Session code was not found in time. Ask host to open host page and share this 8-digit code.");
  setStatus("<strong>Timeout</strong> — session not created.", "bad");
  return false;
}

async function waitForHostListening(timeoutMs = 180000) {
  const start = Date.now();
  setBanner("info", "Waiting for host to come online and open signaling…");
  setStatus("<strong>Waiting</strong> — host must start sharing first.", "busy");

  while (Date.now() - start < timeoutMs) {
    const result = await fetchSessionStatusProbe(sessionKey);
    if (result.transient) {
      setBanner(
        "info",
        `Contacting signaling…${coldStartMessaging()}`.trim()
      );
      setStatus("<strong>Waiting</strong> — retrying signaling…", "busy");
      await new Promise((r) => setTimeout(r, 2500));
      continue;
    }

    const data = result.data;
    if (!data || data.ok === false) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }

    if (!data.sessionExists) {
      setBanner(
        "warn",
        "No session found for this code. Confirm the host opened from the same popup session code, or ask them to share a new code."
      );
      setStatus("<strong>Host missing</strong> — session not registered yet.", "bad");
    } else if (!data.hostListening) {
      setBanner(
        "info",
        "Session is registered but the host is not listening yet. On the host machine click “Start sharing”."
      );
      setStatus("<strong>Waiting</strong> — host not on signaling yet.", "busy");
    } else {
      setBanner("", "");
      return true;
    }

    await new Promise((r) => setTimeout(r, 450));
  }

  const lastProbe = await fetchSessionStatusProbe(sessionKey);
  if (lastProbe.transient) {
    setBanner("error", unreachableMessaging());
    setStatus("<strong>Offline</strong> — signaling unreachable.", "bad");
    return false;
  }

  setBanner(
    "error",
    "Timed out waiting for the host. Ensure the host tab is open, session code matches, and signaling server is running."
  );
  setStatus("<strong>Timeout</strong> — host unavailable.", "bad");
  return false;
}

async function startViewer() {
  connectGeneration += 1;
  const gen = connectGeneration;
  closePeer();

  if (!/^\d{8}$/.test(sessionKey)) {
    setBanner("error", "Invalid session code. Enter 8 digit session code.");
    setStatus("<strong>Security</strong> — invalid session code.", "bad");
    return;
  }
  peerId = `viewer-${sessionKey}`;
  targetId = `host-${sessionKey}`;

  persistViewerSession();

  try {
    await registerViewerSession();
  } catch (err) {
    if (err.message === "SESSION_MISSING") {
      const sessionReady = await waitForSessionRegistration();
      if (!sessionReady || gen !== connectGeneration) {
        return;
      }
      try {
        await registerViewerSession();
      } catch (retryErr) {
        setBanner("error", retryErr.message || "Could not join session.");
        setStatus("<strong>Error</strong> — session join failed.", "bad");
        return;
      }
    } else {
      setBanner("error", err.message || "Could not join session.");
      setStatus("<strong>Error</strong> — session join failed.", "bad");
      return;
    }
  }

  const hostUp = await waitForHostListening();
  if (!hostUp || gen !== connectGeneration) {
    return;
  }

  pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  pc.addTransceiver("video", { direction: "recvonly" });

  pc.ontrack = (event) => {
    videoEl.srcObject = event.streams[0];
    void videoEl.play().catch(() => {});
    setStatus("<strong>Streaming</strong> — remote video track received.", "ok");
  };

  controlChannel = pc.createDataChannel("control", {
    ordered: true
  });
  controlChannel.onopen = () => {
    setStatus("<strong>Connected</strong> — control channel ready.", "ok");
  };
  controlChannel.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "remoteCursor" && typeof msg.cursor === "string") {
        applyRemoteCursor(msg.cursor);
      }
    } catch {
      /* ignore non-JSON */
    }
  };
  controlChannel.onclose = () => {
    applyRemoteCursor("");
    if (gen !== connectGeneration) return;
    setStatus("<strong>Control</strong> — channel closed. Try Reconnect.", "bad");
  };
  controlChannel.onerror = () => {
    setStatus("<strong>Control</strong> — channel error.", "bad");
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    const payload = serializeIceCandidate(event.candidate);
    if (!payload) return;
    void postSignal({
      to: targetId,
      from: peerId,
      type: "candidate",
      payload
    }).catch((err) => console.warn("ICE signal:", err));
  };

  attachSignalListener(gen);

  pc.onconnectionstatechange = () => {
    if (gen !== connectGeneration) return;
    const state = pc.connectionState;
    if (state === "failed" || state === "disconnected") {
      setBanner("warn", "WebRTC connection dropped. Click Reconnect.");
      setStatus(`<strong>WebRTC</strong> — ${state}.`, "bad");
    } else if (state === "connected") {
      setStatus("<strong>WebRTC</strong> — connected.", "ok");
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sig = await postSignal({
      to: targetId,
      from: peerId,
      type: "offer",
      payload: offer
    });
    if (sig && sig.delivered === 0) {
      setBanner(
        "error",
        "Host is not receiving signaling (delivered to 0 peers). Ensure host clicked Start sharing and both sides use the same 8-digit session code."
      );
      setStatus("<strong>Unreachable</strong> — host not listening for this target ID.", "bad");
      return;
    }
    setStatus(`<strong>Handshake</strong> — offer sent to <span class="mono">${targetId}</span>.`, "busy");
  } catch (err) {
    console.error(err);
    setBanner("error", err.message || "Could not send offer.");
    setStatus("<strong>Error</strong> — signaling failed.", "bad");
  }
}

wireControls();
if (fullscreenBtn) {
  fullscreenBtn.addEventListener("click", () => {
    void toggleVideoFullscreen();
  });
}
reconnectBtn.addEventListener("click", () => {
  void startViewer();
});

async function bootstrapViewer() {
  try {
    SIGNALING_URL =
      typeof globalThis.__REMOTE_ACCESS_RESOLVE_SIGNALING__ === "function"
        ? await globalThis.__REMOTE_ACCESS_RESOLVE_SIGNALING__()
        : SIGNALING_URL;
  } catch (err) {
    console.warn("Signaling resolve failed:", err);
  }
  SIGNALING_URL = String(SIGNALING_URL || "").replace(/\/+$/, "");
  syncSessionChrome();
  void startViewer();
}

void bootstrapViewer();
