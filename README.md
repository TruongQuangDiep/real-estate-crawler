# 🏢 Real Estate Inventory Crawler & Media Storage System (V2)

Hệ thống backend tự động thu thập, chuẩn hóa, đối chiếu dữ liệu rổ hàng bất động sản từ các nền tảng **HiSale** (`hisale.vn`) và **SalePro** (`salepro.com`), lưu trữ nội bộ vào cơ sở dữ liệu **MongoDB Local** trên máy chủ VPS, tự động đồng bộ hình ảnh vào **Google Drive** theo phân cấp thư mục và gửi báo cáo định kỳ (báo cáo ngày & báo cáo tuần) kèm file Excel 24 cột chi tiết qua Gmail SMTP.

---

## 🌟 Tính năng nổi bật trên phiên bản V2

- **Đồng bộ hình ảnh Google Drive tự động (Google Drive API v3)**:
  - Tự động tạo cây thư mục chuẩn: `Nguồn / Tên Dự Án / Mã Căn` bên trong Thư mục tổng công ty chỉ định.
  - Tải ảnh, xác thực định dạng, kiểm tra kích thước tối đa (`IMAGE_MAX_SIZE_MB`).
  - **Chống trùng lặp nội dung bằng SHA-256**: Không upload lại ảnh đã tồn tại.
  - Sử dụng **OAuth 2.0 & Refresh Token**: Hoạt động vĩnh viễn trên VPS mà không cần đăng nhập lại.
  - Bảo mật tuyệt đối: Thư mục và file không bị chuyển sang public bừa bãi.
- **Nghiệp vụ hình ảnh phân tầng chuẩn xác**:
  - **HiSale**: Bóc tách toàn bộ mảng ảnh riêng của từng căn (`image_price_list_json`) và lưu vào thư mục riêng của căn.
  - **SalePro (3 cấp độ rõ ràng)**:
    - *Cấp độ 1 (Dự án)*: Tải ảnh đại diện/phối cảnh dự án vào thư mục `_Project` và liên kết với các căn cùng dự án.
    - *Cấp độ 2 (Layout & Tài liệu)*: Bóc tách link layout thiết kế vào thư mục `_Layouts`, phân biệt rõ link ảnh với link tài liệu PDF/Web (`document_urls`).
    - *Cấp độ 3 (Căn riêng lẻ)*: Nếu API không trả về ảnh riêng thì để trống, tuyệt đối không gán ảnh phối cảnh dự án giả làm ảnh riêng của căn.
- **Báo cáo tuần chuyên sâu (Weekly Executive Report)**:
  - Tự động kích hoạt vào **06:00 sáng Thứ Hai hàng tuần**.
  - Tổng hợp dữ liệu từ 00:00 thứ Hai tuần trước đến 00:00 thứ Hai tuần hiện tại.
  - Thống kê căn mới toàn sàn, phân bổ theo nguồn, dự án, cao tầng/thấp tầng, hiệu năng phiên quét và tiến độ đồng bộ ảnh.
  - **Độc lập hoàn toàn với `is_notified`**: Không ảnh hưởng đến chu trình thông báo căn mới của báo cáo ngày.
  - Lưu trạng thái gửi vào MongoDB (`ReportLog`) để chống gửi trùng khi khởi động lại VPS.
- **Nâng cấp file Excel 24 cột chuẩn doanh nghiệp**:
  - Giữ nguyên 18 cột truyền thống và bổ sung 6 cột Google Drive & Media mới.
  - Tích hợp Hyperlink mở trực tiếp thư mục Google Drive của căn.
  - Tự động ngắt dòng (`wrapText`), AutoFilter toàn bộ 24 cột và cố định dòng tiêu đề.

---

## 📐 Sơ đồ kiến trúc hệ thống V2

