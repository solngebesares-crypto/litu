const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.WECHAT_PORT || process.env.PORT || 8787);
// Loopback by default. Set HOST=0.0.0.0 only behind an HTTPS reverse proxy:
// every page and API below then requires a valid invite session.
const HOST = process.env.HOST || '127.0.0.1';
const INVITE_FILE = process.env.INVITE_FILE || path.join(__dirname, 'invite-codes.json');
const SECRET_FILE = path.join(__dirname, '.invite-secret');
// Activated devices stay signed in for a year; the code itself can expire sooner.
const SESSION_DAYS = Number(process.env.INVITE_SESSION_DAYS || 365);
const DEVICE_COOKIE = 'phk_device';
const SESSION_COOKIE = 'phk_session';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_BODY = 8 * 1024 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const state = { appId: '', appSecret: '', token: '', tokenExpiresAt: 0 };
const fallbackImage = path.join(__dirname, 'aurora-cover.png');

/* ------------------------------------------------------------------ */
/* Invite codes                                                        */
/* ------------------------------------------------------------------ */

function loadInvites() {
  try {
    const data = JSON.parse(fs.readFileSync(INVITE_FILE, 'utf8'));
    return Array.isArray(data.codes) ? data : { codes: [] };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`无法读取 ${INVITE_FILE}：${error.message}`);
    return { codes: [] };
  }
}

