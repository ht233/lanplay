# Android 客户端验证报告

> 目标设备：小明 Q1（峰米）· FengOS · Android 9.0 · Amlogic T972 · 2GB RAM / 8GB 存储

## 一、结论摘要

| 项目 | 结果 |
|---|---|
| Android TV 模拟器实测 | ✅ **已跑通**（Android TV 9 / API 28 / 1280×720 / 213dpi，与目标机同代） |
| 自动化回归（Robolectric / Android 9 运行时） | ✅ 37 个测试全部通过 |
| Android Lint | ✅ 0 error |
| 编译 | ✅ debug + release 均成功，release APK 约 6.2 MB |
| 端到端流程 | ✅ 连接 → 浏览 → 播放 → 控制栏 → 进度条 → 倍速 → 音轨 → 字幕 → HOME 恢复 → 退出释放 |

**尚未在真实小明 Q1 上回归**，实机清单见第六节。

## 二、模拟器环境

宿主机需开启嵌套虚拟化（DISM 启用 `HypervisorPlatform` + `VirtualMachinePlatform`，重启后 WHPX 生效）：

```powershell
$env:JAVA_HOME="<JDK 目录>"
$env:ANDROID_SDK_ROOT="<SDK 目录>"
$env:ANDROID_AVD_HOME="<AVD 目录>"
& "$env:ANDROID_SDK_ROOT\emulator\emulator.exe" -avd tv9 -no-window -no-audio `
    -no-boot-anim -gpu swiftshader_indirect -no-snapshot -memory 3072
