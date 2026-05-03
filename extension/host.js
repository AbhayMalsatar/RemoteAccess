let SIGNALING_URL = "http://localhost:3000";
const statusEl = document.getElementById("status");
const startBtn = document.getElementById("startBtn");
const previewEl = document.getElementById("preview");
const tabSelectEl = document.getElementById("tabSelect");
const refreshTabsBtn = document.getElementById("refreshTabsBtn");
const metaPeerEl = document.getElementById("metaPeer");
const metaTargetEl = document.getElementById("metaTarget");
const metaSessionEl = document.getElementById("metaSession");
const captureBadgeEl = document.getElementById("captureBadge");
const tabControlHelpEl = document.getElementById("tabControlHelp");
const signalingHintEl = document.getElementById("signalingHint");

const query = new URLSearchParams(window.location.search);
const sessionKey = query.get("sessionKey") || "";
const peerId = sessionKey ? `host-${sessionKey}` : "";
const targetId = sessionKey ? `viewer-${sessionKey}` : "";

if (metaPeerEl) metaPeerEl.textContent = peerId || "—";
if (metaTargetEl) metaTargetEl.textContent = targetId || "—";
if (metaSessionEl) metaSessionEl.textContent = sessionKey || "—";

let pc;
let controlChannel;
let nativePort;
let selectedTabId = null;
let captureMode = "unknown";
let signalEvents = null;
let isStarting = false;
let lastSentRemoteCursor = "";
/** ICE candidates received before setRemoteDescription (offer) — applying early throws DOMException. */
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

function setStatus(text, tone = "neutral") {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.remove("ok", "warn", "bad");
  if (tone === "ok") statusEl.classList.add("ok");
  else if (tone === "warn") statusEl.classList.add("warn");
  else if (tone === "bad") statusEl.classList.add("bad");
}

function modeLabel(mode) {
  if (mode === "browser") return "Browser tab";
  if (mode === "window") return "App window";
  if (mode === "monitor") return "Full screen";
  return "Not sharing";
}

function updateCaptureUi() {
  if (captureBadgeEl) {
    captureBadgeEl.textContent = modeLabel(captureMode);
    captureBadgeEl.className =
      captureMode === "unknown" ? "idle" : "on live";
  }
  const tabRowActive =
    captureMode === "unknown" || captureMode === "browser";
  if (tabSelectEl) {
    tabSelectEl.disabled = !tabRowActive;
    tabSelectEl.setAttribute("aria-disabled", tabRowActive ? "false" : "true");
  }
  if (refreshTabsBtn) {
    refreshTabsBtn.disabled = !tabRowActive;
  }
  if (tabControlHelpEl) {
    if (captureMode === "unknown") {
      tabControlHelpEl.textContent =
        "When you share a Chrome tab, remote clicks and keys go to the tab you select below. If you share a window or the whole screen, use the native host for OS-level control.";
    } else if (captureMode === "browser") {
      tabControlHelpEl.textContent =
        "Injection targets the selected tab. Refresh the list after opening new pages. Hover an option to see the full URL.";
    } else {
      tabControlHelpEl.textContent =
        "Tab injection is disabled for this capture type. The native messaging host drives the shared window or display.";
    }
  }
}

function closeHostRuntime() {
  captureMode = "unknown";
  lastSentRemoteCursor = "";
  pendingRemoteIceCandidates = [];
  updateCaptureUi();
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
  if (previewEl.srcObject) {
    previewEl.srcObject.getTracks().forEach((t) => t.stop());
    previewEl.srcObject = null;
  }
}

function connectNative() {
  if (nativePort) return;
  try {
    nativePort = chrome.runtime.connectNative("com.remote.control");
    if (chrome.runtime.lastError) {
      console.warn("Native messaging:", chrome.runtime.lastError.message);
      nativePort = null;
      return;
    }
    nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      setStatus(err ? `Native host disconnected: ${err.message}` : "Native host disconnected.");
      nativePort = null;
    });
  } catch (err) {
    console.warn("Native messaging unavailable:", err);
  }
}

