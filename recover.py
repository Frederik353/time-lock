#!/usr/bin/env python3
"""
should i ever need a fast server to recover something quicker.

Usage:
  python3 recover.py "TL2...."          token string as an argument
  python3 recover.py token.txt          a file that contains the token
  python3 recover.py < token.txt        token on stdin
  python3 recover.py --pure "TL2...."   force the built-in AES-GCM (self-contained)

Dependencies (all optional):
  gmpy2         big-int squaring, roughly 5-10x faster. Falls back to plain
                Python ints if missing (works everywhere, just slower).
  cryptography  or pycryptodome for the final AES-GCM decrypt. If neither is
                present, a stdlib-only AES-GCM built into this file is used, so
                the script runs on bare Python with no installs at all.
"""
import sys
import json
import base64
import hashlib
import time

# ---- big-int squaring backend: gmpy2 if available, else Python int ----
try:
    from gmpy2 import mpz

    _BACKEND = "gmpy2"
except Exception:  # pragma: no cover - environment dependent
    mpz = int
    _BACKEND = "python-int"


# --------------------------------------------------------------------------
# token
# --------------------------------------------------------------------------
def b64d(s):
    return base64.b64decode(s)


def load_token(raw):
    s = raw.strip()
    if not s.startswith("TL2."):
        raise SystemExit("error: that does not look like a Time Lock token (no TL2. prefix).")
    try:
        body = json.loads(b64d(s[4:]).decode("utf-8"))
    except Exception as e:
        raise SystemExit("error: could not decode the token: %s" % e)
    if body.get("v") != 2:
        raise SystemExit("error: unsupported token version: %r" % body.get("v"))
    try:
        N = int.from_bytes(b64d(body["n"]), "big")
        g = int.from_bytes(b64d(body["g"]), "big")
        t = int(body["t"])
        iv = b64d(body["iv"])
        ct = b64d(body["ct"])
    except Exception as e:
        raise SystemExit("error: token is missing or has a bad field: %s" % e)
    mode = 1 if body.get("m") == 1 else 0
    if not (N > 1 and t >= 1):
        raise SystemExit("error: token is malformed.")
    return N, g, t, iv, ct, mode


