package com.lanplay.client

import android.os.Build
import androidx.test.core.app.ApplicationProvider
import com.lanplay.client.model.ApiException
import com.lanplay.client.net.LanPlayApi
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
 * 边界与容错测试：模拟投影仪上最容易遇到的异常场景。
 * 目标设备只有 2GB 内存、WiFi 信号一般，网络抖动与越权访问都要能给出可理解的错误。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class EdgeCaseTest {

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
        app.getSharedPreferences("lanplay_client", android.content.Context.MODE_PRIVATE).edit().clear().commit()
        api = LanPlayApi.get(app)
        api.baseUrl = "http://127.0.0.1:8099"
        pin = Regex("\"pin\"\\s*:\\s*\"(\\d{6})\"").find(guiState())?.groupValues?.get(1) ?: ""
        runBlocking { api.pair("http://127.0.0.1:8099", pin, "Robo TV") }
    }

    @Test
    fun connectingToDeadHostFailsWithReadableMessage() = runBlocking {
        val dead = LanPlayApi(ApplicationProvider.getApplicationContext())
        dead.baseUrl = "http://127.0.0.1:59999"
        try {
            dead.roots()
            throw AssertionError("连接不存在的端口应该抛异常")
        } catch (e: ApiException) {
            assertTrue("错误信息应可读，实际：${e.message}",
                (e.message ?: "").isNotBlank() && !(e.message ?: "").startsWith("HTTP 0"))
        }
    }

    @Test
    fun browseOutsideRootIsRejected() = runBlocking {
        val root = api.roots().first { it.type == "dir" }
        try {
            api.browse(root.id, "../../../../Windows/System32")
            throw AssertionError("越权路径应该被拒绝")
        } catch (e: ApiException) {
            assertTrue("应返回 4xx，实际 ${e.code}", e.code in 400..499)
            assertTrue("应给出可理解提示，实际：${e.message}", (e.message ?: "").isNotBlank())
        }
    }

    @Test
    fun playingMissingFileFailsGracefully() = runBlocking {
        val root = api.roots().first { it.type == "dir" }
        try {
            api.play(root.id, "不存在的文件.mkv", 0.0)
            throw AssertionError("播放不存在的文件应失败")
        } catch (e: ApiException) {
            assertEquals("应返回 404，实际 ${e.code}", 404, e.code)
        }
    }

    @Test
    fun unauthorizedRequestGives401NotCrash() = runBlocking {
        val fresh = LanPlayApi(ApplicationProvider.getApplicationContext())
        fresh.baseUrl = "http://127.0.0.1:8099"
        fresh.token = null
        try {
            fresh.roots()
            throw AssertionError("无 token 应返回 401")
        } catch (e: ApiException) {
            assertEquals(401, e.code)
        }
    }

    @Test
    fun expiredTokenIsClearedOnResume() = runBlocking {
        val fresh = LanPlayApi(ApplicationProvider.getApplicationContext())
        fresh.baseUrl = "http://127.0.0.1:8099"
        fresh.token = "t-invalid-token"
        val ok = fresh.resume()
        assertFalse("无效 token 的 resume 应返回 false", ok)
        assertEquals("无效 token 应被清除", null, fresh.token)
    }

    @Test
    fun concurrentSessionLimitIsReported() = runBlocking {
        val root = api.roots().first { it.type == "dir" }
        val video = api.browse(root.id, "").items.first { !it.isDir && it.kind == "video" }
        val first = api.play(root.id, video.path, 0.0)
        var secondId: String? = null
        try {
            val second = api.play(root.id, video.path, 0.0)
            secondId = second.sessionId
            // 若服务端 maxSessions > 1 则允许，这里只要求不会崩溃
        } catch (e: ApiException) {
            assertTrue("并发超限应给出可读提示，实际：${e.message}",
                (e.message ?: "").contains("并发") || (e.message ?: "").contains("会话"))
        } finally {
            api.stop(first.sessionId)
            secondId?.let { api.stop(it) }
        }
    }

    @Test
    fun seekBeyondDurationIsClamped() = runBlocking {
        val root = api.roots().first { it.type == "dir" }
        val video = api.browse(root.id, "").items.first { !it.isDir && it.kind == "video" }
        val play = api.play(root.id, video.path, 0.0)
        // 请求跳到远超片长的位置，服务端应夹紧而不是崩溃
        val res = api.seek(play.sessionId, 99999.0)
        assertTrue("超出片长的 seek 应被夹紧到时长内，实际 ${res.position} / ${res.duration}",
            res.position <= res.duration + 1.0)
        api.stop(play.sessionId)
    }

    @Test
    fun negativeSeekIsClampedToZero() = runBlocking {
        val root = api.roots().first { it.type == "dir" }
        val video = api.browse(root.id, "").items.first { !it.isDir && it.kind == "video" }
        val play = api.play(root.id, video.path, 0.0)
        val res = api.seek(play.sessionId, -50.0)
        assertTrue("负数 seek 应被夹紧到 0，实际 ${res.position}", res.position >= 0.0)
        api.stop(play.sessionId)
    }

    @Test
    fun deviceNameIsPreservedAcrossReconnect() = runBlocking {
        val app = ApplicationProvider.getApplicationContext<android.content.Context>()
        val api2 = LanPlayApi.get(app)
        api2.deviceName = "客厅投影仪"
        assertEquals("客厅投影仪", api2.deviceName)

        // 模拟进程重启：清单例但保留 prefs
        val f = LanPlayApi::class.java.getDeclaredField("instance")
        f.isAccessible = true
        f.set(null, null)
        val api3 = LanPlayApi.get(app)
        assertEquals("重连后设备名应保留", "客厅投影仪", api3.deviceName)
        assertEquals("重连后 baseUrl 应保留", "http://127.0.0.1:8099", api3.baseUrl)
    }

    @Test
    fun discoveryReturnsEmptyListWhenNoServerBroadcasts() = runBlocking {
        // Robolectric 下没有真实广播，只验证不会抛异常、能正常返回（投影仪上同理）
        val result = com.lanplay.client.discovery.DiscoveryClient(
            ApplicationProvider.getApplicationContext(), 52399
        ).scan(600)
        assertTrue("无服务端时应返回空列表而不是抛异常", result.isEmpty())
    }
}