function truncateLabel(s, max = 72) {
  if (!s || s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

async function refreshControllableTabs() {
  const tabs = await chrome.tabs.query({});
  const filtered = tabs.filter((tab) => {
    if (!tab.id || !tab.url || !tab.title) return false;
    if (tab.url.startsWith("chrome://")) return false;
    if (tab.url.startsWith("chrome-extension://")) return false;
    return true;
  });

  tabSelectEl.innerHTML = "";

  if (filtered.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.disabled = true;
    opt.selected = true;
    opt.textContent = "No controllable tabs — open a normal page in another tab";
    tabSelectEl.appendChild(opt);
    selectedTabId = null;
    return;
  }

  for (const tab of filtered) {
    const option = document.createElement("option");
    option.value = String(tab.id);
    const title = tab.title || "Untitled";
    option.textContent = truncateLabel(title, 78);
    option.title = `${tab.title}\n${tab.url}`;
    tabSelectEl.appendChild(option);
  }

  const preferred =
    selectedTabId && filtered.some((t) => t.id === selectedTabId)
      ? selectedTabId
      : filtered[0].id;
  selectedTabId = preferred;
  tabSelectEl.value = String(preferred);
}

async function autoSelectCapturedTab(stream) {
  const [videoTrack] = stream.getVideoTracks();
  const label = (videoTrack && videoTrack.label) ? videoTrack.label.toLowerCase() : "";
  if (!label) return false;

  const tabs = await chrome.tabs.query({});
  const candidates = tabs.filter((tab) => {
    if (!tab.id || !tab.title || !tab.url) return false;
    if (tab.url.startsWith("chrome://")) return false;
    if (tab.url.startsWith("chrome-extension://")) return false;
    return true;
  });

  // Desktop-captured browser tabs usually include the tab title in track label.
  const exact = candidates.find((tab) => label.includes(tab.title.toLowerCase()));
  if (!exact) return false;

  selectedTabId = exact.id;
  tabSelectEl.value = String(exact.id);
  return true;
}

async function sendControlToTab(controlEvent) {
  if (!selectedTabId) return;
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId: selectedTabId },
      func: (eventPayload) => {
        function updateLastPoint(x, y) {
          window.__remoteControlLastPoint = { x, y };
        }

        function getLastPoint() {
          return window.__remoteControlLastPoint || {
            x: Math.floor(window.innerWidth / 2),
            y: Math.floor(window.innerHeight / 2)
          };
        }

        /** Walk ancestors until a non-auto cursor (inputs, links, resize handles). */
        function effectiveCursor(startEl) {
          let el = startEl;
          for (let depth = 0; depth < 36 && el && el.nodeType === 1; depth++) {
            const c = window.getComputedStyle(el).cursor;
            if (c && c !== "auto") return c;
            el = el.parentElement;
          }
          return "default";
        }

        const EDITABLE_SELECTOR =
          'input:not([type="hidden"]):not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled]), [contenteditable="true"]';

        function pickEditableIn(root) {
          if (!root || root.nodeType !== 1) return null;
          const direct = root.matches && root.matches(EDITABLE_SELECTOR) ? root : null;
          if (direct) return direct;
          return root.querySelector(EDITABLE_SELECTOR) || null;
        }

        function isEditableSurface(el) {
          if (!el) return false;
          if (el instanceof HTMLSelectElement) return !el.disabled;
          if (el instanceof HTMLInputElement) {
            if (el.disabled || el.readOnly || el.type === "hidden") return false;
            return true;
          }
          if (el instanceof HTMLTextAreaElement) {
            return !el.disabled && !el.readOnly;
          }
          if (el.isContentEditable) return true;
          return false;
        }

        function resolveTargetForKeyboard() {
          const active = document.activeElement;
          const agEditorRoot =
            active &&
            active.closest &&
            active.closest(
              ".ag-popup-editor, .ag-cell-inline-editing, .ag-rich-select-cell-editor, .ag-large-text, .ag-cell-editor, .ag-popup-child"
            );
          if (agEditorRoot) {
            const inp = pickEditableIn(agEditorRoot);
            if (inp) return inp;
          }

          if (
            active &&
            active !== document.body &&
            active !== document.documentElement
          ) {
            if (
              active instanceof HTMLInputElement ||
              active instanceof HTMLTextAreaElement ||
              active instanceof HTMLSelectElement ||
              active.isContentEditable
            ) {
              return active;
            }
            const inner = pickEditableIn(active);
            if (inner) return inner;
            /* Focused gridcell/div/button/etc.: arrows & Enter must hit this node, not elementFromPoint. */
            return active;
          }

          const p = getLastPoint();
          let el = document.elementFromPoint(p.x, p.y) || document.body;
          const cell =
            el.closest &&
            el.closest('[role="gridcell"], .ag-cell, .ag-cell-value, [col-id]');
          if (cell) {
            const editingHost =
              cell.closest &&
              cell.closest(".ag-cell-inline-editing, .ag-row-editing");
            if (editingHost) {
              const inHost = pickEditableIn(editingHost);
              if (inHost) return inHost;
            }
            const inCell = pickEditableIn(cell);
            if (inCell) return inCell;
            const popupInput = document.querySelector(
              ".ag-popup-editor " +
                EDITABLE_SELECTOR.split(",")
                  .map((s) => s.trim())
                  .join(", .ag-popup-editor ") +
                ", .ag-large-text textarea"
            );
            if (
              popupInput &&
              popupInput.ownerDocument.contains(popupInput) &&
              popupInput.getClientRects().length > 0
            ) {
              return popupInput;
            }
          }
          return el;
        }

        function emitFocusin(el) {
          if (!el || typeof el.dispatchEvent !== "function") return;
          try {
            el.dispatchEvent(new FocusEvent("focusin", { bubbles: true, cancelable: true }));
          } catch {
            /* ignore */
          }
        }

        function focusIfNeeded(el) {
          if (!el || typeof el.focus !== "function") return;
          if (document.activeElement === el) return;
          el.focus({ preventScroll: true });
          emitFocusin(el);
        }

        /** Walk up from hit target to something focusable for keyboard + widget hooks (grid cells, tabs, RS control). */
        function interactiveFocusAncestor(hitEl) {
          let n = hitEl;
          for (let d = 0; d < 30 && n && n.nodeType === 1; d++) {
            if (!(n instanceof HTMLElement)) break;
            if ("disabled" in n && n.disabled) {
              n = n.parentElement;
              continue;
            }
            const tag = n.tagName;
            if (tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA") return n;
            if (tag === "INPUT" && n.type !== "hidden") return n;
            if (tag === "A" && n.hasAttribute("href")) return n;
            if (n.isContentEditable) return n;
            const ti = n.tabIndex;
            if (typeof ti === "number" && ti >= 0) return n;
            const role = n.getAttribute && n.getAttribute("role");
            if (
              role &&
              /^(button|combobox|gridcell|columnheader|row|tab|menuitem|option|switch|checkbox|radio|link|treeitem|textbox)$/i.test(
                role
              )
            ) {
              return n;
            }
            if (
              n.classList &&
              (n.classList.contains("ag-cell") ||
                n.classList.contains("ag-header-cell"))
            ) {
              return n;
            }
            n = n.parentElement;
          }
          return hitEl instanceof HTMLElement ? hitEl : document.body;
        }

        function findReactSelectCombo(hitEl) {
          if (!hitEl || !hitEl.closest) return null;
          return (
            hitEl.closest('[role="combobox"]') ||
            hitEl.closest("[class*='__control']") ||
            hitEl.closest(".react-select__control") ||
            null
          );
        }

        /** Libraries attach listeners to focused nodes (RS hidden input), grid cells, tabindex wrappers — align focus after hit. */
        function focusBestPointerTarget(hitEl, button) {
          if (!(hitEl instanceof HTMLElement) || button !== 0) return;

          const inOverlay =
            hitEl.closest &&
            hitEl.closest(
              '[role="listbox"], [role="menu"], .ag-popup, [class*="__menu"], [class*="MenuList"], [class*="menu-list"]'
            );
          if (inOverlay) {
            focusIfNeeded(interactiveFocusAncestor(hitEl));
            return;
          }

          const agEdit =
            hitEl.closest &&
            hitEl.closest(".ag-popup-editor, .ag-cell-inline-editing");
          if (agEdit) {
            const inp = pickEditableIn(agEdit);
            if (inp) {
              focusIfNeeded(inp);
              return;
            }
          }

          const combo = findReactSelectCombo(hitEl);
          if (combo && combo.contains(hitEl)) {
            const inp =
              combo.querySelector(
                'input[aria-autocomplete="list"], input[aria-autocomplete], textarea:not([aria-hidden="true"]), input:not([type="hidden"]):not([readonly])'
              );
            if (inp) {
              focusIfNeeded(inp);
              return;
            }
            focusIfNeeded(combo);
            return;
          }

          focusIfNeeded(interactiveFocusAncestor(hitEl));
        }

        /** Some grids/widgets still read legacy keyCode/which on synthetic KeyboardEvents. */
        function legacyKeyInit(key, code) {
          const table = {
            ArrowLeft: 37,
            ArrowUp: 38,
            ArrowRight: 39,
            ArrowDown: 40,
            Enter: 13,
            NumpadEnter: 13,
            Escape: 27,
            Tab: 9,
            Backspace: 8,
            Delete: 46,
            Home: 36,
            End: 35,
            PageUp: 33,
            PageDown: 34,
            " ": 32
          };
          const kn = table[key] ?? table[code];
          if (kn != null) return { keyCode: kn, which: kn };
          if (key && key.length === 1) {
            const uc = key.toUpperCase().charCodeAt(0);
            return { keyCode: uc, which: uc };
          }
          return {};
        }

        function dispatchBeforeInputSurface(target, inputType, data) {
          try {
            const ev = new InputEvent("beforeinput", {
              bubbles: true,
              cancelable: true,
              composed: true,
              inputType,
              data: data == null ? null : String(data)
            });
            return target.dispatchEvent(ev);
          } catch {
            return true;
          }
        }

        function dispatchInputSurface(target, inputType, data) {
          try {
            target.dispatchEvent(
              new InputEvent("input", {
                bubbles: true,
                cancelable: false,
                composed: true,
                inputType,
                data: data == null ? null : String(data)
              })
            );
          } catch {
            target.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }

        function insertTextLikeUser(target, text) {
          if (!target) return false;
          const isInput =
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement;
          const isEditable = target.isContentEditable;
          const isLineBreak =
            text === "\n" && target instanceof HTMLTextAreaElement;
          const beforeType = isLineBreak ? "insertLineBreak" : "insertText";
          const beforeData = isLineBreak ? "\n" : text;

          if (isInput) {
            if (!dispatchBeforeInputSurface(target, beforeType, beforeData)) return false;
            const value = target.value || "";
            const start =
              typeof target.selectionStart === "number"
                ? target.selectionStart
                : value.length;
            const end =
              typeof target.selectionEnd === "number"
                ? target.selectionEnd
                : value.length;
            target.value = value.slice(0, start) + text + value.slice(end);
            const nextPos = start + text.length;
            target.selectionStart = nextPos;
            target.selectionEnd = nextPos;
            dispatchInputSurface(target, beforeType, beforeData);
            return true;
          }

          if (isEditable) {
            if (!dispatchBeforeInputSurface(target, beforeType, beforeData)) return false;
            document.execCommand("insertText", false, text);
            dispatchInputSurface(target, beforeType, beforeData);
            return true;
          }

          return false;
        }

        function deleteBackwardLikeUser(target) {
          if (!target) return false;
          const isInput =
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement;
          const isEditable = target.isContentEditable;

          if (isInput) {
            if (!dispatchBeforeInputSurface(target, "deleteContentBackward", null))
              return false;
            const value = target.value || "";
            let start =
              typeof target.selectionStart === "number"
                ? target.selectionStart
                : value.length;
            const end =
              typeof target.selectionEnd === "number"
                ? target.selectionEnd
                : value.length;

            if (start === end && start > 0) {
              start -= 1;
            }
            target.value = value.slice(0, start) + value.slice(end);
            target.selectionStart = start;
            target.selectionEnd = start;
            dispatchInputSurface(target, "deleteContentBackward", null);
            return true;
          }

          if (isEditable) {
            if (!dispatchBeforeInputSurface(target, "deleteContentBackward", null))
              return false;
            document.execCommand("delete", false);
            dispatchInputSurface(target, "deleteContentBackward", null);
            return true;
          }

          return false;
        }

        function deleteForwardLikeUser(target) {
          if (!target) return false;
          const isInput =
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement;
          const isEditable = target.isContentEditable;

          if (isInput) {
            if (!dispatchBeforeInputSurface(target, "deleteContentForward", null))
              return false;
            const value = target.value || "";
            let start =
              typeof target.selectionStart === "number"
                ? target.selectionStart
                : value.length;
            let end =
              typeof target.selectionEnd === "number"
                ? target.selectionEnd
                : value.length;
            if (start === end && end < value.length) {
              end += 1;
            }
            target.value = value.slice(0, start) + value.slice(end);
            target.selectionStart = start;
            target.selectionEnd = start;
            dispatchInputSurface(target, "deleteContentForward", null);
            return true;
          }

          if (isEditable) {
            if (!dispatchBeforeInputSurface(target, "deleteContentForward", null))
              return false;
            document.execCommand("forwardDelete", false);
            dispatchInputSurface(target, "deleteContentForward", null);
            return true;
          }

          return false;
        }

        function nearestScrollable(el) {
          let n = el;
          for (let i = 0; i < 32 && n; i++) {
            if (!(n instanceof Element)) break;
            const st = window.getComputedStyle(n);
            const oy = st.overflowY;
            const ox = st.overflowX;
            const canY =
              (oy === "auto" || oy === "scroll" || oy === "overlay") &&
              n.scrollHeight > n.clientHeight + 1;
            const canX =
              (ox === "auto" || ox === "scroll" || ox === "overlay") &&
              n.scrollWidth > n.clientWidth + 1;
            if (canY || canX) return n;
            n = n.parentElement;
          }
          return document.scrollingElement || document.documentElement;
        }

        function mouseBase(viewportX, viewportY, payload) {
          return {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: viewportX,
            clientY: viewportY,
            button: typeof payload.button === "number" ? payload.button : 0,
            buttons: typeof payload.buttons === "number" ? payload.buttons : 0,
            ctrlKey: !!payload.ctrlKey,
            shiftKey: !!payload.shiftKey,
            altKey: !!payload.altKey,
            metaKey: !!payload.metaKey
          };
        }

        function pointerInit(viewportX, viewportY, payload, overrides) {
          const btn = typeof payload.button === "number" ? payload.button : 0;
          const buttons = typeof payload.buttons === "number" ? payload.buttons : 0;
          return {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: viewportX,
            clientY: viewportY,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
            button: btn,
            buttons,
            ctrlKey: !!payload.ctrlKey,
            shiftKey: !!payload.shiftKey,
            altKey: !!payload.altKey,
            metaKey: !!payload.metaKey,
            pressure: buttons ? 0.5 : 0,
            ...overrides
          };
        }

        function dispatchPointerOn(el, type, viewportX, viewportY, payload, overrides) {
          if (typeof PointerEvent === "undefined" || !el) return;
          try {
            el.dispatchEvent(
              new PointerEvent(type, pointerInit(viewportX, viewportY, payload, overrides))
            );
          } catch {
            /* ignore */
          }
        }

        function hitTarget(viewportX, viewportY) {
          return document.elementFromPoint(viewportX, viewportY) || document.body;
        }

        function ancestorChain(el) {
          const out = [];
          for (let n = el; n && n.nodeType === 1; n = n.parentElement) out.push(n);
          return out.reverse();
        }

        /** Nested mouse + pointer enter/leave so hover and pointer listeners (not only input) update. */
        function hoverTransition(prev, next, vx, vy, buttons, payload) {
          const ancP = prev ? ancestorChain(prev) : [];
          const ancN = ancestorChain(next);
          let k = 0;
          while (
            k < ancP.length &&
            k < ancN.length &&
            ancP[k] === ancN[k]
          ) {
            k++;
          }

          for (let i = ancP.length - 1; i >= k; i--) {
            const el = ancP[i];
            if (!el.isConnected) continue;
            dispatchPointerOn(el, "pointerout", vx, vy, payload, {
              buttons,
              relatedTarget: next,
              bubbles: true
            });
            dispatchPointerOn(el, "pointerleave", vx, vy, payload, {
              buttons,
              relatedTarget: next,
              bubbles: false
            });
            el.dispatchEvent(
              new MouseEvent("mouseleave", {
                bubbles: false,
                cancelable: true,
                view: window,
                clientX: vx,
                clientY: vy,
                relatedTarget: next,
                button: 0,
                buttons
              })
            );
            el.dispatchEvent(
              new MouseEvent("mouseout", {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: vx,
                clientY: vy,
                relatedTarget: next,
                button: 0,
                buttons
              })
            );
          }

          for (let i = k; i < ancN.length; i++) {
            const el = ancN[i];
            dispatchPointerOn(el, "pointerover", vx, vy, payload, {
              buttons,
              relatedTarget: prev,
              bubbles: true
            });
            dispatchPointerOn(el, "pointerenter", vx, vy, payload, {
              buttons,
              relatedTarget: prev,
              bubbles: false
            });
            el.dispatchEvent(
              new MouseEvent("mouseenter", {
                bubbles: false,
                cancelable: true,
                view: window,
                clientX: vx,
                clientY: vy,
                relatedTarget: prev,
                button: 0,
                buttons
              })
            );
            el.dispatchEvent(
              new MouseEvent("mouseover", {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: vx,
                clientY: vy,
                relatedTarget: prev,
                button: 0,
                buttons
              })
            );
          }
        }

        const hasNormalized =
          typeof eventPayload.nx === "number" &&
          typeof eventPayload.ny === "number";
        const viewportX = hasNormalized
          ? Math.max(0, Math.min(window.innerWidth - 1, Math.round(eventPayload.nx * window.innerWidth)))
          : Math.max(0, Math.min(window.innerWidth - 1, eventPayload.x || 0));
        const viewportY = hasNormalized
          ? Math.max(0, Math.min(window.innerHeight - 1, Math.round(eventPayload.ny * window.innerHeight)))
          : Math.max(0, Math.min(window.innerHeight - 1, eventPayload.y || 0));

        if (eventPayload.type === "move") {
          updateLastPoint(viewportX, viewportY);
          const moveBtns =
            typeof eventPayload.buttons === "number" ? eventPayload.buttons : 0;
          const next = hitTarget(viewportX, viewportY);
          const prev = window.__remoteLastHoverEl || null;

          if (prev !== next) {
            hoverTransition(prev, next, viewportX, viewportY, moveBtns, eventPayload);
          }

          window.__remoteLastHoverEl = next;

          dispatchPointerOn(
            next,
            "pointermove",
            viewportX,
            viewportY,
            eventPayload,
            { buttons: moveBtns }
          );

          next.dispatchEvent(
            new MouseEvent("mousemove", {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: viewportX,
              clientY: viewportY,
              button: 0,
              buttons: moveBtns
            })
          );

          /* CSS :hover often ignores synthetic events in Chromium; JS listeners use the chain above. */
          return effectiveCursor(next);
        }

        if (eventPayload.type === "mousedown") {
          updateLastPoint(viewportX, viewportY);
          const target = hitTarget(viewportX, viewportY);
          window.__remotePressTarget = target;
          const opts = mouseBase(viewportX, viewportY, eventPayload);

          dispatchPointerOn(target, "pointerdown", viewportX, viewportY, eventPayload, {});
          target.dispatchEvent(new MouseEvent("mousedown", opts));
          focusBestPointerTarget(target, opts.button);
          return effectiveCursor(target);
        }

        if (eventPayload.type === "mouseup") {
          updateLastPoint(viewportX, viewportY);
          const target =
            window.__remotePressTarget ||
            hitTarget(viewportX, viewportY);

          dispatchPointerOn(target, "pointerup", viewportX, viewportY, eventPayload, {});

          target.dispatchEvent(new MouseEvent("mouseup", mouseBase(viewportX, viewportY, eventPayload)));
          return effectiveCursor(target);
        }

        if (eventPayload.type === "click") {
          updateLastPoint(viewportX, viewportY);
          const target =
            window.__remotePressTarget ||
            hitTarget(viewportX, viewportY);
          const btn = typeof eventPayload.button === "number" ? eventPayload.button : 0;
          const detail = typeof eventPayload.detail === "number" ? eventPayload.detail : 1;
          const mb = mouseBase(viewportX, viewportY, eventPayload);

          if (btn === 0) focusBestPointerTarget(target, btn);
          if (
            btn === 0 &&
            (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
          ) {
            const pos = (target.value || "").length;
            try {
              target.setSelectionRange(pos, pos);
            } catch {
              /* ignore */
            }
          }

          target.dispatchEvent(
            new MouseEvent("click", {
              ...mb,
              detail
            })
          );

          if (btn === 1) {
            try {
              target.dispatchEvent(
                new MouseEvent("auxclick", {
                  ...mb,
                  detail,
                  button: 1
                })
              );
            } catch {
              /* ignore */
            }
          }

          window.__remotePressTarget = null;
          return effectiveCursor(target);
        }

        if (eventPayload.type === "dblclick") {
          updateLastPoint(viewportX, viewportY);
          const target =
            window.__remotePressTarget ||
            hitTarget(viewportX, viewportY);
          const btn = typeof eventPayload.button === "number" ? eventPayload.button : 0;
          if (btn === 0) focusBestPointerTarget(target, btn);
          target.dispatchEvent(
            new MouseEvent("dblclick", {
              ...mouseBase(viewportX, viewportY, eventPayload),
              detail: 2
            })
          );
          window.__remotePressTarget = null;
          return effectiveCursor(target);
        }

        if (eventPayload.type === "contextmenu") {
          updateLastPoint(viewportX, viewportY);
          const target = hitTarget(viewportX, viewportY);
          target.dispatchEvent(
            new MouseEvent("contextmenu", {
              ...mouseBase(viewportX, viewportY, { ...eventPayload, button: 2 })
            })
          );
          return effectiveCursor(target);
        }

        if (eventPayload.type === "wheel") {
          updateLastPoint(viewportX, viewportY);
          const target = document.elementFromPoint(viewportX, viewportY) || document.body;
          const wheelEvt = new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            clientX: viewportX,
            clientY: viewportY,
            deltaX: typeof eventPayload.deltaX === "number" ? eventPayload.deltaX : 0,
            deltaY: typeof eventPayload.deltaY === "number" ? eventPayload.deltaY : 0,
            deltaZ: typeof eventPayload.deltaZ === "number" ? eventPayload.deltaZ : 0,
            deltaMode: typeof eventPayload.deltaMode === "number" ? eventPayload.deltaMode : 0,
            ctrlKey: !!eventPayload.ctrlKey,
            shiftKey: !!eventPayload.shiftKey,
            altKey: !!eventPayload.altKey,
            metaKey: !!eventPayload.metaKey
          });
          const ok = target.dispatchEvent(wheelEvt);
          const scroller = nearestScrollable(target);
          if (scroller) {
            scroller.scrollLeft += typeof eventPayload.deltaX === "number" ? eventPayload.deltaX : 0;
            scroller.scrollTop += typeof eventPayload.deltaY === "number" ? eventPayload.deltaY : 0;
          }
          void ok;
          return effectiveCursor(target);
        }

        if (eventPayload.type === "key") {
          const key = eventPayload.key || "";
          const action = eventPayload.action || "down";
          const code = eventPayload.code || "";
          const target = resolveTargetForKeyboard();

          const keyboardOptions = {
            bubbles: true,
            cancelable: true,
            key,
            code,
            ctrlKey: !!eventPayload.ctrlKey,
            altKey: !!eventPayload.altKey,
            shiftKey: !!eventPayload.shiftKey,
            metaKey: !!eventPayload.metaKey,
            repeat: !!eventPayload.repeat,
            ...legacyKeyInit(key, code)
          };

          const downEvent = new KeyboardEvent("keydown", keyboardOptions);
          const upEvent = new KeyboardEvent("keyup", keyboardOptions);

          const hasModifier =
            !!eventPayload.ctrlKey ||
            !!eventPayload.altKey ||
            !!eventPayload.metaKey;

          const selectAllChord =
            action === "down" &&
            (eventPayload.ctrlKey || eventPayload.metaKey) &&
            String(key).toLowerCase() === "a";

          if (selectAllChord) {
            focusIfNeeded(target);
            const canSelect =
              target instanceof HTMLInputElement ||
              target instanceof HTMLTextAreaElement;
            const canCE = target && target.isContentEditable;
            if (canSelect) {
              target.select();
            } else if (canCE) {
              try {
                document.execCommand("selectAll");
              } catch {
                /* ignore */
              }
            }
            target.dispatchEvent(downEvent);
            return;
          }

          if (action === "up") {
            focusIfNeeded(target);
            target.dispatchEvent(upEvent);
            return;
          }

          focusIfNeeded(target);

          /* Printable text + Backspace + Delete: full editing pipeline is beforeinput → mutate → input
           * (see insert/delete helpers). Skip keydown here to avoid double updates on controlled inputs. */
          const useSyntheticTextOnly =
            !hasModifier &&
            isEditableSurface(target) &&
            !(target instanceof HTMLSelectElement) &&
            (key.length === 1 || key === "Backspace" || key === "Delete");

          if (useSyntheticTextOnly) {
            if (key.length === 1) {
              void insertTextLikeUser(target, key);
            } else if (key === "Backspace") {
              void deleteBackwardLikeUser(target);
            } else {
              void deleteForwardLikeUser(target);
            }
            return;
          }

          const keydownAllowed = target.dispatchEvent(downEvent);

          /* Deprecated but still used by older widgets; only after keydown and only if keydown ran. */
          if (
            keydownAllowed &&
            !hasModifier &&
            key.length === 1 &&
            key !== "\u0000"
          ) {
            try {
              const leg = legacyKeyInit(key, code);
              const ch = key.charCodeAt(0);
              target.dispatchEvent(
                new KeyboardEvent("keypress", {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code,
                  ctrlKey: !!eventPayload.ctrlKey,
                  altKey: !!eventPayload.altKey,
                  shiftKey: !!eventPayload.shiftKey,
                  metaKey: !!eventPayload.metaKey,
                  repeat: !!eventPayload.repeat,
                  charCode: ch,
                  keyCode: leg.keyCode != null ? leg.keyCode : ch,
                  which: leg.which != null ? leg.which : ch
                })
              );
            } catch {
              /* ignore */
            }
          }

          /* Let app handlers run first (Enter → next field, grid navigation). Only emulate defaults
           * when nothing canceled the synthetic keydown. */
          if (!hasModifier && key === "Enter") {
            if (target instanceof HTMLTextAreaElement && keydownAllowed) {
              void insertTextLikeUser(target, "\n");
            }
          } else if (!hasModifier && key === "Tab" && keydownAllowed) {
            const inAgGrid =
              target.closest && target.closest(".ag-root-wrapper, .ag-root");
            if (!inAgGrid) {
              const focusable = Array.from(
                document.querySelectorAll(
                  "input,textarea,select,button,a[href],[tabindex]:not([tabindex='-1'])"
                )
              ).filter((el) => !el.hasAttribute("disabled"));
              const idx = focusable.indexOf(target);
              const next = focusable[(idx + 1) % Math.max(focusable.length, 1)];
              if (next) focusIfNeeded(next);
            }
          }
        }
      },
      args: [controlEvent]
    });

    const cursorHint =
      injected &&
      injected[0] &&
      typeof injected[0].result === "string"
        ? injected[0].result
        : null;
    if (
      cursorHint != null &&
      controlChannel &&
      controlChannel.readyState === "open" &&
      cursorHint !== lastSentRemoteCursor
    ) {
      lastSentRemoteCursor = cursorHint;
      try {
        controlChannel.send(
          JSON.stringify({ type: "remoteCursor", cursor: cursorHint })
        );
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    console.error("Tab control failed:", err);
  }
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

async function getScreenStream() {
  const streamId = await new Promise((resolve) => {
    chrome.desktopCapture.chooseDesktopMedia(["screen", "window", "tab"], resolve);
  });

  if (!streamId) {
    throw new Error("Screen capture was cancelled.");
  }

  const mandatoryBase = {
    chromeMediaSource: "desktop",
    chromeMediaSourceId: streamId
  };

  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        mandatory: {
          ...mandatoryBase,
          maxWidth: 3840,
          maxHeight: 2160,
          maxFrameRate: 60
        }
      },
      audio: false
    });
  } catch {
    return navigator.mediaDevices.getUserMedia({
      video: { mandatory: mandatoryBase },
      audio: false
    });
  }
}