```mermaid
flowchart TD
    subgraph Sources ["Nguồn dữ liệu Bất động sản"]
        HS["HiSale API<br/>(Dữ liệu căn + Ảnh riêng)"]
        SP_LOW["SalePro Thấp tầng API<br/>(Quỹ căn + Avatar dự án)"]
        SP_HIGH["SalePro Cao tầng API<br/>(Quỹ căn + Avatar dự án)"]
    end

    subgraph CrawlerEngine ["Bộ điều phối Crawler & Scheduler"]
        SCHED["Node-Cron Scheduler<br/>• Crawl: 6h, 10h, 14h, 18h, 22h<br/>• Daily Mail: 7h sáng<br/>• Weekly Report: 6h sáng T2<br/>• Image Sync: Mỗi 15 phút"]
        CRAWL_RUNNER["Crawler Runner<br/>(3-Retry Backoff & Deduplication)"]
    end

    subgraph Storage ["Lưu trữ Dữ liệu Nội bộ"]
        MONGO[("MongoDB Local Server<br/>(real_estate_db)")]
        UNITS["Units Collection<br/>(24 cột & Media Meta)"]
        PROJECTS["Projects Collection<br/>(Dự án & Avatar S3)"]
        LOGS["CrawlLog & ReportLog<br/>(Chống trùng gửi mail)"]
        MONGO --- UNITS
        MONGO --- PROJECTS
        MONGO --- LOGS
    end

    subgraph MediaService ["Image Storage Service"]
        IMG_WORKER["Image Sync Worker<br/>• Batch Size: 20<br/>• Concurrency: 2<br/>• SHA-256 Dedup"]
        GDRIVE["Google Drive API v3<br/>• OAuth 2.0 + Refresh Token<br/>• Auto Folder Tree"]
    end

    subgraph Reports ["Hệ thống Báo cáo & Thông báo"]
        EXCEL["ExcelJS Engine<br/>(Xuất file .xlsx 24 cột)"]
        MAILER["Nodemailer SMTP<br/>(Gmail Secure App Password)"]
        USER["Người nhận / Ban Giám Đốc<br/>(Email HTML Dashboard + Excel)"]
    end

    HS --> CRAWL_RUNNER
    SP_LOW --> CRAWL_RUNNER
    SP_HIGH --> CRAWL_RUNNER
    SCHED --> CRAWL_RUNNER

    CRAWL_RUNNER --> MONGO
    SCHED --> IMG_WORKER
    IMG_WORKER <--> MONGO
    IMG_WORKER --> GDRIVE

    SCHED --> MAILER
    MONGO --> MAILER
    EXCEL --> MAILER
    MAILER --> USER
```

---

## 📂 Cấu trúc thư mục nguồn

```text
crawler/
├── .env                  # Cấu hình môi trường máy chủ (Tuyệt đối KHÔNG commit)
├── .env.example          # File cấu hình mẫu chuẩn
├── .gitignore            # Loại trừ credentials, token, log, node_modules
├── package.json          # Danh sách thư viện và tập lệnh terminal
├── package-lock.json     # Khóa phiên bản dependencies
├── README.md             # Tài liệu kỹ thuật chi tiết
├── credentials/          # Thư mục chứa khóa xác thực Google Drive (bảo mật)
│   ├── credentials.json  # OAuth 2.0 Client Secret từ Google Cloud
│   └── token.json        # OAuth Access Token & Refresh Token
├── src/
│   ├── index.js          # Điểm khởi chạy chính & Scheduler tự động
│   ├── db.js             # Quản lý kết nối MongoDB Local
│   ├── mailer.js         # Gửi email báo cáo ngày qua SMTP Gmail
│   ├── testMail.js       # Script kiểm thử email báo cáo ngày
│   ├── crawlers/
│   │   ├── hisaleCrawler.js          # Thu thập rổ hàng HiSale
│   │   ├── saleproCrawler.js         # Thu thập SalePro thấp tầng
│   │   └── saleproHighRiseCrawler.js # Thu thập SalePro cao tầng
│   ├── models/
│   │   ├── Unit.js       # Schema căn hộ (Bổ sung 11 trường Media & Drive)
│   │   ├── Project.js    # Schema dự án (Bổ sung Drive Media)
│   │   ├── CrawlLog.js   # Nhật ký phiên quét dữ liệu
│   │   └── ReportLog.js  # Nhật ký gửi báo cáo ngày & tuần (Chống gửi trùng)
│   ├── services/
│   │   ├── hisaleAuth.js           # Phiên đăng nhập HiSale
│   │   ├── saleproAuth.js          # Phiên đăng nhập SalePro
│   │   ├── googleDriveService.js   # Xử lý API v3, tạo thư mục lồng nhau, upload file
│   │   ├── imageStorageService.js  # Tải ảnh, SHA-256, kiểm tra dung lượng, batching
│   │   ├── weeklyReportService.js  # Xử lý số liệu và tạo HTML báo cáo tuần
│   │   ├── reportService.js        # Giao diện HTML email báo cáo ngày
│   │   └── excelService.js         # Xuất buffer Excel 24 cột chuẩn
│   └── scripts/
│       ├── authorizeDrive.js       # Xác thực OAuth 2.0 lần đầu lấy Refresh Token
│       ├── testDrive.js            # Kiểm tra quyền truy cập thư mục tổng & upload thử
│       ├── syncImages.js           # Đồng bộ thủ công một batch hình ảnh
│       └── weeklyReport.js         # Gửi báo cáo tuần thủ công hoặc test giao diện
└── test/
    └── verifyV2.js                 # Bộ kiểm thử tự động toàn diện V2
```

