package com.lanplay.client

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Build
import android.view.KeyEvent
import android.view.View
import android.widget.EditText
import androidx.test.core.app.ApplicationProvider
import com.lanplay.client.net.LanPlayApi
import com.lanplay.client.ui.TvSeekBar
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper
import java.net.HttpURLConnection
import java.net.URL

/**
 * UI 行为测试：在 JVM 上用真实 Android 9 (API 28) 运行时启动 Activity，
 * 模拟遥控器按键，验证焦点、按键分发与页面跳转。
 * 依赖本机运行的服务端（127.0.0.1:8099）；不在线时跳过。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class UiBehaviourTest {

    private lateinit var app: Context
    private var pin: String = ""

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

    /** 清掉单例与已保存状态，保证每个用例从干净状态开始 */
    private fun resetApi() {
        val f = LanPlayApi::class.java.getDeclaredField("instance")
        f.isAccessible = true
        f.set(null, null)
        app.getSharedPreferences("lanplay_client", Context.MODE_PRIVATE).edit().clear().commit()
        app.getSharedPreferences("lanplay_resume", Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        assumeTrue("服务端未运行，跳过 UI 测试", serverUp())
        pin = Regex("\"pin\"\\s*:\\s*\"(\\d{6})\"").find(guiState())?.groupValues?.get(1) ?: ""
        resetApi()
    }

    // ---------------- ConnectActivity ----------------

    @Test
    fun connectActivityStartsAndPrefillsDeviceName() {
        val controller = Robolectric.buildActivity(ConnectActivity::class.java).setup()
        val activity = controller.get()
        assertNotNull("ConnectActivity 启动失败", activity)
        val name = activity.findViewById<EditText>(R.id.input_name)
        assertTrue("设备名应预填，实际 '${name.text}'", name.text.toString().isNotBlank())
        // 标题与提示存在
        assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.btn_connect).visibility)
    }

    @Test
    fun connectActivityRejectsEmptyAddress() {
        val activity = Robolectric.buildActivity(ConnectActivity::class.java).setup().get()
        activity.findViewById<View>(R.id.btn_connect).performClick()
        ShadowLooper.idleMainLooper()
        val hint = activity.findViewById<android.widget.TextView>(R.id.hint)
        assertTrue("空地址应给出提示，实际 '${hint.text}'", hint.text.contains("请输入"))
    }

    @Test
    fun connectActivityPairsAndNavigatesToBrowse() {
        val controller = Robolectric.buildActivity(ConnectActivity::class.java).setup()
        val activity = controller.get()
        activity.findViewById<EditText>(R.id.input_address).setText("127.0.0.1:8099")
        activity.findViewById<EditText>(R.id.input_pin).setText(pin)
        activity.findViewById<android.widget.Button>(R.id.btn_connect).performClick()

        // 等待协程完成（网络 + 配对）
        repeat(40) {
            ShadowLooper.idleMainLooper()
            Thread.sleep(100)
        }
        val next = shadowOf(activity).nextStartedActivity
        assertNotNull("配对成功后应跳转 BrowseActivity，实际 hint='${activity.findViewById<android.widget.TextView>(R.id.hint).text}'", next)
        assertEquals(BrowseActivity::class.java.name, next.component?.className)
    }

    // ---------------- BrowseActivity ----------------

    @Test
    fun browseActivityLoadsRootsAndFiles() {
        // 先配对，写入 token
        val api = LanPlayApi.get(app)
        api.baseUrl = "http://127.0.0.1:8099"
        kotlinx.coroutines.runBlocking { api.pair("http://127.0.0.1:8099", pin, "Robo TV") }

        val activity = Robolectric.buildActivity(BrowseActivity::class.java).setup().get()
        repeat(30) {
            ShadowLooper.idleMainLooper()
            Thread.sleep(100)
        }
        val rootList = activity.findViewById<androidx.recyclerview.widget.RecyclerView>(R.id.root_list)
        assertTrue("媒体源列表应有条目", rootList.adapter?.itemCount ?: 0 > 0)
        val fileList = activity.findViewById<androidx.recyclerview.widget.RecyclerView>(R.id.file_list)
        assertTrue("文件列表应有条目", fileList.adapter?.itemCount ?: 0 > 0)
        assertEquals(View.GONE, activity.findViewById<View>(R.id.file_empty).visibility)
    }

    @Test
    fun browseActivityBackFromSubdirGoesToParent() {
        val api = LanPlayApi.get(app)
        api.baseUrl = "http://127.0.0.1:8099"
        kotlinx.coroutines.runBlocking { api.pair("http://127.0.0.1:8099", pin, "Robo TV") }

        val activity = Robolectric.buildActivity(BrowseActivity::class.java).setup().get()
        repeat(20) { ShadowLooper.idleMainLooper(); Thread.sleep(100) }
        // 根目录下按返回 → 应退出（finish），不崩溃
        activity.onBackPressed()
        assertTrue("根目录按返回应结束 Activity", activity.isFinishing)
    }

    // ---------------- TvSeekBar（遥控器按键） ----------------

    @Test
    fun seekBarStepsOnDpadAndRepeatsOnHold() {
        val activity = Robolectric.buildActivity(ConnectActivity::class.java).setup().get()
        // 必须 attach 到窗口：未 attach 的 View 上 postDelayed 只会进 HandlerActionQueue，不会真正执行
        val container = android.widget.FrameLayout(activity)
        val bar = TvSeekBar(activity)
        container.addView(bar, android.widget.FrameLayout.LayoutParams(600, 80))
        activity.setContentView(container)
        bar.max = 1000
        bar.progressValue = 500
        val steps = mutableListOf<Int>()
        bar.onStep = { steps.add(it) }
        val seeks = mutableListOf<Int>()
        bar.onSeek = { seeks.add(it) }

        assertEquals("初始进度应为 500", 500, bar.progressValue)

        // 单击右键：应触发一次 +1（PlayerActivity 里再乘 10 秒）
        val down = KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_RIGHT)
        bar.onKeyDown(KeyEvent.KEYCODE_DPAD_RIGHT, down)
        assertEquals("单击右键应步进一次", 1, steps.size)
        assertEquals(1, steps[0])

        // 抬起后停止连发
        bar.onKeyUp(KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_RIGHT))

        // 长按：280ms 后开始连续触发，每 110ms 一次（TvSeekBar.startRepeat 实参）
        steps.clear()
        bar.onKeyDown(KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_RIGHT))
        ShadowLooper.idleMainLooper()
        ShadowLooper.getShadowMainLooper().idleFor(1200, java.util.concurrent.TimeUnit.MILLISECONDS)
        assertTrue("长按应连续步进，实际 ${steps.size} 次", steps.size >= 3)
        assertTrue("长按应始终是同一方向", steps.all { it == 1 })

        bar.onKeyUp(KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_RIGHT))
        val after = steps.size
        ShadowLooper.getShadowMainLooper().idleFor(1000, java.util.concurrent.TimeUnit.MILLISECONDS)
        assertEquals("抬起后应停止连发", after, steps.size)

        // 左键应反向
        steps.clear()
        bar.onKeyDown(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_LEFT))
        assertEquals("左键应给出 -1 方向", listOf(-1), steps)
        bar.onKeyUp(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_LEFT))

        // OK 键提交当前进度
        bar.onKeyDown(KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_CENTER))
        assertEquals("OK 键应提交当前进度", 1, seeks.size)
        assertEquals(500, seeks[0])
    }

    // ---------------- PlayerActivity ----------------

    @Test
    fun playerActivityStartsAndShowsControls() {
        val api = LanPlayApi.get(app)
        api.baseUrl = "http://127.0.0.1:8099"
        kotlinx.coroutines.runBlocking { api.pair("http://127.0.0.1:8099", pin, "Robo TV") }
        val root = kotlinx.coroutines.runBlocking { api.roots() }.first { it.type == "dir" }
        val video = kotlinx.coroutines.runBlocking { api.browse(root.id, "") }
            .items.first { !it.isDir && it.kind == "video" }

        val intent = Intent(app, PlayerActivity::class.java)
            .putExtra(PlayerActivity.EXTRA_ROOT_ID, root.id)
            .putExtra(PlayerActivity.EXTRA_PATH, video.path)
        val controller = Robolectric.buildActivity(PlayerActivity::class.java, intent).setup()
        val activity = controller.get()
        repeat(40) { ShadowLooper.idleMainLooper(); Thread.sleep(100) }

        val controls = activity.findViewById<View>(R.id.controls)
        assertNotNull("播放页控制栏应存在", controls)
        val title = activity.findViewById<android.widget.TextView>(R.id.title)
        assertTrue("标题应显示文件名，实际 '${title.text}'", title.text.toString().isNotBlank())
        val total = activity.findViewById<android.widget.TextView>(R.id.time_total)
        assertTrue("总时长应显示，实际 '${total.text}'", total.text.toString() != "--:--")
        controller.pause().stop().destroy()
    }
}
