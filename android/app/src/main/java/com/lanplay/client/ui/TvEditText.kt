package com.lanplay.client.ui

import android.content.Context
import android.util.AttributeSet
import android.view.KeyEvent
import androidx.appcompat.widget.AppCompatEditText

/**
 * 电视用输入框。
 *
 * 原生 EditText 会把方向键交给文本光标（ArrowKeyMovementMethod）：
 * 在投影仪上按上下键，光标在框里乱跳，焦点却出不去 —— 用户以为遥控器失灵。
 *
 * 本控件的行为：
 * - 上下键：永远移动焦点（输入框只有一行，上下没有别的含义）；
 * - 左右键：光标不在边界时先移动光标，到了边界再移动焦点；
 * - OK 键：把焦点和光标留在框内，由 Activity 负责弹键盘。
 */
class TvEditText @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = android.R.attr.editTextStyle
) : AppCompatEditText(context, attrs, defStyleAttr) {

    init {
        isSingleLine = true
        // 关掉会把方向键吃掉的移动方式；光标移动改由下面手动处理
        movementMethod = null
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_UP -> return focusSearch(FOCUS_UP)?.let {
                if (it.requestFocus(FOCUS_UP)) true else false
            } ?: false

            KeyEvent.KEYCODE_DPAD_DOWN -> return focusSearch(FOCUS_DOWN)?.let {
                if (it.requestFocus(FOCUS_DOWN)) true else false
            } ?: false

            KeyEvent.KEYCODE_DPAD_LEFT -> {
                // 光标不在最左才移光标，否则交给系统移焦点
                if (selectionStart > 0 && selectionStart == selectionEnd) {
                    setSelection(selectionStart - 1)
                    return true
                }
                return false
            }

            KeyEvent.KEYCODE_DPAD_RIGHT -> {
                val len = text?.length ?: 0
                if (selectionEnd < len && selectionStart == selectionEnd) {
                    setSelection(selectionEnd + 1)
                    return true
                }
                return false
            }
        }
        return super.onKeyDown(keyCode, event)
    }
}