# --------------------------------------------------------------------------
# the actual time-lock work: x = g, then square it t times mod N
# --------------------------------------------------------------------------
def fmt(sec):
    if sec != sec or sec in (float("inf"), float("-inf")):  # nan/inf
        return "--:--"
    sec = int(round(sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    if h:
        return "%d:%02d:%02d" % (h, m, s)
    return "%d:%02d" % (m, s)


def solve(N, g, t):
    Nm = mpz(N)
    x = mpz(g) % Nm
    start = time.time()
    last_print = 0.0
    i = 0
    batch = 2000
    while i < t:
        step = batch if (t - i) >= batch else (t - i)
        for _ in range(step):
            x = x * x % Nm
        i += step
        now = time.time()
        el = now - start
        if now - last_print > 0.2 or i == t:
            last_print = now
            rate = i / el if el > 0 else 0.0
            rem = (t - i) / rate if rate > 0 else float("inf")
            sys.stderr.write(
                "\r  {:6.2f}%  {:,}/{:,} sq  {:,.0f} sq/s  elapsed {}  eta {}        ".format(
                    100.0 * i / t, i, t, rate, fmt(el), fmt(rem)
                )
            )
            sys.stderr.flush()
    sys.stderr.write("\n")
    return int(x)


# --------------------------------------------------------------------------
# key derivation + AES-GCM decrypt (mirror of the web unit)
#   key = SHA-256( material, left-padded to N's byte length )
#   AES-256-GCM, iv = 12 bytes, aad = b"time-lock/mode=<0|1>", tag appended to ct
# --------------------------------------------------------------------------
def derive_key(material, N):
    modlen = (N.bit_length() + 7) // 8
    mk = material.to_bytes(modlen, "big")
    return hashlib.sha256(mk).digest()


def decrypt(key, iv, ct_and_tag, mode, force_pure=False):
    aad = ("time-lock/mode=%d" % mode).encode()
    auth_err = "error: authentication failed. Token corrupted, tampered, or wrong secret."
    if not force_pure:
        try:
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
            from cryptography.exceptions import InvalidTag
        except ImportError:
            pass
        else:
            try:
                return AESGCM(key).decrypt(iv, ct_and_tag, aad)
            except InvalidTag:
                raise SystemExit(auth_err)
        try:
            from Crypto.Cipher import AES
        except ImportError:
            pass
        else:
            tag = ct_and_tag[-16:]
            ct = ct_and_tag[:-16]
            c = AES.new(key, AES.MODE_GCM, nonce=iv)
            c.update(aad)
            try:
                return c.decrypt_and_verify(ct, tag)
            except ValueError:
                raise SystemExit(auth_err)
    return _pure_aesgcm_decrypt(key, iv, ct_and_tag, aad)


# --------------------------------------------------------------------------
# stdlib-only AES-256-GCM, so the script needs zero installs if it has to.
# Encrypt-only AES core (GCM only ever encrypts), plus GHASH over GF(2^128).
# --------------------------------------------------------------------------
_SBOX = (
    b"c|w{\xf2ko\xc50\x01g+\xfe\xd7\xabv\xca\x82\xc9}\xfaYG\xf0\xad\xd4\xa2\xaf"
    b"\x9c\xa4r\xc0\xb7\xfd\x93&6?\xf7\xcc4\xa5\xe5\xf1q\xd81\x15\x04\xc7#\xc3"
    b"\x18\x96\x05\x9a\x07\x12\x80\xe2\xeb'\xb2u\t\x83,\x1a\x1bnZ\xa0R;\xd6\xb3"
    b")\xe3/\x84S\xd1\x00\xed \xfc\xb1[j\xcb\xbe9JLX\xcf\xd0\xef\xaa\xfbCM3\x85"
    b"E\xf9\x02\x7fP<\x9f\xa8Q\xa3@\x8f\x92\x9d8\xf5\xbc\xb6\xda!\x10\xff\xf3\xd2"
    b"\xcd\x0c\x13\xec_\x97D\x17\xc4\xa7~=d]\x19s`\x81O\xdc\"*\x90\x88F\xee\xb8"
    b"\x14\xde^\x0b\xdb\xe02:\nI\x06$\\\xc2\xd3\xacb\x91\x95\xe4y\xe7\xc87m\x8d"
    b"\xd5N\xa9lV\xf4\xeaez\xae\x08\xbax%.\x1c\xa6\xb4\xc6\xe8\xddt\x1fK\xbd\x8b"
    b"\x8ap>\xb5fH\x03\xf6\x0ea5W\xb9\x86\xc1\x1d\x9e\xe1\xf8\x98\x11i\xd9\x8e"
    b"\x94\x9b\x1e\x87\xe9\xceU(\xdf\x8c\xa1\x89\r\xbf\xe6BhA\x99-\x0f\xb0T\xbb\x16"
)
_RCON = (0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36,
         0x6C, 0xD8, 0xAB, 0x4D)


def _xtime(a):
    a <<= 1
    if a & 0x100:
        a ^= 0x11B
    return a & 0xFF


def _mul(a, b):
    p = 0
    for _ in range(8):
        if b & 1:
            p ^= a
        b >>= 1
        a = _xtime(a)
    return p


def _key_expansion(key):
    # AES-256: Nk=8, Nr=14 -> 60 words
    Nk, Nr = 8, 14
    w = [list(key[4 * i:4 * i + 4]) for i in range(Nk)]
    for i in range(Nk, 4 * (Nr + 1)):
        temp = list(w[i - 1])
        if i % Nk == 0:
            temp = temp[1:] + temp[:1]  # RotWord
            temp = [_SBOX[b] for b in temp]  # SubWord
            temp[0] ^= _RCON[i // Nk - 1]
        elif Nk > 6 and i % Nk == 4:
            temp = [_SBOX[b] for b in temp]
        w.append([w[i - Nk][j] ^ temp[j] for j in range(4)])
    # group into 15 round keys of 16 bytes
    return [bytes(w[4 * r + c][b] for c in range(4) for b in range(4))
            for r in range(Nr + 1)]


def _aes256_encrypt_block(block, round_keys):
    Nr = 14
    s = [[block[r + 4 * c] for c in range(4)] for r in range(4)]  # column-major

    def add_rk(rk):
        for c in range(4):
            for r in range(4):
                s[r][c] ^= rk[r + 4 * c]

    add_rk(round_keys[0])
    for rnd in range(1, Nr):
        # SubBytes
        for r in range(4):
            for c in range(4):
                s[r][c] = _SBOX[s[r][c]]
        # ShiftRows
        for r in range(1, 4):
            s[r] = s[r][r:] + s[r][:r]
        # MixColumns
        for c in range(4):
            a0, a1, a2, a3 = s[0][c], s[1][c], s[2][c], s[3][c]
            s[0][c] = _mul(a0, 2) ^ _mul(a1, 3) ^ a2 ^ a3
            s[1][c] = a0 ^ _mul(a1, 2) ^ _mul(a2, 3) ^ a3
            s[2][c] = a0 ^ a1 ^ _mul(a2, 2) ^ _mul(a3, 3)
            s[3][c] = _mul(a0, 3) ^ a1 ^ a2 ^ _mul(a3, 2)
        add_rk(round_keys[rnd])
    # final round, no MixColumns
    for r in range(4):
        for c in range(4):
            s[r][c] = _SBOX[s[r][c]]
    for r in range(1, 4):
        s[r] = s[r][r:] + s[r][:r]
    add_rk(round_keys[Nr])
    return bytes(s[r][c] for c in range(4) for r in range(4))


def _gf_mul(x, y):
    # multiply in GF(2^128), GCM bit convention
    R = 0xE1000000000000000000000000000000
    z = 0
    v = x
    for i in range(127, -1, -1):
        if (y >> i) & 1:
            z ^= v
        if v & 1:
            v = (v >> 1) ^ R
        else:
            v >>= 1
    return z


def _ghash(h, data):
    y = 0
    for i in range(0, len(data), 16):
        block = data[i:i + 16]
        block = block + b"\x00" * (16 - len(block))
        y ^= int.from_bytes(block, "big")
        y = _gf_mul(y, h)
    return y


def _pure_aesgcm_decrypt(key, iv, ct_and_tag, aad):
    if len(key) != 32:
        raise SystemExit("error: expected a 256-bit key.")
    if len(iv) != 12:
        raise SystemExit("error: this build expects a 96-bit IV.")
    tag = ct_and_tag[-16:]
    ct = ct_and_tag[:-16]
    rk = _key_expansion(key)
    h = int.from_bytes(_aes256_encrypt_block(b"\x00" * 16, rk), "big")
    j0 = iv + b"\x00\x00\x00\x01"

    # GHASH(aad || pad || ct || pad || len(aad)_64 || len(ct)_64)
    g = b""
    g += aad + b"\x00" * ((16 - len(aad) % 16) % 16)
    g += ct + b"\x00" * ((16 - len(ct) % 16) % 16)
    g += (len(aad) * 8).to_bytes(8, "big") + (len(ct) * 8).to_bytes(8, "big")
    s = _ghash(h, g)
    ej0 = int.from_bytes(_aes256_encrypt_block(j0, rk), "big")
    expected = (s ^ ej0).to_bytes(16, "big")

    import hmac as _hmac
    if not _hmac.compare_digest(expected, tag):
        raise SystemExit("error: authentication failed. Token corrupted, tampered, or wrong secret.")

    # CTR decrypt starting at inc32(j0)
    out = bytearray()
    counter = int.from_bytes(j0, "big")
    for i in range(0, len(ct), 16):
        counter = (counter & ~0xFFFFFFFF) | ((counter + 1) & 0xFFFFFFFF)
        ks = _aes256_encrypt_block(counter.to_bytes(16, "big"), rk)
        chunk = ct[i:i + 16]
        out += bytes(a ^ b for a, b in zip(chunk, ks))
    return bytes(out)


# --------------------------------------------------------------------------
def read_token(args):
    import os

    if not args:
        data = sys.stdin.read()
        if not data.strip():
            raise SystemExit(__doc__)
        return data
    arg = args[0]
    if arg.startswith("TL2."):
        return arg
    if os.path.isfile(arg):
        with open(arg, "r", encoding="utf-8") as f:
            return f.read()
    return arg


def main(argv):
    force_pure = False
    args = []
    for a in argv:
        if a in ("-h", "--help"):
            print(__doc__)
            return 0
        if a == "--pure":
            force_pure = True
        else:
            args.append(a)

    raw = read_token(args)
    N, g, t, iv, ct, mode = load_token(raw)

    modlen = (N.bit_length() + 7) // 8
    sys.stderr.write(
        "Time Lock recovery\n"
        "  modulus   : %d-bit (%d bytes)\n"
        "  squarings : %s\n"
        "  on leave  : %s\n"
        "  backend   : %s\n"
        "  decrypt   : %s\n\n"
        % (N.bit_length(), modlen, format(t, ","),
           "lenient (pause/resume)" if mode == 1 else "strict (reset)",
           _BACKEND, "built-in AES-GCM" if force_pure else "library if present")
    )

    start = time.time()
    material = solve(N, g, t)
    key = derive_key(material, N)
    secret = decrypt(key, iv, ct, mode, force_pure=force_pure)
    elapsed = time.time() - start

    sys.stderr.write("\nunlocked in %s\n" % fmt(elapsed))
    sys.stderr.write("----- secret below (stdout) -----\n")
    sys.stderr.flush()
    # secret goes to stdout so you can pipe it; diagnostics went to stderr
    sys.stdout.buffer.write(secret)
    if not secret.endswith(b"\n"):
        sys.stdout.buffer.write(b"\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
