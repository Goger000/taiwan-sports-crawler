/**
 * Webhook 警報工具
 * 爬蟲失敗時通知 Discord / Slack
 * 透過環境變數 WEBHOOK_URL 設定目標（GitHub Actions Secrets）
 */

const https = require('https');
const { URL } = require('url');

/**
 * 發送警報訊息至 Discord 或 Slack
 * @param {string} league   聯賽識別碼
 * @param {string} message  錯誤描述
 * @param {Error}  [error]  原始 Error 物件
 */
async function sendAlert(league, message, error) {
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[webhook] WEBHOOK_URL 未設定，略過警報');
    return;
  }

  const text = [
    `🚨 **爬蟲失敗警報**`,
    `聯賽：\`${league}\``,
    `訊息：${message}`,
    error ? `錯誤：\`${error.message}\`` : '',
    `時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`,
  ].filter(Boolean).join('\n');

  // 自動偵測 Discord vs Slack 格式
  const isDiscord = webhookUrl.includes('discord.com');
  const payload = JSON.stringify(isDiscord ? { content: text } : { text });

  return new Promise((resolve) => {
    const parsed = new URL(webhookUrl);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      console.log(`[webhook] 警報已送出，狀態碼：${res.statusCode}`);
      resolve();
    });
    req.on('error', (e) => {
      console.error(`[webhook] 發送失敗：${e.message}`);
      resolve(); // 不因 webhook 失敗而中斷主流程
    });
    req.write(payload);
    req.end();
  });
}

module.exports = { sendAlert };
