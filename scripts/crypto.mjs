// Mã hoá / giải mã dữ liệu bằng mật khẩu (AES-GCM, khoá dẫn xuất PBKDF2-SHA256).
// Trang web dùng đúng thuật toán này (Web Crypto) để giải mã trong trình duyệt.
//
// Phân quyền:
//  - Mỗi tài khoản quảng cáo có 1 khoá riêng (ngẫu nhiên). Số liệu của tài khoản được mã hoá bằng khoá đó.
//  - Chủ trang (mật khẩu DATA_PASSWORD) giữ "chùm khoá" keyring.json chứa khoá của mọi tài khoản.
//  - Người xem có cặp khoá ECDH P-256 (khoá bí mật được khoá bằng mật khẩu của họ). Máy đồng bộ gói
//    khoá các tài khoản được phép vào keys/<uid>.json bằng khoá công khai của họ.
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

// ---- khoá riêng từng tài khoản quảng cáo ----
export const newRawKey = () => b64(wc.getRandomValues(new Uint8Array(32)));
export const importRawKey = (rawB64) => wc.subtle.importKey('raw', unb64(rawB64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

// ---- gói dữ liệu cho một người xem (ECDH P-256 + AES-GCM) ----
async function sharedKey(priv, pub) {
  const bits = new Uint8Array(await wc.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
  const tag = enc.encode('evelyn-ads-studio/v1');
  const mix = new Uint8Array(bits.length + tag.length); mix.set(bits); mix.set(tag, bits.length);
  const h = await wc.subtle.digest('SHA-256', mix);
  return wc.subtle.importKey('raw', h, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
export async function sealFor(pubB64, obj) {
  const pub = await wc.subtle.importKey('raw', unb64(pubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await wc.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const k = await sharedKey(eph.privateKey, pub);
  const epk = b64(new Uint8Array(await wc.subtle.exportKey('raw', eph.publicKey)));
  return { epk, ...(await encryptJSON(k, obj)) };
}
