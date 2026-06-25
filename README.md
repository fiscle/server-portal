# Server Portal

一个轻量的 Web 运维管理平台，提供用户注册/登录、推荐码邀请、远程 SSH 会话、文件管理、服务器资源查看和审计日志查询等功能。

项目后端使用 Node.js + Express，前端为原生 HTML/CSS/JavaScript，终端使用 xterm.js，数据默认保存到 SQLite；当 sqlite3 不可用时，会自动退回 JSON 文件存储。

## 功能特性

- 用户与权限
  - 首位注册用户自动成为管理员。
  - 管理员默认获得 6 个推荐码。
  - 新注册普通用户默认获得 3 个推荐码。
  - 后续注册必须使用推荐码。
  - 支持用户启用/停用、删除、重置密码、用户分组。
  - 管理员可查看推荐码归属、使用情况和用户推荐链路。

- 登录安全
  - 登录和注册支持动态验证码。
  - 默认前几次正常尝试不要求验证码，失败或频繁访问后才要求输入。

- 远程管理
  - 管理员配置 SSH 会话。
  - 支持密码或私钥认证。
  - 支持按用户或用户组授权。
  - 支持直连、跳板连接、多级跳板连接。
  - 默认限制直连目标为本机或内网地址。
  - 如确需公网直连，可通过白名单配置。

- 文件管理
  - 每个用户有自己的文件目录。
  - 普通用户只能访问自己的文件。
  - 管理员可以切换查看自己的文件或全部用户文件。
  - 支持上传、下载、新建文件夹、删除文件。

- 服务器资源
  - 查看主机、CPU、内存、磁盘和用户文件统计。
  - 默认普通用户也可以查看，可配置为仅管理员可看。

- 审计日志
  - 记录用户登录、登录失败、注册、退出。
  - 记录文件上传、下载、删除、新建文件夹。
  - 记录远程连接成功/失败。
  - 记录修改密码、重置密码、用户管理、推荐码管理、远程会话管理。
  - 管理员可分页查询、搜索、筛选日志。

- 部署工具
  - 提供 systemd 部署脚本。
  - 支持 Nginx 反向代理。
  - 支持已有 HTTPS 证书或 Let’s Encrypt 自动申请证书。
  - 提供恢复出厂脚本。

## 技术栈

- Node.js >= 16
- Express
- WebSocket
- ssh2
- xterm.js
- multer
- SQLite CLI
- Nginx + systemd，生产部署推荐

## 目录结构

```text
server-portal/
├── app.js                 # 后端主程序
├── package.json           # Node.js 依赖
├── start.sh               # 本地/简单启动脚本
├── stop.sh                # 本地/简单停止脚本
├── deploy-systemd.sh      # 生产部署脚本
├── factory-reset.sh       # 恢复出厂脚本
├── DEPLOYMENT.md          # 详细部署说明
├── config/
│   ├── defaults.js        # 默认配置
│   └── index.js           # 配置加载与环境变量覆盖
└── public/
    ├── index.html         # 前端页面
    ├── app.js             # 前端逻辑
    ├── styles.css         # 主样式
    └── remote-sessions.css
```

运行后会自动生成：

```text
data/     # 用户、推荐码、远程会话、SQLite 数据、文件根目录等
logs/     # 简单脚本启动时的日志
run/      # 简单脚本启动时的 PID 文件
```

建议不要把 `data/`、`logs/`、`run/`、`node_modules/` 提交到 Git。

## 快速启动

```bash
cd server-portal
npm install
./start.sh
```

默认访问：

```text
http://服务器IP:8088
```

停止服务：

```bash
./stop.sh
```

也可以直接运行：

```bash
npm start
```

## 首次使用

首次打开系统时，直接注册第一个用户。

规则：

- 第一个注册用户自动成为管理员。
- 管理员不需要推荐码。
- 管理员默认获得 6 个推荐码。
- 后续用户注册必须输入有效推荐码。

## 配置

