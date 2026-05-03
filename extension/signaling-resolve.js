(function signalingResolve() {
  function normalizeSignalingUrl(raw) {
    const s = String(raw ?? "").trim();
    if (!s) return "";
    let urlStr = s.replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(urlStr)) urlStr = `http://${urlStr}`;
    try {
      const u = new URL(urlStr);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      return u.origin;
    } catch {
      return "";
    }
  }

  /** URL comes only from signaling-config.js (globalThis.__REMOTE_ACCESS_SIGNALING__). */
  async function resolveSignalingUrlFromConfig() {
    const cfg =
      typeof globalThis.__REMOTE_ACCESS_SIGNALING__ === "string"
        ? globalThis.__REMOTE_ACCESS_SIGNALING__.trim()
        : "";
    if (cfg) {
      const n = normalizeSignalingUrl(cfg);
      if (n) return n;
    }
    return "http://localhost:3000";
  }

  globalThis.__REMOTE_ACCESS_NORMALIZE_SIGNALING_URL__ = normalizeSignalingUrl;
  globalThis.__REMOTE_ACCESS_RESOLVE_SIGNALING__ = resolveSignalingUrlFromConfig;
})();
