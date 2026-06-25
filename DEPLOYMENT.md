# Server Portal 发布部署说明

本文档说明如何把本应用部署到云服务器，并通过已有域名、Nginx 和 HTTPS 证书对外访问。

## 1. 部署前准备

服务器需要具备：

- Linux 系统，推荐 CentOS 7+/Rocky/Ubuntu/Debian。
- Node.js 16 或更高版本，推荐 Node.js 20 LTS。
- npm。
- sqlite3 命令行工具。
- systemd。
- Nginx。
- 一个已经解析到服务器公网 IP 的域名，例如 `portal.example.com`。
- 已有 HTTPS 证书和私钥，例如：
  - 证书：`/etc/ssl/portal/fullchain.pem`
  - 私钥：`/etc/ssl/portal/privkey.pem`

云服务器安全组/防火墙建议开放：

- `22/tcp`：SSH 管理。
- `80/tcp`：HTTP 跳转 HTTPS，或用于证书申请。
- `443/tcp`：HTTPS 访问。

不要把 Node.js 应用端口，例如 `8088`，直接开放到公网；推荐只让它监听 `127.0.0.1`，由 Nginx 反向代理。

## 2. 上传应用代码

把 `server-portal` 目录上传到服务器，例如：

```bash
scp -r server-portal root@your-server:/tmp/server-portal
```

登录服务器：

```bash
ssh root@your-server
cd /tmp/server-portal
```

## 3. 使用已有 Nginx 和 HTTPS 证书部署

如果服务器已经安装好 Nginx，并且证书文件已经存在，可以直接执行：

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

脚本会自动完成：

- 检查并安装缺失依赖。
- 创建运行用户，默认 `portal`。
- 安装应用到 `/opt/server-portal`。
- 写入统一配置文件 `/opt/server-portal/config/local.json`。
- 安装 Node.js 依赖。
- 创建并启动 systemd 服务。
- 写入 Nginx 站点配置。
- 配置 HTTPS 证书。
- 检查应用和 Nginx 配置。

部署完成后访问：

```text
https://portal.example.com
```

首次打开系统时，注册的第一个用户会自动成为管理员。

## 4. 常用部署参数

```bash
sudo ./deploy-systemd.sh \
  --domain portal.example.com \
  --cert-file /etc/ssl/portal/fullchain.pem \
  --key-file /etc/ssl/portal/privkey.pem \
  --host 127.0.0.1 \
  --port 8088 \
  --session-timeout-ms 28800000 \
  --admin-invite-count 6 \
  --user-invite-count 3 \
  --file-root /data/server-portal/files \
  --max-upload-bytes 104857600 \
  --max-upload-files 10 \
  --client-max-body-size 100m
```

参数说明：

- `--host`：Node.js 应用监听地址，生产环境建议 `127.0.0.1`。
- `--port`：Node.js 应用监听端口。
- `--session-timeout-ms`：登录会话超时时间，单位毫秒。
- `--admin-invite-count`：首位管理员默认推荐码数量。
- `--user-invite-count`：新注册普通用户默认推荐码数量。
- `--file-root`：文件管理根目录。
- `--max-upload-bytes`：单文件上传大小限制。
- `--max-upload-files`：单次上传文件数量限制。
- `--client-max-body-size`：Nginx 上传大小限制，应大于等于应用上传限制。
- `--resources-admin-only`：服务器资源页面只允许管理员查看。
- `--allow-public-direct-hosts`：允许远程会话“直接连接”的公网地址白名单，多个值用英文逗号分隔。
- `--no-nginx`：只部署 systemd 服务，不写 Nginx 配置。

## 5. 如果暂时不配置 HTTPS

可以先部署 HTTP：

```bash
sudo ./deploy-systemd.sh \
  --domain portal.example.com \
  --host 127.0.0.1 \
  --port 8088
```

之后再用已有证书重新执行一次带 `--cert-file` 和 `--key-file` 的部署命令即可。

## 6. 使用 Let's Encrypt 自动申请证书

如果没有现成证书，可以让脚本调用 certbot：

```bash
sudo ./deploy-systemd.sh \
  --domain portal.example.com \
  --letsencrypt \
  --email admin@example.com
```

执行前请确认：

- 域名已经解析到本机公网 IP。
- 服务器 `80/tcp` 和 `443/tcp` 可从公网访问。
- 当前服务器可以安装 certbot。

## 7. 服务管理

查看服务状态：

```bash
systemctl status server-portal
```

查看实时日志：

```bash
journalctl -u server-portal -f
```

重启服务：

```bash
systemctl restart server-portal
```

查看 Nginx 配置是否正确：

```bash
nginx -t
```

重载 Nginx：

```bash
systemctl reload nginx
```

## 8. 恢复出厂

恢复出厂会删除：

- 用户。
- 推荐码。
- 远程会话配置。
- 文件管理中的业务文件。
- 审计日志。

systemd 部署后，在安装目录执行：

```bash
cd /opt/server-portal
sudo ./factory-reset.sh
```

如果要跳过交互确认：

```bash
cd /opt/server-portal
sudo ./factory-reset.sh --yes
```

恢复完成后，系统会重新启动，再次访问页面时可以重新注册首位管理员。

## 9. 重要数据备份

建议定期备份：

- `/opt/server-portal/data/portal.sqlite3`
- `/opt/server-portal/data/portal.sqlite3-wal`
- `/opt/server-portal/data/portal.sqlite3-shm`
- `/opt/server-portal/data/remote-master.key`
- 文件管理目录，例如 `/opt/server-portal/data/files` 或自定义 `--file-root`
- `/opt/server-portal/config/local.json`

尤其要保护 `remote-master.key`。如果丢失，已经保存的远程会话密码或私钥将无法解密。

## 10. 常见问题

### 远程会话想连接 Web 服务器本身，主机地址怎样填

如果 Node.js 应用就运行在这台云服务器上，远程会话里建议这样配置：

```text
连接方式：直接连接
主机地址：127.0.0.1
端口：22
登录用户名：服务器上的 SSH 用户，例如 qtest 或 root
认证方式：密码或私钥
```

不要优先填写云服务器公网 IP。因为 SSH 连接是由服务器后端发起的，访问自己时走 `127.0.0.1` 最稳定，也不会绕公网一圈。

如果你确实需要让“直接连接”允许某个公网 IP 或域名，例如云服务器公网 IP `203.0.113.10`，部署时可以显式加入白名单：

```bash
sudo ./deploy-systemd.sh \
  --domain portal.example.com \
  --cert-file /etc/ssl/portal/fullchain.pem \
  --key-file /etc/ssl/portal/privkey.pem \
  --allow-public-direct-hosts 203.0.113.10,portal.example.com
```

也可以在 `/opt/server-portal/config/local.json` 中配置：

```json
{
  "remote": {
    "allowPublicDirectHosts": ["203.0.113.10", "portal.example.com"]
  }
}
```

修改配置后重启服务：

```bash
systemctl restart server-portal
```

### 访问 HTTPS 页面时远程终端连不上

远程终端使用 WebSocket。Nginx 配置必须包含：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

部署脚本生成的 Nginx 配置已经包含这些配置。

### 上传大文件失败

需要同时检查两处限制：

- 应用参数：`--max-upload-bytes`
- Nginx 参数：`--client-max-body-size`

例如应用允许 100 MB，Nginx 也应设置为 `100m` 或更大。

### Node.js 版本过低

脚本会检查 Node.js 主版本。若低于 16，会停止部署。建议安装 Node.js 20 LTS 后重新执行部署脚本。

### 不想让普通用户看到服务器资源

部署时加：

```bash
--resources-admin-only
```
