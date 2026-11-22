"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const TL = window.TimeLock;
  const { STRICT, LENIENT, fmtTime, fmtEta, biToBytes, padTo } = TL;

  // ---------- live puzzle-state visualization ----------
  const GRID = 16,
    CELLS = GRID * GRID;
  function themeColors() {
    const cs = getComputedStyle(document.documentElement);
    return {
      ink: cs.getPropertyValue("--ink-rgb").trim(),
      acc: cs.getPropertyValue("--accent-rgb").trim(),
    };
  }
  function drawState(x) {
    const canvas = $("viz");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = canvas.clientWidth || 200;
    if (canvas.width !== Math.round(size * dpr)) {
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const { ink, acc } = themeColors();
    let bytes = biToBytes(x);
    if (bytes.length < CELLS) bytes = padTo(bytes, CELLS);
    const off = bytes.length - CELLS;
    const gap = Math.max(1, size * 0.011);
    const cell = (size - gap * (GRID + 1)) / GRID;
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        const v = bytes[off + r * GRID + c];
        const a = 0.05 + 0.95 * (v / 255);
        ctx.fillStyle =
          v > 214
            ? "rgba(" + acc + "," + a.toFixed(3) + ")"
            : "rgba(" + ink + "," + a.toFixed(3) + ")";
        ctx.fillRect(
          gap + c * (cell + gap),
          gap + r * (cell + gap),
          cell,
          cell,
        );
      }
    }
  }

  // ================= LOCK =================
  async function lock() {
    const plain = $("plain").value;
    if (!plain) {
      setLockScreen("error", "type a secret first");
      return;
    }
    const targetSec = parseInt($("dur").value, 10);
    if (!(targetSec > 0)) {
      setLockScreen("error", "enter a valid duration");
      return;
    }
    const mode = pickedMode;
    const btn = $("lock-btn");
    btn.disabled = true;
    try {
      const STATUS = {
        keys: "generating keys…",
        calibrate: "calibrating on this device…",
        seal: "sealing…",
      };
      // use a rate the background measured while they typed, if one's ready
      // and still fresh; otherwise lockSecret calibrates inline as before.
      if (CAL.inFlight) await CAL.inFlight;
      const res = await TL.lockSecret({
        plain,
        targetSec,
        mode,
        rate: calFresh() ? CAL.rate : undefined,
        minCalibrateMs: 350,
        onStatus: (s) => setLockScreen("working", STATUS[s]),
      });
      showToken(res.token, targetSec);
    } catch (err) {
      setLockScreen(
        "error",
        "error: " + (err && err.message ? err.message : err),
      );
    } finally {
      btn.disabled = false;
    }
  }
  function setLockScreen(state, text) {
    const msg = $("lock-msg"),
      done = $("lock-done");
    if (state === "done") {
      done.hidden = false;
      msg.hidden = true;
    } else {
      done.hidden = true;
      msg.hidden = false;
      $("lock-msg-txt").textContent = text;
      msg.className = "screen-msg" + (state === "error" ? " err" : "");
    }
    $("lock-actions").hidden = state !== "done";
  }
  function showToken(tok, targetSec) {
    $("lock-out").textContent = tok;
    $("lock-head").textContent = "✓ locked · ≈ " + fmtEta(targetSec);
    setLockScreen("done");
  }

  // ---------- mode selection + wake lock ----------
  let pickedMode = STRICT;
  let wakeLock = null;
  async function requestWake() {
    try {
      if ("wakeLock" in navigator)
        wakeLock = await navigator.wakeLock.request("screen");
    } catch (e) {}
  }
  function releaseWake() {
    try {
      if (wakeLock) {
        wakeLock.release();
        wakeLock = null;
      }
    } catch (e) {}
  }

  // ================= UNLOCK =================
  let solving = false,
    cancelRequested = false,
    leftStrict = false,
    curMode = STRICT;
  const TOKEN_ERR = {
    "not-token": "That doesn't look like a Time Lock token.",
    "bad-version": "Unsupported token version.",
    malformed: "Token is malformed.",
  };

  let revealedSecret = "";
  function maskOf(s) {
    return s.replace(/[^\n]/g, "•");
  }
  function setMasked(masked) {
    const el = $("reveal-pw");
    el.dataset.masked = masked ? "true" : "false";
    el.textContent = masked ? maskOf(revealedSecret) : revealedSecret;
    const t = $("toggle-pw");
    t.setAttribute("aria-pressed", String(!masked));
    const lbl = masked ? "Reveal secret" : "Hide secret";
    t.setAttribute("aria-label", lbl);
    t.setAttribute("title", lbl);
  }
  function setRunning(on) {
    revealedSecret = "";
    $("out-screen").hidden = true;
    $("hero").hidden = false;
    $("reveal").hidden = true;
    $("copy-pw-status").textContent = "";
    $("screen-idle").hidden = on;
    $("screen").classList.toggle("can-fs", on);
    $("count").classList.toggle("live", on);
    if (!on) {
      $("hold-note").textContent = "";
      setFullscreen(false);
    }
  }
  function showResult(secret) {
    revealedSecret = secret;
    setMasked(true);
    $("screen-idle").hidden = true;
    $("hero").hidden = true;
    $("out-screen").hidden = false;
    $("screen").classList.remove("can-fs");
    $("count").classList.remove("live");
    $("hold-note").textContent = "";
    setFullscreen(false);
    $("reveal").hidden = false;
  }
  function setThemeColor(onScreen) {
    const cs = getComputedStyle(document.documentElement);
    const c = (
      onScreen
        ? cs.getPropertyValue("--screen")
        : cs.getPropertyValue("--surface")
    ).trim();
    let m = document.querySelector('meta[name="theme-color"]');
    if (!m) {
      m = document.createElement("meta");
      m.setAttribute("name", "theme-color");
      document.head.appendChild(m);
    }
    if (c) m.setAttribute("content", c);
  }
  function setFullscreen(on) {
    const el = $("screen");
    const isOn = el.classList.contains("fs-on");
    const want = on === undefined ? !isOn : on;
    if (want === isOn) return;
    const overlay = $("fs-overlay");
    const hero = $("hero");
    if (want) {
      el.classList.add("fs-on");
      overlay.appendChild(hero);
      overlay.hidden = false;
      document.body.classList.add("fs-lock");
      document.documentElement.classList.add("fs-lock");
      setThemeColor(true);
    } else {
      el.classList.remove("fs-on");
      el.insertBefore(hero, $("screen-idle"));
      overlay.hidden = true;
      document.body.classList.remove("fs-lock");
      document.documentElement.classList.remove("fs-lock");
      setThemeColor(false);
      fitDevice();
    }
  }

  let fitQueued = false;
  function fitDevice() {
    const el = $("view-main");
    if (!el || el.hidden) return;
    if (document.body.classList.contains("fs-lock")) return;
    // The unit is laid out to fill the window by CSS at every size (kiosk
    // fill on large/short screens, a full-width scrolling page on small
    // portrait phones). It is never scaled up and floated in a letterbox,
    // and never shrunk to fit height (which used to make it too narrow on
    // small phones), so there is no transform to apply here.
    el.style.transform = "none";
  }
  function queueFit() {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => {
      fitQueued = false;
      fitDevice();
    });
  }

  async function unlock() {
    if (solving) return;
    let parsed;
    try {
      parsed = TL.parseToken($("token-in").value);
    } catch (err) {
      setUnlockMsg(TOKEN_ERR[err.code] || err.message, "bad");
      return;
    }

    solving = true;
    cancelRequested = false;
    leftStrict = false;
    curMode = parsed.mode;
    $("unlock-btn").disabled = true;
    $("cancel-btn").hidden = false;
    $("reveal").hidden = true;
    setRunning(true);
    queueFit();
    $("hold-note").textContent =
      curMode === STRICT
        ? "● Leaving resets it to zero."
        : "● Leaving pauses the clock";
    setUnlockMsg("");
    requestWake();

    try {
      const result = await TL.solve(parsed, {
        onProgress: (p) => {
          $("bar-fill").style.width = p.pct.toFixed(2) + "%";
          $("st-pct").textContent =
            p.pct >= 100 ? "100%" : p.pct.toFixed(1) + "%";
          if (isFinite(p.elapsed))
            $("st-elapsed").textContent = fmtTime(p.elapsed);
          $("st-eta").textContent = fmtEta(p.remaining);
          drawState(p.x);
        },
        onPause: (paused) =>
          paused
            ? setUnlockMsg("Paused. Come back to continue.", "warn")
            : setUnlockMsg(""),
        shouldCancel: () => cancelRequested,
        shouldReset: () => leftStrict,
      });
      if (result.status === "reset") {
        setUnlockMsg("You left. Progress reset to zero.", "bad");
        setRunning(false);
        return;
      }
      if (result.status === "cancelled") {
        setUnlockMsg(
          "Cancelled. Progress is gone. Next time starts from zero.",
          "bad",
        );
        setRunning(false);
        return;
      }
      if (result.status === "tamper") {
        setUnlockMsg(
          "Finished, but decryption failed. Token corrupted or tampered.",
          "bad",
        );
        setRunning(false);
        return;
      }
      showResult(result.secret);
      queueFit();
    } finally {
      solving = false;
      releaseWake();
      $("unlock-btn").disabled = false;
      $("cancel-btn").hidden = true;
    }
  }
  function setUnlockMsg(msg, kind) {
    const el = $("unlock-msg");
    el.textContent = msg;
    el.className = "note" + (kind ? " " + kind : "");
  }

  // ---------- background calibration ----------
  const CAL = { rate: 0, at: 0, inFlight: null, spoiled: false };
  const CAL_FRESH_MS = 90000;
  function calFresh() {
    return CAL.rate > 0 && Date.now() - CAL.at < CAL_FRESH_MS;
  }
  function repModulus() {
    const bytes = Math.ceil((TL.PRIME_BITS * 2) / 8);
    const a = crypto.getRandomValues(new Uint8Array(bytes));
    a[0] |= 0x80;
    a[bytes - 1] |= 1;
    return { N: TL.bytesToBi(a), g: 3n };
  }
  async function warmCalibration() {
    if (document.hidden || CAL.inFlight || calFresh()) return;
    CAL.spoiled = false;
    const { N, g } = repModulus();
    CAL.inFlight = (async () => {
      try {
        const rate = await TL.benchmarkRate(N, g);
        if (rate > 0 && !CAL.spoiled && !document.hidden) {
          CAL.rate = rate;
          CAL.at = Date.now();
        }
      } catch {
      } finally {
        CAL.inFlight = null;
      }
    })();
    return CAL.inFlight;
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      CAL.spoiled = true;
    } else if ($("plain").value && !calFresh()) {
      warmCalibration();
    }
  });
  let calDebounce = null;
  $("plain").addEventListener("input", () => {
    clearTimeout(calDebounce);
    calDebounce = setTimeout(warmCalibration, 400);
  });

  // ---------- wiring ----------
  $("lock-btn").addEventListener("click", lock);
  $("unlock-btn").addEventListener("click", unlock);
  $("cancel-btn").addEventListener("click", () => {
    cancelRequested = true;
  });
  function wirePaste(btnId, fieldId, trim) {
    const btn = $(btnId);
    const field = $(fieldId);
    let resetTimer = null;
    const flash = (state, title) => {
      btn.classList.remove("ok", "err");
      if (state) btn.classList.add(state);
      btn.setAttribute("title", title);
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        btn.classList.remove("ok", "err");
        btn.setAttribute("title", "Paste from clipboard");
      }, 1100);
    };
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        if (!navigator.clipboard || !navigator.clipboard.readText)
          throw new Error("no api");
        let text = await navigator.clipboard.readText();
        if (trim) text = text.trim();
        if (!text) {
          flash("err", "Clipboard is empty");
          return;
        }
        field.value = text;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        flash("ok", "Pasted");
      } catch (err) {
        field.focus();
        flash("err", "Could not read clipboard, paste manually");
      }
    });
  }
  wirePaste("paste-btn", "token-in", true);
  wirePaste("paste-secret-btn", "plain", false);
  $("toggle-secret").addEventListener("click", () => {
    const el = $("plain");
    const shown = el.type === "password";
    el.type = shown ? "text" : "password";
    const t = $("toggle-secret");
    t.setAttribute("aria-pressed", String(shown));
    const lbl = shown ? "Hide secret" : "Reveal secret";
    t.setAttribute("aria-label", lbl);
    t.setAttribute("title", lbl);
  });
  $("fs-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    setFullscreen();
  });
  $("screen").addEventListener("click", (e) => {
    if (e.target.closest(".fs")) return;
    if ($("screen").classList.contains("can-fs")) setFullscreen(true);
  });
  $("fs-overlay").addEventListener("click", () => setFullscreen(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setFullscreen(false);
  });
  function pressOne(container, btn) {
    container.querySelectorAll(".preset").forEach((p) => {
      p.setAttribute("aria-pressed", String(p === btn));
    });
  }
  $("dur-chips").addEventListener("click", (e) => {
    const b = e.target.closest(".preset");
    if (!b) return;
    $("dur").value = b.dataset.sec;
    pressOne($("dur-chips"), b);
  });
  $("dur").addEventListener("change", () => {
    const v = $("dur").value;
    $("dur-chips")
      .querySelectorAll(".preset")
      .forEach((p) =>
        p.setAttribute("aria-pressed", String(p.dataset.sec === v)),
      );
  });
  $("mode-chips").addEventListener("click", (e) => {
    const b = e.target.closest(".preset");
    if (!b) return;
    pickedMode = parseInt(b.dataset.mode, 10);
    pressOne($("mode-chips"), b);
  });

  document.addEventListener("visibilitychange", () => {
    if (!solving) return;
    if (document.hidden) {
      if (curMode === STRICT) leftStrict = true;
    } else {
      requestWake();
    }
  });

  async function copyLockToken() {
    const el = $("lock-out");
    if (!el.textContent) return;
    try {
      await navigator.clipboard.writeText(el.textContent);
      flashBtn("copy-btn");
      flash("copy-status", "Copied ✓");
    } catch {
      selectText(el);
      flash("copy-status", "Press ⌘/Ctrl+C");
    }
  }
  $("copy-btn").addEventListener("click", copyLockToken);
  $("lock-out").addEventListener("click", copyLockToken);
  $("copy-pw").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(revealedSecret);
      flashBtn("copy-pw");
      flash("copy-pw-status", "Copied ✓");
    } catch {
      setMasked(false);
      selectText($("reveal-pw"));
      flash("copy-pw-status", "Press ⌘/Ctrl+C");
    }
  });
  function flashBtn(id) {
    const el = $(id);
    el.classList.add("ok");
    setTimeout(() => el.classList.remove("ok"), 1200);
  }
  $("toggle-pw").addEventListener("click", () => {
    setMasked($("reveal-pw").dataset.masked !== "true");
  });
  function flash(id, msg) {
    const el = $(id);
    el.textContent = msg;
    setTimeout(() => {
      el.textContent = "";
    }, 2500);
  }
  function selectText(el) {
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  function switchTab(which) {
    const lock = which === "lock";
    $("tabs").setAttribute("data-active", which);
    $("tab-lock").setAttribute("aria-selected", String(lock));
    $("tab-unlock").setAttribute("aria-selected", String(!lock));
    $("panel-lock").classList.toggle("inactive", !lock);
    $("panel-unlock").classList.toggle("inactive", lock);
    $("panel-lock").setAttribute("aria-hidden", String(!lock));
    $("panel-unlock").setAttribute("aria-hidden", String(lock));
  }
  $("tab-lock").addEventListener("click", () => switchTab("lock"));
  $("tab-unlock").addEventListener("click", () => switchTab("unlock"));

  function route() {
    const math = location.hash.replace("#", "") === "math";
    $("view-math").hidden = !math;
    $("view-main").hidden = math;
    document.body.classList.toggle("fit", !math);
    document.body.classList.toggle("mathview", math);
    if (math) $("view-main").style.transform = "none";
    window.scrollTo(0, 0);
    queueFit();
  }
  window.addEventListener("hashchange", route);
  window.addEventListener("resize", queueFit);
  window.addEventListener("orientationchange", () => setTimeout(fitDevice, 80));
  window.addEventListener("load", queueFit);
  if (document.fonts && document.fonts.ready)
    document.fonts.ready.then(fitDevice);
  document.querySelectorAll("input, textarea").forEach((el) => {
    el.addEventListener("blur", () => setTimeout(fitDevice, 60));
  });
  route();

  setThemeColor($("screen").classList.contains("fs-on"));
  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () =>
      setThemeColor($("screen").classList.contains("fs-on"));
    if (mq.addEventListener) mq.addEventListener("change", onScheme);
    else if (mq.addListener) mq.addListener(onScheme);
  }

  window.addEventListener("beforeunload", (e) => {
    if (solving) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  drawState(biToBytes(crypto.getRandomValues(new Uint8Array(96))));
})();
