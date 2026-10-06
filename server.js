const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.WECHAT_PORT || 8787);
const MAX_BODY = 8 * 1024 * 1024;
const state = { appId: '', appSecret: '', token: '', tokenExpiresAt: 0 };
const fallbackImage = path.join(__dirname, 'aurora-cover.png');

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(payload);
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

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  try {
    if (req.method === 'GET' && req.url === '/api/health') return json(res, 200, { ok: true, configured: Boolean(state.appId && state.appSecret) });
    if (req.method === 'POST' && req.url === '/api/wechat/config') {
      const payload = await readJson(req);
      if (!payload.appId || !payload.appSecret) return json(res, 400, { ok: false, error: 'AppID 和 AppSecret 不能为空' });
      state.appId = String(payload.appId).trim();
      state.appSecret = String(payload.appSecret).trim();
      state.token = '';
      state.tokenExpiresAt = 0;
      await getAccessToken();
      return json(res, 200, { ok: true, message: '公众号连接成功，密钥仅保存在本服务进程内存中' });
    }
    if (req.method === 'POST' && req.url === '/api/wechat/draft') {
      const payload = await readJson(req);
      const result = await createDraft(payload);
      return json(res, 200, { ok: true, mediaId: result.media_id });
    }
    return json(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    return json(res, 400, { ok: false, error: error.message });
  }
});

// The draft service receives AppSecret from the local editor. Keep it bound to
// loopback so another device on the network cannot call this endpoint.
server.listen(PORT, '127.0.0.1', () => console.log(`WeChat draft server listening on http://127.0.0.1:${PORT}`));