function saveInvites(data) {
  const tmp = `${INVITE_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, INVITE_FILE);
}

function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function formatCode(raw) {
  return raw.replace(/(.{4})(?=.)/g, '$1-');
}

function generateCode() {
  let raw = '';
  for (let i = 0; i < 8; i++) raw += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return formatCode(raw);
}

function findInvite(data, code) {
  const wanted = normalizeCode(code);
  return wanted ? data.codes.find(item => normalizeCode(item.code) === wanted) : null;
}

// Returns null when the code may be used, otherwise the reason it may not.
function inviteProblem(invite, { forNewLogin } = {}) {
  if (!invite) return '邀请码无效，请检查后重新输入';
  if (invite.disabled) return '该邀请码已停用';
  if (invite.expiresAt && Date.now() > Date.parse(invite.expiresAt)) return '该邀请码已过期';
  if (forNewLogin && invite.maxUses > 0 && invite.uses >= invite.maxUses) return '该邀请码的使用次数已用完';
  return null;
}

function sessionSecret() {
  if (process.env.INVITE_SECRET) return process.env.INVITE_SECRET;
  try { return fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (error) { /* first run */ }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}
const SESSION_SECRET = sessionSecret();

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

/*
 * Device binding: an invite code is bound to the first device (browser) that
 * activates it, up to invite.maxDevices (default 1). Each browser carries a
 * random, long-lived device id; a code already bound elsewhere is refused, so
 * a code passed on to someone else does not work for them. The same device can
 * always log in again, and `invite unbind` frees a code for a new device.
 */
const maxDevicesOf = invite => Math.max(1, Number(invite.maxDevices) || 1);
const boundDevices = invite => (Array.isArray(invite.devices) ? invite.devices : []);

function deviceIdFrom(req) {
  const id = parseCookies(req)[DEVICE_COOKIE];
  return /^[a-f0-9]{32}$/.test(id || '') ? id : null;
}

/*
 * One live login per device: every token carries the device's current session
 * key, which is rotated about every 10 minutes and on every login. If the
 * login is copied to another browser, whichever side refreshes first keeps
 * working and the other is signed out on its next request ("kicked"). The
 * previous key stays valid for 2 minutes so tabs racing the rotation in the
 * same browser are not signed out.
 */
const ROTATE_AFTER_MS = Number(process.env.INVITE_ROTATE_SECONDS || 600) * 1000;
const PREVIOUS_KEY_GRACE_MS = Number(process.env.INVITE_ROTATE_GRACE_SECONDS || 120) * 1000;

function createSessionToken(code, deviceId, key) {
  const payload = Buffer.from(JSON.stringify({ c: normalizeCode(code), d: deviceId, k: key, i: Date.now(), e: Date.now() + SESSION_DAYS * 86400e3 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => part.trim().split('=')).filter(([key]) => key).map(([key, ...rest]) => [key, decodeURIComponent(rest.join('='))]));
}

// A session is valid while its signature checks out, it has not expired and
// its invite code is still usable, so disabling a code signs its users out.
function currentSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = sign(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  let session;
  try { session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (error) { return null; }
  if (!session || Date.now() > session.e) return null;
  const data = loadInvites();
  const invite = findInvite(data, session.c);
  if (inviteProblem(invite)) return null;
  // Unbinding a device (or an old pre-binding session) signs that device out.
  const device = session.d && boundDevices(invite).find(item => item.id === session.d);
  if (!device) return null;
  const now = Date.now();
  const current = Boolean(device.sessionKey) && session.k === device.sessionKey;
  const previous = Boolean(device.previousKey) && session.k === device.previousKey && now < (device.previousValidUntil || 0);
  // Devices activated before keys existed get one on their next request.
  const migrating = !device.sessionKey && !session.k;
  if (!current && !previous && !migrating) return { kicked: true };
  let cookie = null;
  if (migrating || (current && now - (session.i || 0) > ROTATE_AFTER_MS)) {
    device.previousKey = device.sessionKey || null;
    device.previousValidUntil = now + PREVIOUS_KEY_GRACE_MS;
    device.sessionKey = crypto.randomBytes(16).toString('hex');
    device.lastSeenAt = new Date(now).toISOString();
    saveInvites(data);
    cookie = sessionCookie(req, createSessionToken(invite.code, device.id, device.sessionKey), SESSION_DAYS * 86400);
  }
  return { code: invite.code, expiresAt: new Date(session.e).toISOString(), cookie };
}

function sessionCookie(req, value, maxAgeSeconds, name = SESSION_COOKIE) {
  const secure = process.env.COOKIE_SECURE === '1' || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

// Brute-force protection: at most 10 failed attempts per client per 15 minutes.
const failedLogins = new Map();
// X-Forwarded-* headers can be forged by any client, so they are only trusted
// when TRUST_PROXY=1 (behind nginx etc.); the proxy appends the real client
// address as the last X-Forwarded-For entry.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
function clientKey(req) {
  const forwarded = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',').map(part => part.trim()).filter(Boolean).pop() : '';
  return forwarded || req.socket.remoteAddress || '';
}
function loginBlocked(req, scope = 'invite') {
  const entry = failedLogins.get(`${scope}:${clientKey(req)}`);
  return Boolean(entry && entry.count >= 10 && Date.now() - entry.since < 15 * 60e3);
}
function recordFailedLogin(req, scope = 'invite') {
  const key = `${scope}:${clientKey(req)}`;
  const entry = failedLogins.get(key);
  if (!entry || Date.now() - entry.since >= 15 * 60e3) failedLogins.set(key, { count: 1, since: Date.now() });
  else entry.count += 1;
}

function sendFile(res, file, status = 200) {
  fs.readFile(path.join(__dirname, file), (error, content) => {
    if (error) return json(res, 404, { ok: false, error: 'Not found' });
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
    res.end(content);
  });
}

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

/* ------------------------------------------------------------------ */
/* Article images                                                      */
/* ------------------------------------------------------------------ */
// Images are stored on this server and served from public, unguessable URLs.
// When an article is pasted into the WeChat editor, WeChat fetches these URLs
// and re-hosts the images itself, so users never need WeChat API credentials.
// Uploading needs an invite session; reading does not (WeChat must fetch them).
const IMAGE_TYPES = [
  { ext: 'jpg', type: 'image/jpeg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', type: 'image/png', test: b => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'gif', type: 'image/gif', test: b => b.slice(0, 4).toString('latin1') === 'GIF8' },
  { ext: 'webp', type: 'image/webp', test: b => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' }
];

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`图片超过 ${Math.round(limit / 1024 / 1024)}MB 限制`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function saveUploadedImage(req) {
  const buffer = await readBody(req, MAX_IMAGE);
  // Detect the type from the file's own bytes, never from the client's header;
  // SVG and anything else are refused because they could carry scripts.
  const kind = IMAGE_TYPES.find(item => buffer.length > 12 && item.test(buffer));
  if (!kind) throw new Error('只支持 JPG、PNG、GIF、WEBP 图片');
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const name = `${crypto.randomBytes(16).toString('hex')}.${kind.ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);
  return `/uploads/${name}`;
}

