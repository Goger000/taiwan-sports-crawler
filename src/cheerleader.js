/**
 * 啦啦隊班表爬蟲
 * 資料來源：cpblgirls.tw/schedule（靜態 HTML + JSON-LD，無需 Playwright）
 *
 * 解析頁面裡的 <script type="application/ld+json"> 取得 SportsEvent 陣列，
 * 再依 date + homeTeam 對應 cpbl.json 的 game_id，寫入 cheerleader.json。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getWithRetry } = require('./utils/request');

const CHEERLEADER_PATH = path.join(__dirname, '../data/cheerleader.json');
const CPBL_PATH = path.join(__dirname, '../data/cpbl.json');
const SOURCE_URL = 'https://cpblgirls.tw/schedule';

// 場館名稱正規化（移除「市/縣/市立/縣立」等行政區前綴，方便比對）
function normalizeVenue(v) {
  return (v || '')
    .replace(/^(台北市|新北市|桃園市|台中市|台南市|高雄市|嘉義市|嘉義縣|彰化縣|新竹市|新竹縣|苗栗縣|宜蘭縣|花蓮縣|台東縣)/, '')
    .replace(/市立|縣立/, '')
    .trim();
}

// 球隊名稱正規化（移除常見別名差異）
function normalizeTeam(t) {
  return (t || '')
    .replace(/統一7-ELEVEn獅|統一獅/, '統一7-ELEVEn獅')
    .trim();
}

async function crawl() {
  console.log('[cheerleader] 開始從 cpblgirls.tw 抓取啦啦隊班表...');

  // ── 抓取來源頁面 ──────────────────────────────────────────────
  let html;
  try {
    const res = await getWithRetry(SOURCE_URL, {
      referer: 'https://cpblgirls.tw',
    });
    html = res.body;
  } catch (err) {
    console.error('[cheerleader] 無法取得 cpblgirls.tw 頁面:', err.message);
    return;
  }

  // ── 解析 JSON-LD ───────────────────────────────────────────────
  const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!ldMatch) {
    console.warn('[cheerleader] 找不到 JSON-LD，頁面結構可能已變更');
    return;
  }

  let events;
  try {
    events = JSON.parse(ldMatch[1]);
    if (!Array.isArray(events)) events = [events];
  } catch (e) {
    console.error('[cheerleader] JSON-LD 解析失敗:', e.message);
    return;
  }

  console.log(`[cheerleader] 取得 ${events.length} 筆 SportsEvent`);

  // ── 讀取 cpbl.json（用來對應 game_id）────────────────────────
  let cpblData = null;
  try {
    cpblData = JSON.parse(fs.readFileSync(CPBL_PATH, 'utf-8'));
  } catch (_) {
    console.warn('[cheerleader] 無法讀取 cpbl.json，略過 game_id 對應');
  }

  // 建立 date+homeTeam → game_id 對照表
  const gameMap = {};
  if (cpblData) {
    for (const g of cpblData.games || []) {
      const key = `${g.date}|${normalizeTeam(g.homeTeam || g.home_team)}`;
      gameMap[key] = g.id;
    }
  }

  // ── 轉換 SportsEvent → schedule 項目 ─────────────────────────
  const schedule = [];
  for (const ev of events) {
    if (ev['@type'] !== 'SportsEvent') continue;

    const performers = (ev.performer || []).map(p => p.name).filter(Boolean);
    if (performers.length === 0) continue;

    // 解析日期（格式：2026-04-19T16:05:00+08:00）
    const dateStr = (ev.startDate || '').slice(0, 10); // 取 YYYY-MM-DD
    if (!dateStr) continue;

    const homeTeam = normalizeTeam(ev.homeTeam?.name || '');
    const awayTeam = normalizeTeam(ev.awayTeam?.name || '');
    const venue = normalizeVenue(ev.location?.name || '');

    const key = `${dateStr}|${homeTeam}`;
    const gameId = gameMap[key] || null;

    schedule.push({
      game_id: gameId,
      date: dateStr,
      venue,
      home_team: homeTeam,
      away_team: awayTeam,
      cheerleaders: performers,
    });
  }

  // 依日期排序
  schedule.sort((a, b) => a.date.localeCompare(b.date));

  // ── 寫入 cheerleader.json ─────────────────────────────────────
  const output = {
    _note: '啦啦隊班表，由爬蟲自動更新。資料來源：cpblgirls.tw',
    updated_at: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(' ', 'T') + '+08:00',
    schedule,
  };
  fs.writeFileSync(CHEERLEADER_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`[cheerleader] ✅ 班表已更新（共 ${schedule.length} 筆，${schedule.filter(s => s.game_id).length} 筆已對應 game_id）`);

  // ── 反向注入 cpbl.json 的 game.cheerleaders ──────────────────
  if (cpblData) {
    const cheerMap = {};
    for (const s of schedule) {
      if (s.game_id) cheerMap[s.game_id] = s.cheerleaders;
    }
    let injected = 0;
    for (const game of cpblData.games || []) {
      if (cheerMap[game.id]) {
        game.cheerleaders = cheerMap[game.id];
        injected++;
      }
    }
    if (injected > 0) {
      cpblData.updated_at = output.updated_at;
      fs.writeFileSync(CPBL_PATH, JSON.stringify(cpblData, null, 2), 'utf-8');
      console.log(`[cheerleader] 注入 ${injected} 場次的啦啦隊資料至 cpbl.json`);
    }
  }
}

if (require.main === module) {
  crawl().catch(err => {
    console.error('[cheerleader] 爬蟲失敗：', err.message);
    process.exit(1);
  });
}

module.exports = { crawl };
