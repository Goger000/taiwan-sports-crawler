/**
 * CPBL 中華職棒爬蟲
 * 目標：https://www.cpbl.com.tw/schedule
 * 輸出：data/cpbl.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getWithRetry } = require('./utils/request');
const { validateLeagueData } = require('./schema');
const { sendAlert } = require('./utils/webhook');

const OUTPUT_PATH = path.join(__dirname, '../data/cpbl.json');

// 中華職棒球隊名稱對照表（官網可能用簡稱）
const TEAM_NAMES = {
  '兄弟': '中信兄弟',
  '中信兄弟': '中信兄弟',
  '樂天': '樂天桃猿',
  '樂天桃猿': '樂天桃猿',
  '統一': '統一7-ELEVEn獅',
  '統一獅': '統一7-ELEVEn獅',
  '富邦': '富邦悍將',
  '富邦悍將': '富邦悍將',
  '味全': '味全龍',
  '味全龍': '味全龍',
  '台鋼': '台鋼雄鷹',
  '台鋼雄鷹': '台鋼雄鷹',
};

// 場館名稱標準化
const VENUE_NAMES = {
  '洲際': '台中洲際棒球場',
  '台中洲際': '台中洲際棒球場',
  '天母': '天母棒球場',
  '新莊': '新北市立新莊棒球場',
  '桃園': '桃園國際棒球場',
  '澄清湖': '高雄澄清湖棒球場',
  '嘉義': '嘉義市立棒球場',
  '斗六': '雲林斗六棒球場',
  '台南': '台南棒球場',
  '羅東': '宜蘭縣立羅東棒球場',
};

/**
 * 標準化球隊名稱
 */
function normalizeTeam(raw) {
  if (!raw) return raw;
  const trimmed = raw.trim();
  return TEAM_NAMES[trimmed] || trimmed;
}

/**
 * 標準化場館名稱
 */
function normalizeVenue(raw) {
  if (!raw) return raw;
  const trimmed = raw.trim();
  for (const [key, value] of Object.entries(VENUE_NAMES)) {
    if (trimmed.includes(key)) return value;
  }
  return trimmed;
}

/**
 * 解析 CPBL 賽程 HTML
 * CPBL 官網使用 server-side rendered HTML，以 CSS class 標記各欄位
 * @param {string} html
 * @param {string} targetMonth  YYYY-MM 格式
 * @returns {import('./schema').Game[]}
 */
