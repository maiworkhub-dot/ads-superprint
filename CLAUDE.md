# Dashboard báo cáo Meta Ads – SuperPrint ("Evelyn Ads Studio")

## Người dùng
- Marketing lead, KHÔNG rành code. Luôn trả lời bằng tiếng Việt, giải thích đơn giản, tránh thuật ngữ; nếu buộc phải dùng thì giải thích kèm ví dụ đời thường.
- Trước khi đưa thay đổi lên web (push lên `main`), tóm tắt bằng lời thường sẽ đổi gì và hỏi xác nhận.
- Ưu tiên mọi thứ chạy nền trên cloud (GitHub Actions), không phụ thuộc máy tính của người dùng.

## Dự án làm gì
- Trang web tĩnh hiển thị số liệu quảng cáo Meta (chi tiêu, kết quả, CPR, CTR, CPM, CPC…) theo tài khoản / camp / ngày, có khóa bằng mật khẩu.
- Địa chỉ hiện tại: https://maiworkhub-dot.github.io/ads-superprint (GitHub Pages). Dự định gắn tên miền `marketing.superprint.vn` (cần IT thêm CNAME `marketing` → `maiworkhub-dot.github.io`).

## Cấu trúc
- `site/index.html` – toàn bộ giao diện (HTML + CSS + JS trong 1 file): màn khóa mật khẩu, Dashboard, biểu đồ, bảng "Tất cả camp", khung "Ra lệnh: bật / tắt / ngân sách camp", đăng nhập Facebook.
- `site/data/` – số liệu ĐÃ MÃ HOÁ (AES-GCM, khóa từ mật khẩu qua PBKDF2-SHA256 200k vòng). `index.json` = danh sách tài khoản/camp; `days/<accountId>__<YYYY-MM>.json` = số liệu theo ngày từng tháng; `meta.json` = salt + chuỗi kiểm tra mật khẩu; `manifest.json` = hash để chỉ ghi file khi đổi.
- `scripts/sync.mjs` – kéo số liệu từ Meta Graph API (mặc định v23.0), mã hoá, ghi vào `site/data/`. `scripts/crypto.mjs` – mã hoá/giải mã (trang web dùng đúng thuật toán này bằng Web Crypto).
- `.github/workflows/sync.yml` – chạy 2 tiếng/lần từ 07:00–23:00 giờ VN, commit số liệu ("Cập nhật số liệu dd/mm HH:MM") rồi deploy Pages. Chạy tay được (workflow_dispatch) với `backfill_from` để lấy lại từ một ngày.

## Bí mật – tuyệt đối không ghi vào code
- `META_TOKEN` (token Meta quyền ads_read) và `DATA_PASSWORD` (mật khẩu mở trang) nằm ở GitHub Secrets; `ACCOUNT_IDS` ở GitHub Variables.
- Repo là public (GitHub Pages miễn phí) → ai cũng xem được code. Không bao giờ commit token, mật khẩu, số liệu chưa mã hoá.

## Lưu ý khi sửa
- Đổi cấu trúc dữ liệu trong `sync.mjs` thì phải sửa phần đọc tương ứng trong `site/index.html`.
- Không sửa tay các file trong `site/data/` – để workflow tạo lại.
- Kiểm tra trang sau khi sửa (mở `site/index.html` qua một server tĩnh) trước khi push.
