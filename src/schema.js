/**
 * JSON Schema 定義與驗證
 * 所有爬蟲輸出必須符合此結構，前端以此為讀取合約
 */

/** @typedef {'scheduled'|'live'|'final'|'postponed'|'cancelled'} GameStatus */

/**
 * 單場比賽資料結構
 * @typedef {Object} Game
 * @property {string}      id           - 唯一識別碼，格式：{league}-{YYYYMMDD}-{序號}
 * @property {string}      date         - 比賽日期 YYYY-MM-DD
 * @property {string}      time         - 開賽時間 HH:mm（台灣時間）
 * @property {string}      home_team    - 主隊名稱
 * @property {string}      away_team    - 客隊名稱
 * @property {string}      venue        - 場館名稱
 * @property {GameStatus}  status       - 比賽狀態
 * @property {number|null} home_score   - 主隊得分（未開賽為 null）
 * @property {number|null} away_score   - 客隊得分（未開賽為 null）
 * @property {string|null} inning       - 棒球局數 / 籃球節數（未開賽為 null）
 * @property {string[]}    broadcast    - 轉播頻道清單
 * @property {string|null} ticket_url   - 購票連結
 */

/**
 * 聯賽資料輸出根結構
 * @typedef {Object} LeagueData
 * @property {string} league      - 聯賽識別碼：cpbl | tpbl | plg
 * @property {string} sport_type  - 運動類型：baseball | basketball | volleyball
 * @property {string} updated_at  - 最後更新時間 ISO 8601（台灣時間 +08:00）
 * @property {Game[]} games       - 比賽清單
 */

const VALID_LEAGUES = ['cpbl', 'tpbl', 'plg'];
const VALID_SPORT_TYPES = ['baseball', 'basketball', 'volleyball'];
const VALID_STATUSES = ['scheduled', 'live', 'final', 'postponed', 'cancelled'];

/**
 * 驗證單一 Game 物件
 * @param {Game} game
 * @param {number} index
 * @returns {string[]} 錯誤訊息陣列，空陣列表示驗證通過
 */
function validateGame(game, index) {
  const errors = [];
  const prefix = `games[${index}]`;

  if (!game.id || typeof game.id !== 'string') errors.push(`${prefix}.id 必須為非空字串`);
  if (!game.date || !/^\d{4}-\d{2}-\d{2}$/.test(game.date)) errors.push(`${prefix}.date 格式必須為 YYYY-MM-DD`);
  if (!game.time || !/^\d{2}:\d{2}$/.test(game.time)) errors.push(`${prefix}.time 格式必須為 HH:mm`);
  if (!game.home_team || typeof game.home_team !== 'string') errors.push(`${prefix}.home_team 必須為非空字串`);
  if (!game.away_team || typeof game.away_team !== 'string') errors.push(`${prefix}.away_team 必須為非空字串`);
  if (!game.venue || typeof game.venue !== 'string') errors.push(`${prefix}.venue 必須為非空字串`);
  if (!VALID_STATUSES.includes(game.status)) errors.push(`${prefix}.status 必須為 ${VALID_STATUSES.join('|')}`);
  if (game.home_score !== null && typeof game.home_score !== 'number') errors.push(`${prefix}.home_score 必須為數字或 null`);
  if (game.away_score !== null && typeof game.away_score !== 'number') errors.push(`${prefix}.away_score 必須為數字或 null`);
  if (!Array.isArray(game.broadcast)) errors.push(`${prefix}.broadcast 必須為陣列`);

  return errors;
}

/**
 * 驗證完整的 LeagueData 物件
 * @param {LeagueData} data
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateLeagueData(data) {
  const errors = [];

  if (!VALID_LEAGUES.includes(data.league)) {
    errors.push(`league 必須為 ${VALID_LEAGUES.join('|')}，收到：${data.league}`);
  }
  if (!VALID_SPORT_TYPES.includes(data.sport_type)) {
    errors.push(`sport_type 必須為 ${VALID_SPORT_TYPES.join('|')}，收到：${data.sport_type}`);
  }
  if (!data.updated_at || isNaN(Date.parse(data.updated_at))) {
    errors.push(`updated_at 必須為合法 ISO 8601 日期字串`);
  }
  if (!Array.isArray(data.games)) {
    errors.push(`games 必須為陣列`);
  } else {
    data.games.forEach((game, i) => errors.push(...validateGame(game, i)));
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validateLeagueData, VALID_LEAGUES, VALID_STATUSES };
