"use strict";
/* Time Lock - txt frontend UI. Plain-text look. Uses the shared `TimeLock`
   core (core.js) for all crypto; this file is DOM/presentation only. */
(function () {
  const $ = (id) => document.getElementById(id);
  const TL = window.TimeLock;
  const { STRICT, LENIENT, fmtTime } = TL;

  function barTxt(pct) {
    const W = 22,
      f = Math.max(0, Math.min(W, Math.round((pct / 100) * W)));
    return "[" + "█".repeat(f) + "░".repeat(W - f) + "]";
  }

  // ---------- duration + mode selection ----------
  let pickedMode = STRICT;
  function updatePresets() {
    const v = $("custom").value;
    document.querySelectorAll("#presets .tog").forEach((b) => {
      b.setAttribute("aria-current", String(b.dataset.min === v));
    });
  }
  function currentMinutes() {
    const c = parseFloat($("custom").value);
    return c > 0 ? c : 0;
  }
  function updateMode() {
    $("m-strict").setAttribute("aria-current", String(pickedMode === STRICT));
    $("m-lenient").setAttribute("aria-current", String(pickedMode === LENIENT));
  }

  // ---------- wake lock ----------
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

  // ---------- LOCK ----------
  async function lock() {
    const plain = $("plain").value;
    if (!plain) {
      setLockStatus("type a secret first.");
      return;
    }
    const minutes = currentMinutes();
    if (!(minutes > 0)) {
      setLockStatus("pick a duration.");
      return;
    }
    const mode = pickedMode;
    const targetSec = minutes * 60;
    const btn = $("lock-btn");
    btn.disabled = true;
    $("lock-out-wrap").hidden = true;
    try {
      const STATUS = {
        keys: "generating keys...",
        calibrate: "calibrating...",
        seal: "sealing...",
      };
      const res = await TL.lockSecret({
        plain,
        targetSec,
        mode,
        onStatus: (s) => setLockStatus(STATUS[s]),
      });
      $("lock-out").textContent = res.token;
      $("lock-out-wrap").hidden = false;
      setLockStatus("locked. target ~ " + fmtTime(targetSec) + ".");
    } catch (err) {
      setLockStatus("error: " + (err && err.message ? err.message : err));
    } finally {
      btn.disabled = false;
    }
  }
  function setLockStatus(msg) {
    $("lock-status").textContent = msg;
  }

  // ---------- UNLOCK ----------
  let solving = false,
    cancelRequested = false,
    leftStrict = false,
    curMode = STRICT;
  const TOKEN_ERR = {
    "not-token": "not a time lock token.",
    "bad-version": "unsupported version.",
    malformed: "malformed token.",
  };

  async function unlock() {
    if (solving) return;
    let parsed;
    try {
      parsed = TL.parseToken($("token-in").value);
    } catch (err) {
      setUnlockMsg(TOKEN_ERR[err.code] || err.message);
      return;
    }

    solving = true;
    cancelRequested = false;
    leftStrict = false;
    curMode = parsed.mode;
    $("unlock-btn").disabled = true;
    $("cancel-btn").hidden = false;
    $("reveal").hidden = true;
    $("prog").hidden = false;
    setUnlockMsg("");
    $("mode-note").textContent =
      curMode === STRICT
        ? "strict: leave this page and it resets to zero."
        : "lenient: leave and it pauses, resumes when you return.";
    requestWake();

    try {
      const result = await TL.solve(parsed, {
        onProgress: (p) => {
          $("bar-txt").textContent = barTxt(p.pct);
          $("st-pct").textContent = p.pct.toFixed(0) + "%";
          if (isFinite(p.elapsed))
            $("st-elapsed").textContent = fmtTime(p.elapsed);
          $("st-eta").textContent = fmtTime(p.remaining);
        },
        onPause: (paused) =>
          setUnlockMsg(paused ? "paused - come back to continue." : ""),
        shouldCancel: () => cancelRequested,
        shouldReset: () => leftStrict,
      });
      if (result.status === "reset") {
        setUnlockMsg("you left - progress reset to zero.");
        $("prog").hidden = true;
        return;
      }
      if (result.status === "cancelled") {
        setUnlockMsg("cancelled - starts from zero next time.");
        $("prog").hidden = true;
        return;
      }
      if (result.status === "tamper") {
        setUnlockMsg(
          "finished, but decryption failed - token corrupted or tampered.",
        );
        return;
      }
      $("reveal-pw").textContent = result.secret;
      $("reveal").hidden = false;
      $("prog").hidden = true;
    } finally {
      solving = false;
      releaseWake();
      $("unlock-btn").disabled = false;
      $("cancel-btn").hidden = true;
    }
  }
  function setUnlockMsg(msg) {
    $("unlock-msg").textContent = msg;
  }

  document.addEventListener("visibilitychange", () => {
    if (!solving) return;
    if (document.hidden) {
      if (curMode === STRICT) leftStrict = true;
    } else {
      requestWake();
    }
  });

  // ---------- wiring ----------
  $("lock-btn").addEventListener("click", lock);
  $("unlock-btn").addEventListener("click", unlock);
  $("cancel-btn").addEventListener("click", () => {
    cancelRequested = true;
  });

  $("presets").addEventListener("click", (e) => {
    const b = e.target.closest(".tog");
    if (!b) return;
    $("custom").value = b.dataset.min;
    updatePresets();
  });
  $("custom").addEventListener("input", updatePresets);
  $("m-strict").addEventListener("click", () => {
    pickedMode = STRICT;
    updateMode();
  });
  $("m-lenient").addEventListener("click", () => {
    pickedMode = LENIENT;
    updateMode();
  });

  async function copyFrom(el, labelEl, word) {
    const txt = el.textContent;
    if (!txt) return;
    try {
      await navigator.clipboard.writeText(txt);
    } catch {
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
    }
    labelEl.textContent = "copied";
    setTimeout(() => {
      labelEl.textContent = word;
    }, 1600);
  }
  $("lock-out").addEventListener("click", () =>
    copyFrom($("lock-out"), $("lock-out-label"), "token"),
  );
  $("reveal-pw").addEventListener("click", () =>
    copyFrom($("reveal-pw"), $("reveal-label"), "secret"),
  );

  function focusActive() {
    const el = $("panel-lock").hidden ? $("token-in") : $("plain");
    try {
      el.focus({ preventScroll: true });
    } catch (e) {
      try {
        el.focus();
      } catch (_) {}
    }
  }
  function switchTab(which) {
    const lock = which === "lock";
    $("tab-lock").setAttribute("aria-current", String(lock));
    $("tab-unlock").setAttribute("aria-current", String(!lock));
    $("panel-lock").hidden = !lock;
    $("panel-unlock").hidden = lock;
    focusActive();
  }
  $("tab-lock").addEventListener("click", () => switchTab("lock"));
  $("tab-unlock").addEventListener("click", () => switchTab("unlock"));

  function route() {
    const math = location.hash.replace("#", "") === "math";
    $("view-math").hidden = !math;
    $("view-main").hidden = math;
    window.scrollTo(0, 0);
    if (!math) focusActive();
  }
  window.addEventListener("hashchange", route);
  window.addEventListener("beforeunload", (e) => {
    if (solving) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  updatePresets();
  updateMode();
  route();
  focusActive();
})();
