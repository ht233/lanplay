# LanPlay 技术方案说明

本文档面向开发/评审，说明关键选型、模块划分、数据流与已知取舍。

## 1. 总体架构

```
┌──────────────────────────── Win64 电脑（服务端）────────────────────────────┐
│  Electron 主进程                                                            │
│   ├── GUI (HTML/CSS/JS)  ← HTTP → 内置 HTTP Server (127.0.0.1:端口自动顺延) │
│   └── LanPlayServer 核心                                                    │
│         ├── Config         data\config.json（便携）                         │
│         ├── Library        引用根 + 目录遍历 + ffprobe 元数据缓存           │
│         ├── Watcher        被浏览目录 fs.watch 监听 → 媒体库变更通知        │
│         ├── Ffmpeg         路径定位 / 编码器检测 / 硬件试转 / probe         │
│         ├── SessionManager 并发上限、会话历史、90s 无人拉流回收             │
│         ├── TranscodeSession 一个 ffmpeg 进程 + 一代 HLS 目录               │
│         ├── ClientRegistry 配对码 → token、心跳、踢出                       │
│         ├── Discovery      UDP 52310 广播发现                               │
│         └── Metrics        CPU / 内存 / GPU 采样                            │
└─────────────────────────────────────────────────────────────────────────────┘
             ▲  HTTP (JSON + HLS)，局域网，可选 token
             │
┌────────────▼──────────── Android 投影仪 / TV（客户端）─────────────────────┐
│  ConnectActivity   UDP 发现 + 手动地址 + 配对                                │
│  BrowseActivity    引用根 / 目录浏览（遥控器焦点导航）                       │
│  PlayerActivity    ExoPlayer(Media3) + HlsMediaSource + TvSeekBar           │
└─────────────────────────────────────────────────────────────────────────────┘
```

**为什么是 HLS**：客户端是低性能 Android 投影仪，使用 ExoPlayer 内置 HLS 支持即可，不需要额外协议栈；2 秒分片在局域网内起播约 2~4 秒、拖动重开约 1~2 秒，兼顾兼容性与延迟。LL-HLS/WebRTC 可作为后续增强（接口已按「会话 + 播放列表 URL」抽象，替换实现不影响客户端调用方式）。

## 2. 转码与会话模型

**每会话一个 ffmpeg 进程 + 一份 HLS 目录**：

```
data\hls\<sessionId>\g<generation>\
    index.m3u8        # event 型播放列表，持续追加
    seg00000.ts ...
```

- 启动：`ffmpeg -readrate 1 -ss <offset> -i <file> ... -f hls ...`
  - `-readrate` 让 ffmpeg 按实时速度出片，避免一次转完整部片（省 CPU、省磁盘、支持随时 seek）；`-readrate_initial_burst 40` 让起播窗口先多存货。
  - `-hls_playlist_type event` + `-hls_list_size 0`：分片只追加不删除，客户端可回看已转码部分。
  - 音频全路径挂 `aresample=async=1:first_pts=0`：源音频轨晚于视频开始（音画起点错位）时自动前置静音填充，避免播放器音频时钟无数据冻结。
- **seek / 倍速 / 音轨 / 字幕切换**：统一做法是 kill 当前 ffmpeg，`generation += 1`，用新参数和新目录重新起转码。客户端发现 `gen` 变化即重新 `setMediaSource` 并 `seekTo(服务端 position)`。
  - 优点：实现简单、状态可预测、不会出现「seek 后音画不同步」。
  - 代价：每次切换有 1~2 秒重缓冲；旧 generation 目录保留一代便于回退，更早的自动清理。
- **硬件优先**：启动时用 0.4 秒黑帧对 NVENC / QSV / AMF / MediaFoundation 逐个真实试转（仅看 `-encoders` 列表不够，很多机器列出编码器但无可用硬件；微软系统 MFT 编码器按软件编码归类）；会话若硬编失败，`fallbackTried` 标记后自动以 libx264 重开一次。
- **低码率直通**：H.264/HEVC + ≤1080p + ≤8Mbps 三重约束同时满足时 `-c:v copy` 直通（音频仍转 AAC）；倍速≠1 / 字幕烧录 / 显式输出参数 / 直通开关关闭时自动回退转码。
- **字幕**：
  - 文本字幕（SubRip/ASS/WebVTT）→ 服务端用 ffmpeg 转成 WebVTT 缓存到 `data\cache\subs`，客户端作为 `SubtitleConfiguration` 加载，清晰且不吃转码性能；倍速会话按 `(t - start) / speed` 缩放 cue 保证字幕跟随。
  - 图形字幕（PGS/DVD/VobSub）→ 无法轻量渲染，改由服务端 `[0:v]...overlay[0:s:N]` 烧录进视频流。

