# 🏢 Real Estate Inventory Crawler & Email Alert System

Hệ thống backend tự động thu thập (crawler), đồng bộ dữ liệu rổ hàng bất động sản từ các nền tảng **HiSale** (`hisale.com`) và **SalePro** (`salepro.com`), lưu trữ nội bộ vào cơ sở dữ liệu MongoDB và gửi email cảnh báo tự động qua Gmail SMTP khi phát hiện có căn hộ mới xuất hiện.

---

## 🌟 Tính năng nổi bật

- **Đa nền tảng & Đa phân khúc**:
  - **HiSale**: Tự động xác thực tài khoản, thu thập dữ liệu rổ hàng của toàn bộ các dự án mở bán.
  - **SalePro**: Thu thập đồng bộ danh mục dự án, cào chuyên sâu cả phân khúc **Thấp tầng** (Biệt thự, Shophouse, Liền kề) và **Cao tầng** (Căn hộ chung cư, Penthouse) với quy mô hàng chục nghìn căn hộ trên hàng trăm dự án toàn quốc.
- **Lưu trữ nội bộ 100% (Local Database Storage)**:
  - Dữ liệu lưu trữ trực tiếp trên máy chủ / VPS nội bộ qua MongoDB, không phụ thuộc vào các dịch vụ database đám mây bên thứ ba (Firebase, MongoDB Atlas, Supabase...).
  - Thiết lập Compound Unique Index (`source + project_name + unit_code`) đảm bảo không bị trùng lặp dữ liệu và tốc độ truy vấn cực nhanh với `bulkWrite`.
- **Cơ chế chống spam thông minh (Initial Sync)**:
  - Trong lần khởi tạo đầu tiên (`--init`), hệ thống đánh dấu đã ghi nhận toàn bộ giỏ hàng hiện hữu để làm mốc đối chiếu, tránh bắn hàng nghìn email rác.
  - Các phiên chạy tiếp theo chỉ kích hoạt gửi email khi phát hiện có căn mới xuất hiện trong rổ hàng.
- **Báo cáo Email chuyên nghiệp qua Gmail SMTP**:
  - Gửi bảng báo cáo HTML trực quan, tối ưu hiển thị trên cả máy tính và điện thoại di động.
  - Chi tiết từng căn: Tên dự án, Phân khu, Tòa, Tầng, Mã căn, Loại căn, Diện tích thông thủy / Tim tường, Giá niêm yết, Giá thanh toán sớm (TTS), Trạng thái và liên kết mở quỹ căn trực tiếp.
  - Tiêu đề và nội dung gắn nhãn thời gian thực giúp ngăn chặn Gmail gộp nhóm (thread collapse).
- **Cơ chế tự phục hồi & Chống gián đoạn mạng (Auto-retry)**:
  - Tích hợp bộ thử lại tự động (Auto-retry 3 lần với Exponential Backoff) khi gặp sự cố chập chờn đường truyền Internet hoặc TCP socket reset (`ECONNRESET`, `ETIMEDOUT`).

---

## 📁 Cấu trúc thư mục dự án

```text
crawler/
├── .env                  # File cấu hình biến môi trường cục bộ (KHÔNG commit lên Git)
├── .env.example          # File mẫu cấu hình môi trường
├── .gitignore            # Danh sách loại trừ Git (node_modules, .env, logs...)
├── package.json          # Quản lý dependencies và scripts điều khiển
├── package-lock.json     # Khóa phiên bản thư viện
├── README.md             # Tài liệu hướng dẫn sử dụng chi tiết
└── src/
    ├── index.js          # Điểm khởi chạy chính (CLI runner & Cron job scheduler)
    ├── db.js             # Quản lý kết nối MongoDB nội bộ
    ├── mailer.js         # Xây dựng template HTML và gửi email SMTP qua Nodemailer
    ├── testMail.js       # Script kiểm thử gửi email độc lập
    ├── crawlers/
    │   ├── hisaleCrawler.js          # Logic cào dữ liệu sàn HiSale
    │   ├── saleproCrawler.js         # Logic cào phân khúc thấp tầng SalePro
    │   └── saleproHighRiseCrawler.js # Logic cào phân khúc cao tầng SalePro (có Auto-retry)
    ├── models/
    │   ├── Project.js    # Schema lưu trữ danh mục dự án
    │   ├── Unit.js       # Schema lưu trữ thông tin chi tiết từng căn hộ
    │   └── CrawlLog.js   # Schema lưu vết lịch sử các phiên cào
    └── services/
        ├── hisaleAuth.js # Quản lý phiên đăng nhập và Cookie của HiSale
        └── saleproAuth.js# Quản lý phiên đăng nhập và Token của SalePro
```

---

## ⚙️ Yêu cầu hệ thống

- **Node.js**: Phiên bản `>= 18.0.0` (Khuyến nghị Node 20 LTS hoặc mới hơn).
- **MongoDB**: MongoDB Community Server `>= 6.0` chạy nội bộ (Localhost trên cổng `27017`) hoặc Docker MongoDB container.

---

## 🚀 Hướng dẫn cài đặt & Cấu hình

### 1. Cài đặt các gói thư viện
Mở Terminal / PowerShell tại thư mục dự án:
```bash
npm install
```

### 2. Thiết lập biến môi trường (.env)
Tạo file `.env` từ file mẫu `.env.example`:
```bash
cp .env.example .env
```
*(Trên Windows PowerShell: `Copy-Item .env.example .env`)*

