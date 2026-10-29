// Mã hoá / giải mã dữ liệu bằng mật khẩu (AES-GCM, khoá dẫn xuất PBKDF2-SHA256).
// Trang web dùng đúng thuật toán này (Web Crypto) để giải mã trong trình duyệt.
import { webcrypto as wc } from 'node:crypto';
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
export const ITER = 200000;

export async function deriveKey(password, saltB64, iter = ITER) {
  const base = await wc.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return wc.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(saltB64), iterations: iter, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
export async function encryptJSON(key, obj) {
  const iv = wc.getRandomValues(new Uint8Array(12));
  const ct = await wc.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { v: 1, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}
export async function decryptJSON(key, box) {
  const pt = await wc.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
  return JSON.parse(dec.decode(pt));
}
export const newSalt = () => b64(wc.getRandomValues(new Uint8Array(16)));
export async function verifier(key) { // để trang kiểm tra mật khẩu đúng hay sai
  return encryptJSON(key, { ok: 'superprint-ads' });
}