```

判据不要用 `sys.boot_completed`（TV 镜像恒为空），改用
`adb shell service check package` 返回 `found`，或 `dumpsys window | grep mCurrentFocus`。

| 参数 | 值 |
|---|---|
| AVD | `tv9`（Android TV 9 / API 28 / x86） |
| 分辨率 / 密度 | 1280×720 / 213 dpi（与小明 Q1 同档） |
| CPU / 内存 | 6 核 / 3072 MB |
| GPU | swiftshader_indirect（`-gpu guest` 会让 surfaceflinger 崩溃） |

## 三、Robolectric 自动化回归（37 个用例，全部通过）

| 测试类 | 用例数 | 覆盖内容 |
|---|---|---|
| `SmokeTest` | 4 | API 28、5 个布局 inflate、控件完整性 |
| `ApiContractTest` | 7 | 真实打服务端：配对、错误 PIN、roots、browse、media、play+seek+speed+stop、字幕 VTT、未知会话 404 |
| `UiBehaviourTest` | 7 | 三个 Activity 真实启动、配对后跳转、列表加载、返回层级、TvSeekBar 按键与长按、播放页起播 |
| `SeekTimelineTest` | 4 | offset 字段、seek 后时间轴归零、前后跳一致性 |
| `EdgeCaseTest` | 10 | 死端口、越权 4xx、缺文件 404、无 token 401、失效 token、并发上限、seek 夹紧、设备名持久化、发现空列表 |
| `TargetDeviceTest` | 5 | API 28 可用性、非触摸、2000 条模型内存、字幕 VTT MIME、HLS 分片可下载 |

测试会自动探测 `127.0.0.1:8099`，服务端未启动时跳过网络相关用例。

## 四、模拟器实测发现并修复的问题

### 严重（会导致播放不可用）

| # | 问题 | 修复 |
|---|---|---|
| 1 | seek 后播放跳飞（服务端重启 ffmpeg 后 HLS 时间轴归零） | 客户端 seek 后 `seekTo(0)`，UI 仍显示绝对位置 |
| 2 | 字幕选中却不显示（`HlsMediaSource` 忽略 `SubtitleConfigurations`） | 改用 `DefaultMediaSourceFactory` 合并外挂 VTT |
| 3 | 空 RecyclerView 霸占初始焦点 | 空列表不可聚焦，焦点交给地址输入框 |
| 4 | 控制栏隐藏后焦点丢失 | 隐藏前把焦点还给根布局 |

### 中等（影响手感与稳定性）

| # | 问题 | 修复 |
|---|---|---|
| 5 | 软键盘自动弹出遮半屏 | `stateAlwaysHidden` + 按 OK 才弹 + 返回键先收键盘 |
| 6 | EditText 吞方向键 | `TvEditText` 让上下键直接换焦点 |
| 7 | Activity 栈无限堆积 | `CLEAR_TOP\|SINGLE_TOP` + 连接页 `finish()` + `onNewIntent` |
| 8 | HOME 后服务端仍在转码占并发 | `onStop` 停会话，回前台用 `serverPos` 续播 |
| 9 | 断线后界面不提示一直转圈 | 轮询连续失败 5 次给出可读提示 |
| 10 | 起播等待偏长 | 服务端 `-readrate_initial_burst` 预读，首片 0.6s 出来 |
| 11 | 长 GOP 片源分片变 10 秒 | `-force_key_frames` 强制对齐 2 秒 |

### 轻微（体验优化）

| # | 问题 | 修复 |
|---|---|---|
| 12 | 字幕贴底部被控制栏挡住 | 上移 16%、26sp、白字黑描边 |
| 13 | 播放列表没有「下一个」 | 可切上/下集，支持 `KEYCODE_MEDIA_NEXT/PREVIOUS` |
| 14 | 倍速按钮文字不刷新 | 切换后同步更新按钮文案 |

后续迭代修复的焦点导航（弹窗后焦点保持原位、进入目录定位第一条、左栏焦点闭环）、缩略图串位、
倍速字幕同步等问题不再单列，见 acceptance.md。

## 五、性能实测（本机软编，非投影仪）

| 场景 | 结果 |
|---|---|
| 1080p → 1080p / libx264 faster / 4000k | 5.04× 实时（20s 片用 4.0s） |
| 1080p → 720p / veryfast / 2500k | 11.45× 实时（1.7s） |
| 4K → 1080p | 6s 片用 1.8s |
| HLS 起播 | API 0.44s 返回，0.6s 首片，1.6s 三片 |
| seek 响应 | gen 递增 + 新分片，约 1–2 秒 |

## 六、实机测试建议清单

在小明 Q1 上优先验证：

1. **连接页**：初始焦点是否在地址输入框、上下键能否逐级移动、键盘是否只在按 OK 时弹出。
2. **拖动进度条**：呼出控制栏 → 上键进进度条 → 左右键步进 / 长按连发，确认画面跟随。
3. **按 HOME 再回前台**：确认自动续播到离开时的位置，且服务端会话数先归 0 再重新拉起。
4. **字幕**：选一条文本字幕，确认底部出现文字且不被控制栏遮挡。
5. **倍速**：切 2.0x，确认画面加速且音画同步。
6. **音轨**：多音轨片源切换，确认声音变化。
7. **退出释放**：返回键退出播放页，确认服务端会话数归 0。
8. **弱网/断线**：拔网线或关服务端，确认给出可读提示而非一直转圈。
9. **长片**：≥1 小时片源，确认长时间播放不累积延迟。
10. **绿色版**：解压到 U 盘/其他分区，确认双击 `LanPlay.exe` 能起、端口自动顺延。

## 七、复现命令

```powershell
# 1. 启动服务端（开发模式）
$env:LANPLAY_ROOT="<项目目录>"
node server/standalone.js

# 2. 跑全部客户端测试
cd android
gradle.bat --no-daemon :app:testDebugUnitTest

# 3. Lint / 出包
gradle.bat --no-daemon :app:lintDebug
gradle.bat --no-daemon :app:assembleRelease

# 4. 模拟器上装包
adb install -r dist\LanPlay-Client-1.0.0.apk
adb reverse tcp:8099 tcp:8099
adb shell monkey -p com.lanplay.client -c android.intent.category.LAUNCHER 1
```
