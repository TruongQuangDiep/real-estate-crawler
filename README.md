# 🏢 Real Estate Inventory Crawler & Email Report System

Hệ thống backend tự động thu thập, chuẩn hóa, đối chiếu dữ liệu rổ hàng bất động sản từ các nền tảng **HiSale** (`hisale.com`) và **SalePro** (`salepro.com`), lưu trữ nội bộ vào cơ sở dữ liệu MongoDB trên máy chủ VPS và gửi báo cáo định kỳ qua Gmail SMTP kèm file Excel chi tiết khi phát hiện căn mới.

---

## 🌟 Tính năng chính

- **Đa nền tảng & Đa phân khúc**:
  - **HiSale**: Tự động xác thực tài khoản, thu thập dữ liệu rổ hàng của toàn bộ các dự án mở bán.
  - **SalePro**: Thu thập danh mục dự án, cào chuyên sâu cả phân khúc **Thấp tầng** (Biệt thự, Shophouse, Liền kề) và **Cao tầng** (Căn hộ chung cư, Penthouse) với quy mô hàng chục nghìn căn hộ trên hàng trăm dự án toàn quốc.
- **Lưu trữ nội bộ 100% (Local Database Storage)**:
  - Dữ liệu lưu trữ trực tiếp trên máy chủ / VPS nội bộ qua MongoDB, **không lưu trữ qua database đám mây bên thứ ba** (Firebase, MongoDB Atlas, Supabase...).
  - Thiết lập Compound Unique Index (`source + project_name + unit_code`) đảm bảo không bị trùng lặp dữ liệu và tốc độ truy vấn cực nhanh với `bulkWrite`.
- **Báo cáo chuyên nghiệp (Email HTML + File Excel đính kèm)**:
  - **Email HTML Executive Dashboard**: Hiển thị bảng KPI tổng quan (Số căn đã quét, Số căn mới, Trạng thái từng nguồn), và xem trước các căn mới tiêu biểu.
  - **Đính kèm File Excel (`.xlsx`) tự động**: Toàn bộ danh sách căn mới (không giới hạn số lượng) được xuất trực tiếp thành file Excel đính kèm với 18 cột thông tin chi tiết (STT, Mã căn, Phân khu, Tòa, Tầng, Loại căn, Diện tích, Giá niêm yết, Giá thanh toán sớm, Tiêu chuẩn bàn giao, Link quỹ căn...).
- **Cơ chế gửi báo cáo linh hoạt (`MAIL_REPORT_MODE`)**:
  - `DAILY`: Gửi email báo cáo định kỳ hằng ngày (kể cả khi không có căn mới để báo cáo trạng thái hệ thống hoạt động ổn định).
  - `NEW_ONLY`: Chỉ gửi email khi phát hiện có căn mới trong rổ hàng.
  - `MAIL_ON_ERROR=true`: Tự động gửi cảnh báo nếu phiên cào gặp sự cố kết nối.
- **Cơ chế chống spam thông minh (Initial Sync)**:
  - Khi chạy lần đầu với cờ `--init`, hệ thống ghi nhận toàn bộ giỏ hàng hiện hữu vào cơ sở dữ liệu để làm mốc đối chiếu, tuyệt đối không gửi hàng nghìn email rác.
- **Cơ chế tự phục hồi mạng (Auto-retry)**:
  - Tích hợp bộ thử lại tự động (Auto-retry 3 lần với Exponential Backoff) khi gặp sự cố chập chờn đường truyền Internet hoặc TCP socket reset (`ECONNRESET`, `ETIMEDOUT`).

---

## 📁 Cấu trúc thư mục dự án

