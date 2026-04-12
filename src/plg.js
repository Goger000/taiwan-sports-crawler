/**
 * PLG P+ League 籃球爬蟲
 * 目標：https://pleaguebasketball.com/schedule
 * 輸出：data/plg.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getWithRetry } = require('./utils/request');
const { validateLeagueData } = require('./schema');
const { sendAlert } = require('./utils/webhook');

const OUTPUT_PATH = path.join(__dirname, '../data/plg.json');

const TEAM_NAMES = {
  '台啤永豐': '台啤永豐雲豹',
  '雲豹': '台啤永豐雲豹',
  '高雄17直播': '高雄17直播勇士',
  '勇士': '高雄17直播勇士',
  '新竹街口': '新竹街口攻城獅',
  '攻城獅': '新竹街口攻城獅',
  '台北富邦': '台北富邦勇士',
  '富邦勇士': '台北富邦勇士',
  '桃園緯來': '桃園緯來飛羊',
  '飛羊': '桃園緯來飛羊',
  '福爾摩沙': '福爾摩沙夢想家',
};

const VENUE_NAMES = {
  '新竹': '新竹縣立體育館',
  '高雄體育館': '高雄市立體育館',
  '台北小巨蛋': '台北小巨蛋',
  '小巨蛋': '台北小巨蛋',
  '竹南': '苗栗縣竹南體育館',
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

    const id = `plg-${date.replace(/-/g, '')}-${String(++gameIndex).padStart(3, '0')}`;
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
  console.log('[plg] 開始抓取 PLG 賽程...');
  const now = new Date();
  const season = now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1;
  const url = `https://pleaguebasketball.com/schedule?season=${season}`;

  console.log(`[plg] 抓取 ${season} 賽季：${url}`);
  const { statusCode, body } = await getWithRetry(url, { referer: 'https://pleaguebasketball.com/' });

  if (statusCode !== 200) throw new Error(`HTTP ${statusCode}`);

  const games = parseScheduleHtml(body);
  console.log(`[plg] 解析到 ${games.length} 場比賽`);

  const output = {
    league: 'plg',
    sport_type: 'basketball',
    updated_at: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(' ', 'T') + '+08:00',
    games,
  };

  const { valid, errors } = validateLeagueData(output);
  if (!valid) throw new Error(`Schema 驗證失敗：\n${errors.join('\n')}`);

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`[plg] 成功輸出 ${games.length} 場比賽至 ${OUTPUT_PATH}`);
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
