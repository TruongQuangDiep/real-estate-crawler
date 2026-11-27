# 🏢 Real Estate Inventory Crawler & Media Storage System (V3.1 Production Readiness)

Hệ thống backend tự động thu thập, chuẩn hóa, đối chiếu dữ liệu rổ hàng bất động sản từ các nền tảng **HiSale** (`hisale.vn`) và **SalePro** (`salepro.com`), lưu trữ nội bộ vào cơ sở dữ liệu **MongoDB Local** trên máy chủ VPS, tự động đồng bộ hình ảnh vào **Google Drive** theo phân cấp thư mục 3 tầng và gửi báo cáo định kỳ (báo cáo ngày & báo cáo tuần) kèm file Excel 26 cột chi tiết qua Gmail SMTP.

---

## 🌟 Tính năng nổi bật trên phiên bản V3.1 (Production Readiness)

- **Chuẩn hóa Thuật toán Đối chiếu Layout (Layout Matching Engine V3.1)**:
  - Khớp diện tích chặt chẽ trong khoảng sai số cực nhỏ `±0.5 m²` (tim tường / thông thủy).
  - Đối chiếu mã thiết kế cụ thể (`design_code`, `layout_code`), phân khu và phong cách kiến trúc đặc thù (Manhattan, Paris, v.v.).
  - Xử lý nhập nhằng minh bạch: Khi có nhiều layout cùng diện tích tương đương hoặc khi thiếu thông tin diện tích, hệ thống chuyển sang `TYPE_MATCH` kèm nhãn tham khảo rõ ràng, tuyệt đối không gán `EXACT` tùy tiện.
  - Phân biệt tuyệt đối: 1PN với 1PN+, 2PN với 2PN+, Biệt thự đơn lập với Biệt thự song lập.
  - Ghi nhận trung thực: Căn SalePro không có ảnh riêng -> `image_sync_status = 'NO_IMAGE'`, không lấy avatar dự án giả làm ảnh riêng.
- **Tự động Đồng bộ Media Dự án Định kỳ (Project Media Scheduler)**:
  - Bổ sung Cron Job chạy nền (`PROJECT_MEDIA_SYNC_CRON`, mặc định 02:00 sáng hàng ngày) tự động quét và cập nhật media cho các dự án mới hoặc các dự án ở phiên bản schema cũ.
  - Hỗ trợ nâng cấp mượt mà từ V2 lên V3.1 với trường `media_schema_version: 3` và `media_synced_at`.
- **Cơ chế Phát hiện Thay đổi URL Ảnh & Tái sử dụng Drive Thông minh**:
  - Phát hiện URL ảnh bị thay thế dù tổng số lượng ảnh không đổi thông qua logic `$setDifference`.
  - Kiểm tra tính hợp lệ của file trên Google Drive trước khi tái sử dụng `drive_file_id`; nếu file đã bị xóa trên Drive thì tự động upload lại.
- **Khắc phục Toàn diện Phân loại Phân khúc HiSale (determineSegment)**:
  - Ưu tiên loại căn hộ (`unit_type`): Liền kề, Biệt thự, Shophouse được phân loại chính xác vào `Thap_tang` ngay cả khi có mã dãy (`TX5`, `CL2`, `SL01`) hoặc số tầng xây dựng.
  - Bảo toàn 3.834 căn thấp tầng HiSale trong hệ thống.
- **Bảo mật & Ổn định Hệ thống Chuyên sâu (Security & Concurrency)**:
  - Chống SSRF đa chặng: Kiểm tra hostname trước mọi bước chuyển hướng HTTP (`beforeRedirect`).
  - Kiểm tra chữ ký nhị phân (Magic Bytes) chống lưu nhầm các trang HTML/JSON lỗi vào Google Drive.
  - **Hoàn thiện Atomic Locking với Lease ID**: Mỗi lần claim căn hộ hoặc dự án đều sinh `lease_id` (UUID) ngẫu nhiên. Mọi thao tác ghi kết quả đều sử dụng Conditional Update (`image_sync_lock_owner: leaseId` và `image_sync_locked_until > now`). Nếu khóa hết hạn hoặc bị worker khác chiếm quyền, worker cũ tự động bị từ chối ghi (`matchedCount = 0`), ngăn chặn triệt để race condition và ghi đè dữ liệu cũ.
  - **Khóa phân tán Concurrency Lock Service (`SystemLock`)**: Ngăn chặn chạy đồng thời giữa tiến trình nền (`PROJECT_MEDIA_SYNC_CRON`) và lệnh thủ công CLI (`npm run images:sync-projects`). Cơ chế tự động thử lại (retry) với TTL expiration an toàn.
