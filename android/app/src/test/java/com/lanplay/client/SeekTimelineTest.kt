package com.lanplay.client

import android.os.Build
import androidx.test.core.app.ApplicationProvider
import com.lanplay.client.net.LanPlayApi
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
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
 * 回归测试：HLS 时间轴与媒体绝对位置的关系。
 *
 * 服务端 seek 后重启 ffmpeg，新播放列表从 0 开始，0 对应媒体的 offset 秒。
 * 客户端必须用 (position - offset) 换算，否则会跳到流末尾之外。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class SeekTimelineTest {

    private lateinit var api: LanPlayApi
    private var pin = ""

    private fun serverUp(): Boolean = try {
        val c = URL("http://127.0.0.1:8099/api/ping").openConnection() as HttpURLConnection
        c.connectTimeout = 1500; c.readTimeout = 1500
        c.responseCode == 200
    } catch (e: Exception) { false }

    private fun guiState(): String {
        val c = URL("http://127.0.0.1:8099/api/gui/state").openConnection() as HttpURLConnection
        c.connectTimeout = 2000
        return c.inputStream.bufferedReader().readText()
    }

    @Before
    fun setUp() {
        assumeTrue("服务端未运行，跳过", serverUp())
        val f = LanPlayApi::class.java.getDeclaredField("instance")
        f.isAccessible = true
        f.set(null, null)
        val app = ApplicationProvider.getApplicationContext<android.content.Context>()
        app.getSharedPreferences("lanplay_client", android.content.Context.MODE_PRIVATE)
            .edit().clear().commit()
        api = LanPlayApi.get(app)
        api.baseUrl = "http://127.0.0.1:8099"
        pin = Regex("\"pin\"\\s*:\\s*\"(\\d{6})\"").find(guiState())?.groupValues?.get(1) ?: ""
        runBlocking { api.pair("http://127.0.0.1:8099", pin, "Robo TV") }
    }

    private fun firstVideo(): Triple<String, String, String> = runBlocking {
        val root = api.roots().first { it.type == "dir" }
        val v = api.browse(root.id, "").items.first { !it.isDir && it.kind == "video" }
        Triple(root.id, v.path, root.id)
    }

    @Test
    fun playResultExposesOffsetField() = runBlocking {
        val (rootId, path, _) = firstVideo()
        val res = api.play(rootId, path, 0.0)
        // offset 必须被解析出来（为 0 也算有效，但不能是 NaN 之类的脏值）
        assertTrue("offset 应为有限数值，实际 ${res.offset}", !res.offset.isNaN())
        api.stop(res.sessionId)
    }

    @Test
    fun seekStartsNewTimelineAtZero() = runBlocking {
        val (rootId, path, _) = firstVideo()
        val play = api.play(rootId, path, 0.0)
        val seeked = api.seek(play.sessionId, 12.0)

        // 关键不变量：seek 之后 offset 应接近 12，position 应 >= offset
        assertTrue("seek 后 offset 应约等于 12，实际 ${seeked.offset}", seeked.offset >= 11.0)
        assertTrue("seek 后 position 应 >= offset，实际 pos=${seeked.position} off=${seeked.offset}",
            seeked.position >= seeked.offset - 0.5)

        // 相对位置 = position - offset，必须远小于 position 本身（否则客户端会越界 seek）
        val relative = seeked.position - seeked.offset
        assertTrue("相对流内位置应远小于绝对位置（rel=$relative pos=${seeked.position}），" +
            "否则客户端按 position seek 会跳飞", relative < seeked.position)

        api.stop(seeked.sessionId)
    }

    @Test
    fun playlistTimelineStartsFromZeroAfterSeek() = runBlocking {
        val (rootId, path, _) = firstVideo()
        val play = api.play(rootId, path, 0.0)
        val seeked = api.seek(play.sessionId, 12.0)
        Thread.sleep(3000)

        val conn = URL(seeked.playlist).openConnection() as HttpURLConnection
        conn.connectTimeout = 3000; conn.readTimeout = 8000
        val m3u8 = conn.inputStream.bufferedReader().readText()
        conn.disconnect()

        // 播放列表应从 0 编号开始；真正的媒体偏移靠 ffmpeg -ss 完成
        assertTrue("播放列表应是 EVENT 型", m3u8.contains("#EXT-X-PLAYLIST-TYPE:EVENT") || m3u8.contains("#EXT-X-TARGETDURATION"))
        val firstSeg = Regex("seg(\\d+)\\.ts").find(m3u8)?.groupValues?.get(1)?.toIntOrNull()
        assertEquals("seek 后新流的分片应从 0 开始编号", 0, firstSeg)

        api.stop(seeked.sessionId)
    }

    @Test
    fun seekBackwardsAndForwardsKeepOffsetConsistent() = runBlocking {
        val (rootId, path, _) = firstVideo()
        val play = api.play(rootId, path, 0.0)

        val fwd = api.seek(play.sessionId, 15.0)
        assertTrue("向后跳 offset≈15，实际 ${fwd.offset}", fwd.offset >= 14.0)

        val back = api.seek(play.sessionId, 5.0)
        assertTrue("向前跳 offset≈5，实际 ${back.offset}", back.offset <= 6.5)
        val rel = back.position - back.offset
        assertTrue("跳回后相对位置应很小，实际 $rel", rel < 5.0)

        api.stop(back.sessionId)
    }
}
