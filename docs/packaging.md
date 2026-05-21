# Panel 打包发布

## 当前方案（v1.0）· electron-builder

```bash
npm run package    # macOS 不签名快测（out/mac-arm64/Xikely.app）
npm run dist       # macOS 完整签名打包（需 Apple Developer 账号 + .p12）
npm run dist:all   # 全平台 mac/win/linux
```

### 实测（2026-05-21）
- 打包成功 ✅
- `Xikely.app` 真能 open 启动
- 启动后 3 个进程（electron 主进程 + server.js 子进程 + Renderer）
- 体积 **304MB**（electron 自带 chromium runtime，已知限制）

### 已知问题
- 体积大（304MB）— 卖给普通用户下载体验差
- arm64 要求签名（需 Apple Developer Program $99/年）
- 启动比纯 web 慢 ~2-3 秒（electron 初始化）

## 未来方案（v2.0）· Tauri

迁移 Tauri 后预期：
- 体积 **~20MB**（缩小 15×）
- 启动 **~1s**
- 主进程 Rust 比 Node 内存少 60%

### 迁移工作量评估
1. `cargo install tauri-cli` ✅ 已有
2. `tauri init` 生成 `src-tauri/` 目录
3. 改 `tauri.conf.json`：
   - 用 `localhost:51735` 作 webview URL
   - sidecar 方式 spawn `node server.js`（Tauri 2 支持）
4. 写 `src-tauri/src/main.rs`（~50 行 Rust）spawn + lifecycle
5. 测 4 房模式 + MCP + autopilot 全 work
6. `tauri build --target universal-apple-darwin`

工作量：**2-3 天专注期**

### 折中方案（v1.5 中间态）

如果 v2.0 迁 Tauri 风险大，可用：
- **electron-builder 减包配置**：strip node_modules / 排除不必要 locales
- 体积可从 304MB 降到 ~150MB（仍大）
- 适合内测，不适合公开下载

## 上架渠道（v1.0）

1. **GitHub Releases**（免费）：build .app 上传，让用户自己下载
   - 缺点：用户绕过 Gatekeeper 警告
   - 优点：免费 + 用户能看到源码
2. **Mac App Store**（$99/年）：需完整签名 + 公证
3. **Setapp** ($9.99/月 用户订阅）：垂类 macOS 工具集合
4. **官网直分发** ：自建 download 页 + Sparkle/electron-updater 自动更新

## 当前推荐路径（v1.0 → v1.5 → v2.0）

| 版本 | 渠道 | 体积 | 用户群 |
|---|---|---|---|
| v1.0 | GitHub Releases unsigned | 304MB | 开发者早期用户（能绕过 Gatekeeper）|
| v1.1 | + Apple Developer 签名 | 304MB | 普通 macOS 用户 |
| v1.5 | 同上 + electron-updater 自动升级 | 304MB | 同上 + 留存 |
| v2.0 | 迁 Tauri 重新打包 | ~20MB | 大众市场（含 Windows / Linux）|

## 上架前 checklist

- [ ] 装 .icns / .ico app icon（当前用 electron 默认）
- [ ] 写 LICENSE 文件（决定 MIT / GPL / 商业 License）
- [ ] README 加截图 + 5 分钟 demo 视频
- [ ] 隐私政策（如开启 telemetry）
- [ ] 代码签名（Apple Developer ID）
- [ ] 公证（macOS Gatekeeper 不弹警告）
- [ ] 自动更新 endpoint（GitHub Release latest.json）
