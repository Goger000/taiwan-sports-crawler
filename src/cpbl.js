/**
 * CPBL 中華職棒爬蟲
 * API：POST https://www.cpbl.com.tw/schedule/getgamedatas
 * 需要 CSRF Token（從頁面 HTML 取得）
 * 輸出：data/cpbl.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { getWithRetry } = require('./utils/request');
const { validateLeagueData } = require('./schema');
const { sendAlert } = require('./utils/webhook');

const OUTPUT_PATH = path.join(__dirname, '../data/cpbl.json');

// 場館縮寫 → 標準名稱
const VENUE_MAP = {
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
  '大巨蛋': '台北大巨蛋',
  '台北大巨蛋': '台北大巨蛋',
};

// KindCode → 比賽類型描述
const KIND_MAP = {
  'A': '一軍例行賽',
  'C': '一軍總冠軍賽',
  'E': '一軍季後挑戰賽',
  'G': '一軍熱身賽',
  'B': '一軍明星賽',
};

function normalizeVenue(abbe) {
  if (!abbe) return '待確認';
  const trimmed = abbe.trim();
  for (const [key, value] of Object.entries(VENUE_MAP)) {
    if (trimmed.includes(key)) return value;
  }
  return trimmed;
}

/**
 * 將 CPBL PresentStatus 轉換為 Schema status
 * PresentStatus: 1=排程中（含未來與已完賽）, 2=進行中, 3=延賽, 4=取消
 * 注意：PresentStatus===1 對所有場次（含未來）都回傳 1，
 *       必須額外檢查分數來判斷是否真的完賽（棒球不可能以 0:0 正常結束）
 */
function toStatus(presentStatus, homeScore, visitingScore) {
  if (presentStatus === 3) return 'postponed';
  if (presentStatus === 4) return 'cancelled';
  if (presentStatus === 2) return 'live';
  if (presentStatus === 1) {
    const hs = Number(homeScore) || 0;
    const vs = Number(visitingScore) || 0;
    if (hs > 0 || vs > 0) return 'final';
    return 'scheduled'; // 0:0 代表尚未開賽
  }
  return 'scheduled';
}

/**
 * POST 請求到 CPBL API（帶 CSRF Token）
 */
function postCPBL(path, postData, token, cookie) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(postData).toString();
    const req = https.request({
      hostname: 'www.cpbl.com.tw',
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'RequestVerificationToken': token,
        'Cookie': cookie,
        'Referer': 'https://www.cpbl.com.tw/schedule',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*',
      },
    }, (res) => {
      const enc = res.headers['content-encoding'];
      let stream = res;
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 從頁面取得 CSRF token 和 Cookie
 */
async function getTokenAndCookie(year) {
  const page = await getWithRetry(
    `https://www.cpbl.com.tw/schedule?year=${year}&month=4`,
    { referer: 'https://www.cpbl.com.tw/' }
  );
  // Vue.js AJAX 使用 TOKEN1:TOKEN2 格式的 token（來自 script 區塊）
  // 一般表單 hidden input 的 token 格式不同，無法用於 AJAX API
  const jsTokenMatch = page.body.match(/RequestVerificationToken:\s*'([A-Za-z0-9_\-]+:[A-Za-z0-9_\-]+)'/);
  const inputMatch = page.body.match(/name="__RequestVerificationToken" type="hidden" value="([^"]+)"/);
  const token = (jsTokenMatch && jsTokenMatch[1]) || (inputMatch && inputMatch[1]) || '';
  const cookie = (page.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  if (!token) throw new Error('無法取得 CSRF Token，CPBL 頁面結構可能已變更');
  return { token, cookie };
}

/**
 * 主程式
 */
async function crawl() {
  console.log('[cpbl] 開始抓取 CPBL 賽程...');

  const now = new Date();
  const year = now.getFullYear();

  // 取得 CSRF Token
  console.log('[cpbl] 取得 CSRF Token...');
  const { token, cookie } = await getTokenAndCookie(year);
  console.log('[cpbl] Token 取得成功');

  // 抓取一軍例行賽（KindCode=A）
  console.log(`[cpbl] 抓取 ${year} 年賽程...`);
  const resp = await postCPBL(
    '/schedule/getgamedatas',
    { kindCode: 'A', year: String(year) },
    token,
    cookie
  );

  if (resp.statusCode !== 200) {
    throw new Error(`API 回傳 HTTP ${resp.statusCode}`);
  }

  let result;
  try {
    result = JSON.parse(resp.body);
  } catch (e) {
    throw new Error(`API 回傳非 JSON：${resp.body.slice(0, 200)}`);
  }

  if (!result.Success) {
    throw new Error(`API 回傳失敗：${JSON.stringify(result)}`);
  }

  const rawGames = JSON.parse(result.GameDatas);
  console.log(`[cpbl] 原始資料：${rawGames.length} 場`);

  // 轉換為 Schema 格式
  const games = rawGames
    .filter(g => ['A', 'C', 'E'].includes(g.KindCode)) // 只留一軍正規賽事
    .map((g, i) => {
      const dateStr = g.GameDate.slice(0, 10); // "2026-03-28T00:00:00" → "2026-03-28"
      const timeStr = g.GameDateTimeS
        ? g.GameDateTimeS.slice(11, 16)          // "2026-03-28T17:06:00" → "17:06"
        : '18:35';

      return {
        id: `cpbl-${dateStr.replace(/-/g, '')}-${String(g.GameSno).padStart(3, '0')}`,
        date: dateStr,
        time: timeStr,
        home_team: g.HomeTeamName || '待確認',
        away_team: g.VisitingTeamName || '待確認',
        venue: normalizeVenue(g.FieldAbbe),
        status: toStatus(g.PresentStatus, g.HomeScore, g.VisitingScore),
        home_score: toStatus(g.PresentStatus, g.HomeScore, g.VisitingScore) === 'final' ? Number(g.HomeScore) : null,
        away_score: toStatus(g.PresentStatus, g.HomeScore, g.VisitingScore) === 'final' ? Number(g.VisitingScore) : null,
        inning: null,
        broadcast: [],
        ticket_url: null,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  console.log(`[cpbl] 轉換後：${games.length} 場`);

  const output = {
    league: 'cpbl',
    sport_type: 'baseball',
    updated_at: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(' ', 'T') + '+08:00',
    games,
  };

  const { valid, errors } = validateLeagueData(output);
  if (!valid) throw new Error(`Schema 驗證失敗：\n${errors.join('\n')}`);

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`[cpbl] ✅ 成功輸出 ${games.length} 場至 ${OUTPUT_PATH}`);
  return output;
}

if (require.main === module) {
  crawl().catch(async (err) => {
    console.error('[cpbl] 爬蟲失敗：', err.message);
    await sendAlert('cpbl', '賽程爬蟲失敗', err);
    process.exit(1);
  });
}

module.exports = { crawl };
