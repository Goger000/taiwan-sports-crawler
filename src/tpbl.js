/**
 * TPBL 台灣職業籃球大聯盟爬蟲
 * API：GET https://api.tpbl.basketball/api/seasons/{id}/games
 * 先取得賽季清單，找出 IN_PROGRESS 或最新賽季，再抓比賽資料
 * 輸出：data/tpbl.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getWithRetry } = require('./utils/request');
const { validateLeagueData } = require('./schema');
const { sendAlert } = require('./utils/webhook');

const OUTPUT_PATH = path.join(__dirname, '../data/tpbl.json');
const API_BASE = 'https://api.tpbl.basketball/api';

/**
 * 將 TPBL API 狀態轉換為 Schema status
 * TPBL status: COMPLETED, NOT_STARTED, IN_PROGRESS, POSTPONED, CANCELLED
 */
function toStatus(apiStatus, isLive) {
  if (isLive) return 'live';
  switch (apiStatus) {
    case 'COMPLETED':   return 'final';
    case 'NOT_STARTED': return 'scheduled';
    case 'IN_PROGRESS': return 'live';
    case 'POSTPONED':   return 'postponed';
    case 'CANCELLED':   return 'cancelled';
    default:            return 'scheduled';
  }
}

/**
 * 取得賽季清單，返回 IN_PROGRESS 或最新賽季的 ID
 */
async function getCurrentSeasonId() {
  const r = await getWithRetry(`${API_BASE}/seasons`, { referer: 'https://tpbl.basketball/' });
  if (r.statusCode !== 200) throw new Error(`seasons API 回傳 HTTP ${r.statusCode}`);
  const seasons = JSON.parse(r.body);
  if (!seasons.length) throw new Error('無法取得賽季資料');
  // 優先找 IN_PROGRESS，否則取最後一個（最新）
  const active = seasons.find(s => s.status === 'IN_PROGRESS');
  return (active || seasons[seasons.length - 1]).id;
}

async function crawl() {
  console.log('[tpbl] 開始抓取 TPBL 賽程...');

  const seasonId = await getCurrentSeasonId();
  console.log(`[tpbl] 目前賽季 ID：${seasonId}`);

  const url = `${API_BASE}/seasons/${seasonId}/games`;
  console.log(`[tpbl] 抓取：${url}`);
  const r = await getWithRetry(url, { referer: 'https://tpbl.basketball/' });

  if (r.statusCode !== 200) throw new Error(`games API 回傳 HTTP ${r.statusCode}`);

  const rawGames = JSON.parse(r.body);
  console.log(`[tpbl] 原始資料：${rawGames.length} 場`);

  const games = rawGames
    .map(g => {
      const status = toStatus(g.status, g.is_live);
      const isCompleted = status === 'final';
      return {
        id: `tpbl-${g.game_date.replace(/-/g, '')}-${String(g.id).padStart(4, '0')}`,
        date: g.game_date,
        time: g.game_time ? g.game_time.slice(0, 5) : '19:00',
        home_team: g.home_team.name,
        away_team: g.away_team.name,
        venue: g.venue || '待確認',
        status,
        home_score: isCompleted && g.home_team.won_score != null ? Number(g.home_team.won_score) : null,
        away_score: isCompleted && g.away_team.won_score != null ? Number(g.away_team.won_score) : null,
        inning: null,
        broadcast: [],
        // 職籃購票：TPBL 官網比賽頁面（含購票連結）
        ticket_url: `https://www.tpbl.basketball/games/${g.id}`,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  console.log(`[tpbl] 轉換後：${games.length} 場`);

  const output = {
    league: 'tpbl',
    sport_type: 'basketball',
    updated_at: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(' ', 'T') + '+08:00',
    games,
  };

  const { valid, errors } = validateLeagueData(output);
  if (!valid) throw new Error(`Schema 驗證失敗：\n${errors.join('\n')}`);

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`[tpbl] ✅ 成功輸出 ${games.length} 場至 ${OUTPUT_PATH}`);
  return output;
}

if (require.main === module) {
  crawl().catch(async (err) => {
    console.error('[tpbl] 爬蟲失敗：', err.message);
    await sendAlert('tpbl', '賽程爬蟲失敗', err);
    process.exit(1);
  });
}

module.exports = { crawl };
