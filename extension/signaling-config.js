// Set your signaling server URL here (only place the extension reads from code). No trailing slash.
// Same URL must be reachable from every PC that loads this extension build.
// Examples:
//   This PC only:                 "http://localhost:3000"
//   Wi‑Fi / LAN (host PC's IP):    "http://192.168.1.10:3000"
//   Production / tunnel:          "https://signal.example.com"
globalThis.__REMOTE_ACCESS_SIGNALING__ = "http://localhost:3000";
