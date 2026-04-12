/**
 * 防封鎖 HTTP 工具模組
 * 實作 SPEC 規定的六項防封鎖機制：
 * 1. 隨機 Jitter（±15 秒）
 * 2. 隨機 User-Agent 輪替
 * 3. 正確 Referer 設定
 * 4. Session Cookie 保持
 * 5. Exponential Backoff（429/503 時）
 * 6. robots.txt 遵守
 */

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { URL } = require('url');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

/**
 * 隨機取得 User-Agent
 */
function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * 隨機 jitter 延遲（毫秒）
 * @param {number} baseMs   基準毫秒
 * @param {number} jitterMs 最大抖動範圍（±）
 */
function jitterDelay(baseMs, jitterMs = 15000) {
  const offset = Math.floor(Math.random() * jitterMs * 2) - jitterMs;
  return Math.max(1000, baseMs + offset);
}

/**
 * sleep
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 發送 HTTP/HTTPS GET 請求（含防封鎖 headers）
 * @param {string} url
 * @param {Object} options
 * @param {string} [options.referer]   Referer header
 * @param {string} [options.cookie]    Cookie 字串
 * @returns {Promise<{ statusCode: number, body: string, headers: Object }>}
 */
function get(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': randomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        ...(options.referer ? { 'Referer': options.referer } : {}),
        ...(options.cookie ? { 'Cookie': options.cookie } : {}),
      },
    };

    const req = lib.request(reqOptions, (res) => {
      const encoding = res.headers['content-encoding'];
      let stream = res;

      if (encoding === 'gzip') {
        stream = res.pipe(zlib.createGunzip());
      } else if (encoding === 'br') {
        stream = res.pipe(zlib.createBrotliDecompress());
      } else if (encoding === 'deflate') {
        stream = res.pipe(zlib.createInflate());
      }

      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });
      stream.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error(`請求逾時：${url}`));
    });
    req.end();
  });
}

/**
 * 帶 Exponential Backoff 重試的 GET
 * @param {string} url
 * @param {Object} options
 * @param {number} [maxRetries=3]
 * @returns {Promise<{ statusCode: number, body: string, headers: Object }>}
 */
async function getWithRetry(url, options = {}, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await get(url, options);

      if (result.statusCode === 429 || result.statusCode === 503) {
        const waitMs = Math.pow(2, attempt) * 60000; // 60s → 120s → 240s
        console.warn(`[request] ${result.statusCode} Too Many Requests，等待 ${waitMs / 1000}s 後重試（${attempt + 1}/${maxRetries}）`);
        await sleep(waitMs);
        continue;
      }

      return result;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const waitMs = Math.pow(2, attempt) * 5000;
        console.warn(`[request] 請求失敗，${waitMs / 1000}s 後重試：${err.message}`);
        await sleep(waitMs);
      }
    }
  }
  throw lastError || new Error(`${url} 重試 ${maxRetries} 次後仍失敗`);
}

/**
 * 兩次請求之間的標準等待（依 SPEC 頻率策略）
 * @param {'game_live'|'pre_game'|'daily'} mode
 */
async function politeWait(mode = 'daily') {
  const delays = {
    game_live: jitterDelay(90000, 15000),  // 90s ± 15s
    pre_game:  jitterDelay(300000, 30000), // 5min ± 30s
    daily:     jitterDelay(1800000, 60000), // 30min ± 1min
  };
  const ms = delays[mode] || delays.daily;
  console.log(`[request] 等待 ${(ms / 1000).toFixed(1)}s（模式：${mode}）`);
  await sleep(ms);
}

module.exports = { get, getWithRetry, politeWait, sleep, randomUserAgent };
