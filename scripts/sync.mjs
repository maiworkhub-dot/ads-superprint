// Đồng bộ số liệu Meta Ads về thư mục site/data (đã mã hoá).
// Chạy tự động bằng GitHub Actions; có thể chạy tay: META_TOKEN=... DATA_PASSWORD=... node scripts/sync.mjs
//
// Biến môi trường:
//   META_TOKEN       (bắt buộc) mã truy cập Meta có quyền ads_read
//   DATA_PASSWORD    (bắt buộc) mật khẩu để mở trang báo cáo
//   BACKFILL_FROM    (tuỳ chọn) YYYY-MM-DD — lấy lại toàn bộ từ ngày này (lần chạy đầu mặc định 2025-01-01)
//   ACCOUNT_IDS      (tuỳ chọn) danh sách ID tài khoản, cách nhau bởi dấu phẩy, nếu chỉ muốn lấy vài tài khoản
//   META_API_VERSION (tuỳ chọn) mặc định v23.0
//   REFRESH_DAYS     (tuỳ chọn) số ngày gần nhất lấy lại mỗi lần chạy, mặc định 3 (lead hay được Meta cập nhật trễ)
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deriveKey, encryptJSON, decryptJSON, newSalt, verifier, ITER } from './crypto.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'site', 'data');
const DEFAULT_BACKFILL = '2025-01-01';

const LEAD_KEYS = ['lead', 'onsite_conversion.lead_grouped', 'leadgen_grouped', 'offsite_conversion.fb_pixel_lead', 'onsite_web_lead'];
const MSG_KEYS = ['onsite_conversion.messaging_conversation_started_7d'];

const log = (...a) => console.log('[sync]', ...a);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const todayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const timeIn = (tz) => new Intl.DateTimeFormat('vi-VN', { timeZone: tz || 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());

function actionValue(actions, keys) {
  if (!Array.isArray(actions)) return 0;
  const m = new Map(actions.map((a) => [a.action_type, Number(a.value) || 0]));
  for (const k of keys) if (m.has(k) && m.get(k) > 0) return m.get(k); // lấy chỉ số đầu tiên có giá trị, tránh cộng trùng
  return 0;
}
function resultType(objective, leads, msgs) {
  const o = String(objective || '').toUpperCase();
  if (o.includes('LEAD')) return 'lead';
  if (o.includes('MESSAGE')) return 'message';
  if (o.includes('ENGAGEMENT')) return msgs > 0 ? 'message' : leads > 0 ? 'lead' : 'engagement';
  if (o.includes('AWARENESS') || o.includes('REACH') || o.includes('BRAND')) return 'reach';
  if (o.includes('TRAFFIC') || o.includes('LINK_CLICK')) return 'click';
  if (o.includes('SALES') || o.includes('CONVERSION')) return leads > 0 ? 'lead' : msgs > 0 ? 'message' : 'other';
  return leads > 0 ? 'lead' : msgs > 0 ? 'message' : 'other';
}
const statusVi = (s) => ({ ACTIVE: 'Đang chạy', PAUSED: 'Đang tắt', CAMPAIGN_PAUSED: 'Đang tắt', ARCHIVED: 'Đã lưu trữ', DELETED: 'Đã xoá', IN_PROCESS: 'Đang xử lý', WITH_ISSUES: 'Có lỗi', ADSET_PAUSED: 'Nhóm QC đang tắt', PENDING_REVIEW: 'Đang xét duyệt', DISAPPROVED: 'Bị từ chối' }[s] || s || 'Không rõ');

// ---------------- Meta Graph API ----------------
function api(token, version) {
  const base = `https://graph.facebook.com/${version}/`;
  async function get(pathOrUrl, params = {}) {
    let url = pathOrUrl.startsWith('http') ? new URL(pathOrUrl) : new URL(base + pathOrUrl);
    if (!pathOrUrl.startsWith('http')) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    if (!url.searchParams.has('access_token')) url.searchParams.set('access_token', token);
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url);
      const body = await res.json().catch(() => ({}));
      if (res.ok && !body.error) return body;
      const e = body.error || {};
      const transient = [1, 2, 4, 17, 32, 341, 613, 80000, 80004].includes(e.code) || res.status >= 500;
      if (transient && attempt < 3) { await new Promise((r) => setTimeout(r, 5000 * (attempt + 1))); continue; }
      const err = new Error(`Meta API lỗi ${e.code || res.status}: ${e.message || res.statusText}`); err.meta = e; throw err;
    }
  }
  async function all(p, params) {
    const out = []; let page = await get(p, params);
    while (page) { out.push(...(page.data || [])); page = page.paging?.next ? await get(page.paging.next) : null; }
    return out;
  }
  return { get, all };
}

