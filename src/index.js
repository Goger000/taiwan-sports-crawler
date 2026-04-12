/**
 * 爬蟲主進入點
 * 依傳入參數執行指定聯賽或全部聯賽
 *
 * 用法：
 *   node src/index.js          # 執行全部聯賽
 *   node src/index.js cpbl     # 只執行 CPBL
 *   node src/index.js tpbl plg # 執行 TPBL 和 PLG
 */

'use strict';

const { sendAlert } = require('./utils/webhook');

const CRAWLERS = {
  cpbl: () => require('./cpbl').crawl(),
  tpbl: () => require('./tpbl').crawl(),
  plg:  () => require('./plg').crawl(),
};

async function main() {
  const targets = process.argv.slice(2).filter(a => CRAWLERS[a]);
  const leagues = targets.length > 0 ? targets : Object.keys(CRAWLERS);

  console.log(`[index] 執行聯賽：${leagues.join(', ')}`);

  const results = { success: [], failed: [] };

  for (const league of leagues) {
    try {
      await CRAWLERS[league]();
      results.success.push(league);
    } catch (err) {
      console.error(`[index] ${league} 失敗：${err.message}`);
      results.failed.push(league);
      await sendAlert(league, `爬蟲執行失敗（由 index.js 捕獲）`, err);
    }
  }

  console.log(`\n[index] 結果摘要`);
  console.log(`  成功：${results.success.join(', ') || '無'}`);
  console.log(`  失敗：${results.failed.join(', ') || '無'}`);

  if (results.failed.length > 0) {
    process.exit(1);
  }
}

main();