/**
 * Favor readable UI/text on the viewer: high bitrate, keep resolution before FPS,
 * avoid downscaling the encoded stream when the browser allows it.
 */
async function tuneOutgoingVideo(pc) {
  const senders = pc.getSenders().filter((s) => s.track && s.track.kind === "video");
  for (const sender of senders) {
    const tryApply = async (patch) => {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      patch(params);
      await sender.setParameters(params);
    };

    try {
      await tryApply((params) => {
        const enc = params.encodings[0];
        enc.maxBitrate = 15_000_000;
        enc.maxFramerate = 60;
        enc.scaleResolutionDownBy = 1;
        params.degradationPreference = "maintain-resolution";
      });
    } catch {
      try {
        await tryApply((params) => {
          const enc = params.encodings[0];
          enc.maxBitrate = 15_000_000;
          enc.maxFramerate = 60;
          params.degradationPreference = "maintain-resolution";
          delete enc.scaleResolutionDownBy;
        });
      } catch {
        try {
          await tryApply((params) => {
            Object.assign(params.encodings[0], { maxBitrate: 12_000_000 });
            params.degradationPreference = "balanced";
            delete params.encodings[0].maxFramerate;
          });
        } catch (err) {
          console.warn("Video tuning skipped:", err);
        }
      }
    }

  }
}