```text
crawler/
├── .env                  # File cấu hình biến môi trường cục bộ (KHÔNG commit lên Git)
├── .env.example          # File mẫu cấu hình môi trường chuẩn
├── .gitignore            # Danh sách loại trừ Git (node_modules, .env, session caches...)
├── package.json          # Quản lý dependencies và scripts điều khiển
├── package-lock.json     # Khóa phiên bản thư viện
├── README.md             # Tài liệu hướng dẫn sử dụng chi tiết
└── src/
    ├── index.js          # Điểm khởi chạy chính (CLI runner & Cron job scheduler)
    ├── db.js             # Quản lý kết nối MongoDB nội bộ (bảo mật URL)
    ├── mailer.js         # Điều phối gửi email SMTP qua Nodemailer
    ├── testMail.js       # Script kiểm thử gửi email & file Excel đính kèm
    ├── crawlers/
    │   ├── hisaleCrawler.js          # Logic cào dữ liệu sàn HiSale
    │   ├── saleproCrawler.js         # Logic cào phân khúc thấp tầng SalePro
    │   └── saleproHighRiseCrawler.js # Logic cào phân khúc cao tầng SalePro (có Auto-retry)
    ├── models/
    │   ├── Project.js    # Schema lưu trữ danh mục dự án
    │   ├── Unit.js       # Schema lưu trữ thông tin chi tiết từng căn hộ
    │   └── CrawlLog.js   # Schema lưu vết lịch sử các phiên cào (SUCCESS/PARTIAL/FAILED)
    └── services/
        ├── hisaleAuth.js   # Quản lý phiên đăng nhập và Cookie của HiSale
        ├── saleproAuth.js  # Quản lý phiên đăng nhập và Token của SalePro
        ├── excelService.js # Xuất file Excel báo cáo căn mới trong bộ nhớ
        └── reportService.js# Tạo giao diện HTML email báo cáo Executive Dashboard
```

---

## ⚙️ Yêu cầu hệ thống

- **Node.js**: Phiên bản `>= 18.0.0` (Khuyến nghị Node 20 LTS trở lên).
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
# 1. Lịch cào dữ liệu (5 lần/ngày: 06:00, 10:00, 14:00, 18:00, 22:00)
# Cào và tích lũy căn mới vào database, không gửi email trong các phiên này:
CRON_SCHEDULE=0 6,10,14,18,22 * * *

# 2. Lịch gửi email báo cáo tổng hợp (Đúng 07:00 sáng mỗi ngày gửi 1 email duy nhất kèm file Excel):
MAIL_CRON_SCHEDULE=0 7 * * *

# Múi giờ hoạt động
CRON_TIMEZONE=Asia/Ho_Chi_Minh

# ==========================================
# CẤU HÌNH BÁO CÁO EMAIL & EXCEL
# ==========================================
# 'DAILY' (gửi báo cáo mỗi ngày) hoặc 'NEW_ONLY' (chỉ gửi khi có căn mới)
MAIL_REPORT_MODE=DAILY
MAIL_ON_ERROR=true
MAIL_MAX_PREVIEW_UNITS=15
```

> **📌 Hướng dẫn lấy Mật khẩu ứng dụng Gmail (App Password):**
> 1. Truy cập [Google Account Security](https://myaccount.google.com/security) và bật **Xác minh 2 bước (2-Step Verification)**.
> 2. Tìm mục **Mật khẩu ứng dụng (App Passwords)**, tạo một mật khẩu mới (chuỗi 16 ký tự).
> 3. Điền chuỗi 16 ký tự này vào biến `SMTP_PASS` (không dùng mật khẩu đăng nhập thông thường).

---

## 📖 Hướng dẫn sử dụng chi tiết (Commands)

| Lệnh | Chức năng | Mô tả |
| :--- | :--- | :--- |
| `npm run test:mail` | **Test gửi email** | Gửi ngay 1 email mẫu kèm file Excel đính kèm tới danh sách `MAIL_TO` để kiểm tra kết nối SMTP và giao diện hiển thị. |
| `npm run crawl:salepro` | **Khởi tạo dữ liệu SalePro** | Nạp toàn bộ dự án thấp tầng và cao tầng của SalePro vào local MongoDB mà không gửi mail. |
| `npm run crawl:hisale` | **Khởi tạo dữ liệu HiSale** | Nạp toàn bộ dữ liệu dự án của sàn HiSale vào local MongoDB mà không gửi mail. |
| `npm run crawl:init` | **Khởi tạo toàn bộ** | Quét và đồng bộ mốc dữ liệu gốc cho cả 2 sàn cùng lúc (không gửi mail). |
| `npm run crawl:now` | **Quét kiểm tra ngay** | Chạy ngay 1 phiên cào đầy đủ. Tạo báo cáo email và đính kèm file Excel ngay lập tức. |
| `npm run report:now` | **Gửi báo cáo ngay** | Kích hoạt gửi ngay email báo cáo tổng hợp kèm file Excel của các căn mới tích lũy. |
| `npm start` | **Chạy tự động (Cron Job)** | Giữ tiến trình chạy ngầm: Tự động cào 5 lần/ngày (`CRON_SCHEDULE`) và gửi đúng 1 email tổng hợp vào 07:00 sáng mỗi ngày (`MAIL_CRON_SCHEDULE`). |

---

## 🖥️ Hướng dẫn triển khai lên máy chủ VPS

Hệ thống được thiết kế hoàn toàn tương thích để chuyển giao từ máy cá nhân lên VPS Linux (Ubuntu / Debian / CentOS) mà không cần chỉnh sửa code:

### Bước 1: Kết nối VPS và tải mã nguồn
```bash
# 1. Kết nối vào VPS bằng SSH
ssh user@<IP_VPS>