function sendUploadedImage(res, name) {
  if (!/^[a-f0-9]{32}\.(?:jpg|png|gif|webp)$/.test(name)) return json(res, 404, { ok: false, error: 'Not found' });
  const kind = IMAGE_TYPES.find(item => name.endsWith(`.${item.ext}`));
  fs.readFile(path.join(UPLOAD_DIR, name), (error, content) => {
    if (error) return json(res, 404, { ok: false, error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': kind.type,
      'Content-Length': content.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(content);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY) {
        reject(new Error('请求内容超过 8MB 限制'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (error) { reject(new Error('请求不是有效 JSON')); }
    });
    req.on('error', reject);
  });
}

function requestJson(method, urlString, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = https.request({
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...headers }
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data || '{}')); } catch (error) { reject(new Error(`微信接口返回了非 JSON 内容 (${res.statusCode})`)); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestBuffer(urlString) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const req = https.get({ hostname: url.hostname, path: `${url.pathname}${url.search}` }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`图片下载失败 (${res.statusCode})`));
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) req.destroy(new Error('图片超过 8MB 限制'));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || 'image/jpeg' }));
    });
    req.on('error', reject);
  });
}

function toImageBuffer(src) {
  if (typeof src !== 'string') return null;
  const match = src.match(/^data:(image\/[\w.+-]+);base64,(.+)$/s);
  if (!match) return null;
  return { buffer: Buffer.from(match[2], 'base64'), contentType: match[1] };
}

function resolveLocalImage(src) {
  if (typeof src !== 'string') return null;
  const filename = src.split(/[?#]/)[0].split('/').pop();
  if (!filename || !/\.(png|jpe?g|gif|webp)$/i.test(filename)) return null;
  const candidate = path.join(__dirname, filename);
  if (!fs.existsSync(candidate)) return null;
  const ext = path.extname(candidate).toLowerCase();
  const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
  return { buffer: fs.readFileSync(candidate), contentType };
}

function normalizeImage(src, image) {
  const isLegacyPlaceholder = /stitch-placeholder(?:-|\.)/i.test(String(src || ''));
  const isSvg = /^image\/svg\+xml$/i.test(String(image?.contentType || '')) || /\.svg(?:[?#]|$)/i.test(String(src || ''));
  if (isLegacyPlaceholder && fs.existsSync(fallbackImage)) {
    return { buffer: fs.readFileSync(fallbackImage), contentType: 'image/png' };
  }
  if (isSvg) throw new Error('公众号不支持 SVG 图片，请在编辑器中替换为 JPG 或 PNG 图片');
  return image;
}

function multipart(fieldName, filename, file, contentType) {
  const boundary = `----paiban-${Date.now().toString(16)}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, file, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

function uploadMedia(token, file, contentType, permanent) {
  if (!/^image\/(jpeg|jpg|png|gif|webp)$/i.test(contentType)) {
    return Promise.reject(new Error('公众号只接受 JPG、PNG、GIF 或 WEBP 图片，请替换文章中的占位图'));
  }
  return new Promise((resolve, reject) => {
    const url = new URL(`https://api.weixin.qq.com/cgi-bin/${permanent ? 'material/add_material' : 'media/uploadimg'}?access_token=${encodeURIComponent(token)}${permanent ? '&type=image' : ''}`);
    const form = multipart('media', permanent ? 'cover.jpg' : 'article.jpg', file, contentType);
    const req = https.request({ hostname: url.hostname, path: `${url.pathname}${url.search}`, method: 'POST', headers: { 'Content-Type': form.contentType, 'Content-Length': form.body.length } }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data || '{}');
          if (result.errcode) reject(new Error(`${result.errcode}: ${result.errmsg}`));
          else resolve(result);
        } catch (error) { reject(new Error('图片上传接口返回了非 JSON 内容')); }
      });
    });
    req.on('error', reject);
    req.end(form.body);
  });
}