---

## 🗂️ Cấu trúc thư mục trên Google Drive

Toàn bộ hình ảnh và tài liệu được lưu trữ tự động bên trong **Thư mục tổng** (được cấu hình qua biến `GOOGLE_DRIVE_ROOT_FOLDER_NAME` hoặc `GOOGLE_DRIVE_ROOT_FOLDER_ID`, ví dụ: `Real_Estate_Crawler_Test`):

```text
[Google Drive Root Folder] (Tên: GOOGLE_DRIVE_ROOT_FOLDER_NAME / ID: GOOGLE_DRIVE_ROOT_FOLDER_ID)
├── HiSale/
│   ├── Thap_tang/
│   │   └── VINHOMES GLOBAL GATE HA LONG/
│   │       ├── ND11-58/
│   │       │   ├── image_01.jpg
│   │       │   └── image_02.jpg
│   │       └── ND11-59/
│   │           └── image_01.jpg
│   └── Cao_tang/
│       └── THE CITYON - IMPERIA OCEAN CITY/
│           └── A2.1009/
│               ├── image_01.jpg
│               └── image_02.jpg
└── SalePro/
    ├── Thap_tang/
    │   └── VINHOMES GRAND PARK/
    │       ├── _Project/
    │       │   └── project_avatar.jpg        <-- Ảnh phối cảnh đại diện dự án
    │       ├── _Layouts/
    │       │   ├── layout_01.png             <-- Ảnh layout mặt bằng bóc từ share_content
    │       │   └── layout_02.png
    │       └── BS12.1809/                    <-- Thư mục căn riêng (nếu có ảnh riêng)
    └── Cao_tang/
        └── VINHOMES GOLDEN CITY/
            ├── _Project/
            │   └── project_avatar.jpg
            ├── _Layouts/
            │   └── layout_01.png
            └── BS15.2201/
```

**Quy tắc phân loại:**
- Phân tầng chính xác theo nguồn: `HiSale` và `SalePro`.
- Phân khúc dữ liệu thực tế: `Thap_tang` và `Cao_tang` (dựa trên loại căn, tầng, tòa, project type).
- Tạo thư mục theo nhu cầu thực tế (*on-demand*): Chỉ khởi tạo khi có dữ liệu căn thuộc nhóm đó, tránh tạo thư mục rỗng.
- Mỗi dự án và từng căn hộ đều có thư mục riêng biệt kèm tên chuẩn hóa chống lỗi ký tự đặc biệt.

---

## 🔐 Hướng dẫn cài đặt Google Cloud Console & OAuth 2.0

Để bot tự động tải ảnh lên Google Drive lâu dài trên VPS mà không bao giờ bị hỏi mật khẩu hay hết hạn:

### Bước 1: Bật Google Drive API
1. Truy cập [Google Cloud Console](https://console.cloud.google.com/).
2. Tạo mới một Project (Ví dụ: `Real-Estate-Crawler`).
3. Vào menu **APIs & Services** > **Library**, tìm kiếm `Google Drive API` và bấm **Enable (Bật)**.

### Bước 2: Cấu hình Màn hình đồng ý OAuth (OAuth consent screen)
1. Vào **APIs & Services** > **OAuth consent screen**.
2. Chọn loại **External** (hoặc **Internal** nếu sử dụng Google Workspace doanh nghiệp).
3. Điền tên ứng dụng (VD: `Real Estate Crawler Bot`) và email quản trị viên.
4. Tại mục **Test users**, bấm **Add Users** và thêm địa chỉ Gmail của bạn vào.

### Bước 3: Tạo OAuth Client ID
1. Vào **APIs & Services** > **Credentials** > **Create Credentials** > **OAuth client ID**.
2. Chọn Application type: **Desktop app**.
3. Bấm **Create**, sau đó tải file JSON về máy.
4. Đổi tên file thành `credentials.json` (hoặc `credentials.test.json` khi chạy thử nghiệm) và đặt vào thư mục `credentials/` của dự án.

### Bước 4: Lấy Refresh Token lần đầu (Loopback Flow)
Chạy lệnh xác thực tự động trên terminal:
```bash
npm run drive:auth
```
- Trình duyệt web sẽ tự động mở trang xác thực tài khoản Google qua địa chỉ an toàn `http://127.0.0.1:<PORT>`.
- Đăng nhập tài khoản Google và cho phép ứng dụng truy cập quyền `drive.file`.
- Callback server nhận mã tự động, hệ thống lưu token vĩnh viễn vào `credentials/token.json` (kèm `refresh_token`).
- Token sẽ tự động làm mới ngầm khi hết hạn, không bao giờ cần đăng nhập lại thủ công.

### Bước 5: Khởi tạo thư mục tổng trên Drive
Hệ thống hỗ trợ 2 cách tiếp cận linh hoạt:
1. **Tạo mới tự động bằng API (Khuyên dùng)**:
   ```bash
   npm run drive:create-root
   ```
   Lệnh sẽ tự tạo Thư mục tổng theo tên cấu hình trong `GOOGLE_DRIVE_ROOT_FOLDER_NAME` (mặc định: `Real_Estate_Crawler_Test`), tự động cấp full quyền cho ứng dụng và tự ghi ID mới vào file `.env`. Nếu thư mục đã tồn tại, script sẽ tái sử dụng mà không tạo trùng.

2. **Cấp quyền thư mục công ty có sẵn**:
   Nếu dùng thư mục có sẵn do sếp/công ty tạo từ trước, chạy:
   ```bash
   npm run drive:picker
   ```
   Để chọn và cấp quyền thư mục qua giao diện Google Picker chuẩn.

### Bước 6: Kiểm tra kết nối và phân quyền thư mục
```bash
npm run drive:test
```
Lệnh sẽ kiểm tra quyền truy cập Thư mục tổng, tạo thử thư mục con và upload 1 ảnh kiểm thử để xác nhận hệ thống sẵn sàng 100%.

---

## ⚙️ Cấu hình biến môi trường (.env)

| Biến môi trường | Giá trị mặc định | Giải thích |
|---|---|---|
| `MONGO_URI` | `mongodb://127.0.0.1:27017/real_estate_db` | Đường dẫn kết nối MongoDB Local |
| `CRON_SCHEDULE` | `0 6,10,14,18,22 * * *` | Lịch cào dữ liệu rổ hàng (5 lần/ngày) |
| `MAIL_CRON_SCHEDULE` | `0 7 * * *` | Lịch gửi báo cáo tổng hợp buổi sáng |
| `WEEKLY_REPORT_ENABLED` | `true` | Bật/tắt gửi báo cáo tuần |
| `WEEKLY_REPORT_CRON` | `0 6 * * 1` | Lịch gửi báo cáo tuần (06:00 sáng Thứ Hai) |
| `GOOGLE_DRIVE_ENABLED` | `true` | Bật tính năng đồng bộ hình ảnh Google Drive |
| `GOOGLE_DRIVE_ROOT_FOLDER_NAME` | `Real_Estate_Crawler_Test` | Tên thư mục tổng Google Drive (tự động quản lý) |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | *(Folder ID)* | ID thư mục Drive tổng (tự sinh bởi script hoặc chỉ định) |
| `GOOGLE_DRIVE_CREDENTIALS` | `./credentials/credentials.json` | Đường dẫn file OAuth Client credentials |
| `GOOGLE_DRIVE_TOKEN` | `./credentials/token.json` | Đường dẫn file lưu trữ Access & Refresh Token |
| `IMAGE_SYNC_ENABLED` | `true` | Kích hoạt worker đồng bộ ảnh nền |
| `IMAGE_SYNC_CRON` | `*/15 * * * *` | Chu kỳ quét đồng bộ hình ảnh (mỗi 15 phút) |
| `IMAGE_SYNC_BATCH_SIZE` | `20` | Số căn tối đa xử lý trong mỗi đợt đồng bộ |
| `IMAGE_UPLOAD_CONCURRENCY` | `2` | Số luồng upload Drive song song |
| `IMAGE_MAX_SIZE_MB` | `20` | Giới hạn dung lượng tối đa cho mỗi file ảnh |

---

## 📊 Cấu trúc 24 cột trong File Excel Báo cáo

File Excel đính kèm được tạo tự động trong bộ nhớ với đầy đủ 24 cột:

1. **STT**
2. **Nguồn** (`HISALE` / `SALEPRO`)
3. **Dự án**
4. **Phân khu**
5. **Tòa**
6. **Tầng**
7. **Mã căn**
8. **Loại căn**
9. **Hướng**
10. **DT đất / Thông thủy (m²)**
11. **DT XD / Tim tường (m²)**
12. **Giá bán niêm yết (VNĐ)**
13. **Giá thanh toán sớm (VNĐ)**
14. **Trạng thái**
15. **Tiêu chuẩn bàn giao**
16. **Hỗ trợ ngân hàng**
17. **Link quỹ căn / bảng giá**
18. **Ngày ghi nhận**
19. **Hình ảnh riêng của căn — Google Drive** *(Mới V2)*
20. **Hình ảnh layout — Google Drive** *(Mới V2)*
21. **Hình ảnh dự án — Google Drive** *(Mới V2)*
22. **Thư mục hình ảnh của căn — Google Drive** *(Mới V2 - Có Hyperlink click mở ngay)*
23. **Tài liệu liên quan** *(Mới V2)*
24. **Trạng thái đồng bộ hình ảnh** (`SUCCESS`, `PARTIAL`, `NO_IMAGE`, `PENDING`...) *(Mới V2)*

---

## 💻 Danh sách tập lệnh Terminal

```bash
# ==========================================
# CRAWLER & SCHEDULER
# ==========================================
npm start                 # Khởi chạy toàn bộ hệ thống tự động (Crawler, Daily, Weekly, Image Sync)
npm run crawl:now         # Quét toàn bộ rổ hàng ngay lập tức và gửi email báo cáo
npm run crawl:init        # Khởi tạo dữ liệu ban đầu (lưu rổ hàng, không gửi mail rác)
npm run crawl:hisale      # Khởi tạo dữ liệu riêng cho sàn HiSale
npm run crawl:salepro     # Khởi tạo dữ liệu riêng cho sàn SalePro
npm run report:now        # Gửi ngay báo cáo tổng hợp ngày kèm file Excel 24 cột

# ==========================================
# GOOGLE DRIVE & MEDIA
# ==========================================
npm run drive:auth        # Hướng dẫn và xác thực Google Drive OAuth lần đầu
npm run drive:create-root # Tự động tạo thư mục tổng qua API & tự cập nhật ID vào .env
npm run drive:picker      # Cấp quyền thư mục công ty có sẵn qua giao diện Google Picker
npm run drive:test        # Kiểm tra kết nối thư mục tổng và upload thử file
npm run images:sync       # Đồng bộ một batch ảnh đang chờ xử lý
npm run images:sync -- 5  # Đồng bộ thử nghiệm tối đa 5 căn

# ==========================================
# BÁO CÁO TUẦN (WEEKLY REPORT)
# ==========================================
npm run report:weekly     # Tổng hợp và gửi báo cáo tuần ngay lập tức
npm run test:mail:weekly  # Kiểm thử giao diện email báo cáo tuần bằng dữ liệu mẫu
npm run test:mail         # Kiểm thử email báo cáo ngày mẫu
npm test                  # Chạy bộ test tự động toàn diện V2 (node test/verifyV2.js)
```

---

## 🚀 Hướng dẫn triển khai Production trên VPS (Ubuntu / Debian / Windows Server)

Sử dụng **PM2** để quản lý tiến trình chạy nền liên tục 24/7, tự động khởi động lại khi gặp sự cố:

```bash
# 1. Cài đặt PM2 toàn cục
npm install -g pm2

# 2. Khởi chạy bot crawler
pm2 start src/index.js --name "real-estate-crawler"

# 3. Cấu hình tự khởi động cùng hệ điều hành khi VPS reboot
pm2 startup
pm2 save

# 4. Kiểm tra trạng thái và nhật ký hoạt động
pm2 status
pm2 logs real-estate-crawler --lines 100
```

---

## 🛡️ Giới hạn kỹ thuật & Lưu ý vận hành

1. **Hình ảnh riêng của căn SalePro**: API bảng hàng của SalePro hiện chỉ trả về thông số danh sách và link quỹ căn web, chưa có mảng ảnh chi tiết riêng của từng căn. Hệ thống tự động kế thừa ảnh phối cảnh đại diện dự án (`_Project`) và link tài liệu mặt bằng (`_Layouts`), đồng thời giữ trạng thái `NO_IMAGE` đối với ảnh riêng của căn để đảm bảo trung thực dữ liệu, không gọi spam 15.000 request chi tiết gây khóa IP.
2. **Bảo mật thông tin xác thực**: Không bao giờ commit file `.env`, `credentials/credentials.json` hoặc `credentials/token.json` lên Git. Đảm bảo kho lưu trữ GitHub được đặt ở chế độ **Private**.
3. **Quota Google Drive API**: Giới hạn mặc định của Google Drive API v3 là 12.000 requests/phút. Cấu hình `IMAGE_UPLOAD_CONCURRENCY=2` và batch size 20 đảm bảo an toàn tuyệt đối, không bao giờ chạm ngưỡng giới hạn quota.
