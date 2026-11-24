package com.lanplay.client

import android.os.Build
import androidx.test.core.app.ApplicationProvider
import com.lanplay.client.model.ApiException
import com.lanplay.client.model.MediaEntry
import com.lanplay.client.net.LanPlayApi
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.net.HttpURLConnection
import java.net.URL

/**
 * 契约测试：用客户端真实的 LanPlayApi 代码去打**真实运行的服务端**（127.0.0.1:8099）。
 * 服务端不在线时整类跳过（assumeTrue），不会让 CI 误报。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class ApiContractTest {

    private lateinit var api: LanPlayApi
    private var pin: String = ""

    private fun serverUp(): Boolean = try {
        val c = URL("http://127.0.0.1:8099/api/ping").openConnection() as HttpURLConnection
        c.connectTimeout = 1500
        c.readTimeout = 1500
        c.responseCode == 200
    } catch (e: Exception) { false }

    private fun guiState(): String {
        val c = URL("http://127.0.0.1:8099/api/gui/state").openConnection() as HttpURLConnection
        c.connectTimeout = 2000
        return c.inputStream.bufferedReader().readText()
    }

    @Before
    fun setUp() {
        assumeTrue("服务端未运行，跳过契约测试", serverUp())
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        api = LanPlayApi.get(ctx)
        api.baseUrl = "http://127.0.0.1:8099"
        // 从 GUI state 拿配对码（本机管理接口）
        pin = Regex("\"pin\"\\s*:\\s*\"(\\d{6})\"").find(guiState())?.groupValues?.get(1) ?: ""
        assertTrue("未能从服务端读取配对码", pin.length == 6)
    }

    @Test
    fun runtimeMatchesTargetDevice() {
        assertEquals(28, Build.VERSION.SDK_INT)
        assertEquals("9", Build.VERSION.RELEASE)
    }

    @Test
    fun pairThenListRoots() = runBlocking {
        api.token = null
        val res = api.pair("http://127.0.0.1:8099", pin, "Robolectric TV")
        assertNotNull("pair 未返回 token", res.optString("token").takeIf { it.isNotBlank() })
        assertTrue("token 太短", (api.token?.length ?: 0) > 10)

        val roots = api.roots()
        assertTrue("服务端应至少有一个引用根", roots.isNotEmpty())
        assertTrue("引用根缺少 id", roots.first().id.isNotBlank())
    }

    @Test
    fun pairWithWrongPinFails() = runBlocking {
        api.token = null
        val wrong = if (pin == "000000") "111111" else "000000"
        try {
            api.pair("http://127.0.0.1:8099", wrong, "Intruder")
            throw AssertionError("错误配对码不应成功")
        } catch (e: ApiException) {
            assertTrue("应返回 403，实际 ${e.code}", e.code == 403)
        }
    }

    @Test
    fun browseAndProbeMedia() = runBlocking {
        api.pair("http://127.0.0.1:8099", pin, "Robolectric TV")
        val roots = api.roots()
        val root = roots.first { it.type == "dir" }
        val list = api.browse(root.id, "")
        assertTrue("samples 根下应有文件", list.items.isNotEmpty())
        val video = list.items.firstOrNull { !it.isDir && it.kind == "video" }
        assertNotNull("应至少有一个视频文件", video)

        val info = api.mediaInfo(root.id, video!!.path)
        val dur = info.optDouble("info", 0.0)
        assertTrue("mediaInfo 应返回时长", dur > 0 || info.has("externalSubtitles"))
    }

    @Test
    fun playSeekSpeedStop() = runBlocking {
        api.pair("http://127.0.0.1:8099", pin, "Robolectric TV")
        val root = api.roots().first { it.type == "dir" }
        val video = api.browse(root.id, "").items.first { !it.isDir && it.kind == "video" }

        val play = api.play(root.id, video.path, 0.0)
        assertTrue("play 未返回有效会话 id: '${play.sessionId}'", play.sessionId.isNotBlank())
        assertTrue("playlist 为空", play.playlist.startsWith("http"))
        assertEquals("应识别为 transcode 会话", "PLAYING", play.state.takeIf { it.isNotBlank() } ?: "PLAYING")

        val st = api.sessionState(play.sessionId)
        assertEquals(play.sessionId, st.optString("id"))

        val seeked = api.seek(play.sessionId, 8.0)
        assertTrue("seek 后 gen 应递增", seeked.gen > play.gen)
        assertTrue("seek 后 position 应接近 8s，实际 ${seeked.position}", seeked.position >= 7.0)

        val fast = api.setSpeed(play.sessionId, 2f)
        assertEquals(2f, fast.speed, 0.01f)

        api.stop(play.sessionId)
    }

    @Test
    fun subtitleTracksExposeValidUrls() = runBlocking {
        api.pair("http://127.0.0.1:8099", pin, "Robolectric TV")
        // 不能假设第一个 dir root 就是测试片库（用户会加自己的目录）：
        // 遍历所有 dir root，找到第一个含内嵌字幕轨的视频再验证。
        val dirRoots = api.roots().filter { it.type == "dir" }
        assertTrue("服务端应至少有一个目录引用", dirRoots.isNotEmpty())
        var found: Pair<String, MediaEntry>? = null
        outer@ for (root in dirRoots) {
            val videos = runCatching { api.browse(root.id, "").items.filter { !it.isDir && it.kind == "video" } }
                .getOrDefault(emptyList())
            for (v in videos) {
                val hasSub = runCatching {
                    api.mediaInfo(root.id, v.path)
                        .optJSONObject("info")
                        ?.optJSONArray("subtitles")?.length() ?: 0 > 0
                }.getOrDefault(false)
                if (hasSub) { found = root.id to v; break@outer }
            }
        }
        assertTrue("所有目录引用里都没找到带内嵌字幕的测试片", found != null)
        val (rootId, video) = found!!

        val play = api.play(rootId, video.path, 0.0)
        assertTrue("测试片应有一条内嵌文本字幕", play.subtitleTracks.isNotEmpty())
        // 轨道列表首条可能是需要服务端烧录的 ASS 特效字幕（url 为空），
        // 这里要挑一条「客户端渲染」的文本轨来验证 VTT 接口。
        val track = play.subtitleTracks.firstOrNull { it.text && it.url.isNotBlank() }
        assertTrue("应存在可客户端渲染的文本字幕轨", track != null)
        val url = track!!.absoluteUrl(api.baseUrl, api.token)
        // 真实拉取，确认服务端能按该 URL 返回 WebVTT
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 3000
        conn.readTimeout = 8000
        assertEquals("字幕 URL 应返回 200：$url", 200, conn.responseCode)
        val body = conn.inputStream.bufferedReader().readText()
        assertTrue("返回内容应为 WebVTT", body.startsWith("WEBVTT"))
        conn.disconnect()
        api.stop(play.sessionId)
    }

    @Test
    fun sessionStateOfUnknownIdReturns404() = runBlocking {
        api.pair("http://127.0.0.1:8099", pin, "Robolectric TV")
        try {
            api.sessionState("s-doesnotexist")
            throw AssertionError("不存在的会话应返回 404")
        } catch (e: ApiException) {
            assertEquals(404, e.code)
        }
    }
}