Chỉnh sửa các thông số trong file `.env`:
```env
# ==========================================
# CẤU HÌNH DATABASE MONGODB (LOCAL / VPS)
# ==========================================
MONGO_URI=mongodb://127.0.0.1:27017/real_estate_db
MONGO_DB_NAME=real_estate_db

# ==========================================
# CẤU HÌNH CRAWLER HISALE
# ==========================================
HISALE_PHONE=035387xxxx
HISALE_PASSWORD=your_hisale_password
HISALE_PROJECT_IDS=ALL

# ==========================================
# CẤU HÌNH CRAWLER SALEPRO
# ==========================================
SALEPRO_EMAIL=your_email@example.com
SALEPRO_PASSWORD=your_salepro_password
SALEPRO_PROJECT_IDS=ALL
SALEPRO_COORDINATE_MANAGER_ID=645
SALEPRO_AUTH_TOKEN=
SALEPRO_COOKIE=

# ==========================================
# CẤU HÌNH GỬI MAIL SMTP (GMAIL)
# ==========================================
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_16_char_app_password
MAIL_FROM="Bot Quản Lý Giỏ Hàng BĐS" <your_email@gmail.com>
MAIL_TO=recipient1@gmail.com,recipient2@gmail.com

# ==========================================
# CẤU HÌNH LỊCH CHẠY TỰ ĐỘNG (CRON JOB)
# ==========================================
CRON_SCHEDULE=0 7 * * *
```

> **📌 Lưu ý khi cấu hình Gmail SMTP:**
> 1. Truy cập [Google Account Security](https://myaccount.google.com/security) và bật **Xác minh 2 bước (2-Step Verification)**.
> 2. Tìm mục **Mật khẩu ứng dụng (App Passwords)**, tạo một mật khẩu mới (chuỗi 16 ký tự).
> 3. Điền chuỗi 16 ký tự này vào biến `SMTP_PASS` (không dùng mật khẩu đăng nhập Gmail thông thường).

---

## 📖 Hướng dẫn sử dụng chi tiết (Commands)

| Lệnh | Chức năng | Mô tả |
| :--- | :--- | :--- |
| `npm run test:mail` | **Test gửi email** | Gửi ngay 1 email mẫu tới danh sách `MAIL_TO` để kiểm tra kết nối SMTP và giao diện hiển thị. |
| `npm run crawl:salepro` | **Khởi tạo dữ liệu SalePro** | Nạp toàn bộ dự án thấp tầng và cao tầng của SalePro vào local MongoDB mà không gửi mail. |
| `npm run crawl:hisale` | **Khởi tạo dữ liệu HiSale** | Nạp toàn bộ dữ liệu dự án của sàn HiSale vào local MongoDB mà không gửi mail. |
| `npm run crawl:init` | **Khởi tạo toàn bộ** | Quét và đồng bộ mốc dữ liệu gốc cho cả 2 sàn cùng lúc. |
| `npm run crawl:now` | **Quét kiểm tra ngay** | Chạy ngay 1 phiên cào đầy đủ. Nếu phát hiện căn mới so với database nội bộ, tự động gửi email thông báo. |
| `npm start` | **Chạy tự động (Cron Job)** | Giữ tiến trình chạy ngầm, tự động thức dậy cào theo lịch trình đã cấu hình trong `CRON_SCHEDULE` (mặc định 07:00 sáng mỗi ngày). |

---

## 🖥️ Hướng dẫn triển khai lên máy chủ VPS

Hệ thống được thiết kế hoàn toàn tương thích để chuyển giao từ máy cá nhân lên VPS Linux (Ubuntu / Debian / CentOS) mà không cần chỉnh sửa code:

### Bước 1: Kết nối VPS và tải mã nguồn
```bash
# 1. Kết nối vào VPS bằng SSH
ssh user@<IP_VPS>

# 2. Clone mã nguồn từ GitHub Private Repo
git clone https://github.com/<your-username>/<your-repo-name>.git /opt/crawler
cd /opt/crawler

# 3. Cài đặt dependencies
npm install
```

### Bước 2: Khởi tạo cơ sở dữ liệu nội bộ trên VPS
Cài đặt MongoDB trực tiếp trên VPS hoặc chạy container:
```bash
# Tùy chọn chạy nhanh bằng Docker nội bộ trên VPS:
docker run -d --name mongo_local -p 27017:27017 -v mongo_data:/data/db --restart unless-stopped mongo:7
```

### Bước 3: Thiết lập cấu hình `.env`
Tạo file `.env` trên VPS và điền thông số tương tự như máy cá nhân:
```bash
nano .env
```
Đảm bảo `MONGO_URI=mongodb://127.0.0.1:27017/real_estate_db`.

### Bước 4: Chạy ngầm vĩnh viễn với PM2
Sử dụng công cụ quản lý tiến trình **PM2** để bot tự động khởi động cùng hệ thống và tự phục hồi nếu gặp sự cố:
```bash
# Cài đặt PM2 toàn cục (nếu chưa có)
npm install -g pm2

# Khởi động dịch vụ bot chạy ngầm
pm2 start src/index.js --name "real-estate-bot"

# Cấu hình tự động khởi động cùng VPS khi reboot
pm2 startup
pm2 save

# Xem nhật ký hoạt động thời gian thực
pm2 logs real-estate-bot
```

---

## 🛡️ Bảo mật & Giám sát dữ liệu

- **Không đưa thông tin nhạy cảm lên Git**: File `.env` chứa mật khẩu Gmail, cookie, token xác thực đã được đưa vào `.gitignore` để đảm bảo an toàn tuyệt đối.
- **Giám sát hoạt động**: Toàn bộ lịch sử mỗi lần cào, số lượng căn quét được, số lượng căn mới và thông báo gửi mail đều được ghi nhận vào collection `crawllogs` trong cơ sở dữ liệu.
