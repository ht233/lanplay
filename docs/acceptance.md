# LanPlay 验收报告

> 本报告记录当前版本（v1.0.0）的验收结论与实测证据。

测试环境：Windows 11 Pro（Ryzen 5 5500，12 逻辑核 / 8 GB 内存，无独立 GPU）＋ Android TV 9 模拟器（API 28 / 1280×720，与目标机小明 Q1 同档）；版本：服务端 / 客户端 1.0.0。

## 一、PRD 验收项

| # | PRD 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 服务端解压后可启动 GUI，能添加单文件、多文件、文件夹、整盘及网络路径引用 | ✅ 通过 | `dist\LanPlay-win64\LanPlay.exe` 双击启动；粘贴路径 /「选择文件夹」/「选择文件」/ **全窗口拖拽** 四种方式均可添加；引用根支持禁用/移除/排序 |
| 2 | 客户端可通过自动发现或手动 IP 连接服务端，并列出服务端引用内容 | ✅ 通过 | UDP 52310 发现（含 MulticastLock）与手动地址；Android TV 9 模拟器实测：手动输入地址 + 配对码 → 进入浏览页列出引用根与文件；`ApiContractTest` / `UiBehaviourTest` 覆盖同一链路 |
| 3 | 播放高码率片源时由服务端转码推流，投影仪不直接解码原片且播放稳定 | ✅ 服务端侧通过 | `/api/play` 返回 `PLAYING`、`encoder=h264_mf`；ffmpeg 命令行含 `-readrate 1 -i <源> -c:v h264_mf -f hls`；HLS 分片持续生成（双端验证）。客户端只持有 `/hls/` URL，不接触源文件 |
| 4 | 遥控器可完成播放/暂停、快进快退、进度调整、倍速、选集、字幕/音轨切换 | ✅ 通过 | 模拟器实测（真实遥控器按键事件）：OK 呼出控制栏；进度条左右键步进、长按连发；倍速 2.0x 后服务端出现 `-readrate 2 / atempo=2`；音轨「✓国语 / English」切换生效；字幕正常渲染；HOME 回前台自动续播；退出后会话数归 0 |
| 5 | 服务端可调用 GPU/CPU 转码，支持字幕处理与会话释放 | ✅ 通过 | 启动日志「硬件编码可用：MediaFoundation H.264」；无独显时回退 libx264；文本字幕 `/api/subtitle/vtt` 返回 WEBVTT；图形字幕走 `overlay` 烧录；`/api/session/stop` 后进程结束、`sweep()` 20s 内回收 |
| 6 | 服务端为绿色免安装形态，默认配置可开箱使用 | ✅ 通过 | `dist\LanPlay-win64`（479 MB）整个文件夹拷贝即用；首次运行自动生成 `data\config.json`（默认端口 8099、maxSessions 2、H.264/4000k/自动分辨率）；端口占用自动顺延 |
| 7 | （追加需求）服务端支持亮色主题切换 | ✅ 通过 | 顶栏「☀ 亮色」按钮 / 设置页「外观」预览块 / `Ctrl+Shift+L`；深浅两套主题下各页面均可读；选择写入 localStorage 刷新后保持；「跟随系统」读取 `prefers-color-scheme` |

## 二、实测记录

### 服务端启动（便携版）

```
LanPlay 服务端启动 v1.0.0
初始配对码：******（可在设置中重新生成）
ffmpeg 9.1 已检测（LanPlay-win64\bin\ffmpeg.exe）
硬件编码可用：MediaFoundation H.264
监听 0.0.0.0:8099；局域网发现服务 UDP:52310
```

### 端到端播放（HTTP API）

```
POST /api/pair  {pin, name:"客厅投影仪"}        → token
GET  /api/roots                                  → [{id:"…", name:"samples"}]
POST /api/play  {rootId, path:"transcode_1080p_hevc.mkv"}
     → { state:"PLAYING", encoder:"h264_mf", hardware:true,
         playlist:"…/hls/<session>/g1/index.m3u8",
         subtitleTracks:[{kind:"embedded", label:"chi", url:"/api/subtitle/vtt?…"}],
         audioTracks:[{label:"国语"},{label:"English"}] }
GET  /hls/<session>/g1/index.m3u8
     → #EXTM3U / TARGETDURATION:2 / PLAYLIST-TYPE:EVENT / seg00000.ts …
POST /api/session/seek   {position:12}  → gen=2, offset=12
POST /api/session/speed  {speed:2}      → gen=3
POST /api/session/audio  {index:1}      → gen=4, audioIndex=1
POST /api/session/stop                  → 会话结束，历史记录「正常」
```

