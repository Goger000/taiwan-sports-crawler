/**
 * PLG P. League+ 籃球爬蟲
 * 注意：PLG 已於 2024-2025 賽季後與 T1 League 合併為 TPBL（台灣職業籃球大聯盟）。
 * PLG 官方網站已停用，此模組輸出空資料集以維持 API 相容性。
 * 實際籃球賽程請參閱 tpbl.json。
 * 輸出：data/plg.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { validateLeagueData } = require('./schema');
const { sendAlert } = require('./utils/webhook');

const OUTPUT_PATH = path.join(__dirname, '../data/plg.json');

async function crawl() {
  console.log('[plg] PLG 已併入 TPBL，輸出空資料集...');

  const output = {
    league: 'plg',
    sport_type: 'basketball',
    updated_at: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(' ', 'T') + '+08:00',
    games: [],
  };

  const { valid, errors } = validateLeagueData(output);
  if (!valid) throw new Error(`Schema 驗證失敗：\n${errors.join('\n')}`);

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`[plg] ✅ 輸出空資料集至 ${OUTPUT_PATH}（PLG 已停辦，請改用 tpbl 資料）`);
  return output;
}

if (require.main === module) {
  crawl().catch(async (err) => {
    console.error('[plg] 爬蟲失敗：', err.message);
    await sendAlert('plg', '賽程爬蟲失敗', err);
    process.exit(1);
  });
}

module.exports = { crawl };
