# Evelyn Ads Studio – ghi chú cho Claude Code

Web báo cáo quảng cáo Meta (Facebook/Instagram) của Evelyn (Mai). Chạy miễn phí trên GitHub:
GitHub Actions lấy số liệu từ Meta mỗi giờ, GitHub Pages đưa web lên mạng.

- Web: https://maiworkhub-dot.github.io/evelyn-ads-studio/ (có mật khẩu)
- Kho: https://github.com/maiworkhub-dot/evelyn-ads-studio
- Người dùng không rành code: giải thích đơn giản bằng tiếng Việt, tự làm thay vì hướng dẫn khi có thể.

## Quy ước bắt buộc
- Gọi chiến dịch là **"camp"** (không viết "cam").
- Tên camp luôn ghi **đầy đủ, đúng như trên Meta**, không rút gọn, ở mọi chỗ (báo cáo, tin nhắn, bảng).
- Giao diện tông pastel nữ tính, đơn giản, dễ dùng; tiếng Việt.
- Thay đổi lớn về hình thức báo cáo: đề xuất mẫu cho người dùng duyệt trước rồi mới code.
- Không bao giờ ghi mã Meta (token) hay mật khẩu vào code. Chỉ để trong GitHub → Settings → Secrets.
- Không sửa tay `site/data/` (máy tự ghi, đã mã hoá).

## Cấu trúc
```
site/index.html            Toàn bộ giao diện (1 file: HTML + CSS + JS, không build)
site/data/                 Số liệu đã mã hoá (máy tự ghi)
  meta.json                {salt, iter, check} – dùng kiểm tra mật khẩu chủ trang
  manifest.json            {files: {đường_dẫn: sha16}}
  index.json (khoá chính)  {synced_at, token_expires, api_version, pages, accounts[...]}
  keyring.json (khoá chính) {keys: {act: khoá_riêng}, done, grants} – khoá riêng từng tài khoản
  acct/<act>.json (khoá TK) {synced_at, pages (của TK), account} – bản cho người xem
  days/<act>__<YYYY-MM>.json (khoá TK)  hàng [dd, chỉ_số_camp, spend, imp, reach, clicks, res, link_clicks, leads, msgs, engagement]
  approvals/<uid>__<ms>.json  chủ trang tạo qua trang "new file" của GitHub (web điền sẵn): hồ sơ + accounts ([] = xoá)
  users/<uid>.json         hồ sơ đăng nhập công khai (máy ghi từ approvals): u, name, salt, iter, pub, priv
  keys/<uid>.json          máy đồng bộ gói khoá các TK được xem cho người đó (ECDH P-256)
  userlist.json (khoá chính) danh sách người xem cho tab Người xem
scripts/sync.mjs           Lấy số liệu Meta Graph API (Node 22, không thư viện ngoài)
scripts/crypto.mjs         AES-GCM, khoá PBKDF2-SHA256 200k vòng từ mật khẩu
.github/workflows/sync.yml Lịch chạy + commit dữ liệu + deploy Pages
```
Mỗi tài khoản trong index: id, name, bm_id, bm_name, campaigns[{id, campaign, status, daily_budget,
result_type, objective, page_ids}], months, first_date, synced_through, synced_time, error.
Loại kết quả: lead, message, reach, click, engagement, other — chỉ **lead** và **message** tính vào
"kết quả" và CPL.

## Đồng bộ (scripts/sync.mjs)
- Secrets: `META_TOKEN` (mã người dùng, quyền ads_read + business_management, sống ~60 ngày),
  `DATA_PASSWORD` (mật khẩu web). Biến tuỳ chọn: `ACCOUNT_IDS`, `META_API_VERSION` (mặc định v23.0),
  `BACKFILL_FROM` (lấy lại toàn bộ từ ngày), `REFRESH_DAYS` (mặc định 3).
- Lịch: `5 0-16 * * *` UTC = mỗi giờ 7h–23h giờ VN. Chạy tay: Actions → "Đồng bộ Meta Ads" → Run workflow
  (`gh workflow run sync.yml -R maiworkhub-dot/evelyn-ads-studio`).
- Lấy: /me/adaccounts → mỗi tài khoản: campaigns, adsets, ads (để biết fanpage), insights level=campaign
  theo ngày. Tên fanpage: promote_pages, owned/client_pages của BM, trang công khai, bản xem trước quảng cáo.
- Đổi mật khẩu web: sửa secret DATA_PASSWORD rồi chạy lại với backfill_from = 2025-01-01 (mã hoá lại toàn bộ).
- Lỗi 190 = mã Meta hết hạn/bị huỷ → tạo mã mới ở Graph API Explorer (app "Ads Superprint",
  id 1915751329586412) → Extend → dán vào secret META_TOKEN.