function parseScheduleHtml(html, targetMonth) {
  const games = [];

  // 比賽區塊：每場比賽在 .ScheduleTableWrap 或 .game 類似容器內
  // 以下使用 regex 解析關鍵欄位（避免引入 cheerio 等外部依賴）
  // 格式通常為：日期、主客隊、場地、時間

  // 解析日期區塊
  const dateBlockRegex = /<div[^>]*class="[^"]*date[^"]*"[^>]*>[\s\S]*?(\d{1,2})[\s\S]*?<\/div>/gi;
  const gameRowRegex = /<tr[^>]*class="[^"]*(?:game|schedule)[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;

  // 抓取所有比賽列
  let match;
  let gameIndex = 0;

  // 解析賽程表格
  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  // 移除 HTML tags 的輔助函式
  const stripTags = (str) => str.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

  // 解析日期（從 th 或特定 class 提取）
  const dateRegex = /(\d{4})[\/.年](\d{1,2})[\/.月](\d{1,2})/;

  let currentDate = '';
  const rows = html.split(/<tr[\s>]/i).slice(1);

  for (const row of rows) {
    const cells = [];
    let cellMatch;
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    while ((cellMatch = cellRegex.exec(row)) !== null) {
      cells.push(stripTags(cellMatch[1]));
    }

    if (cells.length < 4) continue;

    // 嘗試從第一格解析日期
    const dateMatch = cells[0] && cells[0].match(/(\d{1,2})[\/.月](\d{1,2})/);
    if (dateMatch && targetMonth) {
      currentDate = `${targetMonth}-${String(dateMatch[2] || dateMatch[1]).padStart(2, '0')}`;
    }

    if (!currentDate) continue;

    // 嘗試識別主客隊、時間、場地
    const timeCell = cells.find(c => /\d{2}:\d{2}/.test(c));
    const time = timeCell ? timeCell.match(/(\d{2}:\d{2})/)?.[1] : '18:35';

    // 隊伍通常在連續兩格
    const teamCells = cells.filter(c => c && Object.keys(TEAM_NAMES).some(t => c.includes(t)));
    if (teamCells.length < 2) continue;

    const awayTeam = normalizeTeam(teamCells[0]);
    const homeTeam = normalizeTeam(teamCells[1]);
    const venue = normalizeVenue(cells.find(c => Object.keys(VENUE_NAMES).some(v => c.includes(v))) || '');

    // 比分解析
    const scoreCell = cells.find(c => /^\d+[-:]\d+$/.test(c.trim()));
    let homeScore = null;
    let awayScore = null;
    let status = 'scheduled';

    if (scoreCell) {
      const scoreParts = scoreCell.trim().split(/[-:]/);
      awayScore = parseInt(scoreParts[0], 10);
      homeScore = parseInt(scoreParts[1], 10);
      status = 'final';
    }

    const id = `cpbl-${currentDate.replace(/-/g, '')}-${String(++gameIndex).padStart(3, '0')}`;

    games.push({
      id,
      date: currentDate,
      time: time || '18:35',
      home_team: homeTeam,
      away_team: awayTeam,
      venue: venue || '待確認',
      status,
      home_score: homeScore,
      away_score: awayScore,
      inning: null,
      broadcast: [],
      ticket_url: null,
    });
  }

  return games;
}

/**
 * 主程式：抓取當月與下月賽程
 */
async function crawl() {
  console.log('[cpbl] 開始抓取 CPBL 賽程...');

  const now = new Date();
  const months = [
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
    `${now.getFullYear()}-${String(now.getMonth() + 2).padStart(2, '0')}`,
  ];

  const allGames = [];

  for (const month of months) {
    const [year, mon] = month.split('-');
    const url = `https://www.cpbl.com.tw/schedule?year=${year}&month=${parseInt(mon, 10)}`;
    console.log(`[cpbl] 抓取 ${month} 賽程：${url}`);

    try {
      const { statusCode, body } = await getWithRetry(url, {
        referer: 'https://www.cpbl.com.tw/',
      });

      if (statusCode !== 200) {
        throw new Error(`HTTP ${statusCode}`);
      }

      const games = parseScheduleHtml(body, month);
      console.log(`[cpbl] ${month} 解析到 ${games.length} 場比賽`);
      allGames.push(...games);
    } catch (err) {
      console.error(`[cpbl] 抓取 ${month} 失敗：${err.message}`);
      throw err;
    }
  }

  // 去除重複（依 id）
  const uniqueGames = Array.from(new Map(allGames.map(g => [g.id, g])).values());

  const output = {
    league: 'cpbl',
    sport_type: 'baseball',
    updated_at: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(' ', 'T') + '+08:00',
    games: uniqueGames,
  };

  // Schema 驗證
  const { valid, errors } = validateLeagueData(output);
  if (!valid) {
    const msg = `Schema 驗證失敗：\n${errors.join('\n')}`;
    console.error(`[cpbl] ${msg}`);
    throw new Error(msg);
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`[cpbl] 成功輸出 ${uniqueGames.length} 場比賽至 ${OUTPUT_PATH}`);
  return output;
}

// 直接執行
if (require.main === module) {
  crawl().catch(async (err) => {
    console.error('[cpbl] 爬蟲失敗：', err.message);
    await sendAlert('cpbl', '賽程爬蟲失敗', err);
    process.exit(1);
  });
}

module.exports = { crawl };
