/**
 * CPBL 啦啦隊班表爬蟲
 * 從 CPBL 官網抓取各場次出勤啦啦隊員名單，合併至 cheerleader.json
 * 並反向將資料注入對應的 cpbl.json 場次（game.cheerleaders 欄位）
 *
 * 執行時機：GitHub Actions 賽前高頻排程（台灣時間 17:00 / 18:00 / 19:00）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getWithRetry } = require('./utils/request');
const { sendAlert } = require('./utils/webhook');

const CHEERLEADER_PATH = path.join(__dirname, '../data/cheerleader.json');
const CPBL_PATH = path.join(__dirname, '../data/cpbl.json');

// 場次頁面解析啦啦隊名單
// CPBL 場次詳情 URL 格式：https://www.cpbl.com.tw/games/{GameSno}
// 啦啦隊資訊通常出現在 .cheerleader-name 或 .game-info-cheerleader 區塊

async function fetchCheerleadersForGame(gameSno) {
  try {
    const url = `https://www.cpbl.com.tw/games/${gameSno}`;
    const page = await getWithRetry(url, { referer: 'https://www.cpbl.com.tw/schedule' });

    const names = [];

    // 解析 cheerleader 區塊（CPBL 官網結構可能隨改版調整）
    // 嘗試多種選取模式
    const patterns = [
      // 模式 A：class="cheer-name" 或 class="cheerleader"
      /class="cheer(?:leader)?[^"]*"[^>]*>([^<]{2,10})<\/[a-z]+>/gi,
      // 模式 B：啦啦隊員姓名（中文2-5字）出現在特定區塊
      /啦啦隊員[：:]\s*([^\n<]{2,50})/gi,
    ];

    for (const pattern of patterns) {
      const matches = [...page.body.matchAll(pattern)];
      for (const m of matches) {
        const raw = m[1].trim();
        // 過濾非姓名字串（姓名通常2-5中文字）
        if (/^[\u4e00-\u9fa5]{2,5}$/.test(raw) && !names.includes(raw)) {
          names.push(raw);
        }
      }
      if (names.length > 0) break;
    }

    return names;
  } catch (_) {
    return [];
  }
}

async function crawl() {
  console.log('[cheerleader] 開始抓取啦啦隊班表...');

  // 讀取現有 CPBL 賽程，找出今日或未來3天的場次
  let cpblData = null;
  try {
    cpblData = JSON.parse(fs.readFileSync(CPBL_PATH, 'utf-8'));
  } catch (_) {
    console.warn('[cheerleader] 無法讀取 cpbl.json，略過啦啦隊更新');
    return;
  }

  const now = new Date();
  const todayStr = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const threeDaysLater = new Date(now);
  threeDaysLater.setDate(now.getDate() + 3);
  const threeDaysStr = threeDaysLater.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

  const upcomingGames = (cpblData.games || []).filter(
    g => g.date >= todayStr && g.date <= threeDaysStr && g.status !== 'cancelled'
  );

  console.log(`[cheerleader] 找到 ${upcomingGames.length} 場近期賽事`);

  // 讀取現有班表資料
  let cheerleaderData = { updated_at: '', schedule: [] };
  try {
    cheerleaderData = JSON.parse(fs.readFileSync(CHEERLEADER_PATH, 'utf-8'));
  } catch (_) {}

  const existingIds = new Set(cheerleaderData.schedule.map(s => s.game_id));
  let updated = false;

  for (const game of upcomingGames) {
    // 從 game.id 中提取 GameSno（格式：cpbl-YYYYMMDD-NNN）
    const snoMatch = game.id.match(/cpbl-\d{8}-(\d+)/);
    if (!snoMatch) continue;
    const gameSno = parseInt(snoMatch[1], 10);

    if (existingIds.has(game.id)) {
      console.log(`[cheerleader] 跳過已有資料：${game.id}`);
      continue;
    }

    console.log(`[cheerleader] 抓取 ${game.id}（場次 ${gameSno}）...`);
    const cheerleaders = await fetchCheerleadersForGame(gameSno);

    if (cheerleaders.length > 0) {
      cheerleaderData.schedule.push({
        game_id: game.id,
        date: game.date,
        venue: game.venue,
        home_team: game.home_team,
        away_team: game.away_team,
        cheerleaders,
      });
      existingIds.add(game.id);
      updated = true;
      console.log(`[cheerleader] ${game.id} 啦啦隊：${cheerleaders.join('、')}`);
    }

    // 避免請求過快
    await new Promise(r => setTimeout(r, 1500));
  }

  // 清理超過 60 天的舊資料
  const cutoff = new Date(now);
  cutoff.setDate(now.getDate() - 60);
  const cutoffStr = cutoff.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  cheerleaderData.schedule = cheerleaderData.schedule.filter(s => s.date >= cutoffStr);

  // 更新 cheerleader.json
  cheerleaderData.updated_at = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(' ', 'T') + '+08:00';
  fs.writeFileSync(CHEERLEADER_PATH, JSON.stringify(cheerleaderData, null, 2), 'utf-8');
  console.log(`[cheerleader] ✅ 班表已更新（共 ${cheerleaderData.schedule.length} 筆）`);

  // 反向注入 cpbl.json 的 game.cheerleaders 欄位
  if (updated) {
    const cheerMap = {};
    for (const s of cheerleaderData.schedule) {
      cheerMap[s.game_id] = s.cheerleaders;
    }
    let injected = 0;
    for (const game of cpblData.games) {
      if (cheerMap[game.id]) {
        game.cheerleaders = cheerMap[game.id];
        injected++;
      }
    }
    if (injected > 0) {
      cpblData.updated_at = cheerleaderData.updated_at;
      fs.writeFileSync(CPBL_PATH, JSON.stringify(cpblData, null, 2), 'utf-8');
      console.log(`[cheerleader] 注入 ${injected} 場次的啦啦隊資料至 cpbl.json`);
    }
  }
}

if (require.main === module) {
  crawl().catch(async (err) => {
    console.error('[cheerleader] 爬蟲失敗：', err.message);
    await sendAlert('cheerleader', '啦啦隊班表爬蟲失敗', err).catch(() => {});
    process.exit(1);
  });
}

module.exports = { crawl };
