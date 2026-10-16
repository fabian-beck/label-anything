const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VALUES = new Uint8Array(128);
for (let i = 0; i < ALPHABET.length; i++) VALUES[ALPHABET.charCodeAt(i)] = i;

/** Decodes standard (padded) base64 without depending on `atob` or `Buffer`. */
export function decodeBase64(text: string): Uint8Array {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 61 /* = */) end--;
  const out = new Uint8Array(Math.floor((end * 3) / 4));
  let bits = 0;
  let count = 0;
  let o = 0;
  for (let i = 0; i < end; i++) {
    bits = (bits << 6) | VALUES[text.charCodeAt(i) & 0x7f];
    count += 6;
    if (count >= 8) {
      count -= 8;
      out[o++] = (bits >> count) & 0xff;
    }
  }
  return out;
}