### 客户端 APK 校验

```
package: com.lanplay.client  versionName=1.0.0
LEANBACK_LAUNCHER + LAUNCHER 双入口，touchscreen required=false
```

## 三、客户端验证

Android TV 9 模拟器（1280×720 / 213dpi）跑通「连接 → 浏览 → 播放 → 控制栏 → 进度条 → 倍速 →
音轨 → 字幕 → HOME 恢复 → 退出释放」全流程；同时保留 Robolectric（JVM 加载真实 Android 9 运行时）自动化回归：

| 测试类 | 用例 | 结果 |
|---|---|---|
| SmokeTest（运行时/布局/控件） | 4 | ✅ |
| ApiContractTest（真实服务端 API 契约） | 7 | ✅ |
| UiBehaviourTest（Activity 启动/按键/跳转） | 7 | ✅ |
| SeekTimelineTest（HLS 时间轴换算） | 4 | ✅ |
| EdgeCaseTest（异常与边界） | 10 | ✅ |
| TargetDeviceTest（API 28/低内存/非触摸） | 5 | ✅ |
| **合计** | **37** | **0 失败** |

Android Lint：**0 error**。模拟器实测暴露的问题（seek 时间轴、字幕不显示、Activity 栈堆积、焦点闭环等）
均已修复，详见 [android-verification.md](android-verification.md)。

## 四、未验证项与风险

1. **Android 实机**：模拟器已覆盖主要交互路径，但**尚未在真实小明 Q1 上回归**。建议实机重点验证：拖动进度条、按 HOME 后回前台、字幕字体大小。
2. **无线带宽**：1080p@4 Mbps 在 2.4G 拥挤环境下可能抖动；建议客户端设置里降到 2500 kbps / 720p。
3. **图形字幕**：PGS 烧录需要 `-filter_complex overlay`，在 4K 源上会增加 CPU，需实测。
4. **签名**：release APK 使用 debug keystore，正式分发前需替换。

## 五、补充 31：控制栏驻留 / 双击退出 / 触屏支持

**需求**：① 控制栏焦点移动时不自动隐藏，停止操作后才计时；② 播放页与主界面 2 秒内双击 BACK 才退出；③ 增加触屏支持（手机上无响应），且不许改坏遥控器逻辑。

**实现**：
- 控制栏驻留：scheduleControlsHide(delay) 统一计时——焦点在控制栏内且按钮行可见（操作中）时挂起倒计时，焦点离开或停止操作后重新计时；到期回调重查焦点再决定续期或隐藏（修复第一版「呼出瞬间焦点未生效被误判」的 bug）。
- 双击退出：PlayerActivity/BrowseActivity 根目录 2 秒窗口内双击 BACK 才退出，首次按下单弹提示；子目录 BACK 仍为返回上级。
- 触屏：item_media*.xml 移除 ocusableInTouchMode（列表首点即点击）；PlayerView 点击切换控制栏显隐；TvSeekBar 新增 onTouchEvent（DOWN/MOVE/UP 映射进度，equestDisallowInterceptTouchEvent 防滚动拦截）。遥控器按键路径全部独立，未改动。

**验证**：
- 控制栏：呼出后焦点移动持续操作不隐藏 ✔；OK 点按后进入轻量态 2s 隐藏 ✔；无操作 2s 自动隐藏 ✔（补充 34 由 3.4s 调整为 2s）。
- 双击退出：主界面 BACK#1 停留 + 窗口内 BACK#2 退出 ✔；超窗口 BACK#2 仅提示 ✔；播放页 BACK#1 停留 / BACK#2 回浏览页 ✔。
- 触屏（模拟器）：列表 tap 直接进播放页 ✔；tap 画面呼出/再点隐藏控制栏 ✔；tap 控制栏按钮（30s 步进）生效 ✔；tap 进度条定位跳转（00:00→01:42/03:00）✔。连续 swipe 拖动逻辑同 ACTION_MOVE 代码路径，模拟器时序（2s 自动隐藏 + swiftshader 截图延迟）难以稳定演示，待真机复验。
- 遥控器回归：五键操作、焦点闭环、双击退出与触屏互不干扰 ✔。
- 单测 37/37 通过（rowseActivityBackFromSubdirGoesToParent 改为双击语义两段断言）；ssembleRelease exit=0（APK 6,498,404B）。
- 服务端回归：server-test 84/84、server-edge 27/27、burn-smoke 3/3 PASS。
- 产物：dist 478.7MB；LanPlay-1.0.1-win64+apk.zip 201,688,505B（102 entries：LanPlay.exe 188,614,144B / ffmpeg.exe 110,590,976B / APK 6,498,404B）。
## 六、补充 32：短视频「播放一两秒就跳下一集」修复

