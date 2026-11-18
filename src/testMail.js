require('dotenv').config();
const { sendTestEmail } = require('./mailer');

async function main() {
  console.log('[Mail Test] Đang kiểm tra kết nối SMTP và gửi email mẫu...');
  const result = await sendTestEmail();
  console.log(
    `[Mail Test] ✅ Gửi thành công tới: ${result.to} (MessageId: ${result.messageId})`
  );
  console.log('[Mail Test] Vui lòng kiểm tra Hộp thư đến (hoặc tab Quảng cáo / Spam) trong Gmail.');
}

main().catch((err) => {
  console.error('[Mail Test] ❌ Gửi email thất bại:', err.message);
  process.exit(1);
});
