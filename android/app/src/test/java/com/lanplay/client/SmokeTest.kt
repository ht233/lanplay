package com.lanplay.client

import android.os.Build
import android.view.LayoutInflater
import android.view.View
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 冒烟测试：确认 Robolectric 能在 JVM 上以 Android 9 (API 28) 运行时启动，
 * 并且五个布局都能真实 inflate（能抓出 XML 属性错误、自定义 View 构造函数问题等）。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class SmokeTest {

    @Test
    fun runtimeIsAndroid9() {
        assertEquals(28, Build.VERSION.SDK_INT)
        assertEquals("9", Build.VERSION.RELEASE)
    }

    @Test
    fun allLayoutsInflateOnApi28() {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val inflater = LayoutInflater.from(ctx)
        val layouts = listOf(
            R.layout.activity_connect,
            R.layout.activity_browse,
            R.layout.activity_player,
            R.layout.item_media,
            R.layout.item_server
        )
        for (id in layouts) {
            val v: View = inflater.inflate(id, null, false)
            assertNotNull("layout $id 未能 inflate", v)
        }
    }

    @Test
    fun playerLayoutHasAllControls() {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val root = LayoutInflater.from(ctx).inflate(R.layout.activity_player, null, false)
        val expected = listOf(
            R.id.player_view, R.id.loading_box, R.id.loading_text,
            R.id.error_box, R.id.error_text, R.id.btn_retry,
            R.id.controls, R.id.time_current, R.id.seek, R.id.time_total,
            R.id.title, R.id.btn_play, R.id.btn_back10, R.id.btn_fwd30,
            R.id.btn_speed, R.id.btn_audio, R.id.btn_subtitle,
            R.id.menu_panel, R.id.menu_title, R.id.menu_list, R.id.seek_hint
        )
        val missing = expected.filter { root.findViewById<View>(it) == null }
        assertTrue("播放页缺少控件: $missing", missing.isEmpty())
    }

    @Test
    fun browseLayoutHasThreeLists() {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val root = LayoutInflater.from(ctx).inflate(R.layout.activity_browse, null, false)
        for (id in listOf(R.id.root_list, R.id.file_list, R.id.file_empty, R.id.path, R.id.status)) {
            assertNotNull("浏览页缺少控件 id=$id", root.findViewById<View>(id))
        }
    }
}