// ---------------- file helpers ----------------
async function readJSON(p, fallback) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; } }
async function writeIfChanged(p, key, obj, manifest, rel) {
  const plain = JSON.stringify(obj); const h = sha(plain);
  if (manifest.files[rel] === h) return false;
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(await encryptJSON(key, obj)));
  manifest.files[rel] = h; return true;
}

export async function run(env = process.env) {
  const token = env.META_TOKEN, password = env.DATA_PASSWORD;
  if (!token) throw new Error('Thiếu META_TOKEN.');
  if (!password) throw new Error('Thiếu DATA_PASSWORD.');
  const version = env.META_API_VERSION || 'v23.0';
  const refreshDays = Math.max(1, Number(env.REFRESH_DAYS || 3));
  const only = (env.ACCOUNT_IDS || '').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean);
  const g = api(token, version);

  // khoá mã hoá (salt cố định trong meta.json; đổi mật khẩu => tạo salt mới và ghi lại toàn bộ)
  const metaPath = path.join(DATA, 'meta.json');
  let meta = await readJSON(metaPath, null);
  let key, rekey = false;
  if (meta?.salt) {
    key = await deriveKey(password, meta.salt, meta.iter || ITER);
    try { await decryptJSON(key, meta.check); } catch { log('Mật khẩu đã đổi: mã hoá lại toàn bộ dữ liệu từ Meta.'); rekey = true; }
  }
  if (!meta?.salt || rekey) { meta = { salt: newSalt(), iter: ITER }; key = await deriveKey(password, meta.salt); meta.check = await verifier(key); rekey = true; }
  const manifestPath = path.join(DATA, 'manifest.json');
  const manifest = rekey ? { files: {} } : await readJSON(manifestPath, { files: {} });

  let index = { accounts: [] };
  if (!rekey) { try { index = await decryptJSON(key, await readJSON(path.join(DATA, 'index.json'))); } catch { index = { accounts: [] }; } }
  const prevAcc = new Map((index.accounts || []).map((a) => [a.id, a]));

  // 0. hạn của token
  let tokenExpires = null;
  try { const d = await g.get('debug_token', { input_token: token }); tokenExpires = d.data?.expires_at ? new Date(d.data.expires_at * 1000).toISOString() : 'never'; } catch { /* không bắt buộc */ }

  // 1. danh sách tài khoản quảng cáo mà token xem được
  const accRows = await g.all('me/adaccounts', { fields: 'id,account_id,name,currency,timezone_name,account_status,business{id,name}', limit: '200' });
  const accounts = accRows.filter((a) => !only.length || only.includes(String(a.account_id)));
  log(`Tìm thấy ${accRows.length} tài khoản, đồng bộ ${accounts.length}.`);

  const outAccounts = [];
  const allPages = new Set();
  const adOfPage = new Map();
  let changed = 0;
  for (const a of accounts) {
    const id = String(a.account_id);
    const prev = prevAcc.get(id) || { campaigns: [], months: [] };
    const tz = a.timezone_name || 'Asia/Ho_Chi_Minh';
    const today = todayIn(tz);
    const acc = {
      id, name: a.name || id, act_id: id, currency: a.currency || 'VND', timezone: tz,
      bm_id: a.business?.id || 'none', bm_name: a.business?.name || 'Không thuộc BM',
      account_status: a.account_status, campaigns: (prev.campaigns || []).map((c) => ({ ...c })),
      months: [...(prev.months || [])], first_date: prev.first_date || null,
      synced_through: today, synced_time: timeIn(tz), synced_at: new Date().toISOString(), error: null,
    };
    try {
      const byId = new Map(acc.campaigns.map((c, i) => [c.id, i]));
      const ensure = (cid, name) => {
        if (byId.has(cid)) return byId.get(cid);
        acc.campaigns.push({ id: cid, campaign: name, status: 'Không rõ', daily_budget: null, result_type: null, objective: null });
        byId.set(cid, acc.campaigns.length - 1); return acc.campaigns.length - 1;
      };
      // 2. camp + trạng thái + ngân sách
      const camps = await g.all(`act_${id}/campaigns`, { fields: 'id,name,effective_status,daily_budget,objective', limit: '500' });
      const adsets = await g.all(`act_${id}/adsets`, { fields: 'campaign_id,daily_budget,effective_status,promoted_object', limit: '500' }).catch(() => []);
      // fanpage mà camp đang chạy cho (lấy từ nhóm quảng cáo và mẫu quảng cáo)
      const pageOf = new Map();
      const addPage = (cid, pid) => { if (!cid || !pid) return; pid = String(pid); if (!pageOf.has(cid)) pageOf.set(cid, new Set()); pageOf.get(cid).add(pid); };
      for (const s of adsets) addPage(s.campaign_id, s.promoted_object?.page_id);
      const ads = await g.all(`act_${id}/ads`, { fields: 'campaign_id,creative{actor_id,object_story_spec{page_id},effective_object_story_id}', limit: '500' }).catch(() => []);
      for (const ad of ads) { const cr = ad.creative || {}; const pid = cr.object_story_spec?.page_id || cr.actor_id || (cr.effective_object_story_id || '').split('_')[0] || null; addPage(ad.campaign_id, pid); if (pid) { const l = adOfPage.get(pid) || []; if (l.length < 3) l.push(ad.id); adOfPage.set(pid, l); } }
      const adsetBudget = new Map();
      for (const s of adsets) if (s.effective_status === 'ACTIVE' && s.daily_budget) adsetBudget.set(s.campaign_id, (adsetBudget.get(s.campaign_id) || 0) + Number(s.daily_budget));
      const factor = ['VND', 'JPY', 'KRW', 'CLP', 'ISK', 'TWD', 'HUF', 'IDR', 'COP', 'PYG'].includes(acc.currency) ? 1 : 100; // ngân sách trả về theo đơn vị nhỏ nhất
      for (const c of camps) {
        const i = ensure(c.id, c.name), t = acc.campaigns[i];
        t.campaign = c.name; t.status = statusVi(c.effective_status); t.objective = c.objective;
        const db = c.daily_budget ? Number(c.daily_budget) : adsetBudget.get(c.id) || null;
        t.daily_budget = db ? db / factor : null;
      }
      for (const t of acc.campaigns) { if (pageOf.has(t.id)) t.page_ids = [...pageOf.get(t.id)]; for (const pid of t.page_ids || []) allPages.add(pid); }
      // 3. số liệu theo ngày
      const backfill = env.BACKFILL_FROM || (!prev.months?.length ? DEFAULT_BACKFILL : null);
      const since = backfill || addDays(prev.synced_through || today, -(refreshDays - 1));
      const fetched = new Map(); // date -> rows
      const typeVotes = new Map();
      for (let s = since; s <= today; s = addDays(s, 90)) {
        const u = addDays(s, 89) < today ? addDays(s, 89) : today;
        const rows = await g.all(`act_${id}/insights`, {
          level: 'campaign', time_increment: '1', time_range: { since: s, until: u }, limit: '500',
          fields: 'campaign_id,campaign_name,objective,spend,impressions,reach,clicks,actions',
        });
        for (const r of rows) {
          const ci = ensure(r.campaign_id, r.campaign_name);
          const leads = actionValue(r.actions, LEAD_KEYS), msgs = actionValue(r.actions, MSG_KEYS);
          const c = acc.campaigns[ci]; if (!c.objective && r.objective) c.objective = r.objective;
          const v = typeVotes.get(ci) || { lead: 0, message: 0 }; v.lead += leads; v.message += msgs; typeVotes.set(ci, v);
          const date = r.date_start;
          if (!fetched.has(date)) fetched.set(date, []);
          fetched.get(date).push({ ci, spend: Math.round(Number(r.spend) || 0), imp: Number(r.impressions) || 0, reach: Number(r.reach) || 0, clicks: Number(r.clicks) || 0, leads, msgs });
        }
        log(`${acc.name}: ${s} → ${u}: ${rows.length} dòng`);
      }
      for (const [ci, v] of typeVotes) acc.campaigns[ci].result_type = resultType(acc.campaigns[ci].objective, v.lead, v.message);
      for (const c of acc.campaigns) if (!c.result_type) c.result_type = resultType(c.objective, 0, 0);

      // 4. gộp vào file theo tháng
      const months = new Set([...acc.months]);
      const touchedMonths = new Set();
      for (let d = since; d <= today; d = addDays(d, 1)) touchedMonths.add(d.slice(0, 7));
      for (const mo of touchedMonths) {
        const rel = `days/${id}__${mo}.json`, p = path.join(DATA, rel);
        let rows = [];
        if (!rekey && !backfill) { try { rows = (await decryptJSON(key, await readJSON(p))).rows || []; } catch { rows = []; } }
        const lo = since > `${mo}-01` ? since : `${mo}-01`;
        rows = rows.filter((r) => `${mo}-${r[0]}` < lo); // bỏ các ngày vừa lấy lại
        for (const [date, list] of fetched) {
          if (date.slice(0, 7) !== mo) continue;
          for (const x of list) {
            const t = acc.campaigns[x.ci].result_type;
            const res = t === 'lead' ? x.leads : t === 'message' ? x.msgs : 0;
            if (x.spend > 0 || res > 0) rows.push([date.slice(8), x.ci, x.spend, x.imp, x.reach, x.clicks, res]);
          }
        }
        rows.sort((p1, p2) => p1[0].localeCompare(p2[0]) || p1[1] - p2[1]);
        if (rows.length) { months.add(mo); if (await writeIfChanged(p, key, { account_id: id, month: mo, rows }, manifest, rel)) changed++; }
      }
      acc.months = [...months].sort();
      const firstFetched = [...fetched.entries()].filter(([, l]) => l.some((x) => x.spend > 0)).map(([d]) => d).sort()[0];
      if (firstFetched && (!acc.first_date || firstFetched < acc.first_date || backfill)) acc.first_date = firstFetched;
      if (backfill && !firstFetched) acc.first_date = null;
    } catch (e) {
      log(`Lỗi tài khoản ${acc.name}: ${e.message}`);
      Object.assign(acc, { ...prev, error: e.message, synced_through: prev.synced_through || null });
      acc.bm_id = acc.bm_id || a.business?.id || 'none'; acc.bm_name = acc.bm_name || a.business?.name || 'Không thuộc BM';
    }
    outAccounts.push(acc);
  }

  // tên fanpage
  const pages = { ...(index.pages || {}) };
  const take = (list) => { for (const p of list || []) if (p?.id && p?.name) pages[p.id] = p.name; };
  if ([...allPages].some((p) => !pages[p])) {
    for (const a of outAccounts) take(await g.all(`act_${a.id}/promote_pages`, { fields: 'name', limit: '100' }).catch(() => []));
    for (const b of new Set(outAccounts.map((a) => a.bm_id).filter((b) => b && b !== 'none'))) {
      take(await g.all(`${b}/owned_pages`, { fields: 'name', limit: '100' }).catch(() => []));
      take(await g.all(`${b}/client_pages`, { fields: 'name', limit: '100' }).catch(() => []));
    }
    take(await g.all('me/accounts', { fields: 'name', limit: '100' }).catch(() => []));
  }
  const need = [...allPages].filter((p) => !pages[p]);
  for (let i = 0; i < need.length; i += 50) {
    const chunk = need.slice(i, i + 50);
    try { const r = await g.get('', { ids: chunk.join(','), fields: 'name' }); for (const [k, v] of Object.entries(r || {})) if (v?.name) pages[k] = v.name; }
    catch { for (const pid of chunk) { try { const r = await g.get(pid, { fields: 'name' }); if (r?.name) pages[pid] = r.name; } catch { /* không đọc được tên */ } } }
  }
  // page của BM khách: đọc tên công khai từ trang Facebook
  const dec = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).trim();
  const bad = /^(facebook|log in|đăng nhập|content not found|error|trang|page not found)/i;
  for (const pid of [...allPages].filter((p) => !pages[p])) {
    for (const [url, ua] of [[`https://www.facebook.com/${pid}`, 'facebookexternalhit/1.1'], [`https://m.facebook.com/${pid}`, 'facebookexternalhit/1.1'], [`https://www.facebook.com/profile.php?id=${pid}`, 'Mozilla/5.0']]) {
      try {
        const html = await (await fetch(url, { headers: { 'user-agent': ua, 'accept-language': 'vi,en' }, redirect: 'follow' })).text();
        const m = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) || html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const name = m && dec(m[1]).replace(/\s*[|\-–]\s*Facebook$/i, '');
        if (name && !bad.test(name)) { pages[pid] = name; break; }
      } catch { /* thử cách khác */ }
    }
  }
  // cách cuối: xem trước quảng cáo (chỉ cần ads_read) – trong khung xem trước có tên page
  const fromPreview = (html, pid) => [
    html.match(new RegExp(`facebook\\.com\\/(?:${pid}|[^"'/?]+)\\/?["'][^>]*>(?:<[^>]+>)*([^<]{2,80})<`, 'i'))?.[1],
    html.match(/"page_name"\s*:\s*"([^"]+)"/)?.[1],
    html.match(/aria-label="([^"]{2,80})"[^>]*role="link"/)?.[1],
    html.match(/<strong[^>]*>(?:<[^>]+>)*([^<]{2,80})</)?.[1],
    html.match(/<h[2-4][^>]*>(?:<[^>]+>)*([^<]{2,80})</)?.[1],
  ].filter(Boolean).map((x) => dec(x.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))))).find((x) => !bad.test(x));
  for (const pid of [...allPages].filter((p) => !pages[p] && adOfPage.has(p))) {
    let last = '';
    outer: for (const adId of adOfPage.get(pid)) for (const fmt of ['DESKTOP_FEED_STANDARD', 'MOBILE_FEED_STANDARD', 'INSTAGRAM_STANDARD']) {
      try {
        const pv = await g.get(`${adId}/previews`, { ad_format: fmt });
        const src = dec((pv?.data?.[0]?.body || '').match(/src="([^"]+)"/)?.[1] || '');
        if (!src) continue;
        const html = await (await fetch(src, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/130', 'accept-language': 'vi,en' } })).text();
        const name = fromPreview(html, pid);
        if (name) { pages[pid] = name; break outer; }
        last = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160);
      } catch (e) { last = String(e.message || e).slice(0, 120); }
    }
    if (!pages[pid]) log(`  preview ${pid}: ${last}`);
  }
  log(`Fanpage: ${allPages.size} page, đọc được tên ${Object.keys(pages).length}. Thiếu: ${[...allPages].filter((p) => !pages[p]).join(', ') || 'không'}`);
  const out = { synced_at: new Date().toISOString(), token_expires: tokenExpires, api_version: version, pages, accounts: outAccounts };
  await fs.mkdir(DATA, { recursive: true });
  await fs.writeFile(path.join(DATA, 'index.json'), JSON.stringify(await encryptJSON(key, out)));
  await fs.writeFile(metaPath, JSON.stringify(meta));
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  log(`Xong: ${outAccounts.length} tài khoản, ${changed} file số liệu thay đổi.`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((e) => { console.error('[sync] THẤT BẠI:', e.message); process.exit(1); });
}