- **Cấu hình Linh hoạt & Tiết kiệm Quota**:
  - Cấu hình số lượng ảnh phối cảnh dự án qua `IMAGE_MAX_PROJECT_IMAGES` (mặc định: `0` = lưu toàn bộ).
  - Tách biệt rõ ràng các trạng thái đồng bộ: `SUCCESS`, `PARTIAL`, `FAILED`, `NO_IMAGE`.
  - **Chuẩn hóa `media_schema_version`**: CHỈ dự án đạt `SUCCESS` hoặc `NO_IMAGE` mới được gắn `media_schema_version = 3`. Các dự án `PARTIAL` hoặc `FAILED` được giữ version cũ để các phiên quét tiếp theo tự động phát hiện và retry đầy đủ.
  - Không bao giờ ghi đè media dự án thành mảng rỗng khi API đối tác gặp lỗi tạm thời.
- **Rà soát & Di chuyển Phân khúc An toàn (Safe Segment Migration)**:
  - Bổ sung lệnh rà soát phân khúc Google Drive hỗ trợ chế độ Dry-run an toàn 100% (`npm run drive:migrate-segments:dry`).
- **Báo cáo Excel 26 cột & Bộ Kiểm thử Toàn diện**:
  - File Excel 26 cột chuẩn V3.1 với định dạng wrapText và Hyperlink mở Google Drive trực tiếp.
  - Bộ kiểm thử tự động `node test/verifyV3.js` với 12 kịch bản kiểm thử độc lập đạt độ tin cậy 100%.

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
│   ├── Cao_tang/
│   │   └── THE CITYON - IMPERIA OCEAN CITY/
│   │       └── A2.1009/
│   │           ├── image_01.jpg
│   │           └── image_02.jpg
│   └── Thap_tang/
│       └── VINHOMES GLOBAL GATE HA LONG/
│           ├── HG12-08/
│           │   ├── image_01.jpg
│           │   └── image_02.jpg
│           └── HG12-09/
└── SalePro/
    ├── Cao_tang/
    │   └── Ten_du_an/ (VD: CHARMORA CITY_CT, IMPERIA SKY PARK, QTOPIA)
    │       ├── _Project/                     <-- Ảnh đại diện, banner phối cảnh dự án
    │       │   ├── project_avatar.jpg
    │       │   └── banner_01.jpg
    │       ├── _FloorPlans/                  <-- Mặt bằng tổng thể, phân khu, tòa nhà, tầng
    │       │   ├── Mat_bang_tong_the.png
    │       │   └── Mat_bang_tang_dien_hinh.png
    │       └── _Layouts/                     <-- Thiết kế chi tiết theo từng loại căn
    │           ├── Studio/
    │           ├── 1PN/
    │           ├── 1PN_Plus/
    │           ├── 2PN/
    │           └── 3PN/
    └── Thap_tang/
        └── Ten_du_an/ (VD: VINHOMES GREEN PARADISE, VINHOMES HẢI VÂN BAY)
            ├── _Project/
            │   └── project_avatar.jpg
            ├── _FloorPlans/
            │   └── Mat_bang_tong_the.png
            └── _Layouts/
                ├── Lien_ke/
                ├── Biet_thu_song_lap/
                └── Biet_thu_don_lap/
