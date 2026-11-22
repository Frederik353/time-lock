"use strict";
/* ============================================================
   Time Lock - core
   Pure crypto + puzzle logic.
   ============================================================ */
(function (global) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const PRIME_BITS = 1024,
    VERSION = 2,
    STRICT = 0,
    LENIENT = 1;

  // ---------- utils ----------
  function b64enc(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64dec(str) {
    const s = atob(str);
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }
  function biToBytes(bi) {
    if (bi === 0n) return new Uint8Array([0]);
    let hex = bi.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    const a = new Uint8Array(hex.length / 2);
    for (let i = 0; i < a.length; i++)
      a[i] = parseInt(hex.substr(i * 2, 2), 16);
    return a;
  }
  function bytesToBi(a) {
    let hex = "";
    for (let i = 0; i < a.length; i++)
      hex += a[i].toString(16).padStart(2, "0");
    return hex === "" ? 0n : BigInt("0x" + hex);
  }
  function padTo(bytes, len) {
    if (bytes.length >= len) return bytes;
    const a = new Uint8Array(len);
    a.set(bytes, len - bytes.length);
    return a;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.round(sec);
    const m = Math.floor(sec / 60),
      s = sec % 60;
    if (m >= 60) {
      const h = Math.floor(m / 60);
      return (
        h +
        ":" +
        String(m % 60).padStart(2, "0") +
        ":" +
        String(s).padStart(2, "0")
      );
    }
    return m + ":" + String(s).padStart(2, "0");
  }

  // ---------- number theory ----------
  function modpow(base, exp, mod) {
    base %= mod;
    let res = 1n;
    while (exp > 0n) {
      if (exp & 1n) res = (res * base) % mod;
      exp >>= 1n;
      base = (base * base) % mod;
    }
    return res;
  }
  const SMALL_PRIMES = (() => {
    const out = [],
      n = 2000,
      sieve = new Uint8Array(n + 1);
    for (let i = 2; i <= n; i++) {
      if (!sieve[i]) {
        out.push(BigInt(i));
        for (let j = i * i; j <= n; j += i) sieve[j] = 1;
      }
    }
    return out;
  })();
  function randBits(bits) {
    const bytes = Math.ceil(bits / 8),
      a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    let x = bytesToBi(a);
    const ex = BigInt(bytes * 8 - bits);
    if (ex > 0n) x >>= ex;
    return x;
  }
  function randBelow(limit) {
    const bits = limit.toString(2).length;
    while (true) {
      const x = randBits(bits);
      if (x < limit) return x;
    }
  }
  function isProbablePrime(n, rounds) {
    if (n < 2n) return false;
    for (const p of SMALL_PRIMES) {
      if (n === p) return true;
      if (n % p === 0n) return false;
    }
    let d = n - 1n,
      r = 0;
    while ((d & 1n) === 0n) {
      d >>= 1n;
      r++;
    }
    witness: for (let i = 0; i < rounds; i++) {
      const a = 2n + randBelow(n - 3n);
      let x = modpow(a, d, n);
      if (x === 1n || x === n - 1n) continue;
      for (let j = 1; j < r; j++) {
        x = (x * x) % n;
        if (x === n - 1n) continue witness;
      }
      return false;
    }
    return true;
  }
  function genPrime(bits) {
    while (true) {
      let c = randBits(bits);
      c |= 1n;
      c |= 1n << BigInt(bits - 1);
      if (isProbablePrime(c, 6)) return c;
    }
  }

  // ---------- crypto ----------
  function aadFor(mode) {
    return enc.encode("time-lock/mode=" + mode);
  }
  async function deriveAesKey(materialBi, modLen) {
    const mkBytes = padTo(biToBytes(materialBi), modLen);
    const hash = await crypto.subtle.digest("SHA-256", mkBytes);
    return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  }
  async function benchmarkRate(N, g) {
    let x = g % N;
    let w0 = performance.now();
    do {
      for (let i = 0; i < 2000; i++) x = (x * x) % N;
    } while (performance.now() - w0 < 110);

    // Size the batch the way the unlock does (~70ms of work per batch).
    let p0 = performance.now(),
      pc = 0;
    do {
      for (let i = 0; i < 2000; i++) x = (x * x) % N;
      pc += 2000;
    } while (performance.now() - p0 < 70);
    const probeRate = pc / ((performance.now() - p0) / 1000);
    const batch = Math.max(1, Math.floor(probeRate * 0.07));

    let done = 0;
    const t0 = performance.now();
    do {
      for (let i = 0; i < batch; i++) x = (x * x) % N;
      done += batch;
      await sleep(0);
    } while (performance.now() - t0 < 450);
    return done / ((performance.now() - t0) / 1000);
  }

  // ---------- token errors (frontends map .code to their own wording) ----------
  class TokenError extends Error {
    constructor(code, message) {
      super(message || code);
      this.name = "TokenError";
      this.code = code;
    }
  }

  function parseToken(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s.startsWith("TL2."))
      throw new TokenError("not-token", "not a time lock token");
    let b;
    try {
      b = JSON.parse(dec.decode(b64dec(s.slice(4))));
    } catch (e) {
      throw new TokenError("malformed", "token is malformed");
    }
    if (b.v !== VERSION)
      throw new TokenError("bad-version", "unsupported token version");
    const N = bytesToBi(b64dec(b.n)),
      g = bytesToBi(b64dec(b.g)),
      t = b.t,
      iv = b64dec(b.iv),
      ct = b64dec(b.ct),
      mode = b.m === LENIENT ? LENIENT : STRICT;
    if (!(N > 1n) || !(t >= 1))
      throw new TokenError("malformed", "token is malformed");
    return { N, g, t, iv, ct, mode, modLen: biToBytes(N).length };
  }

  // ---------- LOCK ----------
  async function lockSecret(opts) {
    const plain = opts.plain;
    const targetSec = opts.targetSec;
    const mode = opts.mode;
    const onStatus = opts.onStatus || function () {};

    onStatus("keys");
    await sleep(30);
    const p = genPrime(PRIME_BITS);
    await sleep(0);
    let q = genPrime(PRIME_BITS);
    while (q === p) q = genPrime(PRIME_BITS);
    const N = p * q,
      phi = (p - 1n) * (q - 1n),
      modLen = biToBytes(N).length;
    const g = 2n + randBelow(N - 3n);

    onStatus("calibrate");
    const calStart = performance.now();
    await sleep(30);
    const rate =
      typeof opts.rate === "number" && opts.rate > 0
        ? opts.rate
        : await benchmarkRate(N, g);
    const minCal = opts.minCalibrateMs > 0 ? opts.minCalibrateMs : 0;
    const calElapsed = performance.now() - calStart;
    if (calElapsed < minCal) await sleep(minCal - calElapsed);
    const MARGIN = 1.06;
    let t = Math.round(rate * targetSec * MARGIN);
    if (t < 1) t = 1;

    onStatus("seal");
    await sleep(20);
    const e = modpow(2n, BigInt(t), phi);
    const material = modpow(g, e, N);
    const key = await deriveAesKey(material, modLen);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ctBuf = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aadFor(mode) },
      key,
      enc.encode(plain),
    );
    const bundle = {
      v: VERSION,
      m: mode,
      n: b64enc(biToBytes(N)),
      g: b64enc(biToBytes(g)),
      t,
      iv: b64enc(iv),
      ct: b64enc(new Uint8Array(ctBuf)),
    };
    return {
      token: "TL2." + b64enc(enc.encode(JSON.stringify(bundle))),
      t,
      targetSec,
    };
  }

  // ---------- UNLOCK ----------
  async function solve(parsed, hooks) {
    hooks = hooks || {};
    const onProgress = hooks.onProgress || function () {};
    const onPause = hooks.onPause || function () {};
    const shouldCancel =
      hooks.shouldCancel ||
      function () {
        return false;
      };
    const shouldReset =
      hooks.shouldReset ||
      function () {
        return false;
      };
    const isHidden =
      hooks.isHidden ||
      function () {
        return typeof document !== "undefined" && document.hidden;
      };

    const { N, g, t, iv, ct, mode, modLen } = parsed;
    let x = g % N,
      done = 0;
    const probeStart = performance.now();
    for (let i = 0; i < 3000; i++) x = (x * x) % N;
    done = Math.min(3000, t);
    if (t <= 3000) {
      x = g % N;
      for (let i = 0; i < t; i++) x = (x * x) % N;
      done = t;
    }
    const probeRate = 3000 / ((performance.now() - probeStart) / 1000);
    let batch = Math.max(1, Math.floor(probeRate * 0.07));

    let activeMs = 0,
      lastResume = performance.now(),
      paused = false;

    while (done < t && !shouldCancel() && !shouldReset()) {
      if (mode === LENIENT && isHidden()) {
        if (!paused) {
          paused = true;
          activeMs += performance.now() - lastResume;
          onPause(true);
        }
        await sleep(250);
        continue;
      }
      if (paused) {
        paused = false;
        lastResume = performance.now();
        onPause(false);
      }

      const end = Math.min(done + batch, t);
      for (; done < end; done++) x = (x * x) % N;
      const elapsed = (activeMs + (performance.now() - lastResume)) / 1000;
      const rate = done / Math.max(elapsed, 0.001);
      const remaining = (t - done) / rate;
      const pct = (done / t) * 100;
      onProgress({ done, t, x, elapsed, rate, remaining, pct });
      batch = Math.max(1, Math.floor(rate * 0.07));
      await sleep(0);
    }

    if (shouldReset()) return { status: "reset" };
    if (shouldCancel()) return { status: "cancelled" };

    const elapsed = (activeMs + (performance.now() - lastResume)) / 1000;
    onProgress({ done: t, t, x, elapsed, rate: 0, remaining: 0, pct: 100 });

    const key = await deriveAesKey(x, modLen);
    try {
      const ptBuf = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aadFor(mode) },
        key,
        ct,
      );
      return { status: "ok", secret: dec.decode(ptBuf) };
    } catch (e) {
      return { status: "tamper" };
    }
  }

  global.TimeLock = {
    VERSION,
    PRIME_BITS,
    STRICT,
    LENIENT,
    // utils (frontends need a few of these for visualization/formatting)
    b64enc,
    b64dec,
    biToBytes,
    bytesToBi,
    padTo,
    sleep,
    fmtTime,
    modpow,
    genPrime,
    deriveAesKey,
    aadFor,
    benchmarkRate,
    TokenError,
    // high-level API
    lockSecret,
    parseToken,
    solve,
  };
})(typeof window !== "undefined" ? window : globalThis);