# 2. Clone mã nguồn từ GitHub Private Repo
git clone https://github.com/TruongQuangDiep/real-estate-crawler.git /opt/crawler
cd /opt/crawler

# 3. Cài đặt chính xác các gói dependencies
npm ci
```

### Bước 2: Khởi tạo cơ sở dữ liệu nội bộ an toàn trên VPS
Cài đặt MongoDB container và **chỉ lắng nghe nội bộ trên `127.0.0.1`** (tuyệt đối không mở cổng 27017 ra mạng ngoài):
```bash
# Chạy container MongoDB nội bộ, chỉ bind vào localhost 127.0.0.1:
docker run -d --name mongo_local -p 127.0.0.1:27017:27017 -v mongo_data:/data/db --restart unless-stopped mongo:7
```

### Bước 3: Thiết lập cấu hình `.env`
Tạo file `.env` trên VPS và cấu hình tương tự như máy cá nhân:
```bash
nano .env
```
Đảm bảo `MONGO_URI=mongodb://127.0.0.1:27017/real_estate_db`.

### Bước 4: Khởi tạo mốc dữ liệu ban đầu (Initial Crawl)
Trước khi đưa vào chạy ngầm tự động, chạy lệnh khởi tạo để nạp mốc dữ liệu gốc (tránh gửi hàng nghìn email rác):
```bash
npm run crawl:init
```

### Bước 5: Chạy ngầm vĩnh viễn với PM2
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

## 💾 Hướng dẫn Sao lưu & Phục hồi dữ liệu (Backup & Restore)

Để đảm bảo an toàn dữ liệu trên VPS, thiết lập sao lưu định kỳ vào thư mục riêng:
```bash
# Sao lưu cơ sở dữ liệu ra thư mục:
mongodump --uri="mongodb://127.0.0.1:27017/real_estate_db" --out=/opt/backups/$(date +%F)

# Phục hồi dữ liệu từ bản sao lưu:
mongorestore --uri="mongodb://127.0.0.1:27017/real_estate_db" /opt/backups/<TÊN_THƯ_MỤC_NGÀY>/real_estate_db
```

---

## 🛡️ Bảo mật & Giám sát vận hành

- **Bảo vệ thông tin định danh**: File `.env` và các file lưu cache session (`.hisale_session.json`, `.salepro_session.json`) đều được loại trừ trong `.gitignore`. Chuỗi kết nối MongoDB được ẩn mật khẩu trên console log.
- **Giám sát hoạt động**: Toàn bộ lịch sử mỗi lần cào, số lượng dự án thành công/lỗi, số lượng căn quét được, số lượng căn mới và thông báo gửi mail đều được ghi nhận vào collection `crawllogs` trong cơ sở dữ liệu.
