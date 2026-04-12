/**
 * 快速 Schema 驗證（用於 CI）
 * 相對路徑從 crawler repo root 執行
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { validateLeagueData } = require('./src/schema');

const DATA_DIR = path.join(__dirname, 'data');
const REQUIRED_FILES = ['cpbl.json', 'tpbl.json', 'plg.json'];

let allPassed = true;
console.log('=== JSON Schema 驗證 ===\n');

for (const filename of REQUIRED_FILES) {
  const filePath = path.join(DATA_DIR, filename);
  process.stdout.write(`驗證 ${filename}... `);

  if (!fs.existsSync(filePath)) {
    console.log('❌ 檔案不存在');
    allPassed = false;
    continue;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    console.log(`❌ JSON 解析失敗：${e.message}`);
    allPassed = false;
    continue;
  }

  const { valid, errors } = validateLeagueData(data);
  if (!valid) {
    console.log(`❌ Schema 驗證失敗：${errors.join('; ')}`);
    allPassed = false;
    continue;
  }

  if (data.games.length === 0 && data.league === 'plg') {
    console.log('⚠️  games 陣列為空（PLG 已併入 TPBL）');
    continue;
  }

  if (data.games.length === 0) {
    console.log('❌ games 陣列為空');
    allPassed = false;
    continue;
  }

  console.log(`✅ 通過（${data.games.length} 場，更新：${data.updated_at}）`);
}

console.log('\n' + (allPassed ? '✅ 所有 Schema 驗證通過' : '❌ Schema 驗證未全部通過'));
process.exit(allPassed ? 0 : 1);
