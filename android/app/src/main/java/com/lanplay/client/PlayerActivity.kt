package com.lanplay.client

import android.annotation.SuppressLint
import android.graphics.Color
import android.net.Uri
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import androidx.annotation.OptIn
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.text.TextOutput
import androidx.media3.exoplayer.text.TextRenderer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.source.MergingMediaSource
import androidx.media3.exoplayer.source.SingleSampleMediaSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.common.Tracks
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.core.content.ContextCompat
import com.lanplay.client.databinding.ActivityPlayerBinding
import com.lanplay.client.databinding.ItemMediaBinding
import com.lanplay.client.model.BurnSubtitle
import com.lanplay.client.model.PlayResult
import com.lanplay.client.model.SubtitleTrack
import com.lanplay.client.net.LanPlayApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * 播放页：只播放服务端转码后的 HLS 流，
 * 所有 seek / 倍速 / 音轨 / 图形字幕切换都通过服务端会话参数实现。
 *
 * 时间轴约定（重要）：
 * 服务端每次 seek/切轨/变速都会重启 ffmpeg 并生成新的 HLS 目录，
 * 新播放列表的时间轴**从 0 开始**，对应媒体文件的 `offset` 秒。
 * 因此：
 *   - 对播放器 seek 必须用相对位置 `position - offset`
 *   - 界面上显示、续播记录必须用绝对位置 `position`
 */
