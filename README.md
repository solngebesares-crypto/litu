# litu
shea 的仓库

## 排好看 · 微信公众号文章排版工具

### 启动

需要 Node.js 18 及以上，无需安装依赖。

```bash
node server.js invite create        # 第一次使用：先生成一个邀请码
node server.js                      # 启动服务，浏览器打开终端里显示的地址
```

打开后输入邀请码即可进入编辑器，登录状态保留 30 天。直接双击 `index.html` 打开会被拦截，必须通过服务地址访问。

### 邀请码管理

```bash
node server.js invite create --count 10 --uses 3 --days 30 --note 第一批用户
node server.js invite list            # 查看所有邀请码、登录次数和状态
node server.js invite disable XXXX-XXXX   # 停用，已登录的用户会被立即退出
node server.js invite enable XXXX-XXXX
node server.js invite delete XXXX-XXXX
```

- `--uses`：每个邀请码最多可登录几次（每台设备/浏览器登录算一次），不填为不限。
- `--days`：几天后过期，不填为长期有效。
- 邀请码保存在 `invite-codes.json`，会话签名密钥保存在 `.invite-secret`，两者都已加入 `.gitignore`，不要提交到仓库。
- 同一来源 15 分钟内输错 10 次会被暂时锁定。

### 部署到服务器

默认只监听本机 `127.0.0.1`。对外提供服务时，请放在 HTTPS 反向代理（如 nginx）后面：

```bash
HOST=127.0.0.1 PORT=8787 TRUST_PROXY=1 node server.js
```

| 环境变量 | 说明 |
|---|---|
| `PORT` | 端口，默认 8787 |
| `HOST` | 监听地址，默认 `127.0.0.1` |
| `TRUST_PROXY=1` | 在反向代理之后运行时开启，用代理传来的真实 IP 做防暴力破解，并在 HTTPS 下给 Cookie 加 `Secure` |
| `INVITE_SESSION_DAYS` | 登录有效天数，默认 30 |
| `INVITE_SECRET` | 会话签名密钥；不设置则自动生成并保存在 `.invite-secret` |
| `INVITE_FILE` | 邀请码文件路径，默认 `invite-codes.json` |

注意：草稿保存在每个用户自己的浏览器里（按访问地址区分），换地址或换浏览器看不到之前的草稿。