## 3. 接口与鉴权

- 客户端首次 `POST /api/pair {pin, name, model}` 换取 `token`（30 天），之后所有请求带 `X-LanPlay-Token`。
- `requirePin=false` 时为「局域网信任模式」，无需配对。
- 客户端每 4s 轮询 `GET /api/sync?since=<version>` 做增量同步：媒体库版本号变化（含被浏览目录的 fs.watch 触发）时才重拉列表。
- 缩略图 `GET /thumb/<rootId>/<path>?t=<秒>`：服务端 ffmpeg 抽帧 + 磁盘缓存（480px），列表页不再直读原图。
- `/api/gui/*`（管理接口：改设置、踢客户端、结束会话、打开目录等）**只允许回环地址**，避免局域网任意设备改配置；非本机来源打开管理页会看到明确提示卡。
- `/hls/*` 分片不做鉴权（局域网内随机 sessionId 难以猜测），换取播放器实现简单；如需更严格可给 m3u8 URL 追加签名参数。

## 4. 客户端要点

- **遥控器优先**：所有可点元素都 `focusable`，焦点态由 `bg_focusable` / `bg_list_item` 提供高对比描边；进度条为自绘控件（`TvSeekBar`），左右键步进 10 秒，长按 280ms 后每 110ms 连发；控制栏 5 秒无操作自动隐藏，任意方向键/OK/菜单键呼出。
- **只拉流不解码原片**：客户端从不访问 SMB/本地磁盘，所有播放内容都来自 `/hls/`。
- **状态以服务端为准**：播放页每秒轮询 `/api/session/state`，服务端 ENDED/ERROR 时立即提示，避免客户端「假播放」。
- **续播**：客户端本地按 `rootId + path` 存播放位置（`lanplay_resume` SharedPreferences）。
- **媒体源排序**：客户端本地九档（添加顺序/名称±/时间±/大小±/类型±），与服务端 GUI 各自独立。

## 5. 服务端管理页

Electron GUI 共五个标签页（仅服务端本机可访问）：

| 标签页 | 功能 |
|---|---|
| 媒体源 | 引用管理（输入/选择/拖拽导入）、启停/移除/清空、排序、目录浏览、**预览**（调 Windows 系统默认播放器直接打开原文件）、定位 |
| 转码会话 | 实时进度条、直通/GPU/CPU 三态徽章、手动停止、最近会话历史 |
| 客户端 | 在线状态、心跳、踢出 |
| 日志 | 实时滚动、关键字过滤、导出、清空 |
| 设置 | 转码参数（码率/分辨率/画质/直通开关）、端口、发现开关、PIN、主题（深色/亮色/跟随系统） |

## 6. 已知限制 / 后续可做

| 项 | 现状 | 评估 |
|---|---|---|
| 播放协议 | HLS（mpegts, 2s 分片，EVENT 型可回看已转码部分） | **暂不加 LL-HLS/HTTP-FLV**：家庭观影对 2-4s 延迟不敏感；LL-HLS 需要 ffmpeg part 分片支持（尚不完整）且牺牲回看优势；HTTP-FLV 需客户端换解封装库。协议层已按「会话 + 播放列表 URL」抽象，将来要换实现不影响客户端调用方式 |
| 倍速 | 服务端重开转码（1.0/1.25/1.5/2.0，atempo 链） | **维持重开方案**：切换 1-2s 黑屏在遥控器操作频率下可接受；`-vf` 是启动参数无法进程内动态改，「预生成多速度流」磁盘/转码成本翻倍，家庭场景不值 |
| 图形字幕 | 服务端 libass/overlay 烧录，切换需重开转码 | **维持烧录方案**：sup 预生成 = 提前完整渲染一遍字幕轨，磁盘/CPU 成本高，收益仅少 1-2s 切换黑屏 |
| 多客户端同片 | 各自独立会话（各自转码） | **维持独立会话**：共享流会让一台设备的 seek/倍速/字幕影响另一台，需引入引用计数 + 控制者状态机；家庭 1-2 台设备场景收益不抵复杂度 |
| 客户端验证 | Android 模拟器已回归主要交互路径 | 待真实小明 Q1 实机验证，清单见 android-verification.md 第六节（需实体设备） |
| 安装包签名 | release 使用 debug 签名 | 自装自用不影响功能；正式分发时再生成 keystore + gradle signingConfig（密码走环境变量不入库） |