@OptIn(UnstableApi::class)
class PlayerActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_ROOT_ID = "rootId"
        const val EXTRA_PATH = "path"
        private const val POLL_FAIL_LIMIT = 5
    }

    private lateinit var binding: ActivityPlayerBinding
    private lateinit var api: LanPlayApi
    private var player: ExoPlayer? = null

    private var rootId: String = ""
    private var relPath: String = ""
    private var sessionId: String = ""
    private var duration: Double = 0.0
    private var currentSpeed = 1f
    private var currentGen = -1

    /** 当前 HLS 流的时间轴起点（媒体绝对秒数） */
    private var streamOffset = 0.0

    /** 媒体绝对位置（秒），用于显示、续播、步进 seek */
    private var serverPos = 0.0

    /** 步进/拖动 seek 已提交但新流尚未生效时，暂停用本地进度回写 serverPos */
    private var pendingSeek = false

    /** 从后台返回时需要重新拉起会话 */
    private var backgrounded = false

    private var selectedSubtitle: SubtitleTrack? = null
    private var burnSubtitle: BurnSubtitle? = null
    /** 用户是否在菜单里显式选了「关闭字幕」：自动默认字幕不应再覆盖这个决定 */
    private var subtitlesExplicitlyOff = false

    private var pollJob: Job? = null
    private var seekJob: Job? = null
    /** A-6：IO 错误静默重建的时间戳窗口（60s 内 ≥3 次 → 弹错误放弃） */
    private val ioRebuildStamps = mutableListOf<Long>()
    private var hintJob: Job? = null

    private val handler = Handler(Looper.getMainLooper())
    private val hideControlsRunnable = Runnable { hideControlsNow() }
    private val hideTitleRunnable = Runnable { binding.title.visibility = View.GONE }
    /** seek 提交成功、正在切换新流：播放器位置还是旧流的，ticker 暂不更新显示（防回跳） */
    private var switchingStream = false
    private val ticker = object : Runnable {
        override fun run() {
            val p = player
            if (p != null && sessionId.isNotBlank()) {
                val local = p.currentPosition / 1000.0
                // pendingSeekTarget != null 表示用户正在连续快进/快退（长按连发），
                // 此时进度条显示用户的累积目标，不能被真实播放位置覆盖，
                // 否则长按期间进度条会「往回跳」，看起来像没响应。
                // switchingStream = seek 提交成功但播放器还在播旧流缓冲：
                // 此时 local 是旧流坐标，配新 streamOffset 会算出回跳位置，同样跳过。
                val seeking = pendingSeekTarget != null || switchingStream
                if (local >= 0 && !seeking) {
                    serverPos = streamOffset + local
                    if (!dragging) {
                        binding.timeCurrent.text = BrowseActivity.formatDuration(serverPos)
                        binding.seek.progressValue = toProgress(serverPos)
                    }
                }
            }
            handler.postDelayed(this, 500)
        }
    }

    private var controlsVisible = true
    private var dragging = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityPlayerBinding.inflate(layoutInflater)
        setContentView(binding.root)
        api = LanPlayApi.get(this)
        rootId = intent.getStringExtra(EXTRA_ROOT_ID) ?: ""
        relPath = intent.getStringExtra(EXTRA_PATH) ?: ""
        // 当前源类型在 loadSiblings() 里顺带刷新（单文件源走虚拟列表连播）

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        enterImmersive()

        setupPlayer()
        setupControls()
        val resumeAt = getSharedPreferences("lanplay_resume", MODE_PRIVATE)
            .getFloat(resumeKey(), 0f).toDouble()
        startPlay(resumeAt)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val newRoot = intent.getStringExtra(EXTRA_ROOT_ID) ?: ""
        val newPath = intent.getStringExtra(EXTRA_PATH) ?: ""
        if (newRoot == rootId && newPath == relPath) return
        // 同一个播放页被复用去播另一部片：先停旧会话，再从头起播新片
        // A-3 补充：切片同时取消在途 seek/轮询并重置字幕状态（旧片的字幕轨选择不允许带进新片）
        seekJob?.cancel()
        seekJob = null
        pendingSeekTarget = null
        pendingBurnPath = null
        selectedSubtitle = null
        burnSubtitle = null
        subtitlesExplicitlyOff = false
        subtitleTracks = emptyList()
        endedHandled = false
        ioRebuildStamps.clear()
        stopSession()
        rootId = newRoot
        relPath = newPath
        serverPos = 0.0
        streamOffset = 0.0
        pendingSeek = false
        currentRootType = "dir" // loadSiblings 会按 roots 重新判定
        val resumeAt = getSharedPreferences("lanplay_resume", MODE_PRIVATE)
            .getFloat(resumeKey(), 0f).toDouble()
        startPlay(resumeAt)
    }

    private fun resumeKey(): String = "resume_${rootId}_${relPath.hashCode()}"

    // ---------------- 播放器 ----------------

    /**
     * Media3 1.4.x 默认关闭了「传统字幕解码」（TextRenderer.experimentalSetLegacyDecodingEnabled=false），
     * 只接受 `application/x-media3-cues`（预解析的 cues 格式）的样本。
     * 我们外挂的是标准 WEBVTT（`text/vtt`），直接喂进去会在 enableRenderers 时抛
     * `IllegalStateException: Legacy decoding is disabled, can't handle text/vtt samples`
     * → 整个播放失败（ERROR_CODE_FAILED_RUNTIME_CHECK）。
     * 这里自定义 RenderersFactory，在构建 TextRenderer 时显式打开传统解码。
     */
    private fun createRenderersFactory(): DefaultRenderersFactory {
        return object : DefaultRenderersFactory(this) {
            override fun buildTextRenderers(
                context: android.content.Context,
                output: TextOutput,
                outputLooper: android.os.Looper,
                extensionRendererMode: Int,
                out: ArrayList<androidx.media3.exoplayer.Renderer>
            ) {
                super.buildTextRenderers(context, output, outputLooper, extensionRendererMode, out)
                // 刚被 super 加进去的 TextRenderer 就是需要打开传统解码的那个
                for (r in out) {
                    if (r is TextRenderer) {
                        r.experimentalSetLegacyDecodingEnabled(true)
                    }
                }
            }
        }
    }

    private fun setupPlayer() {
        // 用显式 TrackSelector：外挂 VTT 轨的语言是 und，
        // 默认选择器在「只有一条字幕轨」时并不保证会打开它，
        // 这里在选中字幕后强制渲染该轨，关闭字幕时再关掉。
        val trackSelector = DefaultTrackSelector(this).apply {
            setParameters(buildUponParameters().setSelectUndeterminedTextLanguage(true))
        }
        player = ExoPlayer.Builder(this, createRenderersFactory()).setTrackSelector(trackSelector).build().also { p ->
            binding.playerView.player = p
            binding.playerView.setUseController(false)
            // 字幕默认贴在画面最底部，会被控制栏挡住；上移并放大，投影仪远距离可读。
            // 0.16 实测仍然贴边（用户反馈「离画面底部太近」），抬到 0.22（约画面高度的 1/5）。
            binding.playerView.subtitleView?.apply {
                setFixedTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 26f)
                setBottomPaddingFraction(0.22f)
                setStyle(
                    androidx.media3.ui.CaptionStyleCompat(
                        android.graphics.Color.WHITE,
                        android.graphics.Color.TRANSPARENT,
                        android.graphics.Color.TRANSPARENT,
                        androidx.media3.ui.CaptionStyleCompat.EDGE_TYPE_OUTLINE,
                        android.graphics.Color.BLACK,
                        null
                    )
                )
            }
            p.addListener(object : Player.Listener {
                override fun onPlayerError(error: PlaybackException) {
                    // 快速连按/会话被替换期间旧 gen 分片可能被服务端清理，
                    // 播放器吃到 404 就会报 IO 错误 —— 这类瞬时错误直接
                    // 静默重建会话恢复播放；真失败（如文件损坏）才弹错误框。
                    if (error.errorCode == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS ||
                        error.errorCode == PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND
                    ) {
                        lifecycleScope.launch {
                            // A-6：60s 窗口内连续 ≥3 次重建仍失败 → 放弃静默恢复，弹错误框
                            //（避免服务端长时间不可用时无限循环请求）
                            val now = System.currentTimeMillis()
                            ioRebuildStamps.removeAll { now - it > 60_000 }
                            ioRebuildStamps.add(now)
                            if (ioRebuildStamps.size >= 3) {
                                showError("与服务端连接异常（多次恢复失败）")
                                return@launch
                            }
                            val target = pendingSeekTarget ?: serverPos
                            pendingSeekTarget = null
                            pendingSeek = false
                            val ok = runCatching { rebuildSession(target) }.isSuccess
                            if (!ok) showError("播放出错：${error.errorCodeName}")
                        }
                    } else {
                        showError("播放出错：${error.errorCodeName}")
                    }
                }

                override fun onPlaybackStateChanged(state: Int) {
                    if (state == Player.STATE_READY) {
                        binding.loadingBox.visibility = View.GONE
                        // 新流已就绪：播放器坐标从此有效，解除 ticker 冻结
                        switchingStream = false
                        applySubtitleSelection()
                    } else if (state == Player.STATE_ENDED) {
                        onPlaybackEnded()
                    }
                }

                override fun onTracksChanged(tracks: Tracks) {
                    applySubtitleSelection()
                }
            })
        }
    }

    /**
     * 文本字幕走客户端渲染：选中轨道后必须在 TrackSelector 上显式指定，
     * 否则 Media3 会保持「字幕关闭」，用户点了字幕却什么也看不到。
     */
    private fun applySubtitleSelection() {
        val p = player ?: return
        val selector = p.trackSelector as? DefaultTrackSelector ?: return
        val params = selector.buildUponParameters()
        val sub = selectedSubtitle
        if (sub == null) {
            params.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
        } else {
            params.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                .setSelectUndeterminedTextLanguage(true)
                .setPreferredTextLanguage("und")
        }
        selector.setParameters(params)
    }

    /**
     * 组装播放源。
     *
     * 关键坑：`HlsMediaSource` 会**完全忽略** `MediaItem.SubtitleConfigurations`
     * （那个字段只有渐进式媒体源 MP4 等会读）。之前把外挂 VTT 挂在 HLS MediaItem 上，
     * ExoPlayer 从来不会去拉这个 URL —— 服务端日志里 `/api/subtitle/vtt` 请求数是 0，
     * 表现就是「字幕菜单有轨道、选了却什么也不显示」。
     *
     * 正确做法：HLS 主源 + `SingleSampleMediaSource`（把整条 VTT 当成一个外挂字幕样本）
     * 用 `MergingMediaSource` 显式合并，这样文字轨才真正进入播放器的轨道列表。
     */
    private fun mediaSource(playlistUrl: String, subtitle: SubtitleTrack?): MediaSource {
        val dataSource = OkHttpDataSource.Factory(api.http)
        // 显式建 HLS 源：不要再用 DefaultMediaSourceFactory 推断（它同样会吞掉字幕配置）。
        // chunkless 预备：只靠 media playlist 就能准备轨道信息，省掉
        // 「拉 m3u8 → 拉首片解析 → 才 READY」的一次串行等待（LAN ~200-500ms）。
        // 我们的流没有 master playlist（直接给 media playlist），chunkless 完全适用。
        val hlsSource = HlsMediaSource.Factory(dataSource)
            .setAllowChunklessPreparation(true)
            .createMediaSource(MediaItem.fromUri(Uri.parse(playlistUrl)))
        if (subtitle == null || subtitle.burn) return hlsSource
        // streamOffset 是当前流的时间轴原点：seek / 换轨 / 换音轨后服务端都会重启 ffmpeg，
        // 新 HLS 流从 0 开始，而字幕 cue 是原片绝对时间。不传这个偏移，拖动进度后字幕
        // 就会整体错位（表现为「字幕消失几十秒才出现」）。
        val subUri = Uri.parse(subtitle.absoluteUrl(api.baseUrl, api.token, streamOffset, currentSpeed.toDouble()))
        val subConfig = MediaItem.SubtitleConfiguration.Builder(subUri)
            .setMimeType(MimeTypes.TEXT_VTT)
            // language 必须是合法 ISO-639 码，否则 Media3 会丢弃该轨道；
            // 实际选哪条由 applySubtitleSelection() 强制指定
            .setLanguage("und")
            .setLabel(subtitle.label)
            .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
            .build()
        val subSource = SingleSampleMediaSource.Factory(dataSource)
            .setTreatLoadErrorsAsEndOfStream(true)
            .createMediaSource(subConfig, C.TIME_UNSET)
        return MergingMediaSource(hlsSource, subSource)
    }

    private fun startPlay(startAt: Double = 0.0) {
        endedHandled = false
        binding.loadingBox.visibility = View.VISIBLE
        binding.loadingText.text = "正在拉起转码…"
        binding.errorBox.visibility = View.GONE
        lifecycleScope.launch {
            try {
                // 首次起播（用户还没手动选过字幕）前先探一次字幕轨：
                // 若存在与视频同名的外挂特效字幕，直接带 burn 参数起播，
                // 省掉「先起一次转码、再重启烧录」的 1-2 秒黑屏。
                var burnPath = pendingBurnPath
                var burnIdx: Int? = burnSubtitle?.index?.takeIf { pendingBurnPath == null }
                if (selectedSubtitle == null && burnSubtitle == null && subtitleTracks.isEmpty()) {
                    val tracks = runCatching { api.subtitleTracksOf(rootId, relPath) }.getOrDefault(emptyList())
                    // 默认策略：有字幕就自动打开第一条（优先同名字幕 default，其次第一条文本轨）。
                    // 用户之后在菜单里选「关闭字幕」会显式关掉，不会又被这里强开。
                    val auto = tracks.firstOrNull { it.isDefault } ?: tracks.firstOrNull { !it.burn }
                    if (auto != null) {
                        if (auto.burn && auto.path.isNotBlank()) {
                            burnPath = auto.path
                            // 外挂字幕靠 path 定位，index 只是展示序号
                            burnSubtitle = BurnSubtitle(index = -1, label = auto.label, language = "")
                        } else if (!auto.burn) {
                            selectedSubtitle = auto
                        }
                    }
                }
                val res = api.play(rootId, relPath, startAt, burnIdx, burnPath)
                pendingBurnPath = null
                applyPlay(res)
                startPolling()
            } catch (e: Exception) {
                showError(e.message ?: "无法开始播放")
            }
        }
    }

    private fun applyPlay(res: PlayResult) {
        sessionId = res.sessionId
        duration = res.duration
        currentSpeed = res.speed
        currentGen = res.gen
        streamOffset = res.offset
        serverPos = res.position
        pendingSeek = false
        rememberTracks(res)
        binding.title.text = res.title
        binding.timeTotal.text = BrowseActivity.formatDuration(duration)
        binding.btnSpeed.text = "${currentSpeed}x"
        // 片名跟随控制栏显隐：起播短暂展示 3.4 秒后随控制栏自动隐藏（按上/下/OK 重新呼出）
        binding.title.visibility = View.VISIBLE
        handler.removeCallbacks(hideTitleRunnable)
        handler.postDelayed(hideTitleRunnable, 3400)

        binding.loadingBox.visibility = View.VISIBLE
        binding.loadingText.text = "开始转码（${res.encoder.ifBlank { "编码器" }}）…"

        player?.setMediaSource(mediaSource(res.playlist, selectedSubtitle))
        player?.prepare()
        seekPlayerToServerPosition(res)
        player?.playWhenReady = true
        startUiTicker()
        loadSiblings()
    }

    /**
     * 切换到新一代 HLS 流后的起播位置。
     *
     * 服务端每次 seek / 变速 / 切轨都会重启 ffmpeg（`-ss <offset>`），
     * 新播放列表的时间轴从 0 开始，而流里的 0 秒对应的正是媒体的 `offset` 秒。
     * 也就是说**流本身已经定位到目标位置了**：播放器从 0 播放即可。
     *
     * 反过来，如果按 `position`（媒体绝对秒数）去 seek，就会跳到流末尾之外，
     * 表现是黑屏、卡住，或一下跳到片尾 —— 这是之前最严重的 bug。
     *
     * 从流起点播放还能顺便拿到服务端预转的几秒缓冲，起播更稳。
     */
    private fun seekPlayerToServerPosition(res: PlayResult) {
        // 音频洞（源音频轨比视频晚开始）已由服务端 ffmpeg 滤镜
        // aresample=async=1:first_pts=0 前置静音填充治本（补充 7）：输出流音频
        // PTS 从 0 起就有数据，客户端无需再跳洞（跳洞会跳过洞内的真实画面）。
        player?.seekTo(0)
        binding.timeCurrent.text = BrowseActivity.formatDuration(res.position)
        binding.seek.progressValue = toProgress(res.position)
    }

    /** 同目录视频列表：用于「下一个」选集 */
    private var siblings: List<Pair<String, String>> = emptyList()
    private var siblingIndex = -1

    /**
     * 媒体源类型缓存（dir/file）：决定 siblings 的组织方式。
     * onCreate 时拉一次即可——播放中引用列表不会变。
     */
    private var currentRootType = "dir"

    /**
     * 拉取「下一个/上一个」候选列表。**每次 applyPlay 后都重新拉**（不缓存）：
     * 服务端目录监听会让 browse/roots 反映最新文件删减，
     * 播放中文件被删也不会切到一个不存在的目标。
     * 单文件源（type=file）：把所有启用的散文件按添加顺序组成虚拟列表。
     */
    private fun loadSiblings() {
        lifecycleScope.launch {
            // 顺带刷新当前源类型（onCreate 的异步查询可能还没回来）
            val rootsNow = runCatching { api.roots() }.getOrDefault(emptyList())
            currentRootType = rootsNow.firstOrNull { it.id == rootId }?.type ?: currentRootType
            // 「下一个」按钮不再需要：播完自动接下一集（虚拟列表/目录列表），按钮行保持简洁
            if (currentRootType == "file") {
                siblings = rootsNow.filter { it.enabled && it.type == "file" }.map { it.id to "" }
                siblingIndex = siblings.indexOfFirst { it.first == rootId }
                return@launch
            }
            val parent = if (relPath.contains('/')) relPath.substringBeforeLast('/') else ""
            runCatching { api.browse(rootId, parent) }.onSuccess { res ->
                siblings = res.items.filter { !it.isDir && it.kind == "video" }.map { it.path to it.path }
                siblingIndex = siblings.indexOfFirst { it.second == relPath }
            }
        }
    }

    private fun playNext() {
        if (siblingIndex < 0 || siblingIndex + 1 >= siblings.size) return
        switchToSibling(siblings[siblingIndex + 1])
    }

    /** 循环模式轮换：关 → 列表循环 → 单集循环 → 关 */
    private fun cycleLoopMode() {
        api.loopMode = when (api.loopMode) {
            "off" -> "all"
            "all" -> "one"
            else -> "off"
        }
        updateLoopButton()
        toast(
            when (api.loopMode) {
                "all" -> "循环播放：整个列表"
                "one" -> "循环播放：当前单集"
                else -> "循环播放：关闭"
            }
        )
    }

    private fun updateLoopButton() {
        binding.btnLoop.text = when (api.loopMode) {
            "all" -> "循环:列表"
            "one" -> "循环:单集"
            else -> "循环:关"
        }
        binding.btnLoop.alpha = if (api.loopMode == "off") 0.7f else 1f
    }

    private fun playPrev() {
        if (siblingIndex <= 0) { toast("已在列表开头"); return }
        switchToSibling(siblings[siblingIndex - 1])
    }

    private fun switchToSibling(next: Pair<String, String>) {
        val oldId = sessionId
        // A-3：取消在途 seek 提交并清空待提交目标 —— 旧 seek 结果（含 sessionId 校验兜底）
        // 不允许打到新的一集上；旧会话 id 已变，提交结果会被丢弃但 seekJob 仍会占用。
        seekJob?.cancel()
        seekJob = null
        pendingSeekTarget = null
        sessionId = ""
        pollJob?.cancel()
        lifecycleScope.launch {
            if (oldId.isNotBlank()) runCatching { api.stop(oldId) }
        }
        binding.menuPanel.visibility = View.GONE
        // 文件夹内切换：next = (相对路径, 相对路径)；散文件切换：next = (目标rootId, "")
        if (currentRootType == "file") {
            rootId = next.first
            relPath = next.second
        } else {
            relPath = next.first
        }
        selectedSubtitle = null
        burnSubtitle = null
        subtitlesExplicitlyOff = false
        pendingBurnPath = null
        subtitleTracks = emptyList()
        endedHandled = false
        serverPos = 0.0
        streamOffset = 0.0
        player?.stop()
        binding.title.text = next.first.substringAfterLast('/')
        startPlay(0.0)
    }

    /** 500ms 刷新一次进度条与时间 */
    private fun startUiTicker() {
        handler.removeCallbacks(ticker)
        handler.post(ticker)
    }

    private fun startPolling() {
        pollJob?.cancel()
        pollJob = lifecycleScope.launch {
            var fails = 0
            while (isActive) {
                delay(1000)
                val id = sessionId
                if (id.isBlank()) return@launch
                val st = runCatching { api.sessionState(id) }.getOrNull()
                if (st == null) {
                    fails++
                    if (fails >= POLL_FAIL_LIMIT) {
                        showError("与服务端的会话已中断（可能是服务端关闭或已达最大并发数）")
                        return@launch
                    }
                    continue
                }
                fails = 0
                val state = st.optString("state")
                if (state == "ENDED" || state == "STOPPED") {
                    binding.loadingBox.visibility = View.GONE
                    // A-5：STOPPED = 用户在服务端/其它入口主动停掉会话，不是自然播放结束
                    // ——不触发自动连播/循环，提示后留在播放页（可用「重试」按钮恢复）。
                    if (state == "STOPPED") {
                        showError("会话已停止（服务端手动停止或被新播放替换）")
                        return@launch
                    }
                    onPlaybackEnded()
                    return@launch
                }
                if (state == "ERROR") {
                    showError(st.optString("error", "服务端转码异常"))
                    return@launch
                }
            }
        }
    }

    private fun onPlaybackEnded() {
        // onPlaybackStateChanged 与服务端轮询都会触发，这里只处理一次
        // （A-2：进入即置 true，否则 restartCurrent/playNext 期间第二个事件源仍会再次进入 → 双跑）
        if (endedHandled) return
        endedHandled = true
        val hasNext = siblingIndex >= 0 && siblingIndex + 1 < siblings.size
        when (api.loopMode) {
            "one" -> {
                toast("循环播放：单集")
                restartCurrent()
                return
            }
            "all" -> {
                if (siblings.isNotEmpty()) {
                    val next = if (hasNext) siblingIndex + 1 else 0
                    toast(if (hasNext) "播放结束，自动播放下一个" else "列表循环：回到第一集")
                    switchToSibling(siblings[next])
                    return
                }
            }
        }
        if (hasNext) {
            toast("播放结束，自动播放下一个")
            playNext()
            return
        }
        // 全部播完：立即停掉服务端会话并保存进度，
        // 不等服务端 20 秒清扫，避免"客户端已退出、转码会话还在"的残留感。
        saveResumePoint()
        stopSession()
        toast("播放结束")
        finish()
    }

    /** 循环单集：停止当前会话后从 0 重新开始 */
    private fun restartCurrent() {
        val oldId = sessionId
        // A-3：同 switchToSibling，取消在途 seek
        seekJob?.cancel()
        seekJob = null
        pendingSeekTarget = null
        sessionId = ""
        pollJob?.cancel()
        lifecycleScope.launch { if (oldId.isNotBlank()) runCatching { api.stop(oldId) } }
        serverPos = 0.0
        streamOffset = 0.0
        player?.stop()
        startPlay(0.0)
    }

    /** 播放结束只处理一次（播放器回调与服务端轮询都会触发） */
    private var endedHandled = false

    // ---------------- 控制栏 ----------------

    private fun setupControls() {
        binding.seek.max = 1000
        binding.seek.onStep = { dir -> stepSeek(dir * 10) }
        binding.seek.onSeek = { value -> commitSeek(value) }
        updateLoopButton()

        binding.btnPlay.setOnClickListener { togglePlay() }
        binding.btnBack10.setOnClickListener { stepSeek(-10) }
        binding.btnFwd30.setOnClickListener { stepSeek(30) }
        binding.btnSpeed.setOnClickListener { showSpeedMenu() }
        binding.btnAudio.setOnClickListener { showAudioMenu() }
        binding.btnSubtitle.setOnClickListener { showSubtitleMenu() }
        binding.btnRetry.setOnClickListener { startPlay(serverPos) }
        binding.btnLoop.setOnClickListener { cycleLoopMode() }

        // 根布局可获得焦点：控制栏隐藏后焦点回到这里，
        // 这样方向键会走 Activity.onKeyDown 的「全局快捷键」分支（左右步进），不会丢失焦点
        binding.root.isFocusable = true
        binding.root.isFocusableInTouchMode = true

        binding.controls.setOnFocusChangeListener { _, hasFocus -> if (hasFocus) showControls() }

        // 起播时焦点留在根布局：左右键直接快进快退（全局分支），
        // 按 OK/菜单/上下键才呼出控制栏。避免一进播放页焦点就跳进控制栏，
        // 用户想快进还要先等控制栏自动消失。
    }

    private fun showControls() {
        if (!controlsVisible) controlsVisible = true
        binding.controls.visibility = View.VISIBLE
        binding.controlsButtons.visibility = View.VISIBLE
        // 标题跟随控制栏显隐（取消起播时的独立隐藏回调，避免「控制栏还在、标题先没了」）
        handler.removeCallbacks(hideTitleRunnable)
        binding.title.visibility = View.VISIBLE
        handler.removeCallbacks(hideControlsRunnable)
        handler.postDelayed(hideControlsRunnable, 3400)
    }

    /**
     * 自动隐藏控制栏。
     * 必须先把焦点移出控制栏，否则遥控器会「卡」在一个看不见的按钮上
     * （这是电视播放器常见的手感问题）。
     */
    private fun hideControlsNow() {
        if (binding.menuPanel.visibility == View.VISIBLE) return
        val f = currentFocus
        if (f != null && f.isDescendantOf(binding.controls)) {
            binding.root.requestFocus()
        }
        controlsVisible = false
        binding.controls.visibility = View.GONE
        binding.title.visibility = View.GONE
    }


    private fun View.isDescendantOf(parent: View): Boolean {
        var v: View? = this
        while (v != null) {
            if (v === parent) return true
            v = v.parent as? View
        }
        return false
    }

    private fun togglePlay() {
        val p = player ?: return
        if (p.isPlaying) {
            p.pause()
            binding.btnPlay.text = "播放"
            sessionId.takeIf { it.isNotBlank() }?.let { id ->
                lifecycleScope.launch { runCatching { api.pause(id) } }
            }
        } else {
            p.play()
            binding.btnPlay.text = "暂停"
            sessionId.takeIf { it.isNotBlank() }?.let { id ->
                lifecycleScope.launch { runCatching { api.resumeSession(id) } }
            }
        }
        // OK 切换播放状态：不呼出控制栏/文件名，只显示底部进度条（约 2 秒后自动消失）
        showSeekbarOnly()
    }

    /** 本地先更新 UI，短暂停顿后提交给服务端会话（避免长按连发请求） */
    /**
     * 步进快进/快退（遥控器左右键、长按连发都走这里）。
     *
     * 关键点：这里**只更新本地进度**，真正提交给服务端由 [scheduleSeekCommit]
     * 在「最后一次按键后 450ms」合并成一次 seek。
     * 否则长按连发时每次按键都会 cancel 上一次的计时器再重新计时，
     * 计时器永远到不了点 —— 表现就是「长按没反应，只能一下一下点」。
     */
    private fun stepSeek(deltaSec: Int) {
        val base = pendingSeekTarget ?: serverPos
        val target = (base + deltaSec).coerceIn(0.0, (duration - 1).coerceAtLeast(0.0))
        pendingSeekTarget = target
        pendingSeek = true
        showSeekHint(deltaSec)
        binding.seek.progressValue = toProgress(target)
        binding.timeCurrent.text = BrowseActivity.formatDuration(target)
        scheduleSeekCommit()
        // 左右键 seek 不呼出控制栏，只显示底部进度条（信息更轻量，不遮挡画面）
        showSeekbarOnly()
    }

    /**
     * 长按加速步进（借鉴 FengPlayer DefaultTimeBar：短按 10s，长按放大到 60s）。
     * 方向保留传入符号：右键短按 +30s，长按按住后每次 repeat +60s；左键对称。
     * 系统首次重复约在 500ms 后到来，repeatCount>=2 起视作「长按连发」档。
     */
    private fun seekStep(event: KeyEvent?, baseStep: Int): Int {
        val c = event?.repeatCount ?: 0
        val mag = when {
            c >= 6 -> 180
            c >= 3 -> 90
            c >= 2 -> 60
            else -> Math.abs(baseStep)
        }
        return if (baseStep < 0) -mag else mag
    }

    /**
     * 快进/快退期间的轻量 UI：只显示底部进度条（时间行），
     * 按钮行收起、焦点不动 —— 用户要求「不需要显示控制栏，只显示进度条」。
     * 3 秒无操作后随 hideControlsRunnable 一起退场；之后按上/下/OK 会重新
     * 呼出完整控制栏（按钮行由 showControls 恢复 VISIBLE）。
     */
    private fun showSeekbarOnly() {
        val f = currentFocus
        if (f != null && f.isDescendantOf(binding.controlsButtons)) {
            binding.root.requestFocus()
        }
        binding.controlsButtons.visibility = View.GONE
        binding.controls.visibility = View.VISIBLE
        binding.title.visibility = View.GONE
        handler.removeCallbacks(hideControlsRunnable)
        handler.postDelayed(hideControlsRunnable, 2000)
    }

    private fun commitSeek(progress: Int) {
        val target = duration * progress / 1000.0
        pendingSeekTarget = target
        pendingSeek = true
        binding.timeCurrent.text = BrowseActivity.formatDuration(target)
        scheduleSeekCommit()
    }

    /** 待提交的 seek 目标（长按连发期间累加，松手后一次性提交） */
    private var pendingSeekTarget: Double? = null

    /**
     * 合并提交 seek（第六轮重构）。
     *
     * 三条铁律：
     * 1. **提交循环只跑一次**：stepSeek 里用 restartSeekJob() 显式启动/续接，
     *    而不是每次按键都 cancel+重建 —— 否则长按期间计时器永远被重置，
     *    表现就是「长按没反应」。
     * 2. **防抖窗口内到来的新目标顺延**：循环提交完发现目标又变了就继续下一轮，
     *    不会把旧结果应用到播放器（避免回跳）。
     * 3. **提交失败/会话 404 时自动重建会话**：快速连按 + 旧 gen 目录被服务端
     *    清理时，播放器可能吃到 404 分片报 IO 错误；这里直接重新 play 恢复，
     *    不再给用户弹「播放失败」。
     */
    private fun scheduleSeekCommit() {
        if (seekJob?.isActive == true) return // 已有提交循环在跑：新目标会被它顺延处理
        seekJob = lifecycleScope.launch {
            delay(250)
            while (true) {
                val id = sessionId
                if (id.isBlank()) { pendingSeek = false; pendingSeekTarget = null; return@launch }
                val goal = pendingSeekTarget ?: return@launch
                try {
                    val res = api.seek(id, goal)
                    // A-3 兜底：提交返回时若已经切到别的会话/集数，直接丢弃这份结果
                    if (id != sessionId) return@launch
                    if (pendingSeekTarget != null && Math.abs(pendingSeekTarget!! - goal) > 0.5) {
                        // 提交期间用户又按了键：丢弃这份旧结果，下一轮提交新目标
                        continue
                    }
                    currentGen = res.gen
                    streamOffset = res.offset
                    serverPos = res.position
                    pendingSeekTarget = null
                    rememberPlaylist(res)
                    switchingStream = true
                    reloadStream(res.playlist)
                    return@launch
                } catch (e: Exception) {
                    // 连按期间会话可能被服务端替换/清理（gen 目录被删，播放器报 404）
                    // —— 直接按当前目标重建会话恢复播放，而不是弹错误框
                    val target = pendingSeekTarget ?: goal
                    pendingSeekTarget = null
                    val recovered = runCatching { rebuildSession(target) }.getOrNull()
                    if (recovered != null) {
                        currentGen = recovered.gen
                        streamOffset = recovered.offset
                        serverPos = recovered.position
                        rememberPlaylist(recovered)
                        switchingStream = true
                        return@launch
                    }
                    pendingSeek = false
                    toast("跳转失败：${e.message}")
                    binding.loadingBox.visibility = View.GONE
                    return@launch
                }
            }
        }
    }

    /** 重新加载播放流（seek / 恢复共用）：换源后清掉旧的加载提示 */
    private fun reloadStream(playlist: String) {
        player?.setMediaSource(mediaSource(playlist, selectedSubtitle))
        player?.prepare()
        player?.playWhenReady = true
        binding.loadingBox.visibility = View.GONE
    }

    /**
     * 会话丢失/损坏后的恢复：重新走 /api/play 起一个新会话并从 target 播放。
     * 服务端对同一客户端会自动替换旧会话，因此这里不会触发并发上限。
     */
    private suspend fun rebuildSession(target: Double): PlayResult {
        val burnPath = pendingBurnPath ?: burnSubtitle?.let { b ->
            subtitleTracks.firstOrNull { it.burn && it.path.isNotBlank() }?.path
        }
        val burnIdx = burnSubtitle?.index?.takeIf { it >= 0 && burnPath == null }
        val res = api.play(rootId, relPath, target, burnIdx, burnPath)
        pendingBurnPath = null
        applyPlay(res)
        return res
    }

    private fun showSeekHint(delta: Int) {
        binding.seekHint.visibility = View.VISIBLE
        binding.seekHint.text = if (delta > 0) "▶▶ ${delta}s" else "◀◀ ${-delta}s"
        hintJob?.cancel()
        hintJob = lifecycleScope.launch {
            delay(900)
            binding.seekHint.visibility = View.GONE
        }
    }

    private fun toProgress(pos: Double): Int =
        if (duration <= 0) 0 else ((pos / duration) * 1000).toInt().coerceIn(0, 1000)

    // ---------------- 菜单 ----------------

    private fun openMenu(title: String, items: List<String>, onPick: (Int) -> Unit) {
        binding.menuTitle.text = title
        binding.menuList.layoutManager = LinearLayoutManager(this)
        binding.menuList.adapter = MenuAdapter(items) { i ->
            closeMenu()
            onPick(i)
        }
        binding.menuPanel.visibility = View.VISIBLE
        binding.menuList.post {
            (binding.menuList.layoutManager as LinearLayoutManager).findViewByPosition(0)?.requestFocus()
        }
        showControls()
    }

    private fun closeMenu() {
        binding.menuPanel.visibility = View.GONE
        focusControls()
    }

    /** 控制栏显示时把焦点放到最常用的「暂停」按钮，保证遥控器方向键立即生效 */
    private fun focusControls() {
        showControls()
        binding.btnPlay.requestFocus()
    }

    private fun showSpeedMenu() {
        val speeds = listOf(1f, 1.25f, 1.5f, 2f)
        openMenu("播放速度", speeds.map { if (it == currentSpeed) "✓ ${it}x" else "${it}x" }) { i ->
            applySpeed(speeds[i])
        }
    }

    private fun applySpeed(speed: Float) {
        val id = sessionId
        if (id.isBlank()) return
        lifecycleScope.launch {
            try {
                binding.loadingBox.visibility = View.VISIBLE
                binding.loadingText.text = "切换倍速…"
                val res = api.setSpeed(id, speed)
                currentSpeed = res.speed
                currentGen = res.gen
                streamOffset = res.offset
                serverPos = res.position
                binding.btnSpeed.text = "${speed}x"
                rememberPlaylist(res)
                player?.setMediaSource(mediaSource(res.playlist, selectedSubtitle))
                player?.prepare()
                seekPlayerToServerPosition(res)
                player?.playWhenReady = true
            } catch (e: Exception) {
                binding.loadingBox.visibility = View.GONE
                toast("切换倍速失败：${e.message}")
            }
        }
    }

    private fun showAudioMenu() {
        val tracks = audioTracks
        if (tracks.size <= 1) { toast("该片源只有一条音轨"); return }
        openMenu("音轨选择", tracks.map { it.label + if (it.index == audioIndex) "  ✓" else "" }) { i ->
            switchAudio(tracks[i].index)
        }
    }

    private fun switchAudio(index: Int) {
        val id = sessionId
        if (id.isBlank()) return
        lifecycleScope.launch {
            try {
                binding.loadingBox.visibility = View.VISIBLE
                binding.loadingText.text = "切换音轨…"
                val res = api.setAudio(id, index)
                audioIndex = index
                currentGen = res.gen
                streamOffset = res.offset
                serverPos = res.position
                rememberPlaylist(res)
                player?.setMediaSource(mediaSource(res.playlist, selectedSubtitle))
                player?.prepare()
                seekPlayerToServerPosition(res)
                player?.playWhenReady = true
            } catch (e: Exception) {
                binding.loadingBox.visibility = View.GONE
                toast("切换音轨失败：${e.message}")
            }
        }
    }

    private fun showSubtitleMenu() {
        val items = mutableListOf<String>()
        val actions = mutableListOf<() -> Unit>()
        items.add("关闭字幕")
        actions.add {
            selectedSubtitle = null
            burnSubtitle = null
            subtitlesExplicitlyOff = true
            reloadForSubtitle()
        }
        for (t in subtitleTracks) {
            items.add("${t.label}（文本，客户端渲染）")
            actions.add {
                selectedSubtitle = t
                burnSubtitle = null
                subtitlesExplicitlyOff = false
                reloadForSubtitle()
            }
        }
        for (b in burnSubtitles) {
            items.add("${b.label}（图形，服务端烧录）")
            actions.add {
                burnSubtitle = b
                selectedSubtitle = null
                subtitlesExplicitlyOff = false
                burnOnServer(b.index)
            }
        }
        openMenu("字幕选择", items) { i -> actions[i]() }
    }

    /**
     * 只切换客户端渲染的文本字幕轨：HLS 流不变（仍在当前 generation），
     * 因此可以沿用当前播放列表与本地相对位置，无需重启服务端转码。
     */
    private fun reloadForSubtitle() {
        val url = playlistUrl.ifBlank { return }
        val relativeMs = player?.currentPosition ?: 0L
        player?.setMediaSource(mediaSource(url, selectedSubtitle))
        player?.prepare()
        player?.seekTo(relativeMs)
        player?.playWhenReady = true
        // 选轨必须在 prepare 之后显式下发，否则默认选择器不会打开外挂 VTT 轨
        applySubtitleSelection()
    }

    private fun burnOnServer(index: Int?) {
        val id = sessionId
        if (id.isBlank()) return
        lifecycleScope.launch {
            try {
                binding.loadingBox.visibility = View.VISIBLE
                binding.loadingText.text = "服务端烧录字幕…"
                val res = api.setSubtitleBurn(id, index)
                selectedSubtitle = null
                currentGen = res.gen
                streamOffset = res.offset
                serverPos = res.position
                rememberPlaylist(res)
                player?.setMediaSource(mediaSource(res.playlist, null))
                player?.prepare()
                seekPlayerToServerPosition(res)
                player?.playWhenReady = true
            } catch (e: Exception) {
                binding.loadingBox.visibility = View.GONE
                toast("字幕切换失败：${e.message}")
            }
        }
    }

    private var playlistUrl: String = ""

    private fun rememberPlaylist(res: PlayResult) {
        if (res.playlist.isNotBlank()) playlistUrl = res.playlist
        pendingSeek = false
    }

    // ---------------- 生命周期 & 按键 ----------------

    /**
     * 遥控器五键交互（第七轮真机验收定型，第八轮微调）：
     * - 上：呼出信息（文件名+进度条+控制栏）但焦点不动（看信息不打断操作）
     * - 下：呼出并让焦点进入控制栏（准备点按钮）
     * - OK：焦点不在控制栏时暂停/播放切换；在控制栏内则点按钮
     * - 左/右：焦点不在控制栏时快退/快进（scrub，只显示进度条）；
     *   **焦点在控制栏内时改为按钮间移动焦点**（否则选不到字幕/音轨/循环）
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (binding.menuPanel.visibility == View.VISIBLE) {
            return super.onKeyDown(keyCode, event) // 弹层开着时交给弹层导航
        }
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_UP -> {
                showControls() // 只展示信息，焦点原地不动
                return true
            }
            KeyEvent.KEYCODE_DPAD_DOWN -> {
                focusControls() // 呼出并聚焦「暂停」按钮
                return true
            }
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
                // 焦点在控制栏按钮上时 OK 仍是「点按钮」；焦点在根布局（控制栏隐藏/无按钮焦点）时 OK = 播放/暂停
                val f = currentFocus
                return if (f == null || !f.isDescendantOf(binding.controls)) {
                    togglePlay()
                    true
                } else {
                    super.onKeyDown(keyCode, event)
                }
            }
            KeyEvent.KEYCODE_MENU -> {
                showControls()
                focusControls()
                return true
            }
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT -> {
                // 焦点在控制栏内：左右键在按钮间移动焦点（选字幕/音轨/循环等）；
                // 焦点不在控制栏（根布局）：直接快进/快退（scrub 模式，不呼出按钮行）
                val f = currentFocus
                if (f != null && f.isDescendantOf(binding.controls)) {
                    return super.onKeyDown(keyCode, event)
                }
                stepSeek(seekStep(event, if (keyCode == KeyEvent.KEYCODE_DPAD_RIGHT) 30 else -10))
                return true
            }
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> { togglePlay(); return true }
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> { stepSeek(30); return true }
            KeyEvent.KEYCODE_MEDIA_REWIND -> { stepSeek(-10); return true }
            KeyEvent.KEYCODE_MEDIA_NEXT -> { playNext(); return true }
            KeyEvent.KEYCODE_MEDIA_PREVIOUS -> { playPrev(); return true }
        }
        return super.onKeyDown(keyCode, event)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (binding.menuPanel.visibility == View.VISIBLE) {
            closeMenu()
            return
        }
        // 借鉴 FengPlayer：控制栏可见时 BACK 只收起控制栏，再按一次才退出播放
        if (binding.controls.visibility == View.VISIBLE) {
            hideControlsNow()
            return
        }
        stopSession()
        @Suppress("DEPRECATION")
        super.onBackPressed()
    }

    private fun stopSession() {
        val id = sessionId
        sessionId = ""
        pollJob?.cancel()
        seekJob?.cancel()
        pendingSeek = false
        if (id.isNotBlank()) {
            api.stopAsync(id)
        }
    }

    /** 记住播放进度（供下次续播） */
    private fun saveResumePoint() {
        if (duration > 30 && serverPos > 10 && serverPos < duration - 20) {
            getSharedPreferences("lanplay_resume", MODE_PRIVATE).edit()
                .putFloat(resumeKey(), serverPos.toFloat())
                .apply()
        } else if (duration > 0 && serverPos >= duration - 20) {
            getSharedPreferences("lanplay_resume", MODE_PRIVATE).edit()
                .remove(resumeKey())
                .apply()
        }
    }

    override fun onPause() {
        super.onPause()
        saveResumePoint()
        player?.pause()
    }

    override fun onResume() {
        super.onResume()
        enterImmersive()
        if (backgrounded) {
            // 从后台回来：用离开时的位置重新拉起服务端会话
            backgrounded = false
            startPlay(serverPos)
        } else {
            player?.play()
        }
        // A-7：回前台时按当前播放状态刷新按钮文案（onResume 不经 togglePlay，文案可能过期）
        binding.btnPlay.text = if (player == null || player?.isPlaying == true) "暂停" else "播放"
        showControls()
    }

    override fun onStop() {
        super.onStop()
        if (isChangingConfigurations) return
        saveResumePoint()
        // 退到后台（如按 HOME）时立即释放服务端转码资源，
        // 否则 ffmpeg 会一直跑到片尾并占用并发名额。回来时续播。
        if (sessionId.isNotBlank()) {
            backgrounded = true
            stopSession()
        }
    }

    override fun onDestroy() {
        handler.removeCallbacks(ticker)
        handler.removeCallbacks(hideControlsRunnable)
        pollJob?.cancel()
        seekJob?.cancel()
        hintJob?.cancel()
        if (sessionId.isNotBlank()) stopSession()
        player?.release()
        player = null
        super.onDestroy()
    }

    @SuppressLint("NewApi")
    private fun enterImmersive() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            )
    }

    private fun showError(msg: String) {
        binding.loadingBox.visibility = View.GONE
        binding.errorBox.visibility = View.VISIBLE
        binding.errorText.text = msg
        binding.btnRetry.requestFocus()
        showControls()
    }

    private fun toast(msg: String) {
        binding.seekHint.visibility = View.VISIBLE
        binding.seekHint.text = msg
        hintJob?.cancel()
        hintJob = lifecycleScope.launch {
            delay(1800)
            binding.seekHint.visibility = View.GONE
        }
    }

    // 记录服务端返回的音轨/字幕信息
    private var audioTracks: List<com.lanplay.client.model.AudioTrackInfo> = emptyList()
    private var subtitleTracks: List<SubtitleTrack> = emptyList()
    private var burnSubtitles: List<BurnSubtitle> = emptyList()
    private var audioIndex = 0

    private fun rememberTracks(res: PlayResult) {
        audioTracks = res.audioTracks
        subtitleTracks = res.subtitleTracks
        burnSubtitles = res.burnSubtitles
        audioIndex = res.audioIndex
        if (res.playlist.isNotBlank()) playlistUrl = res.playlist

        // 默认策略：用户没有显式关过字幕时，自动打开第一条可用字幕
        // （优先同名字幕 default，其次第一条文本轨）；显式「关闭字幕」后不再抢着打开。
        if (selectedSubtitle == null && burnSubtitle == null && !subtitlesExplicitlyOff) {
            val auto = subtitleTracks.firstOrNull { it.isDefault }
                ?: subtitleTracks.firstOrNull { !it.burn }
            if (auto != null && !auto.burn) selectedSubtitle = auto
        }
    }

    /** 需要烧录的外挂字幕路径（随 /api/play 一起发给服务端） */
    private var pendingBurnPath: String? = null

    private inner class MenuAdapter(
        private val items: List<String>,
        private val onClick: (Int) -> Unit
    ) : RecyclerView.Adapter<MenuAdapter.Holder>() {
        inner class Holder(val b: ItemMediaBinding) : RecyclerView.ViewHolder(b.root)

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder =
            Holder(ItemMediaBinding.inflate(layoutInflater, parent, false))

        override fun getItemCount(): Int = items.size

        override fun onBindViewHolder(holder: Holder, position: Int) {
            // 弹层是纯文本菜单：隐藏浏览列表复用布局里的缩略图容器（否则露出黑色方块）
            holder.b.thumbWrap.visibility = View.GONE
            holder.b.icon.text = ""
            val text = items[position]
            // 当前选中项打 ✓（保留「未命名」等空 label 可读性）并用 accent 蓝高亮
            val selected = text.startsWith("✓") || text.contains("  ✓")
            val clean = text.replace("✓", "").trim()
            holder.b.name.text = if (selected && clean.isEmpty()) "默认音轨" else clean
            // 选中项处于焦点时背景是 accent 蓝（bg_list_item state_focused），文字必须白色才可见
            holder.b.name.setTextColor(
                if (selected) Color.WHITE
                else ContextCompat.getColor(this@PlayerActivity, R.color.text)
            )
            holder.b.meta.text = ""
            holder.b.arrow.text = ""
            holder.b.root.setOnClickListener { onClick(position) }
        }
    }
}
