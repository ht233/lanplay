package com.lanplay.client.net

import android.content.Context
import android.content.SharedPreferences
import com.lanplay.client.model.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * LanPlay 服务端 HTTP 客户端。
 * 服务端 API 均为 JSON；转码控制类请求携带 X-LanPlay-Token。
 */
class LanPlayApi(private val context: Context) {

    companion object {
        private const val PREFS = "lanplay_client"
        private const val KEY_BASE = "base_url"
        private const val KEY_TOKEN = "token"
        private const val KEY_CLIENT_ID = "client_id"
        private const val KEY_NAME = "device_name"
        private const val KEY_LAST_PATH = "last_path"
        private const val KEY_LAST_ROOT = "last_root"

        @Volatile
        private var instance: LanPlayApi? = null

        fun get(context: Context): LanPlayApi =
            instance ?: synchronized(this) {
                instance ?: LanPlayApi(context.applicationContext).also { instance = it }
            }
    }

    private val prefs: SharedPreferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val jsonType = "application/json; charset=utf-8".toMediaType()
    private val shortClient = http.newBuilder()
        .readTimeout(8, TimeUnit.SECONDS)
        .build()

    var baseUrl: String
        get() = prefs.getString(KEY_BASE, "") ?: ""
        set(value) = prefs.edit().putString(KEY_BASE, value.trimEnd('/')).apply()

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_TOKEN, value).apply()

    var clientId: String?
        get() = prefs.getString(KEY_CLIENT_ID, null)
        set(value) = prefs.edit().putString(KEY_CLIENT_ID, value).apply()

    var deviceName: String
        get() = prefs.getString(KEY_NAME, null) ?: defaultDeviceName()
        set(value) = prefs.edit().putString(KEY_NAME, value).apply()

    var lastPath: String?
        get() = prefs.getString(KEY_LAST_PATH, null)
        set(value) = prefs.edit().putString(KEY_LAST_PATH, value).apply()

    var lastRootId: String?
        get() = prefs.getString(KEY_LAST_ROOT, null)
        set(value) = prefs.edit().putString(KEY_LAST_ROOT, value).apply()

    /** 服务端媒体库版本号：变了说明引用或目录内容有变化，需要重拉列表 */
    var lastLibraryVersion: Int
        get() = prefs.getInt("library_version", 0)
        set(value) = prefs.edit().putInt("library_version", value).apply()

    /** 浏览视图模式：list（列表）/ grid（大图） */
    var viewMode: String
        get() = prefs.getString("view_mode", "list") ?: "list"
        set(value) = prefs.edit().putString("view_mode", value).apply()

    /** 排序方式：name / name-desc / mtime / mtime-desc / size / size-desc / kind */
    var sortMode: String
        get() = prefs.getString("sort_mode", "name") ?: "name"
        set(value) = prefs.edit().putString("sort_mode", value).apply()

    /** 媒体源列表排序（客户端本地设置，与服务端 GUI 互不影响）：
     *  default（=added 添加顺序）/ name± / mtime± / size± / type± */
    var rootSortMode: String
        get() = prefs.getString("root_sort_mode", "default") ?: "default"
        set(value) = prefs.edit().putString("root_sort_mode", value).apply()

    /** 循环播放：播完自动从头/下一集 */
    var loopMode: String
        get() = prefs.getString("loop_mode", "off") ?: "off"
        set(value) = prefs.edit().putString("loop_mode", value).apply()

    /** 上次输入的媒体源路径（方便重复添加同目录下的其他子目录） */
    var lastAddedRootHint: String?
        get() = prefs.getString("last_added_root", null)
        set(value) = prefs.edit().putString("last_added_root", value).apply()

    val isLoggedIn: Boolean get() = baseUrl.isNotBlank() && (!requiresPinCache || token != null)

    private var requiresPinCache = true

    private fun defaultDeviceName(): String {
        val model = android.os.Build.MODEL ?: "Android"
        return "投影仪 $model"
    }

    // ---------------- 基础请求 ----------------

    private fun buildRequest(path: String, method: String = "GET", body: JSONObject? = null, auth: Boolean = true): Request {
        val base = if (path.startsWith("http")) path else baseUrl + path
        val b = Request.Builder().url(base)
        if (auth) token?.let { b.header("X-LanPlay-Token", it) }
        when (method) {
            "GET" -> b.get()
            "POST" -> b.post((body ?: JSONObject()).toString().toRequestBody(jsonType))
            else -> b.method(method, (body ?: JSONObject()).toString().toRequestBody(jsonType))
        }
        return b.build()
    }

    private suspend fun exec(path: String, method: String = "GET", body: JSONObject? = null, auth: Boolean = true, useShort: Boolean = false): JSONObject =
        withContext(Dispatchers.IO) {
            val client = if (useShort) shortClient else http
            val req = buildRequest(path, method, body, auth)
            try {
                client.newCall(req).execute().use { resp ->
                    val text = resp.body?.string() ?: ""
                    if (!resp.isSuccessful) {
                        val msg = runCatching { JSONObject(text).optString("error") }.getOrNull()
                        throw ApiException(
                            when {
                                msg.isNullOrBlank() && resp.code == 401 -> "未授权，请重新连接"
                                msg.isNullOrBlank() -> "HTTP ${resp.code}"
                                else -> msg
                            },
                            resp.code
                        )
                    }
                    if (text.isBlank()) JSONObject() else JSONObject(text)
                }
            } catch (e: ApiException) {
                throw e
            } catch (e: IOException) {
                throw ApiException("无法连接服务端：${e.message ?: "网络错误"}")
            }
        }

    // ---------------- 配对 / 重连 ----------------

    suspend fun probeServer(url: String): JSONObject {
        val old = baseUrl
        baseUrl = url.trimEnd('/')
        try {
            val info = exec("/api/info", auth = false, useShort = true)
            requiresPinCache = info.optBoolean("requirePin", true)
            return info
        } finally {
            if (old.isNotBlank()) baseUrl = old
        }
    }

    /** 用配对码换取长期 token */
    suspend fun pair(url: String, pin: String, name: String): JSONObject {
        baseUrl = url
        val body = JSONObject()
            .put("pin", pin)
            .put("name", name)
            .put("clientId", clientId ?: JSONObject.NULL)
            .put("model", android.os.Build.MODEL ?: "Android TV")
            .put("platform", "Android ${android.os.Build.VERSION.RELEASE}")
            .put("appVersion", "1.0.0")
        val res = exec("/api/pair", "POST", body, auth = false)
        token = res.optString("token", null)
        clientId = res.optString("clientId", null)
        deviceName = name
        requiresPinCache = res.optJSONObject("server")?.optBoolean("requirePin", true) ?: true
        return res
    }

    /** 使用已保存 token 恢复会话 */
    suspend fun resume(): Boolean {
        if (baseUrl.isBlank() || token == null) return false
        return try {
            val body = JSONObject().put("token", token).put("appVersion", "1.0.0")
            val res = exec("/api/resume", "POST", body, auth = false, useShort = true)
            requiresPinCache = res.optJSONObject("server")?.optBoolean("requirePin", true) ?: true
            true
        } catch (e: ApiException) {
            if (e.code == 401) {
                token = null
                false
            } else throw e
        }
    }

    // ---------------- 浏览 ----------------

    suspend fun roots(): List<RootInfo> {
        val res = exec("/api/roots")
        val arr = res.optJSONArray("roots") ?: JSONArray()
        lastLibraryVersion = res.optInt("version", lastLibraryVersion)
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            RootInfo(
                id = o.optString("id"),
                name = o.optString("name"),
                type = o.optString("type", "dir"),
                path = o.optString("path"),
                enabled = o.optBoolean("enabled", true),
                exists = o.optBoolean("exists", true),
                mtime = o.optLong("mtime", 0L),
                size = o.optLong("size", 0L)
            )
        }
    }

    // ---------------- 媒体源增删 + 实时同步 ----------------

    /** 添加媒体源（路径在服务端本机，客户端只是远程登记） */
    suspend fun addRoots(paths: List<String>, name: String? = null): JSONObject {
        val arr = JSONArray()
        paths.forEach { arr.put(it) }
        val body = JSONObject().put("paths", arr)
        if (!name.isNullOrBlank()) body.put("name", name)
        return exec("/api/roots", "POST", body)
    }

    /** 批量操作：enable / disable / remove / purge */
    suspend fun batchRoots(action: String, ids: List<String> = emptyList()): JSONObject {
        val arr = JSONArray()
        ids.forEach { arr.put(it) }
        return exec("/api/roots/batch", "POST", JSONObject().put("action", action).put("ids", arr))
    }

    /**
     * 轻量同步：只返回媒体库版本号、引用列表与在线会话数。
     * 客户端每隔几秒调用一次，version 变了再重拉目录，避免整表轮询。
     */
    suspend fun sync(since: Int): JSONObject = exec("/api/sync?since=$since")

    /** 原图直出 URL（图片查看用，token 走 query） */
    fun rawUrl(rootId: String, relPath: String): String {
        val base = baseUrl.trimEnd('/')
        val encPath = relPath.split("/").joinToString("/") {
            java.net.URLEncoder.encode(it, "UTF-8").replace("+", "%20")
        }
        return "$base/raw/${enc(rootId)}/$encPath?token=${enc(token ?: "")}"
    }

    /** 生成缩略图 URL（大图浏览用） */
    fun thumbUrl(rootId: String, relPath: String, at: Double = 6.0): String {
        val t = (at.toInt()).coerceAtLeast(1)
        val base = baseUrl.trimEnd('/')
        val encPath = relPath.split("/").joinToString("/") {
            java.net.URLEncoder.encode(it, "UTF-8").replace("+", "%20")
        }
        return "$base/thumb/${enc(rootId)}/$encPath?t=$t&token=${enc(token ?: "")}"
    }

    suspend fun browse(rootId: String, relPath: String, sort: String = "", order: String = ""): BrowseResult {
        var url = "/api/browse?rootId=${enc(rootId)}&path=${enc(relPath)}"
        if (sort.isNotBlank()) url += "&sort=${enc(sort)}&order=${enc(order.ifBlank { "asc" })}"
        val res = exec(url)
        val arr = res.optJSONArray("items") ?: JSONArray()
        val items = (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            MediaEntry(
                name = o.optString("name"),
                path = o.optString("path"),
                isDir = o.optString("type") == "dir" || o.optString("kind") == "dir",
                kind = o.optString("kind"),
                size = o.optLong("size", 0),
                duration = o.optDouble("duration", 0.0)
            )
        }
        return BrowseResult(
            name = res.optString("name"),
            path = res.optString("path", relPath),
            isFile = res.optBoolean("isFile", false),
            items = items
        )
    }

    suspend fun mediaInfo(rootId: String, relPath: String): JSONObject =
        exec("/api/media?rootId=${enc(rootId)}&path=${enc(relPath)}")

    // ---------------- 播放控制 ----------------

    /**
     * 起播。
     *
     * @param burnIndex 内嵌图形字幕下标（PGS/DVD 等只能烧录）
     * @param burnPath  外挂字幕绝对路径（ASS 特效字幕走服务端烧录）
     */
    suspend fun play(
        rootId: String,
        relPath: String,
        startAt: Double = 0.0,
        burnIndex: Int? = null,
        burnPath: String? = null
    ): PlayResult {
        val body = JSONObject()
            .put("rootId", rootId)
            .put("path", relPath)
            .put("startAt", startAt)
        when {
            !burnPath.isNullOrBlank() -> body.put("subtitle", JSONObject()
                .put("mode", "burn")
                .put("path", burnPath)
                .put("name", burnPath.substringAfterLast('\\').substringAfterLast('/')))
            burnIndex != null -> body.put("subtitle", JSONObject()
                .put("mode", "burn")
                .put("index", burnIndex)
                .put("name", "内嵌字幕 #$burnIndex"))
        }
        return parsePlay(exec("/api/play", "POST", body))
    }

    /** 预取媒体信息（含字幕轨列表，用于起播前决定自动烧录） */
    suspend fun subtitleTracksOf(rootId: String, relPath: String): List<SubtitleTrack> {
        val res = mediaInfo(rootId, relPath)
        val arr = res.optJSONArray("subtitleTracks") ?: return emptyList()
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            SubtitleTrack(
                id = o.optString("id", "s$i"),
                label = o.optString("label", "字幕 ${i + 1}"),
                url = o.optString("url"),
                kind = o.optString("kind", "embedded"),
                text = o.optBoolean("text", true),
                burn = o.optBoolean("burn", false),
                isDefault = o.optBoolean("default", false),
                path = o.optString("path")
            )
        }
    }

    suspend fun sessionState(id: String): JSONObject = exec("/api/session/state?id=${enc(id)}")

    suspend fun seek(id: String, position: Double): PlayResult =
        parsePlay(exec("/api/session/seek", "POST", JSONObject().put("id", id).put("position", position)))

    suspend fun setSpeed(id: String, speed: Float): PlayResult =
        parsePlay(exec("/api/session/speed", "POST", JSONObject().put("id", id).put("speed", speed)))

    suspend fun setAudio(id: String, index: Int): PlayResult =
        parsePlay(exec("/api/session/audio", "POST", JSONObject().put("id", id).put("index", index)))

    /** 切换字幕：index 用于内嵌图形字幕，path 用于外挂 ASS/SRT 烧录 */
    suspend fun setSubtitleBurn(id: String, index: Int?, path: String? = null): PlayResult {
        val sub = when {
            !path.isNullOrBlank() -> JSONObject()
                .put("mode", "burn")
                .put("path", path)
                .put("name", path.substringAfterLast('\\').substringAfterLast('/'))
            index == null -> JSONObject.NULL
            else -> JSONObject().put("mode", "burn").put("index", index)
        }
        return parsePlay(exec("/api/session/subtitle", "POST", JSONObject().put("id", id).put("subtitle", sub)))
    }

    suspend fun pause(id: String) { exec("/api/session/pause", "POST", JSONObject().put("id", id)) }
    suspend fun resumeSession(id: String) { exec("/api/session/resume", "POST", JSONObject().put("id", id)) }
    suspend fun stop(id: String) { runCatching { exec("/api/session/stop", "POST", JSONObject().put("id", id)) } }

    /**
     * 退出播放页时用：页面销毁会取消 lifecycleScope，
     * 这里用 OkHttp 的异步队列确保「停止会话」请求一定发出。
     */
    fun stopAsync(id: String) {
        runCatching {
            val req = buildRequest("/api/session/stop", "POST", JSONObject().put("id", id))
            http.newCall(req).enqueue(NoopCallback)
        }
    }

    private object NoopCallback : okhttp3.Callback {
        override fun onFailure(call: okhttp3.Call, e: java.io.IOException) { /* 离线忽略 */ }
        override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
            response.close()
        }
    }

    private fun parsePlay(res: JSONObject): PlayResult {
        val audio = res.optJSONArray("audioTracks")?.let { arr ->
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                AudioTrackInfo(
                    index = o.optInt("index", i),
                    // optString 的 default 只在键缺失时生效：服务端下发空串时兜底
                    label = o.optString("label").trim().ifEmpty { "音轨 ${i + 1}" },
                    language = o.optString("language"),
                    channels = o.optInt("channels", 2)
                )
            }
        } ?: emptyList()

        val subs = res.optJSONArray("subtitleTracks")?.let { arr ->
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                SubtitleTrack(
                    id = o.optString("id", "s$i"),
                    label = o.optString("label").trim().ifEmpty { "字幕 ${i + 1}" },
                    url = o.optString("url"),
                    kind = o.optString("kind", "embedded"),
                    text = o.optBoolean("text", true),
                    burn = o.optBoolean("burn", false),
                    isDefault = o.optBoolean("default", false),
                    path = o.optString("path")
                )
            }
        } ?: emptyList()

        val burn = res.optJSONArray("burnSubtitles")?.let { arr ->
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                BurnSubtitle(
                    index = o.optInt("index", i),
                    label = o.optString("label").trim().ifEmpty { "图形字幕 ${i + 1}" },
                    language = o.optString("language")
                )
            }
        } ?: emptyList()

        return PlayResult(
            sessionId = res.optString("id"),
            title = res.optString("title"),
            state = res.optString("state"),
            gen = res.optInt("gen", 1),
            playlist = res.optString("playlist"),
            position = res.optDouble("position", 0.0),
            offset = res.optDouble("offset", 0.0),
            duration = res.optDouble("duration", 0.0),
            speed = res.optDouble("speed", 1.0).toFloat(),
            audioIndex = res.optInt("audioIndex", 0),
            subtitleTracks = subs,
            burnSubtitles = burn,
            audioTracks = audio,
            encoder = res.optString("encoder"),
            error = res.optString("error")
        )
    }

    private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8")
}
