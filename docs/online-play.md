# 同一 Wi-Fi 与公网联机

从 v1.25.0 起，桌面和手机首页分别提供「同一 Wi-Fi」和「公网联机」。两者的房间彼此独立；房间号相同也不会串桌。原来的完整单机对局、快速一局和离线缓存继续可用。

## 同一 Wi-Fi：在一台电脑上开服务

电脑需安装 Node.js 22 或更新版本。首次安装服务依赖需要联网，安装好后，同一网络内游玩不依赖公网。

macOS 双击项目中的 `局域网联机.command`；Windows 双击 `局域网联机.bat` 并保持窗口运行。首次会安装依赖；Mac 随后在后台启动服务并打开建房页面。终端会列出类似下面的地址，请把显示的实际地址发给同一 Wi-Fi 下的朋友：

```text
电脑：http://192.168.1.8:8897/?online=lan
手机：http://192.168.1.8:8897/mobile/?online=lan
```

这里的 IP 只是示例，以启动时显示的为准。房主在页面填写昵称，创建房间，再复制邀请链接。朋友直接点链接、填写昵称并加入，或者输入同一服务地址和六位房间号。邀请入口会把常见手机浏览器转到手机横屏页面。

也可以在 Windows、Linux 或 macOS 的项目目录运行：

```bash
npm ci
npm run start:lan
```

这种手动启动方式需要保持终端运行。后台启动脚本的日志在 `.online-data/lan-server.log`。电脑需保持开机且设备间可互访；访客 Wi-Fi 可能隔离设备。首次出现防火墙入站连接提示时，需允许本服务。手机上不要填写 `127.0.0.1` 或 `localhost`，它们表示手机自己。

如果当前打开的是 GitHub Pages 等 HTTPS 页面，请直接改用电脑提供的局域网网页地址，避免 HTTPS 页面连接 HTTP 服务的混合内容限制。普通局域网 HTTP 可用于浏览器游玩，手机离线安装仍需 HTTPS 或安全上下文。

## 公网：GitHub 连接 Render 部署

v1.25.1 已于 2026-11-03 部署到 Render 免费服务，可直接游玩：