**现象**：部分 30-40s 的 mp4（h264+aac）起播 1-2 秒后自动结束并连播下一集，连环跳完整个目录（用户实测 F:\问题视频 4 连跳）。ffprobe 确认文件编码正常——非格式问题。

**根因**：直通封装的 ffmpeg 参数 -readrate_initial_burst 40 允许前 40 秒数据不限速突发读取；短视频总时长落在 40s 突发窗口内，-readrate 1 实时限速从未生效 → ffmpeg 0.8 秒写完全部分片退出 → 服务端按「播放到片尾」结束会话 → 客户端刚缓冲到第一二个分片就会话被清 → 连播下一集。长视频（>40s）不受影响：40s 突发后限速接管。手动计时实验：burst=40 时 speed=40.8x/0.82s 写完 28.9s 片；burst=5 时 speed=1.21x/24s——实锤。

**修复**（server/core/transcode.js）：突发窗口钳制到视频时长的 60%（保底 5s）：时长 ≥67s 的视频维持 40s burst 不变（起播速度不受影响）；短视频按 0.6×duration 突发，readrate 1 提前接管限速，ffmpeg 存活至客户端接近片尾才退出。

**验证**：
- 1.mp4（28.9s）：burst 钳制为 17.35s（日志确认）→ 客户端持续播放至片尾 00:28/28s 自然结束回浏览页 ✔（修复前 1-2s 被踢）。
- long_3min.mkv（180s）：burst=40 维持不变 ✔，播放正常。
- 服务端回归：server-test 84/84、server-edge 27/27、burn-smoke 3/3 PASS。
## 七、补充 33：控制栏驻留判定重写 / 循环关闭即停 / 短视频提前断流根治

**用户反馈三问题**：① 控制栏左右移动焦点后停止操作仍不自动隐藏（一直显示）；② 「循环」关闭后播完仍连播下一集；③ 短视频播放约 10 秒就结束跳下一集，时长随视频长短增减（补充 32 的钳制修复只解决了一半）。

**根因与修复**：
- ①「停止操作」原判定 = 焦点是否在控制栏内——焦点停在按钮上不动 ≠ 正在操作，倒计时被无限挂起。重写为 lastInteractionAt（最后按键时刻）基准：呼出即计时，任何按键刷新时刻，到期（完整态 2s/轻量态 2s）无新交互才隐藏。
- ② onPlaybackEnded 在 loopMode=off 时也走 playNext()。改为 off/未设置 → 保存进度 + 停会话 + 退出播放页。
- ③ 决定性实验：-readrate_initial_burst 一旦设置，-readrate 1 在直通模式下**全程失效**（burst=18.6 → speed=2.51x；无 burst → speed=1.02x 完美实时；但无 burst 起播要等 20s+——burst 是起播必需）。真正的问题是 ffmpeg 写完全片退出后会话被置 ENDED → 客户端 pos 才 1/3 就被轮询踢去连播。修复：close 分支「写完全部内容」时**保持 PLAYING**（proc=null），客户端把磁盘上已就绪的全部分片播完，由 ExoPlayer STATE_ENDED 本地触发连播/结束；.ts 分片请求也刷新会话活跃度（ExoPlayer 对 event 型 m3u8 只拉一次，分片请求是缓冲期唯一活性证据）；idle 清扫条件覆盖「无进程但有观众」的会话。

**验证（模拟器 E2E）**：
- ③ 2.mp4（31s）：起播 → 30s 后仍 PLAYING（修复前 15s 就跳走）→ 35s 完整播完即停回列表；服务端日志链「新建 → 写完全部内容，等待客户端播完 → 会话停止：客户端停止」。
- ① 轻量态（scrub 进度条）2s 隐藏 ✔；MENU 呼出完整控制栏 → 停 5s → 自动隐藏 ✔。
- ② 循环:列表 → long_3min 播完自动切下一集 ✔；切回循环:关闭 → scrub 至近片尾 → 播完即停回列表（不连播）✔。
- 回归：Android 单测 37/37、APK 6,498,341B；server-test 84/84、server-edge 27/27、burn-smoke 3/3 PASS。
- 产物：dist 478.7MB；LanPlay-1.0.1-win64+apk.zip（102 entries，包内 transcode.js 含修复确认；控制栏 2s 调整后随 v1.0.1 资产一并更新）。