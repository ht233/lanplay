package com.lanplay.client.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.KeyEvent
import android.view.View

/**
 * 遥控器友好的进度条：
 * - 左右键步进（默认 10 秒/次，可配）
 * - 长按连续快进/快退（每 120ms 触发一次）
 * - 屏幕上不显示系统 SeekBar 的小圆点，只画一条清晰的大进度条
 */
class TvSeekBar @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0
) : View(context, attrs, defStyle) {

    var max: Int = 1000
        set(value) { field = if (value <= 0) 1 else value; invalidate() }

    var progressValue: Int = 0
        set(value) { field = value.coerceIn(0, max); invalidate() }

    /**
     * 步进单位（毫秒）。播放器通过 onStep 回调决定语义（如 dir*10s），
     * 此字段保留给希望直接用毫秒步进的调用方；未使用时保持默认 10s。
     */
    @Deprecated("步进语义由 onStep 回调决定（PlayerActivity 用 dir*10s）；此字段保留仅作占位")
    var stepMs: Long = 10_000

    var onSeek: ((Int) -> Unit)? = null
    var onStep: ((Int) -> Unit)? = null

    private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF2B323B.toInt() }
    private val progressPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF2F81F7.toInt() }
    private val thumbPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt() }
    private val focusPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 4f
        color = 0xFF58A6FF.toInt()
    }

    private val rect = RectF()
    private var repeatRunnable: Runnable? = null
    private var repeatDirection = 0

    init {
        isFocusable = true
        isFocusableInTouchMode = true
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        rect.set(paddingLeft.toFloat(), (h / 2f - 6f), w - paddingRight.toFloat(), (h / 2f + 6f))
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val r = if (rect.isEmpty) RectF(
            paddingLeft.toFloat(), height / 2f - 6f, width - paddingRight.toFloat(), height / 2f + 6f
        ) else rect
        val radius = r.height() / 2f
        canvas.drawRoundRect(r, radius, radius, trackPaint)
        val frac = progressValue.toFloat() / max
        val pr = RectF(r.left, r.top, r.left + r.width() * frac, r.bottom)
        canvas.drawRoundRect(pr, radius, radius, progressPaint)
        // 滑块
        val cx = pr.right.coerceIn(r.left + radius, r.right - radius)
        canvas.drawCircle(cx, r.centerY(), radius + 3f, thumbPaint)
        if (isFocused) {
            val f = RectF(r.left - 4f, r.top - 8f, r.right + 4f, r.bottom + 8f)
            canvas.drawRoundRect(f, radius + 6f, radius + 6f, focusPaint)
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT -> {
                val dir = if (keyCode == KeyEvent.KEYCODE_DPAD_RIGHT) 1 else -1
                if (event?.repeatCount == 0) {
                    onStep?.invoke(dir)
                    startRepeat(dir)
                }
                return true
            }
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
                onSeek?.invoke(progressValue)
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_DPAD_LEFT || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT) {
            stopRepeat()
            return true
        }
        return super.onKeyUp(keyCode, event)
    }

    private fun startRepeat(dir: Int) {
        stopRepeat()
        repeatDirection = dir
        val r = object : Runnable {
            override fun run() {
                onStep?.invoke(repeatDirection)
                postDelayed(this, 110)
            }
        }
        repeatRunnable = r
        // 280ms 后开始连发：系统自身按键重复约 50ms/次，若延迟太久
        // 用户感知就是「长按没反应」；间隔 110ms 保证连发顺滑且防抖合并仍生效
        postDelayed(r, 280)
    }

    private fun stopRepeat() {
        repeatRunnable?.let { removeCallbacks(it) }
        repeatRunnable = null
    }

    override fun onDetachedFromWindow() {
        stopRepeat()
        super.onDetachedFromWindow()
    }
}