- [电脑公网联机](https://guandan-online-x50v.onrender.com/?online=public)
- [手机横屏公网联机](https://guandan-online-x50v.onrender.com/mobile/?online=public)

填写昵称后创建房间，复制邀请链接发给朋友；朋友加入并准备后，房主点击「开始对局」。服务地址自动识别，无需自行填写。已通过实际公网四客户端开局、私有手牌隔离、出牌同步、请求去重和断线重连验收；手机网页入口及邀请跳转也已验证。

从 v1.25.2 起，GitHub Pages、安装到手机桌面的版本和解压文件版也默认连接上述公网服务。朋友可打开已更新的游戏，选择「公网联机」，填写昵称和六位房间号加入，无需反复打开邀请链接。自行部署在其他网址时会优先使用自身服务，也可手动修改服务地址。

部署目标为 `SidneyPearson/guandan-web` 的 `codex/render-online` 分支，现有 GitHub Pages 的 `main` 分支保留。先把本版代码发布到该分支，再使用仓库根目录的 `render.yaml`，让 Render 同时托管网页和房间后台，无需自建服务器、购买域名或运行 Docker。

1. 登录 Render，创建 Blueprint，连接 GitHub 仓库 `SidneyPearson/guandan-web`。
2. 选择 `codex/render-online` 分支，Blueprint 路径使用 `render.yaml`。
3. 核对服务是 **Node Web Service**、**Free** 计划、单实例，确认后创建。
4. 等部署成功，打开 Render 显示的实际 `https://…onrender.com` 地址。电脑用根路径，手机用 `/mobile/?online=public`，页面会自动识别自己的房间服务。
5. 后续向该分支推送代码，会触发自动部署。更新时应先结束当前牌局。

首次关联 GitHub 需要在 Render 中完成账号登录和仓库连接。免费方案不需要添加付费磁盘；创建前请以平台实际展示的计划和费用为准。不要把它建成 Static Site，因为房间后台需要运行 Node 程序。[Render 仓库部署](https://render.com/docs/deploy-node-express-app)、[Blueprint 配置](https://render.com/docs/blueprint-spec)。

免费服务空闲 15 分钟后可能休眠，下一次访问约需一分钟唤醒；服务休眠、重启或重新部署后，临时文件会丢失，因此当前牌局需重新开桌。运行期间刷新和短暂断线仍可恢复座位，房间中会显示恢复范围。公网连接已支持等待服务唤醒和重试。[Render 免费服务说明](https://render.com/docs/free)。

如果需要在平台重启、部署后保留牌局，使用 `deploy/render-persistent.yaml`：它配置付费计算和 1 GB 持久磁盘，数据目录为 `/var/data/rooms`。这不是默认创建选项，须先确认 Render 当前展示的费用。[持久磁盘说明](https://render.com/docs/disks)。

| 项目 | 本次 Render 配置 |
| --- | --- |
| Node | 24.14.1 |
| 构建 | `npm ci --omit=dev --no-audit --no-fund` |
| 启动 | `npm run start:public` |
| 健康检查 | `/healthz` |
| 公网地址 | 自动读取 Render 分配的 `RENDER_EXTERNAL_URL` |
| 房间服务 | 单实例；免费版一个 AI Worker |
| 自动更新 | GitHub 部署分支提交后触发 |

### 已安装的手机版如何更新

手机桌面图标固定使用安装时的网址。Render 和 GitHub Pages 是两个来源；在 Render 发布新版，不会更新原 GitHub Pages 图标。要让原图标更新，必须把同一版本发布到 GitHub Pages 使用的 `main` 分支。

原网址发布新版后，保持联网打开原图标，等待新资源下载完成。如果出现「新版已下载」提示，关闭全部游戏窗口，再从原图标打开；确认底部版本为 v1.25.3 或更新版本后，进入「公网联机」输入房间号即可。不要为更新而清除网站数据或删除应用，以免丢失原来的单机存档。直接打开 Render 手机入口也可立即游玩，但不同网址的单机存档和重连凭据各自保存。

## 公网：Docker Compose 部署（自建服务器可选）

如果选择自建服务，准备一台装有 Docker 和 Compose 的服务器，以及一个已解析到该服务器的域名。

上传完整项目，在项目目录执行：

```bash
cp .env.example .env
```

编辑 `.env`，把示例域名换成自己的实际域名：

```dotenv
GUANDAN_DOMAIN=你的实际域名
```

确认域名解析正确、服务器 80 和 443 端口可访问，然后运行：

```bash
docker compose config
docker compose up -d --build
docker compose logs -f game web
```

`game` 运行 Node 服务，仅开放公网房间模式；`web` 使用 Caddy 提供 HTTPS 并转发实时连接。Caddy 会为可验证的公网域名申请证书；域名和端口条件须先满足。[Caddy 官方说明](https://caddyserver.com/docs/quick-starts/reverse-proxy)。Compose 从项目 `.env` 读取域名变量。[Docker 官方说明](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)。

部署后访问：

```text
电脑：https://你的实际域名/?online=public
手机：https://你的实际域名/mobile/?online=public
健康检查：https://你的实际域名/healthz
```

牌局和重连会话保存在 `game-data` 持久卷；同版本服务重启后可恢复。Caddy 证书保存在独立持久卷。升级程序时可重新执行 `docker compose up -d --build`；请先结束正在进行的牌局，版本不一致时不强行恢复旧房间。普通停止用 `docker compose down`，保留卷即可保留数据。

## 已有 Node 运行环境的部署

如果已有支持常驻 Node 和 WebSocket 的运行平台，可以不使用 Docker：

```bash
npm ci --omit=dev
ONLINE_MODES=public PORT=8080 DATA_DIR=/path/to/persistent-data node server/index.cjs
```

让平台的 HTTPS 域名转发到该端口，同时支持 `/socket.io/` 的实时连接和 HTTP 请求。前端可以直接由这个服务提供；若前端单独放在静态站点，在「公网联机」里填写后端的 HTTPS 服务地址。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `ONLINE_MODES` | `lan,public` | 启用 `lan`、`public` 或两者；命令行 `--mode` 优先 |
| `PORT` | 通用／LAN 8897，public 启动命令 8898 | HTTP 和实时服务共用端口 |
| `HOST` | `0.0.0.0` | 监听接口，局域网要允许其他设备访问 |
| `DATA_DIR` | 项目 `.online-data/` | 房间快照和会话哈希存储目录，应可写且持久化 |
| `PUBLIC_URL` | 空 | 可选的公网地址配置 |
| `RENDER_EXTERNAL_URL` | Render 自动提供 | 未设置 `PUBLIC_URL` 时自动使用平台网址 |
| `ROOM_STORAGE` | `persistent` | 免费托管设为 `ephemeral`，向玩家说明平台重启需重新开桌 |
| `AI_WORKERS` | `2` | 服务端 AI 线程数，可设 1–4；免费 Render 配置为 1 |
| `ALLOWED_ORIGINS` | 空 | 可选，允许的前端来源，多个用英文逗号分隔；Compose 已限制为自身域名 |

没有账号体系；知道房间号可以在开局前加入，恢复原座位则必须持有浏览器保存的随机重连凭据。邀请链接只包含模式和房间号，不携带重连凭据。

## 房间里的操作

- 创建者是房主；开局前可选完整升级或快速一局、电脑难度、15／30／60／90 秒回合，以及是否允许出完看对家手牌。
- 点击空位换座，南北一队、东西一队。真人全部连接且准备后，由房主开局；剩余座位由电脑补齐，一个人也能测试房间。
- 出牌、过牌、进贡和还贡由服务端校验。每个客户端只有自己的手牌；允许队友观战时，也只向已出完的那位队友开放对家手牌。
- 倒计时由服务端统一控制，到时自动托管。掉线时保留座位，等待最多 15 秒宽限或当前回合截止时间后托管；重连后自动取回因掉线产生的托管，手动或超时托管可自行取消。
- 刷新当前房间页面会尝试自动恢复；也可在对应模式里选择「恢复上次房间」。重连凭据保存在当前浏览器，清除网站数据或换设备后不能仅凭昵称取回手牌。
- 打开菜单、设置、房间和转竖屏仅影响本人界面，其他玩家继续。每副结束后，在线且未托管的真人都准备好才发下一副。
- 房主掉线时会把管理权交给仍在线的玩家；开局前，新房主可点击掉线座位移除占位。开局后不开放新玩家中途入座，原玩家可重连；主动退出则由电脑补位。
- 无人在线的房间保留 24 小时。服务端存储暂时失败时，房间会显示提示；本地单机存档不会被联机视图覆盖。

## 验证与范围

以下开发检查在源码目录运行；普通发布包包含游戏和房间服务的运行文件。

```bash
npm ci
npm run test:online
npm run test:online-browser
node test/offline.cjs
node test/ui-usability.cjs
node test/spectator-view.cjs
node test/mobile-viewport.cjs
```

在线集成测试使用真实本机 Socket.IO 连接，覆盖两种模式的四客户端通信、私有视图、身份／回合校验、请求去重、电脑补位、服务重启恢复等；浏览器检查使用 macOS Google Chrome 和项目已有的 CDP 驱动，截图保存在 `test/online-evidence/`。

当前服务按单进程、多房间设计，房间数量默认上限 100；没有进行 100 房并发压测。两种模式的同步流程已通过本机浏览器和独立客户端连接验证；Render 公网服务的 HTTPS、桌面／手机网页入口和四客户端实时联机已验收。实际路由器网络和 iOS／Android 真机尚未验收。Compose 配置已通过语法检查；本机 Docker 守护进程未运行，因此本轮没有实际构建／运行容器。