function attachSignalListener() {
  if (signalEvents) {
    signalEvents.close();
    signalEvents = null;
  }
  const events = new EventSource(
    `${SIGNALING_URL}/events?id=${encodeURIComponent(peerId)}&sessionKey=${encodeURIComponent(sessionKey)}`
  );
  signalEvents = events;
  events.onerror = () => {
    setStatus("Signaling connection lost. Reload this page if the viewer cannot connect.");
  };
  events.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    if (!pc) return;

    if (msg.type === "offer") {
      try {
        await pc.setRemoteDescription(msg.payload);
        await flushIceCandidateQueue(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await tuneOutgoingVideo(pc);
        await postSignal({ to: msg.from, from: peerId, type: "answer", payload: answer });
        setStatus(`Offer accepted from ${msg.from}.`);
      } catch (err) {
        console.error("Offer handling failed:", err);
        pendingRemoteIceCandidates = [];
        setStatus("Could not complete handshake. Ask the viewer to refresh.");
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

async function registerHostSession() {
  const res = await fetch(`${SIGNALING_URL}/session/host`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionKey,
      hostPeerId: peerId,
      viewerPeerId: targetId
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Host registration failed (${res.status})`);
  }
}

async function startHost() {
  if (isStarting) return;
  if (!sessionKey) {
    setStatus("Missing session code in URL query.");
    return;
  }
  if (!/^\d{8}$/.test(sessionKey)) {
    setStatus("Invalid or missing session code. Open host from the extension popup.");
    return;
  }

  isStarting = true;
  startBtn.disabled = true;
  startBtn.textContent = "Starting...";
  setStatus("Opening capture picker...");

  // Important: trigger capture picker directly from the button click flow.
  // If async work happens first, Chrome may treat it as non-user-initiated.
  let stream;
  try {
    closeHostRuntime();
    stream = await getScreenStream();
    previewEl.srcObject = stream;
    setStatus("Source selected. Preparing secure session...");
    await previewEl.play().catch(() => {});

    connectNative();
    await registerHostSession();
    await refreshControllableTabs();
  } catch (err) {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    setStatus(err && err.message ? err.message : "Failed to start sharing.");
    isStarting = false;
    startBtn.disabled = false;
    startBtn.textContent = "Start sharing";
    return;
  }
  const [videoTrack] = stream.getVideoTracks();
  const settings = videoTrack ? videoTrack.getSettings() : {};
  // browser -> tab capture, window -> app window capture, monitor -> full screen capture.
  captureMode = settings.displaySurface || "unknown";
  if (captureMode === "browser") {
    const detected = await autoSelectCapturedTab(stream);
    setStatus(
      detected
        ? "Tab capture detected. Control is auto-routed to selected tab."
        : "Tab capture detected. Choose tab control target from dropdown."
    );
  } else {
    setStatus(
      nativePort
        ? `Capture mode: ${captureMode}. Native control will drive selected screen/window.`
        : `Capture mode: ${captureMode}. Install native host for full screen/window control.`
    );
  }

  updateCaptureUi();

  try {
    pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });

    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    for (const vt of stream.getVideoTracks()) {
      try {
        vt.contentHint = "detail";
      } catch {
        /* ignore — hints not supported on all captures */
      }
    }
    const [videoTrackForEnd] = stream.getVideoTracks();
    if (videoTrackForEnd) {
      videoTrackForEnd.onended = () => {
        setStatus("Sharing stopped. Click Start sharing to begin again.");
        closeHostRuntime();
      };
    }

    pc.ondatachannel = (event) => {
    if (event.channel.label !== "control") return;
    controlChannel = event.channel;
    controlChannel.onopen = () => setStatus("Control channel connected.");
    controlChannel.onmessage = (messageEvent) => {
      let parsed;
      try {
        parsed = JSON.parse(messageEvent.data);
      } catch (err) {
        console.error("Invalid control message:", err);
        return;
      }

      if (nativePort && captureMode !== "browser") {
        try {
          nativePort.postMessage(parsed);
        } catch (err) {
          console.error("Native message send failed:", err);
        }
      }

      if (captureMode === "browser") {
        void sendControlToTab(parsed);
      }
    };
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

    attachSignalListener();
    pc.onconnectionstatechange = () => {
      setStatus(`Host state: ${pc.connectionState}`);
    };
    setStatus(`Host ready as ${peerId}. Waiting for viewer offer...`);
  } catch (err) {
    setStatus(`Failed to initialize WebRTC host: ${err.message || err}`);
    closeHostRuntime();
  } finally {
    isStarting = false;
    startBtn.disabled = false;
    startBtn.textContent = "Start sharing";
  }
}

startBtn.addEventListener("click", () => {
  void startHost();
});

refreshTabsBtn.addEventListener("click", () => {
  void refreshControllableTabs();
});

tabSelectEl.addEventListener("change", () => {
  const parsedId = Number(tabSelectEl.value);
  selectedTabId = Number.isFinite(parsedId) ? parsedId : null;
});

async function preRegisterHost() {
  if (!peerId || !targetId || !/^\d{8}$/.test(sessionKey)) {
    setStatus("Open this page from the extension popup so session code is set.");
    return;
  }
  try {
    await registerHostSession();
    setStatus(
      "Session registered with signaling server. Click Start sharing when ready.",
      "ok"
    );
  } catch (err) {
    setStatus(
      err.message || "Signaling server unreachable. Run: node server/signaling.js",
      "bad"
    );
  }
}

async function bootstrapHost() {
  try {
    SIGNALING_URL =
      typeof globalThis.__REMOTE_ACCESS_RESOLVE_SIGNALING__ === "function"
        ? await globalThis.__REMOTE_ACCESS_RESOLVE_SIGNALING__()
        : SIGNALING_URL;
  } catch (err) {
    console.warn("Signaling resolve failed:", err);
  }
  if (signalingHintEl) signalingHintEl.textContent = SIGNALING_URL;
  await refreshControllableTabs().catch((e) => {
    console.warn("Could not load tab list:", e);
  });
  updateCaptureUi();
  void preRegisterHost();
}

void bootstrapHost();