推荐使用 `config/local.json` 覆盖默认配置：

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 8088
  },
  "session": {
    "timeoutMs": 28800000
  },
  "registration": {
    "adminInviteCount": 6,
    "userInviteCount": 3
  },
  "files": {
    "root": "/opt/server-portal/data/files",
    "maxUploadBytes": 104857600,
    "maxUploadFiles": 10
  },
  "resources": {
    "allowUsers": true
  },
  "remote": {
    "allowPublicDirectHosts": []
  },
  "data": {
    "root": "/opt/server-portal/data"
  }
}
```

也可以使用环境变量覆盖：

```bash
PORTAL_HOST=127.0.0.1
PORTAL_PORT=8088
PORTAL_SESSION_TIMEOUT_MS=28800000
PORTAL_ADMIN_INVITE_COUNT=6
PORTAL_USER_INVITE_COUNT=3
PORTAL_FILE_ROOT=/opt/server-portal/data/files
PORTAL_MAX_UPLOAD_BYTES=104857600
PORTAL_MAX_UPLOAD_FILES=10
PORTAL_RESOURCES_ALLOW_USERS=true
PORTAL_REMOTE_ALLOW_PUBLIC_DIRECT_HOSTS=203.0.113.10,portal.example.com
PORTAL_DATA_ROOT=/opt/server-portal/data
```

## 远程会话配置说明

如果要连接 Web 应用所在服务器本身，推荐配置：

```text
连接方式：直接连接
主机地址：127.0.0.1
端口：22
登录用户名：服务器上的 SSH 用户
认证方式：密码或私钥
```

不要优先填写云服务器公网 IP。因为 SSH 连接由后端 Node.js 在服务器上发起，访问自己时走 `127.0.0.1` 最稳定。

如果确实需要允许公网 IP 或域名作为直连目标，可以配置：

```json
{
  "remote": {
    "allowPublicDirectHosts": ["203.0.113.10", "portal.example.com"]
  }
}
```

多级跳板示例：

```text
A：控制服务器
  连接方式：直接连接
  主机地址：127.0.0.1

B：内网跳板 1
  连接方式：通过跳板会话
  跳板会话：A
  主机地址：B 在 A 上可访问的内网 IP

C：内网目标机器
  连接方式：通过跳板会话
  跳板会话：B
  主机地址：C 在 B 上可访问的内网 IP
```

系统会阻止跳板循环引用。

## 生产部署

推荐使用 systemd + Nginx + HTTPS。

如果已有域名、Nginx 和 HTTPS 证书：

```bash
sudo ./deploy-systemd.sh \
  --domain portal.example.com \
  --cert-file /etc/ssl/portal/fullchain.pem \
  --key-file /etc/ssl/portal/privkey.pem \
  --install-dir /opt/server-portal \
  --service-name server-portal \
  --user portal \
  --host 127.0.0.1 \
  --port 8088
```

如果使用 Let’s Encrypt 自动申请证书：

```bash
sudo ./deploy-systemd.sh \
  --domain portal.example.com \
  --letsencrypt \
  --email admin@example.com
```

详细说明见：[DEPLOYMENT.md](./DEPLOYMENT.md)。

## 服务管理

systemd 部署后：

```bash
systemctl status server-portal
journalctl -u server-portal -f
systemctl restart server-portal
```

Nginx：

```bash
nginx -t
systemctl reload nginx
```

## 恢复出厂

恢复出厂会删除：

- 用户
- 推荐码
- 远程会话配置
- 业务文件
- 审计日志
- SQLite 数据库
- 远程会话加密主密钥

执行：

```bash
cd /opt/server-portal
sudo ./factory-reset.sh
```

跳过交互确认：

```bash
sudo ./factory-reset.sh --yes
```

恢复完成后，系统会重新启动，再次打开页面即可注册首位管理员。

## 备份建议

建议定期备份：

```text
data/portal.sqlite3
data/portal.sqlite3-wal
data/portal.sqlite3-shm
data/remote-master.key
data/files/
config/local.json
```

特别注意：`remote-master.key` 用于解密远程会话保存的密码/私钥。如果丢失，已有远程会话凭据将无法解密。

## 安全建议

- 生产环境建议让应用只监听 `127.0.0.1`，由 Nginx 对外提供 HTTPS。
- 不要把 `8088` 等 Node.js 应用端口直接暴露到公网。
- 文件上传目录、SQLite 数据库和 `remote-master.key` 应限制访问权限。
- 谨慎配置公网直连白名单。
- 建议只给可信管理员开放远程会话配置权限。
- 云服务器安全组只开放必要端口，例如 `22`、`80`、`443`。

## 许可证

当前项目尚未声明开源许可证。发布到公开 Git 仓库前，建议根据需要补充 `LICENSE` 文件。
