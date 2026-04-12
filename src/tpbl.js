/**
 * TPBL 台灣籃球超級聯賽爬蟲
 * 目標：https://www.tpbl.basketball/schedule
 * 輸出：data/tpbl.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getWithRetry } = require('./utils/request');
const { validateLeagueData } = require('./schema');
const { sendAlert } = require('./utils/webhook');

const OUTPUT_PATH = path.join(__dirname, '../data/tpbl.json');

const TEAM_NAMES = {
  '新北國王': '新北國王',
  '桃園璞園': '桃園璞園領航猿',
  '領航猿': '桃園璞園領航猿',
  '高雄鋼鐵人': '高雄鋼鐵人',
  '鋼鐵人': '高雄鋼鐵人',
  '福爾摩沙夢想家': '福爾摩沙夢想家',
  '夢想家': '福爾摩沙夢想家',
  '台北戰神': '台北戰神',
  '戰神': '台北戰神',
  '臺銀': '台灣銀行人壽',
  '台灣銀行': '台灣銀行人壽',
};

const VENUE_NAMES = {
  '新北市立': '新北市立體育館',
  '桃園國際': '桃園國際棒球場',
  '林口體育館': '新北市林口體育館',
  '高雄體育館': '高雄市立體育館',
  '台北小巨蛋': '台北小巨蛋',
  '小巨蛋': '台北小巨蛋',
};

function normalizeTeam(raw) {
  if (!raw) return raw;
  const trimmed = raw.trim();
  return TEAM_NAMES[trimmed] || trimmed;
}

function normalizeVenue(raw) {
  if (!raw) return raw;
  const trimmed = raw.trim();
  for (const [key, value] of Object.entries(VENUE_NAMES)) {
    if (trimmed.includes(key)) return value;
  }
  return trimmed;
}

const stripTags = (str) => str.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * 解析 TPBL 賽程 HTML
 */
function parseScheduleHtml(html) {
  const games = [];
  let gameIndex = 0;

  const rows = html.split(/<tr[\s>]/i).slice(1);

  for (const row of rows) {
    const cells = [];
    let cellMatch;
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    while ((cellMatch = cellRegex.exec(row)) !== null) {
      cells.push(stripTags(cellMatch[1]));
    }

    if (cells.length < 4) continue;

    // 嘗試解析日期（TPBL 格式通常為 MM/DD 或 YYYY/MM/DD）
    const dateCell = cells.find(c => /\d{1,4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}/.test(c));
    if (!dateCell) continue;

    const dateMatch = dateCell.match(/(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
    if (!dateMatch) continue;

    const date = `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, '0')}-${String(dateMatch[3]).padStart(2, '0')}`;
    const timeCell = cells.find(c => /\d{2}:\d{2}/.test(c));
    const time = timeCell?.match(/(\d{2}:\d{2})/)?.[1] || '19:00';

    const teamCells = cells.filter(c => c && Object.keys(TEAM_NAMES).some(t => c.includes(t)));
    if (teamCells.length < 2) continue;

    const awayTeam = normalizeTeam(teamCells[0]);
    const homeTeam = normalizeTeam(teamCells[1]);
    const venue = normalizeVenue(cells.find(c => Object.keys(VENUE_NAMES).some(v => c.includes(v))) || '');

    const scoreCell = cells.find(c => /^\d+[-:]\d+$/.test(c.trim()));
    let homeScore = null, awayScore = null, status = 'scheduled';
    if (scoreCell) {
      const parts = scoreCell.trim().split(/[-:]/);
      awayScore = parseInt(parts[0], 10);
      homeScore = parseInt(parts[1], 10);
      status = 'final';
    }

    const id = `tpbl-${date.replace(/-/g, '')}-${String(++gameIndex).padStart(3, '0')}`;
    games.push({
      id, date, time,
      home_team: homeTeam, away_team: awayTeam,
      venue: venue || '待確認', status,
      home_score: homeScore, away_score: awayScore,
      inning: null, broadcast: [], ticket_url: null,
    });
  }

  return games;
}

async function crawl() {
  console.log('[tpbl] 開始抓取 TPBL 賽程...');
  const now = new Date();
  const season = now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1;
  const url = `https://www.tpbl.basketball/schedule?season=${season}`;

  console.log(`[tpbl] 抓取 ${season} 賽季：${url}`);
  const { statusCode, body } = await getWithRetry(url, { referer: 'https://www.tpbl.basketball/' });

  if (statusCode !== 200) throw new Error(`HTTP ${statusCode}`);

  const games = parseScheduleHtml(body);
  console.log(`[tpbl] 解析到 ${games.length} 場比賽`);

  const output = {
    league: 'tpbl',
    sport_type: 'basketball',
    updated_at: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(' ', 'T') + '+08:00',
    games,
  };

  const { valid, errors } = validateLeagueData(output);
  if (!valid) throw new Error(`Schema 驗證失敗：\n${errors.join('\n')}`);

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`[tpbl] 成功輸出 ${games.length} 場比賽至 ${OUTPUT_PATH}`);
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
