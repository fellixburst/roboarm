# 在家中 Ubuntu 电脑运行模拟控制台

程序在 Ubuntu 本机运行后，浏览器的 `127.0.0.1` 才指向这套控制台。远程桌面只负责显示和操作 Ubuntu；请在远程桌面里的 Ubuntu 浏览器打开本机网页，而不是把云环境的内部地址当成家中电脑地址。

## 准备

需要 Git、Node.js 24 或更新版本及随附的 npm。无需 Python、GPU、串口、真实相机或电机。

```bash
node --version
npm --version
git --version
```

Node 主版本应至少为 24。如果缺少 Node 或版本较低，按 [Node.js 官方安装说明](https://nodejs.org/zh-cn/download) 安装 Node.js 24；已经安装 nvm 的用户可执行 `nvm install 24` 和 `nvm use 24`。Ubuntu 自带仓库中的 Node 版本不一定满足要求。缺少 Git 时可使用 Ubuntu 软件管理器安装 Git。

## 首次部署

在 Ubuntu 终端执行，仓库目录不要覆盖已有工作文件：

```bash
git clone --branch dev/m1-simulator https://github.com/fellixburst/roboarm.git
cd roboarm
bash scripts/start-local.sh
```

开发分支包含 3D、橙色球、坐标点动和双目模拟。启动脚本检查 Node 版本，在缺少依赖时执行 `npm ci --omit=dev`，然后启动控制服务。首次安装需要连接 npm 包仓库，安装后无需访问外部 CDN。

保持终端运行，在**同一台 Ubuntu 的浏览器**打开：

**http://127.0.0.1:3000**

应看到“RoboLab · 机器人模拟控制台”、3D 模拟空间、橙色橡胶球和双目视觉区域。先获取控制权，再启用设备。当前运行的仍是模拟器，不会自动连接家中的真实机械臂或相机。

如果希望手动执行，启动脚本等价于先安装运行依赖，再运行 `npm start`。不需要用 sudo 启动服务。

## 再次启动与更新

停止程序用原终端中的 Ctrl+C。再次启动：

```bash
cd roboarm
bash scripts/start-local.sh
```

更新代码前停止服务；保留自己的改动，不使用强制重置：

```bash
git pull --ff-only origin dev/m1-simulator
npm ci --omit=dev
bash scripts/start-local.sh
```

如果已有同名仓库，先执行 `git status` 和 `git branch --show-current` 确认目录及本地改动，避免重复克隆或覆盖。分支尚未合并前，应使用 `dev/m1-simulator`。

## 地址与故障排查

- 网页打不开：确认启动终端没有退出，查看它输出的错误。可在 Ubuntu 执行 `curl http://127.0.0.1:3000/api/health`，应返回 `mode:simulation`、`realHardware:false`。
- 提示端口被占用：用 `PORT=3001 bash scripts/start-local.sh`，然后打开 `http://127.0.0.1:3001`，不要直接关闭未知进程。
- 看见旧界面：先确认地址和启动目录，再强制刷新浏览器。GitHub 项目页、远程桌面监视页都不是机器人控制台。
- 3D 不可用：确认浏览器支持 WebGL，可尝试更新 Firefox/Chromium 或浏览器图形加速设置；二维设备反馈仍可使用。远程桌面的图形能力可能与 Ubuntu 本地显示器不同。
- 配置文件：首次启动不需要 `.env`。可以从 `.env.example` 复制后修改 `HOST`、`PORT`；启动终端中的环境变量优先。

默认只监听本机。若以后需要在同一家庭局域网的其他电脑或手机访问，可以另行设置 `HOST=0.0.0.0` 并使用 Ubuntu 的局域网 IP。当前版本没有生产认证，不要直接配置路由器公网端口映射。
