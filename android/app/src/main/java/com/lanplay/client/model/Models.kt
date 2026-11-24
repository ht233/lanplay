package com.lanplay.client.model

/** 服务端下发的引用根 */
data class RootInfo(
    val id: String,
    val name: String,
    val type: String,
    val path: String,
    val enabled: Boolean = true,
    val exists: Boolean = true,
    /** 引用目标自身修改时间（媒体源时间排序用，旧引用/服务端未下发时 0） */
    val mtime: Long = 0L,
    /** 引用目标字节大小（目录恒 0；媒体源大小排序用） */
    val size: Long = 0L
)

/** 浏览列表项（目录或媒体文件） */
data class MediaEntry(
    val name: String,
    val path: String,
    val isDir: Boolean,
    val kind: String,
    val size: Long,
    val duration: Double
) {
    /** 是否可生成缩略图（视频/图片才有意义） */
    val hasThumb: Boolean get() = !isDir && (kind == "video" || kind == "image")
}

data class BrowseResult(
    val name: String,
    val path: String,
    val isFile: Boolean,
    val items: List<MediaEntry>
)

/** 音轨 */
data class AudioTrackInfo(
    val index: Int,
    val label: String,
    val language: String,
    val channels: Int
)

/** 文本字幕轨（客户端轻量渲染） */
data class SubtitleTrack(
    val id: String,
    val label: String,
    val url: String,
    val kind: String,
    val text: Boolean,
    /** 需要服务端烧录（图形字幕或 ASS 特效字幕） */
    val burn: Boolean = false,
    /** 服务端建议默认选中的字幕（与视频同名的外挂字幕） */
    val isDefault: Boolean = false,
    /** 外挂字幕的绝对路径（烧录时回传给服务端） */
    val path: String = ""
) {
    /**
     * ExoPlayer 直接按 URL 拉取字幕，需要把 token 拼进查询串。
     *
     * `startSec` 是**当前流的时间轴原点**（会话 seek/换轨后服务端会重启 ffmpeg，
     * 新 HLS 流从 0 开始，而字幕 cue 是原片绝对时间）。必须把它传给服务端，
     * 让服务端把 cue 减去这个偏移；否则拖动进度后字幕会整体错位几十秒甚至整片不显示。
     *
     * `speed`（补充 22）：倍速会话的输出流时间轴被压缩（原片第 T 秒出现在流第 T/speed 秒），
     * 服务端按 (t - start) / speed 缩放 cue；speed=1 时恒等。
     */
    fun absoluteUrl(base: String, token: String? = null, startSec: Double = 0.0, speed: Double = 1.0): String {
        var u = if (url.startsWith("http")) url else base.trimEnd('/') + url
        // 服务端下发的 URL 里可能已经带了 start（buildSubtitleTracks 按当时的会话 offset 拼的），
        // 这里要**替换**而不是追加 —— 出现两个 start 时服务端只认第一个，seek 后就会错位。
        u = u.replace(Regex("[?&]start=[^&]*"), "")
        if (startSec > 0.05) {
            u += (if (u.contains('?')) "&" else "?") + "start=" + String.format(java.util.Locale.US, "%.3f", startSec)
        }
        if (speed != 1.0 && speed > 0) {
            u += "&speed=" + String.format(java.util.Locale.US, "%.3f", speed)
        }
        // 字幕抬高：PlayerView 的 setBottomPaddingFraction 对「自动行位置」的 cue 才生效，
        // 实测在投影仪上文字底边只离画面 8px（几乎贴边）。这里在 cue 头里显式写 line:88%，
        // 让播放器把字幕定位到画面高度 88% 处（下方留约一成间隔）。
        // P3 修复：原判断 `contains("?") || contains("=")` 在 URL 里没有任何参数时
        //（contains("=") 恒 false 的场景判断对了，但 contains("?") 判断分支书写错误，
        // 会在无 ? 时也追加 &line=88 产生畸形 URL）——改为严格「已有查询串才用 &」。
        u += if (u.contains('?')) "&line=88" else "?line=88"
        if (!token.isNullOrBlank()) {
            u += if (u.contains('?')) "&token=$token" else "?token=$token"
        }
        return u
    }
}

/** 图形字幕（服务端烧录） */
data class BurnSubtitle(
    val index: Int,
    val label: String,
    val language: String
)

data class PlayResult(
    val sessionId: String,
    val title: String,
    val state: String,
    val gen: Int,
    val playlist: String,
    /** 媒体绝对位置（秒） */
    val position: Double,
    /** 当前 HLS 流的时间轴起点（媒体绝对秒数）；播放器 seek 需减去它 */
    val offset: Double,
    val duration: Double,
    val speed: Float,
    val audioIndex: Int,
    val subtitleTracks: List<SubtitleTrack>,
    val burnSubtitles: List<BurnSubtitle>,
    val audioTracks: List<AudioTrackInfo>,
    val encoder: String,
    val error: String
)

/** 局域网发现到的服务端 */
data class DiscoveredServer(
    val name: String,
    val serverId: String,
    val host: String,
    val port: Int,
    val requirePin: Boolean
) {
    val url: String get() = "http://$host:$port"
}

class ApiException(message: String, val code: Int = 0) : Exception(message)