async function getAccessToken() {
  if (!state.appId || !state.appSecret) throw new Error('请先配置 AppID 和 AppSecret');
  if (state.token && Date.now() < state.tokenExpiresAt) return state.token;
  const result = await requestJson('GET', `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(state.appId)}&secret=${encodeURIComponent(state.appSecret)}`);
  if (result.errcode) throw new Error(`${result.errcode}: ${result.errmsg}`);
  state.token = result.access_token;
  state.tokenExpiresAt = Date.now() + Math.max(60, result.expires_in - 300) * 1000;
  return state.token;
}

async function replaceImages(html, token, coverSrc) {
  const sources = [...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map(match => match[1]);
  const unique = [...new Set(sources)];
  if (!unique.length) throw new Error('请先在文章中插入至少一张图片，第一张图片将作为公众号封面');
  const replacements = new Map();
  for (const src of unique) {
    let image = toImageBuffer(src) || resolveLocalImage(src);
    if (!image && /^https?:\/\//i.test(src)) image = await requestBuffer(src);
    if (!image) throw new Error('发现无法上传的图片地址，请重新上传本地图片后再推送');
    image = normalizeImage(src, image);
    const uploaded = await uploadMedia(token, image.buffer, image.contentType, false);
    if (!uploaded.url) throw new Error('微信没有返回正文图片地址');
    replacements.set(src, uploaded.url);
  }
  let content = html;
  replacements.forEach((url, src) => { content = content.split(src).join(url); });
  const coverSource = coverSrc || unique[0];
  let cover = toImageBuffer(coverSource) || resolveLocalImage(coverSource);
  if (!cover && /^https?:\/\//i.test(coverSource)) cover = await requestBuffer(coverSource);
  if (!cover) throw new Error('封面图片无法上传，请重新上传本地图片');
  cover = normalizeImage(coverSource, cover);
  const coverResult = await uploadMedia(token, cover.buffer, cover.contentType, true);
  if (!coverResult.media_id) throw new Error('微信没有返回封面素材 ID');
  return { content, thumbMediaId: coverResult.media_id };
}

async function createDraft(payload) {
  const token = await getAccessToken();
  const prepared = await replaceImages(payload.content || '', token, payload.coverSrc);
  const result = await requestJson('POST', `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${encodeURIComponent(token)}`, {
    articles: [{
      title: String(payload.title || '未命名文章').slice(0, 64),
      author: String(payload.author || '').slice(0, 16),
      digest: String(payload.digest || '').slice(0, 120),
      content: prepared.content,
      thumb_media_id: prepared.thumbMediaId,
      need_open_comment: 0,
      only_fans_can_comment: 0
    }]
  });
  if (result.errcode) throw new Error(`${result.errcode}: ${result.errmsg}`);
  return result;
}

/* ------------------------------------------------------------------ */
/* Admin console (/admin): invite codes and usage                      */
/* ------------------------------------------------------------------ */
// The admin password is stored as a scrypt hash in admin.json. Admin sessions
// are signed cookies tied to that hash, so changing the password signs every
// admin out. Admin writes require a same-origin JSON request.
const ADMIN_FILE = process.env.ADMIN_FILE || path.join(__dirname, 'admin.json');
const ADMIN_COOKIE = 'phk_admin';
const ADMIN_SESSION_DAYS = 7;

function loadAdmin() {
  try { return JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8')); } catch (error) { return null; }
}

function setAdminPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  fs.writeFileSync(ADMIN_FILE, `${JSON.stringify({ salt, hash, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
}

function checkAdminPassword(password) {
  const admin = loadAdmin();
  if (!admin || !password) return false;
  const actual = crypto.scryptSync(String(password), admin.salt, 64);
  const expected = Buffer.from(admin.hash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function adminToken() {
  const admin = loadAdmin();
  const payload = Buffer.from(JSON.stringify({ v: admin.hash.slice(0, 16), e: Date.now() + ADMIN_SESSION_DAYS * 86400e3 })).toString('base64url');
  return `${payload}.${sign(`admin.${payload}`)}`;
}

function isAdmin(req) {
  const token = parseCookies(req)[ADMIN_COOKIE];
  const admin = loadAdmin();
  if (!admin || !token || !token.includes('.')) return false;
  const [payload, signature] = token.split('.');
  const expected = sign(`admin.${payload}`);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return session.v === admin.hash.slice(0, 16) && Date.now() < session.e;
  } catch (error) { return false; }
}

function adminCookie(req, value, maxAgeSeconds) {
  const secure = process.env.COOKIE_SECURE === '1' || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
  return `${ADMIN_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

// Blocks cross-site requests: admin writes must be JSON from this same site.
function sameOriginJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch (error) { return false; }
}

function inviteStatus(invite) {
  if (invite.disabled) return 'disabled';
  if (invite.expiresAt && Date.now() > Date.parse(invite.expiresAt)) return 'expired';
  return boundDevices(invite).length ? 'active' : 'unused';
}

function deviceLabel(userAgent) {
  const ua = String(userAgent || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '未知系统';
  const browser = /MicroMessenger/.test(ua) ? '微信' : /Edg\//.test(ua) ? 'Edge' : /QQBrowser/.test(ua) ? 'QQ浏览器' : /UCBrowser/.test(ua) ? 'UC' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '浏览器';
  return `${os} · ${browser}`;
}

function adminInviteView(invite) {
  const devices = boundDevices(invite).map(device => ({
    boundAt: device.boundAt,
    lastActiveAt: [device.lastSeenAt, device.lastLoginAt, device.boundAt].filter(Boolean).sort().pop(),
    device: deviceLabel(device.userAgent)
  }));
  return {
    code: invite.code,
    note: invite.note || '',
    status: inviteStatus(invite),
    maxDevices: maxDevicesOf(invite),
    devices,
    lastActiveAt: devices.map(device => device.lastActiveAt).sort().pop() || null,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt || null
  };
}

function adminSummary(data) {
  const invites = data.codes.map(adminInviteView);
  const since = days => new Date(Date.now() - days * 86400e3).toISOString();
  const count = test => invites.filter(test).length;
  let imageCount = 0;
  let imageBytes = 0;
  try {
    for (const name of fs.readdirSync(UPLOAD_DIR)) {
      imageCount += 1;
      imageBytes += fs.statSync(path.join(UPLOAD_DIR, name)).size;
    }
  } catch (error) { /* no uploads yet */ }
  return {
    total: invites.length,
    activated: count(item => item.devices.length > 0),
    activeToday: count(item => item.lastActiveAt && item.lastActiveAt >= since(1)),
    active7d: count(item => item.lastActiveAt && item.lastActiveAt >= since(7)),
    unused: count(item => item.status === 'unused'),
    inactive: count(item => item.status === 'disabled' || item.status === 'expired'),
    imageCount,
    imageBytes
  };
}

function createInvites(data, { count, maxDevices, days, note }) {
  const created = [];
  while (created.length < count) {
    const code = generateCode();
    if (findInvite(data, code)) continue;
    const invite = { code, note, maxDevices, devices: [], maxUses: 0, uses: 0, createdAt: new Date().toISOString(), expiresAt: days > 0 ? new Date(Date.now() + days * 86400e3).toISOString() : null, disabled: false };
    data.codes.push(invite);
    created.push(invite);
  }
  return created;
}

async function handleAdmin(req, res, pathname) {
  if (req.method === 'GET' && (pathname === '/admin' || pathname === '/admin/')) return sendFile(res, 'admin.html');
  if (!pathname.startsWith('/api/admin/')) return false;
  if (req.method === 'POST' && !sameOriginJson(req)) return json(res, 403, { ok: false, error: '请求被拒绝' });

  if (req.method === 'POST' && pathname === '/api/admin/login') {
    if (loginBlocked(req, 'admin')) return json(res, 429, { ok: false, error: '尝试次数过多，请 15 分钟后再试' });
    if (!loadAdmin()) return json(res, 400, { ok: false, error: '还没有设置后台密码，请在服务器上运行 node server.js admin password' });
    const payload = await readJson(req);
    if (!checkAdminPassword(payload.password)) {
      recordFailedLogin(req, 'admin');
      return json(res, 401, { ok: false, error: '密码不正确' });
    }
    failedLogins.delete(`admin:${clientKey(req)}`);
    return json(res, 200, { ok: true }, { 'Set-Cookie': adminCookie(req, adminToken(), ADMIN_SESSION_DAYS * 86400) });
  }
  if (req.method === 'POST' && pathname === '/api/admin/logout') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': adminCookie(req, '', 0) });
  }
  if (!isAdmin(req)) return json(res, 401, { ok: false, error: '请先登录后台' });

  if (req.method === 'GET' && pathname === '/api/admin/overview') {
    const data = loadInvites();
    const invites = data.codes.map(adminInviteView).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return json(res, 200, { ok: true, summary: adminSummary(data), invites });
  }
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: '不支持的请求' });

  if (pathname === '/api/admin/invites') {
    const payload = await readJson(req);
    const count = Math.max(1, Math.min(200, Math.floor(Number(payload.count) || 1)));
    const maxDevices = Math.max(1, Math.min(20, Math.floor(Number(payload.devices) || 1)));
    const days = Math.max(0, Math.min(3650, Math.floor(Number(payload.days) || 0)));
    const note = String(payload.note || '').trim().slice(0, 60);
    const data = loadInvites();
    const created = createInvites(data, { count, maxDevices, days, note });
    saveInvites(data);
    return json(res, 200, { ok: true, codes: created.map(invite => invite.code) });
  }
  const action = pathname.match(/^\/api\/admin\/invites\/([A-Za-z0-9-]{4,20})\/(unbind|disable|enable|delete|note)$/);
  if (action) {
    const data = loadInvites();
    const invite = findInvite(data, action[1]);
    if (!invite) return json(res, 404, { ok: false, error: '找不到这个邀请码' });
    const kind = action[2];
    if (kind === 'unbind') invite.devices = [];
    else if (kind === 'disable') invite.disabled = true;
    else if (kind === 'enable') invite.disabled = false;
    else if (kind === 'delete') data.codes.splice(data.codes.indexOf(invite), 1);
    else if (kind === 'note') invite.note = String((await readJson(req)).note || '').trim().slice(0, 60);
    saveInvites(data);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { ok: false, error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  try {
    if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && pathname.startsWith('/uploads/')) return sendUploadedImage(res, pathname.slice('/uploads/'.length));
    if (pathname === '/admin' || pathname === '/admin/' || pathname.startsWith('/api/admin/')) {
      const handled = await handleAdmin(req, res, pathname);
      if (handled !== false) return handled;
    }

    if (req.method === 'POST' && pathname === '/api/invite/login') {
      if (loginBlocked(req)) return json(res, 429, { ok: false, error: '尝试次数过多，请 15 分钟后再试' });
      const payload = await readJson(req);
      const data = loadInvites();
      const invite = findInvite(data, payload.code);
      const problem = inviteProblem(invite, { forNewLogin: true });
      if (problem) {
        recordFailedLogin(req);
        return json(res, 401, { ok: false, error: problem });
      }
      const deviceId = deviceIdFrom(req) || crypto.randomBytes(16).toString('hex');
      const devices = boundDevices(invite);
      const now = new Date().toISOString();
      const known = devices.find(device => device.id === deviceId);
      const sessionKey = crypto.randomBytes(16).toString('hex');
      if (known) {
        // Logging in again on this device signs out any copy of its old login.
        known.lastLoginAt = now;
        known.sessionKey = sessionKey;
        known.previousKey = null;
      } else if (devices.length >= maxDevicesOf(invite)) {
        const limit = maxDevicesOf(invite);
        return json(res, 403, { ok: false, error: `该邀请码已在${limit > 1 ? ` ${limit} 台` : '另一台'}设备上激活，不能在这台设备上使用。如需更换设备，请联系卖家解绑。` });
      } else {
        devices.push({ id: deviceId, boundAt: now, lastLoginAt: now, sessionKey, userAgent: String(req.headers['user-agent'] || '').slice(0, 160) });
        invite.devices = devices;
      }
      invite.uses = (invite.uses || 0) + 1;
      invite.lastUsedAt = now;
      saveInvites(data);
      failedLogins.delete(`invite:${clientKey(req)}`);
      return json(res, 200, { ok: true }, { 'Set-Cookie': [
        sessionCookie(req, createSessionToken(invite.code, deviceId, sessionKey), SESSION_DAYS * 86400),
        sessionCookie(req, deviceId, 5 * 365 * 86400, DEVICE_COOKIE)
      ] });
    }
    if (req.method === 'POST' && pathname === '/api/invite/logout') {
      return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
    }

    const checked = currentSession(req);
    const kicked = Boolean(checked?.kicked);
    const session = checked && !kicked ? checked : null;
    if (session?.cookie) res.setHeader('Set-Cookie', session.cookie);
    const signedOut = kicked
      ? { ok: false, reason: 'kicked', error: '该邀请码已在其他地方登录，本设备已下线' }
      : { ok: false, error: '请先输入邀请码' };
    if (req.method === 'GET' && pathname === '/api/invite/session') {
      return session ? json(res, 200, { ok: true, code: session.code, expiresAt: session.expiresAt }) : json(res, 401, signedOut);
    }

    // Pages: the editor is only ever sent to holders of a valid invite session.
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      if (kicked) { res.writeHead(302, { Location: '/login?kicked=1' }); return res.end(); }
      return session ? sendFile(res, 'index.html') : sendFile(res, 'login.html', 401);
    }
    if (req.method === 'GET' && pathname === '/login') {
      if (session) { res.writeHead(302, { Location: '/' }); return res.end(); }
      return sendFile(res, 'login.html');
    }

    if (pathname.startsWith('/api/') && !session) return json(res, 401, signedOut);

    if (req.method === 'POST' && pathname === '/api/images') {
      const url = await saveUploadedImage(req);
      return json(res, 200, { ok: true, url });
    }

    if (req.method === 'POST' && pathname === '/api/wechat/config') {
      const payload = await readJson(req);
      if (!payload.appId || !payload.appSecret) return json(res, 400, { ok: false, error: 'AppID 和 AppSecret 不能为空' });
      state.appId = String(payload.appId).trim();
      state.appSecret = String(payload.appSecret).trim();
      state.token = '';
      state.tokenExpiresAt = 0;
      await getAccessToken();
      return json(res, 200, { ok: true, message: '公众号连接成功，密钥仅保存在本服务进程内存中' });
    }
    if (req.method === 'POST' && pathname === '/api/wechat/draft') {
      const payload = await readJson(req);
      const result = await createDraft(payload);
      return json(res, 200, { ok: true, mediaId: result.media_id });
    }
    return json(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    return json(res, 400, { ok: false, error: error.message });
  }
});

/* ------------------------------------------------------------------ */
/* Admin CLI: node server.js invite <create|list|unbind|disable|enable|delete> */
/* ------------------------------------------------------------------ */

function runInviteCli(args) {
  const [command, ...rest] = args;
  const option = (name, fallback) => {
    const index = rest.indexOf(`--${name}`);
    return index >= 0 && rest[index + 1] !== undefined ? rest[index + 1] : fallback;
  };
  const data = loadInvites();
  if (command === 'create') {
    const count = Math.max(1, Math.min(500, Number(option('count', 1)) || 1));
    const maxUses = Math.max(0, Number(option('uses', 0)) || 0);
    const maxDevices = Math.max(1, Number(option('devices', 1)) || 1);
    const days = Number(option('days', 0)) || 0;
    const note = String(option('note', ''));
    const created = [];
    while (created.length < count) {
      const code = generateCode();
      if (findInvite(data, code)) continue;
      const invite = { code, note, maxDevices, devices: [], maxUses, uses: 0, createdAt: new Date().toISOString(), expiresAt: days > 0 ? new Date(Date.now() + days * 86400e3).toISOString() : null, disabled: false };
      data.codes.push(invite);
      created.push(invite);
    }
    saveInvites(data);
    console.log(`已生成 ${created.length} 个邀请码（每个限 ${maxDevices} 台设备使用，${days > 0 ? `${days} 天后过期` : '长期有效'}）：`);
    created.forEach(invite => console.log(`  ${invite.code}`));
    return;
  }
  if (command === 'list') {
    if (!data.codes.length) return console.log('还没有邀请码。用 node server.js invite create 生成。');
    data.codes.forEach(invite => {
      const status = inviteProblem(invite, { forNewLogin: true }) ? `不可用（${inviteProblem(invite, { forNewLogin: true })}）` : '可用';
      const devices = boundDevices(invite);
      const bound = devices.length ? `已激活 ${devices.length}/${maxDevicesOf(invite)} 台（${devices.map(device => device.boundAt.slice(0, 10)).join('、')}）` : `未激活 0/${maxDevicesOf(invite)} 台`;
      const expires = invite.expiresAt ? invite.expiresAt.slice(0, 10) : '长期';
      console.log(`${invite.code}  ${status}  ${bound}  到期 ${expires}${invite.note ? `  备注：${invite.note}` : ''}`);
    });
    return;
  }
  if (['disable', 'enable', 'delete', 'unbind'].includes(command)) {
    const invite = findInvite(data, rest[0]);
    if (!invite) { console.error(`找不到邀请码 ${rest[0] || ''}`); process.exitCode = 1; return; }
    if (command === 'unbind') {
      const count = boundDevices(invite).length;
      invite.devices = [];
      saveInvites(data);
      console.log(`${invite.code} 已解绑 ${count} 台设备：原设备会被退出，可以在新设备上重新输入激活`);
      return;
    }
    if (command === 'delete') data.codes.splice(data.codes.indexOf(invite), 1);
    else invite.disabled = command === 'disable';
    saveInvites(data);
    console.log(`${invite.code} 已${{ disable: '停用（已登录的用户会被立即退出）', enable: '重新启用', delete: '删除' }[command]}`);
    return;
  }
  console.log(`用法：
  node server.js invite create [--count 10] [--devices 1] [--days 30] [--note 备注]
  node server.js invite list
  node server.js invite unbind <邀请码>     （用户换设备时解绑，原设备会被退出）
  node server.js invite disable <邀请码>
  node server.js invite enable <邀请码>
  node server.js invite delete <邀请码>`);
}

if (process.argv[2] === 'invite') {
  runInviteCli(process.argv.slice(3));
} else if (process.argv[2] === 'admin' && process.argv[3] === 'password') {
  // node server.js admin password [新密码]   不填则随机生成一个
  const password = process.argv[4] || crypto.randomBytes(9).toString('base64url');
  if (password.length < 8) { console.error('后台密码至少 8 位'); process.exitCode = 1; }
  else {
    setAdminPassword(password);
    console.log(`后台密码已设置为：${password}\n后台地址：http://你的服务器地址/admin（修改密码后，已登录的后台会被退出）`);
  }
} else {
  server.listen(PORT, HOST, () => {
    console.log(`排好看已启动：http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    if (!loadInvites().codes.length) console.log('提示：还没有邀请码，先运行 node server.js invite create 生成一个。');
  });
}
