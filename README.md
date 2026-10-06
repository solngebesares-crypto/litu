# litu
shea 的仓库

## 排好看 · 微信公众号文章排版工具

### 启动

需要 Node.js 18 及以上，无需安装依赖。

```bash
node server.js invite create        # 第一次使用：先生成一个邀请码
node server.js                      # 启动服务，浏览器打开终端里显示的地址
```

打开后输入邀请码即可进入编辑器；激活后这台设备长期免登录，一个邀请码只能在一台设备上使用。直接双击 `index.html` 打开会被拦截，必须通过服务地址访问。

### 邀请码管理

```bash
node server.js invite create --count 10 --days 365 --note 第一批用户
node server.js invite list            # 查看所有邀请码、激活设备和状态
node server.js invite unbind XXXX-XXXX    # 用户换手机/电脑或清了浏览器数据时解绑，可在新设备上重新激活
node server.js invite disable XXXX-XXXX   # 停用，已登录的用户会被立即退出
node server.js invite enable XXXX-XXXX
node server.js invite delete XXXX-XXXX
```

- **一码一设备**：邀请码在第一次输入的设备（浏览器）上激活并绑定，之后这台设备长期免登录（默认 365 天，可用 `INVITE_SESSION_DAYS` 调整）；把码发给别人，在其他设备上输入会被拒绝。退出登录后，同一台设备仍可用原码重新登录。
- `--devices`：一个邀请码最多可以绑定几台设备，默认 1。
- 用户换设备、换浏览器或清除了浏览器数据后无法自动识别原设备，需要管理员用 `invite unbind` 解绑后重新激活。
- `--days`：几天后过期，不填为长期有效。
- 邀请码保存在 `invite-codes.json`，会话签名密钥保存在 `.invite-secret`，两者都已加入 `.gitignore`，不要提交到仓库。
- 同一来源 15 分钟内输错 10 次会被暂时锁定。

### 文章图片

在编辑器里插入的图片会先在浏览器里压缩（长边不超过 1600px），再上传到本服务，保存在 `uploads/` 目录（已加入 `.gitignore`），文章里只保存图片网址。点「一键复制」后粘贴到公众号后台，微信会自动读取这些网址并转存图片，不需要配置公众号 AppID。

- 上传需要邀请码登录；图片网址本身是公开的（文件名随机且不可猜测），因为微信需要能直接读取。
- 只接受 JPG、PNG、GIF、WEBP，单张不超过 10MB；类型按文件内容判断，SVG 等会被拒绝。
- 复制时如果文章里还有未上传的图片（粘贴进来的、旧草稿里的），会先自动上传。
- 在本机地址（127.0.0.1）运行时，微信读取不到图片，粘贴后图片会缺失；部署到公网服务器后即可正常显示。
- 备份时记得一并备份 `uploads/` 目录。

### 一键部署到阿里云 ECS

1. 生成部署包：`bash deploy/make-bundle.sh`，得到 `dist/paihaokan-deploy.sh`（包含全部程序文件）。
2. 阿里云控制台 → 云服务器 ECS → 安全组 → 入方向，放行 HTTP(80) 端口。
3. 用 Workbench 远程连接服务器（root），把 `paihaokan-deploy.sh` 上传到服务器后运行：`bash paihaokan-deploy.sh`
   已备案的域名可以这样运行：`DOMAIN=example.com bash paihaokan-deploy.sh`
4. 脚本会安装 Node.js 和 nginx、注册开机自启服务，并打印访问地址和第一个邀请码。

升级时用新的部署包再运行一次即可，邀请码、图片和密钥都会保留。

### 部署到服务器

默认只监听本机 `127.0.0.1`。对外提供服务时，请放在 HTTPS 反向代理（如 nginx）后面：

```bash
HOST=127.0.0.1 PORT=8787 TRUST_PROXY=1 node server.js
```

使用 nginx 时，把 `client_max_body_size` 设为 `12m` 以上，否则较大的图片会上传失败。

| 环境变量 | 说明 |
|---|---|
| `PORT` | 端口，默认 8787 |
| `HOST` | 监听地址，默认 `127.0.0.1` |
| `TRUST_PROXY=1` | 在反向代理之后运行时开启，用代理传来的真实 IP 做防暴力破解，并在 HTTPS 下给 Cookie 加 `Secure` |
| `INVITE_SESSION_DAYS` | 登录有效天数，默认 30 |
| `INVITE_SECRET` | 会话签名密钥；不设置则自动生成并保存在 `.invite-secret` |
| `INVITE_FILE` | 邀请码文件路径，默认 `invite-codes.json` |
| `UPLOAD_DIR` | 文章图片保存目录，默认 `uploads/` |

注意：草稿保存在每个用户自己的浏览器里（按访问地址区分），换地址或换浏览器看不到之前的草稿。