## Người xem (chỉ xem Báo cáo ngày + Dashboard)
- uid = sha256(tên đăng nhập viết thường)[:16]. Chủ trang đăng nhập với tên trống/`admin` + mật khẩu DATA_PASSWORD.
- Người xem bấm Đăng ký → web tạo cặp khoá, khoá bí mật được khoá bằng mật khẩu của họ → ra mã `EAS1-…` gửi chủ trang.
- Tab "Người xem" (chỉ chủ trang): dán mã, tick tài khoản → web mở `github.com/<repo>/new/main?filename=site/data/approvals/…&value=…`,
  chủ trang bấm Commit. Không dùng GitHub API từ trình duyệt (máy chủ trang bị "Failed to fetch").
  Push đó chạy workflow với `USERS_ONLY=1`: lấy bản approvals mới nhất mỗi người → users/, keys/, userlist.json, xoá approvals cũ.
- Bỏ quyền/xoá người xem → máy đồng bộ đổi khoá tài khoản đó (mã cũ không mở được số liệu mới).
- Người xem thấy tab Báo cáo ngày + Dashboard (của TK được cấp), không thấy Camp & lệnh / Người xem, không ra lệnh.

## Giao diện (site/index.html)
Màn đăng nhập (chủ trang / người xem / đăng ký) → chọn BM → tài khoản → fanpage. 4 tab:
1. **Báo cáo ngày**: ô tổng, bảng từng camp (Chi tiêu, KQ, CPL, CTR, CPM, CPC, Hiển thị), Hiệu quả / Chưa
   hiệu quả kèm nguyên nhân (`diagnose()`: so CPM, CTR, tỷ lệ click→KQ với TB 30 ngày), tin nhắn gửi sếp.
   Mẫu tin nhắn đã chốt:
   ```
   📊 BÁO CÁO ADS dd/mm | <TÊN FANPAGE> (page đang lọc / page có camp chạy trong ngày; không rõ thì tên TK)
   💰 Chi phí: …đ
   🎯 Kết quả: N lead – CPL …đ   (+ từng camp: lead, CPL)
   ▶️ Camp đang chạy: n – Hiệu quả: a | Chưa hiệu quả: b
   ✅ Hiệu quả: • camp – …đ/lead: lý do
   ⚠️ Chưa hiệu quả: • camp – …đ/lead (giả định: …)
   👉 Đề xuất: 1. … 2. …
   ```
   Bảng camp: Kết quả và Giá/KQ theo mục tiêu từng camp; CTR, CPC tính theo click vào link.
2. **Dashboard**: chọn **bộ chỉ số** (Tổng quan, Tin nhắn, Form, Tiếp cận, Lưu lượng, Tương tác – mỗi bộ 5 chỉ số,
   chỉ tính camp đúng mục tiêu; định nghĩa ở `MET`/`SETS`) + chọn thời gian (Từ khi camp chạy, Hôm nay, Hôm qua, Tuần này/Tuần trước T2–CN,
   7/30 ngày, Tháng này, Toàn bộ, tự chọn) + chọn camp; 6 ô KPI so kỳ trước; "Chỉ số tốt hay chưa tốt";
   biểu đồ SVG tự vẽ theo bộ chỉ số + tỷ trọng; bảng camp có Đánh giá, Ngày chạy (từ–đến); báo cáo từng
   ngày (tổng ngày); báo cáo từng ngày chi tiết (tách camp); tổng hợp tháng. Tiêu đề khung viết hoa.
4. **Người xem**: duyệt/sửa/xoá người xem (xem phần trên).
3. **Camp & lệnh**: danh sách camp + ô lệnh tiếng Việt gọi thẳng Meta từ trình duyệt:
   `tắt/bật <tên camp>`, `đặt ngân sách camp X 300k`, `tăng 20% ngân sách camp X`, `giảm … xuống/bớt …`.
   Luôn hiện danh sách để bấm "Xác nhận thực hiện". Quyền lấy qua **Đăng nhập Facebook**
   (FB JS SDK, Login for Business config_id 1093583000337164, quyền ads_management) hoặc mã dán tay.

## Quy tắc tự động trên Meta (Ads Manager → Quy tắc tự động, tài khoản Nantex 2333829780037368)
Theo thẻ trong tên camp, ngưỡng tính riêng từng camp trong ngày hôm nay:
- `AUTO-TAT` → tự tắt camp khi chi > 400k mà 0 kết quả, hoặc CPL > 200k (CPL chỉ xét camp > 8.000 hiển thị trọn đời).
- `CANH-BAO` → chỉ gửi thông báo với cùng ngưỡng.

## Thử nhanh khi sửa giao diện
Không có build. Mở `site/index.html` qua một server tĩnh (`npx serve site` hoặc
`python3 -m http.server -d site`) và nhập mật khẩu; dữ liệu thật đã mã hoá trong `site/data/`.
Sau khi đẩy lên `main`, workflow tự deploy (~1 phút).
