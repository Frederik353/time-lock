# Time Lock

A tiny, fully client-side time-lock. It encrypts locally in your browser and makes you wait out sequential work to get it back, as anti-impulse friction.

Under the hood it's the classic RSW time-lock puzzle (Rivest, Shamir and Wagner, 1996): the key is buried behind a long chain of repeated squarings mod an RSA modulus, and since each square depends on the last there's no known shortcut, so you just have to grind through them.

**Live:** https://time-lock.frederik-negaard.workers.dev

- Nothing is ever sent anywhere; everything runs in the browser.
- `src/` is the static site (deploy the folder).
- `recover.py` redoes the unlock work on a faster machine if you ever need it.
