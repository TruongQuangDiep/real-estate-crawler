require('dotenv').config();
const { sendTestEmail } = require('./mailer');

async function main() {
  const isEmpty = process.argv.includes('--empty');
  console.log(
    `[Mail Test] Đang kiểm tra kết nối SMTP và gửi email mẫu (${isEmpty ? 'KỊCH BẢN: KHÔNG CÓ CĂN MỚI' : 'KỊCH BẢN: CÓ CĂN MỚI + FILE EXCEL'})...`
  );
  const result = await sendTestEmail({ isEmpty });
  console.log(
    `[Mail Test] ✅ Gửi thành công tới: ${result.to} (MessageId: ${result.messageId})`
  );
  console.log(
    `[Mail Test] Nội dung đã gửi: [${isEmpty ? 'Báo cáo: Đồng bộ ổn định, không phát sinh căn mới' : 'Báo cáo: +3 căn mới kèm file Excel đính kèm'}]`
  );
  console.log('[Mail Test] Vui lòng kiểm tra Hộp thư đến (hoặc tab Cập nhật / Spam) trong Gmail.');
}

main().catch((err) => {
  console.error('[Mail Test] ❌ Gửi email thất bại:', err.message);
  process.exit(1);
});
