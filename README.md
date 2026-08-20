# mm-notify

使用独立 Mattermost Session 长期监听消息的工具。正式模式只把 @提及和一对一私聊发送到 Telegram，不依赖叮咚 Electron 的本地 Cookie。

## 安全边界

- 密码仅保存在 macOS 钥匙串，不写入项目文件或日志
- 启动时优先复用已保存 Session，明确 `401/403` 时才调用登录接口
- 连续密码认证失败最多两次，登录锁跨进程重启保留
- 不把 Session token 写入日志或 `.env`
- `direct-session.json` 和 `direct-login-lock.json` 权限为 `600`
- Telegram Bot token 仅从本机 `.env` 读取

## 原理

程序使用钥匙串中的登录密码创建自己的 Session，保存 Token、Cookie 和 CSRF 字段。叮咚客户端可以退出、重启或保持打开，都不会影响监听服务的 Session。

访问 Mattermost 的 HTTP Session 验证请求和 WebSocket 握手统一携带叮咚桌面客户端 UA。`sign` 按客户端逻辑通过 `MD5(appId + buildTimestamp)` 生成；其中时间戳是当前客户端版本的构建常量，不是请求时的当前时间。

首次运行时，macOS 可能询问是否允许访问钥匙串中的 `mm-notify Mattermost Login`，请选择允许。

## 环境

- macOS
- Node.js 22+
- 已登录并运行的 Mattermost Desktop / 公司定制客户端
- VPN 可访问 Mattermost 服务

## 安装和运行

```bash
cd mm-notify
cp .env.example .env
npm install
npm run diagnose
```

成功后会先看到 `hello`，随后原样打印 `posted`、`typing`、`user_added` 等服务器发给当前用户的全部事件。按 `Ctrl+C` 停止。

VPN 或 Desktop 网络掉线造成 WebSocket 关闭后，程序会等待 5 秒，重新读取最新 Session，再连接。若 Desktop 的 Session 已过期，日志会提示：

```text
请重新登录 Mattermost
```

程序不会尝试自动登录。

## 可选配置

若自动探测失败，可在 `.env` 指定：

```dotenv
MM_DESKTOP_DATA_DIR=/Users/your-name/Library/Application Support/叮咚
MM_KEYCHAIN_SERVICE=叮咚 Safe Storage
MM_RECONNECT_MS=5000
```

不要在 `.env` 中放 Mattermost 密码或 Session token。

当前登录用户的 Mattermost 用户名通过 `/api/v4/users/me` 自动识别，不需要配置。如需同时监听群组名或其他提及别名，可选配置：

```dotenv
MM_MENTION_NAMES=front_sport,another_alias
```

名称可带或不带 `@`，多个名称使用英文逗号分隔。公开项目时不要提交本机 `.env`；其他用户不配置此项也会自动监听自己的用户名。

## Telegram 设置

1. 在 Telegram 找到官方 `@BotFather`，发送 `/newbot` 并按提示创建 Bot。
2. 将 BotFather 给出的 token 写入本机 `.env`：

   ```dotenv
   TELEGRAM_BOT_TOKEN=123456:your-token
   ```

3. 打开刚创建的 Bot，点击 **Start** 或给它发送任意消息。Bot 不能主动联系一个从未与它对话的用户。
4. 自动查找你的 Chat ID：

   ```bash
   npm run telegram:setup
   ```

5. 将显示的 ID 写入 `.env` 的 `TELEGRAM_CHAT_ID`，然后测试：

   ```bash
   npm run telegram:test
   ```

6. 启动正式监听：

   ```bash
   npm start
   ```

## 当前阶段范围

- [x] 第一阶段：Session + WebSocket 全事件诊断
- [x] 第二阶段：解析 `posted`，识别 @我和私聊
- [x] 第三阶段：Telegram Bot
- [ ] 第四阶段：macOS LaunchAgent
