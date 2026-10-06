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
- **同一处登录只能在一个地方在线**：如果有人把已登录浏览器的登录凭证复制到别处，两边会互相顶号——登录凭证约每 10 分钟自动更换一次，先更换的一方继续使用，另一方会被下线并看到提示；重新输入邀请码会把另一方顶下线（后登录的生效）。同一浏览器的多个标签页不受影响。
- `--devices`：一个邀请码最多可以绑定几台设备，默认 1。
- 用户换设备、换浏览器或清除了浏览器数据后无法自动识别原设备，需要管理员用 `invite unbind` 解绑后重新激活。
- `--days`：几天后过期，不填为长期有效。
- 邀请码保存在 `invite-codes.json`，会话签名密钥保存在 `.invite-secret`，两者都已加入 `.gitignore`，不要提交到仓库。
- 同一来源 15 分钟内输错 10 次会被暂时锁定。

### 管理后台

浏览器打开 `http://你的地址/admin`，用后台密码登录，可以：

- 批量生成邀请码（数量、每码可用设备数、有效期、备注）并一键复制；
- 查看已激活用户、近 7 天活跃人数、未使用和已停用的邀请码；
- 查看每个邀请码绑定的设备、激活时间、最近活跃时间；
- 修改备注、解绑设备（用户换设备时用）、停用 / 启用、删除。

设置或修改后台密码（在服务器上运行，不填密码则自动生成一个）：

```bash
node server.js admin password 你的新密码
```

密码以加盐哈希保存在 `admin.json`（已加入 `.gitignore`）。修改密码后，已登录的后台会自动退出。后台登录连续输错 10 次会锁定 15 分钟。

### 文章图片

在编辑器里插入的图片会先在浏览器里压缩（长边不超过 1600px），再上传到本服务，保存在 `uploads/` 目录（已加入 `.gitignore`），文章里只保存图片网址。点「一键复制」后粘贴到公众号后台，微信会自动读取这些网址并转存图片，不需要配置公众号 AppID。

- 上传需要邀请码登录；图片网址本身是公开的（文件名随机且不可猜测），因为微信需要能直接读取。
- 只接受 JPG、PNG、GIF、WEBP，单张不超过 10MB；类型按文件内容判断，SVG 等会被拒绝。
- 复制时如果文章里还有未上传的图片（粘贴进来的、旧草稿里的），会先自动上传。
- 在本机地址（127.0.0.1）运行时，微信读取不到图片，粘贴后图片会缺失；部署到公网服务器后即可正常显示。
- 备份时记得一并备份 `uploads/` 目录。

### 一键部署到阿里云 ECS

1. 生成部署包：`bash deploy/make-bundle.sh`，得到 `dist/paihaokan-deploy.sh`（包含全部程序文件）。
2. 阿里云控制台 → 云服务器 ECS → 安全组 → 入方向，放行 HTTP(80) 和 HTTPS(443) 端口。
3. 用 Workbench 远程连接服务器（root），把 `paihaokan-deploy.sh` 上传到服务器后运行：`bash paihaokan-deploy.sh`
4. 脚本会安装 Node.js 和 nginx、注册开机自启服务，并打印访问地址、第一个邀请码和后台密码。

使用已备案的域名（推荐，对外发布时使用）：

1. 在域名解析里添加一条 A 记录，指向服务器公网 IP（例如主机记录 `pai`，得到 `pai.example.com`）。
2. 解析生效后运行：`DOMAIN=pai.example.com bash paihaokan-deploy.sh`
3. 脚本会用 acme.sh 自动申请 Let's Encrypt 免费 HTTPS 证书，到期前自动续期；
   之后 http 和 IP 访问都会自动跳转到 `https://pai.example.com`。
   如果解析还没生效或证书申请失败，会先用 http 运行，稍后重新运行同一条命令即可。

升级时用新的部署包再运行一次即可（不用再写 `DOMAIN=`，会沿用上次的域名），邀请码、图片、密钥和证书都会保留。

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
| `INVITE_SESSION_DAYS` | 激活设备的免登录天数，默认 365 |
| `INVITE_ROTATE_SECONDS` | 登录凭证自动更换的间隔秒数，默认 600 |
| `INVITE_SECRET` | 会话签名密钥；不设置则自动生成并保存在 `.invite-secret` |
| `INVITE_FILE` | 邀请码文件路径，默认 `invite-codes.json` |
| `ADMIN_FILE` | 后台密码文件路径，默认 `admin.json` |
| `UPLOAD_DIR` | 文章图片保存目录，默认 `uploads/` |

注意：草稿保存在每个用户自己的浏览器里（按访问地址区分），换地址或换浏览器看不到之前的草稿。