```

**Quy tắc phân loại & Lưu trữ:**
- Phân tầng chính xác theo nguồn: `HiSale` và `SalePro`.
- Phân khúc dữ liệu thực tế: `Thap_tang` và `Cao_tang` (dựa trên loại căn, tầng, tòa, project type).
- Tạo thư mục theo nhu cầu thực tế (*on-demand*): Chỉ khởi tạo khi có dữ liệu thuộc nhóm đó, tuyệt đối không tạo thư mục rỗng.
- Căn SalePro không có ảnh riêng thực tế: Không tạo thư mục rỗng cho từng căn; các căn cùng dự án sẽ liên kết trực tiếp tới URL Drive của ảnh phối cảnh, mặt bằng và layout thiết kế tương ứng.

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
| `IMAGE_MAX_PROJECT_IMAGES` | `0` | Giới hạn số ảnh phối cảnh dự án tải về (`0` = không giới hạn) |
| `PROJECT_MEDIA_SYNC_ENABLED` | `true` | Bật worker định kỳ đồng bộ media dự án SalePro V3.1 |
| `PROJECT_MEDIA_SYNC_CRON` | `0 2 * * *` | Lịch đồng bộ media dự án tự động (02:00 sáng mỗi ngày) |
| `PROJECT_MEDIA_SYNC_BATCH_SIZE` | `10` | Số lượng dự án tối đa xử lý trong mỗi phiên quét nền |

---

## 📊 Cấu trúc 26 cột trong File Excel Báo cáo (Chuẩn V3)

File Excel đính kèm được tạo tự động trong bộ nhớ với đầy đủ 26 cột:

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
19. **Hình ảnh riêng của căn — Google Drive** *(Chỉ có khi căn thực sự có ảnh riêng)*
20. **Hình ảnh layout thiết kế — Google Drive** *(Ghi rõ nhãn [Chính xác: ...] hoặc [Tham khảo: ...])*
21. **Mức độ khớp layout** (`EXACT (Chính xác)`, `TYPE_MATCH (Tham khảo)`, `UNMATCHED (Chưa khớp)`)
22. **Hình ảnh mặt bằng — Google Drive** *(Mặt bằng tổng thể, phân khu, tòa, tầng)*
23. **Hình ảnh phối cảnh dự án — Google Drive** *(Ảnh đại diện và banners tiêu biểu của dự án)*
24. **Thư mục Google Drive** *(Hyperlink click mở trực tiếp thư mục dự án / căn)*
25. **Tài liệu liên quan** *(Bảng giá, CSBH, Pháp lý bóc tách từ landing/share info)*
26. **Trạng thái đồng bộ hình ảnh** (`SUCCESS`, `NO_IMAGE`, `FAILED`, `PENDING`)

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
npm run report:now        # Gửi ngay báo cáo tổng hợp ngày kèm file Excel 26 cột

# ==========================================
# GOOGLE DRIVE & MEDIA (V3)
# ==========================================
# 🚀 LỆNH TỔNG (KHUYÊN DÙNG) - Tự động tải TOÀN BỘ media SalePro & căn HiSale lên Drive sếp
npm run images:sync-all   # Đồng bộ trọn gói 100% tất cả dự án & căn (có tự động resume nếu ngắt)

npm run drive:auth        # Hướng dẫn và xác thực Google Drive OAuth lần đầu
npm run drive:create-root # Tự động tạo thư mục tổng qua API & tự cập nhật ID vào .env
npm run drive:picker      # Cấp quyền thư mục công ty có sẵn qua giao diện Google Picker
npm run drive:test        # Kiểm tra kết nối thư mục tổng và upload thử file
npm run drive:migrate-segments:dry      # Rà soát phân khúc Drive (Chế độ DRY-RUN, an toàn 100%)
npm run drive:migrate-segments:execute  # Thực hiện di chuyển phân khúc thật (khi được phê duyệt)
npm run images:stats      # Thống kê trạng thái ảnh từ MongoDB (Chế độ chỉ đọc, không upload)
npm run images:sync -- --source=hisale --limit=5   # Đồng bộ thử nghiệm tối đa 5 căn HiSale
npm run images:sync -- --source=salepro --limit=5  # Xử lý thử nghiệm tối đa 5 căn SalePro

# Đồng bộ Media dự án SalePro V3 (_Project, _FloorPlans, _Layouts và liên kết căn)
npm run images:sync-projects -- --project-id=1295,1341,1475,1355,1385,1277 # Chỉ định ID dự án
npm run images:sync-projects -- --source=salepro --limit=5                   # Theo số lượng

npm run images:backfill -- --source=hisale         # Đồng bộ tồn đọng HiSale theo batch (hỗ trợ resume)
npm run images:backfill -- --source=salepro        # Đồng bộ tồn đọng SalePro theo batch (hỗ trợ resume)

# ==========================================
# BÁO CÁO TUẦN (WEEKLY REPORT) & KIỂM THỬ
# ==========================================
npm run report:weekly     # Tổng hợp và gửi báo cáo tuần ngay lập tức
npm run test:mail:weekly  # Kiểm thử giao diện email báo cáo tuần bằng dữ liệu mẫu
npm run test:mail         # Kiểm thử email báo cáo ngày mẫu
npm test                  # Chạy bộ test tự động toàn diện V3.1 (node test/verifyV3.js)
npm run test:v2           # Chạy bộ test tương thích ngược V2 (node test/verifyV2.js)
npm run test:integration # Chạy bộ test tích hợp Concurrency & Lock trên MongoDB test riêng (node test/integration.test.js)
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
# Báo cáo rổ hàng và lịch sử biến động

Để cào mới rồi đồng bộ Drive và xuất Excel, dừng scheduler/phiên đồng bộ cũ, đóng file Excel đang mở và chạy từng lệnh trong PowerShell:

```powershell
cd D:\intern\crawler
$env:IMAGE_UPLOAD_CONCURRENCY="4"
$env:IMAGE_SYNC_BATCH_SIZE="20"
$env:MEDIA_DOWNLOAD_TIMEOUT_MS="60000"
$env:MEDIA_MAX_SIZE_MB="100"
npm run crawl:refresh
npm run sync:all -- --refresh-projects --refresh-files --retry-failed
npm run documents:sync -- --refresh
npm run drive:repair-links
npm run export:excel
```

`crawl:refresh` cập nhật dữ liệu và ghi lịch sử, không gửi email ngay và không coi căn mới là dữ liệu nền như `--init`. Nếu cào thất bại/thiếu nguồn thì xử lý đăng nhập hoặc API trước khi coi báo cáo là dữ liệu mới đầy đủ. Lệnh đồng bộ có thể trả mã 2 khi còn file lỗi; vẫn có thể xuất Excel để xem phần thành công và lỗi. Các biến tốc độ ở trên chỉ áp dụng trong cửa sổ terminal hiện tại.

`--refresh-projects` quét lại media dự án SalePro; `--refresh-files` kiểm tra lại nội dung file dù URL không đổi, có thể mất nhiều thời gian. Những lần sau có thể dùng `npm run sync:all` và `npm run documents:sync` để xử lý gia tăng. `--retry-failed` mở lại một lượt thử cho căn trước đó đã hết số lần retry. Nguồn 403/404, file bị xóa hoặc định dạng Google native không xuất được vẫn được ghi lỗi; không tạo link giả để lấp ô trống.

Luồng media nhận ảnh, PDF, XLS/XLSX, DOC/DOCX, PPT/PPTX, CSV/TSV/TXT/JSON, ZIP/RAR/7Z, các file video/audio có đuôi được nhận diện và file nhị phân Drive khai báo octet-stream. Google Sheets/Docs/Slides/Drawings được xuất lần lượt sang XLSX/DOCX/PPTX/PDF. Giữ định dạng gốc của file nhị phân; không gán ZIP thành Excel. Giới hạn dung lượng/thời gian vẫn áp dụng. Đây là sao lưu các URL file mà crawler đã tìm thấy; không biến trang web hoặc link chia sẻ bất kỳ thành file tải được.

Trong `Chi_tiet_quy_can`, cột AC giữ thư mục riêng của căn; AF là thư mục dự án dùng chung; AG là file nội bộ đầu tiên nếu có; AH/AI giải thích trạng thái và lỗi. Sheet `Tep_noi_bo` liệt kê từng file đã lưu để mở các file còn lại. Bản sao đã có được giữ link khi lượt tải mới thất bại và ghi rõ lỗi; không khẳng định bản đó là phiên bản mới nhất. `drive:repair-links` chỉ khôi phục URL từ ID đã lưu, không kiểm tra quyền hay sự tồn tại trên Drive.

URL nguồn được giữ dạng văn bản để sao chép, ưu tiên hyperlink cho file/thư mục nội bộ. Bộ xuất giới hạn 60.000 hyperlink trên mỗi sheet để không vượt [giới hạn Excel](https://support.microsoft.com/en-us/excel/excel-specifications-and-limits); các URL vượt ngưỡng vẫn được giữ đầy đủ dưới dạng văn bản và ghi chú trong sheet hướng dẫn.

Xuất báo cáo hiện tại bằng `npm run export:excel`. File được lưu trong `reports/` với hậu tố `_da_kiem_tra.xlsx`, theo ngày Việt Nam. Báo cáo gồm tổng quan, toàn bộ dự án, chi tiết căn, biến động quan sát được, hướng dẫn dữ liệu và trạng thái bảng tính giá trên Drive. Thư mục báo cáo và thông tin đăng nhập không đưa lên Git.

- Danh sách dự án ghép danh mục `Project` với các căn đã lưu, ưu tiên ID theo từng sàn. Dự án có trong danh mục nhưng chưa có căn vẫn xuất hiện. Các ID chưa khớp danh mục được ghi rõ. Số căn 0 trong CSDL không tự động có nghĩa sàn đã hết hàng.
- Giá vay, TTTĐ, đơn giá, trục, mặt tiền và sáu cột quỹ dùng chung logic giữa xuất thủ công và email ngày/tuần. Không suy ra đơn giá từ tổng giá. Thuộc tính thiếu số dùng `-`; không áp dụng/không có trường nguồn thì để trống. Quỹ chưa xác định dùng `-`, không tự gán Yes/No. Chỉ VHub thấp tầng có mặt tiền.
- Chạy `npm run history:init` một lần trên CSDL hiện có để ghi mốc bắt đầu theo dõi. Đây là thao tác bổ sung metadata, không thay giá/trạng thái và không tạo lịch sử giả. Các lần ghi của crawler sau khi cập nhật code sẽ lưu sự kiện căn mới, đổi giá và đổi trạng thái ngay cùng bản ghi căn.
- Căn không còn xuất hiện chỉ được ghi nhận sau lần quét đầy đủ đúng phạm vi. Rời rổ được tách khỏi đã bán. Nếu API chỉ trả căn chưa bán thì không thể khẳng định số bán thực tế; lỗi hoặc phiên quét thiếu không phải bằng chứng căn đã bán. Báo cáo ngày lấy 24 giờ gần nhất, báo cáo tuần lấy tuần trước từ thứ Hai đến thứ Hai theo giờ Việt Nam, có chi tiết giá/trạng thái cũ và mới. Không khôi phục được biến động trước mốc bắt đầu nếu không có dữ liệu lịch sử khác.
- Chạy `npm run documents:sync` để sao lưu các link Google Sheets/Excel trực tiếp tìm được trong dữ liệu nguồn sang thư mục `Bang_tinh_gia` dưới Drive nội bộ. File trùng ID được dùng chung. Kết quả lưu ở `PricingDocument`, gồm link bản sao hoặc lỗi truy cập. Dùng `npm run documents:sync -- --retry-failed` sau khi quyền nguồn đã được cấp lại. Tác vụ gia tăng chạy lúc 04:00 mỗi ngày khi `IMAGE_SYNC_ENABLED=true`; scheduler cần đang chạy (`npm start`). Các link thư mục nguồn vẫn do luồng đồng bộ media xử lý, có phân trang; sheet trạng thái không tuyên bố thư mục đã có đủ bảng tính nếu chưa xác minh.
- Chạy `npm test`, `npm run test:reports` và `npm run test:integration` để kiểm tra. Kiểm thử lịch sử dùng collection tạm trong CSDL test riêng, không thay đổi dữ liệu căn thật.
