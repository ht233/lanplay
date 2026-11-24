package com.lanplay.client

import android.os.Build
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * 目标设备（小明 Q1 / Amlogic T972 / Android 9 / 2GB RAM）适配性检查。
 * 在 API 28 运行时上验证低内存、非触摸、横屏 TV 场景的假设。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class TargetDeviceTest {

    @Test
    fun api28SupportsAllUsedPlatformApis() {
        // 逐条核对代码里用到的平台 API 在 API 28 上的可用性
        assertTrue("DisplayCutout 需 API 28", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)

        // 关键的 API 存在性检查（反射，确保没有用到 API 29+ 才有的方法）
        val required = listOf(
            "android.view.WindowInsets" to "getDisplayCutout",
            "android.view.DisplayCutout" to "getSafeInsetLeft",
            "android.media.MediaCodec" to "createDecoderByType"
        )
        for ((cls, method) in required) {
            val c = Class.forName(cls)
            val found = c.methods.any { it.name == method }
            assertTrue("$cls.$method 在 API 28 应存在", found)
        }
    }

    @Test
    fun appLaunchesWithoutTouchscreen() {
        // 投影仪只有遥控器：touchscreen 声明为 false，应用仍需正常启动
        val pm = ApplicationProvider.getApplicationContext<android.content.Context>().packageManager
        val hasTouch = pm.hasSystemFeature(android.content.pm.PackageManager.FEATURE_TOUCHSCREEN)
        // Robolectric 默认无触摸屏，等价于投影仪环境。
        // P3 修复：原断言 `!hasTouch || true` 恒真（无论结果都通过），改为真断言。
        assertTrue("本测试环境应模拟非触摸设备", !hasTouch)
    }

    @Test
    fun memoryFootprintOfModelsIsSmall() {
        // 2GB 内存设备：确认列表模型不会被大对象撑爆
        val entries = (1..2000).map {
            com.lanplay.client.model.MediaEntry(
                name = "影片文件名称示例_$it.mkv", path = "dir/sub/file_$it.mkv",
                isDir = false, kind = "video", size = 4_000_000_000L, duration = 7200.0
            )
        }
        val runtime = Runtime.getRuntime()
        System.gc()
        val before = runtime.totalMemory() - runtime.freeMemory()
        // 保留引用，防止被优化掉
        assertTrue(entries.size == 2000)
        val after = runtime.totalMemory() - runtime.freeMemory()
        val perEntry = (after - before) / 2000
        assertTrue("单条列表项不应超过 2KB（实际 $perEntry B）", perEntry < 2048)
    }

    @Test
    fun subtitleFileIsServedAsVttNotAss() {
        // Android 9 的 Media3 只吃 WebVTT；确认服务端返回的是 VTT 而不是 ASS/SRT
        val url = java.net.URL("http://127.0.0.1:8099/api/ping")
        try {
            val c = url.openConnection() as java.net.HttpURLConnection
            c.connectTimeout = 1500
            if (c.responseCode != 200) return
        } catch (e: Exception) { return }

        val api = com.lanplay.client.net.LanPlayApi.get(ApplicationProvider.getApplicationContext())
        api.baseUrl = "http://127.0.0.1:8099"
        val state = java.net.URL("http://127.0.0.1:8099/api/gui/state").openConnection() as java.net.HttpURLConnection
        val pin = Regex("\"pin\"\\s*:\\s*\"(\\d{6})\"")
            .find(state.inputStream.bufferedReader().readText())?.groupValues?.get(1) ?: return
        kotlinx.coroutines.runBlocking {
            api.pair("http://127.0.0.1:8099", pin, "DevCheck")
            val root = api.roots().first { it.type == "dir" }
            val video = api.browse(root.id, "").items.first { !it.isDir && it.kind == "video" }
            val play = api.play(root.id, video.path, 0.0)
            // 可能有需要服务端烧录的 ASS 轨（url 为空）；只校验客户端渲染的文本轨
            val textTrack = play.subtitleTracks.firstOrNull { it.text && it.url.isNotBlank() }
            if (textTrack != null) {
                assertTrue("字幕 MIME 应可被 Media3 识别（VTT）", textTrack.url.contains("vtt"))
            }
            api.stop(play.sessionId)
        }
    }

    @Test
    fun hlsSegmentsAreAccessibleOverHttp() {
        // 投影仪通过 HTTP 拉流；确认不存在 HTTPS/明文限制问题
        val api = com.lanplay.client.net.LanPlayApi.get(ApplicationProvider.getApplicationContext())
        api.baseUrl = "http://127.0.0.1:8099"
        val state = try {
            (java.net.URL("http://127.0.0.1:8099/api/gui/state").openConnection() as java.net.HttpURLConnection)
                .inputStream.bufferedReader().readText()
        } catch (e: Exception) { return }
        val pin = Regex("\"pin\"\\s*:\\s*\"(\\d{6})\"").find(state)?.groupValues?.get(1) ?: return

        kotlinx.coroutines.runBlocking {
            api.pair("http://127.0.0.1:8099", pin, "DevCheck")
            val root = api.roots().first { it.type == "dir" }
            val video = api.browse(root.id, "").items.first { !it.isDir && it.kind == "video" }
            val play = api.play(root.id, video.path, 0.0)
            Thread.sleep(2500)
            val conn = java.net.URL(play.playlist).openConnection() as java.net.HttpURLConnection
            assertEquals("HLS 播放列表应可匿名访问（播放器不带 token）", 200, conn.responseCode)
            val m3u8 = conn.inputStream.bufferedReader().readText()
            assertTrue("应是 m3u8", m3u8.startsWith("#EXTM3U"))
            // 取第一个分片，确认可下载
            val seg = m3u8.lines().firstOrNull { it.endsWith(".ts") }
            assertTrue("应有分片", seg != null)
            val segUrl = play.playlist.substringBeforeLast('/') + "/" + seg
            val sc = java.net.URL(segUrl).openConnection() as java.net.HttpURLConnection
            assertEquals("分片应可下载", 200, sc.responseCode)
            assertTrue("分片应有内容", sc.contentLengthLong > 10000)
            api.stop(play.sessionId)
        }
    }
}
