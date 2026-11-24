package com.lanplay.client

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.lanplay.client.databinding.ActivityConnectBinding
import com.lanplay.client.databinding.ItemServerBinding
import com.lanplay.client.discovery.DiscoveryClient
import com.lanplay.client.model.DiscoveredServer
import com.lanplay.client.net.LanPlayApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class ConnectActivity : AppCompatActivity() {

    private lateinit var binding: ActivityConnectBinding
    private lateinit var api: LanPlayApi
    private val servers = mutableListOf<DiscoveredServer>()
    private var scanJob: Job? = null
    private var busy = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityConnectBinding.inflate(layoutInflater)
        setContentView(binding.root)
        api = LanPlayApi.get(this)

        binding.inputName.setText(api.deviceName)
        binding.serverList.layoutManager = LinearLayoutManager(this)
        binding.serverList.adapter = ServerAdapter()

        binding.btnConnect.setOnClickListener { connectManual() }

        // 初始焦点给地址输入框（而不是空列表）。
        // 电视上没有鼠标，焦点落在一个空 RecyclerView 上时用户看不到任何高亮，
        // 按上下键也像"没反应"，会以为应用卡死。
        binding.inputAddress.post {
            if (currentFocus == null || currentFocus === binding.serverList) {
                binding.inputAddress.requestFocus()
            }
        }
        setupTvInputs()

        // 启动时尝试免密恢复上次连接
        val savedBase = api.baseUrl
        if (savedBase.isNotBlank()) {
            binding.hint.text = "正在恢复上次连接：$savedBase"
            lifecycleScope.launch {
                val ok = runCatching { api.resume() }.getOrDefault(false)
                if (ok) enterBrowse() else {
                    binding.hint.text = getString(R.string.discovering)
                    startScan()
                }
            }
        } else {
            startScan()
            applyListFocusability()
        }
        applyWindowInsets()
    }

    /**
     * 电视输入框行为：
     * ① 默认不弹软键盘（投影仪遥控器没有触摸屏，弹出键盘会遮住半屏且方向键被困在键盘里）；
     * ② 用户按 OK 才主动弹出；
     * ③ 按返回先收键盘，不要直接退出页面。
     */
    private fun setupTvInputs() {
        val fields = listOf(binding.inputAddress, binding.inputPin, binding.inputName)
        for (f in fields) {
            f.setOnClickListener {
                f.requestFocus()
                val imm = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
                imm.showSoftInput(f, InputMethodManager.SHOW_IMPLICIT)
            }
            f.setOnFocusChangeListener { _, hasFocus ->
                if (!hasFocus) {
                    val imm = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
                    imm.hideSoftInputFromWindow(f.windowToken, 0)
                }
            }
        }
    }

    private fun hideKeyboard() {
        val imm = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(binding.root.windowToken, 0)
    }

    override fun onBackPressed() {
        // 键盘开着时，返回键先收键盘
        val imm = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
        if (imm.isAcceptingText) {
            hideKeyboard()
            binding.inputAddress.requestFocus()
            return
        }
        super.onBackPressed()
    }

    private fun applyWindowInsets() {
        val root = binding.root
        root.setOnApplyWindowInsetsListener { v, insets ->
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                val cut = insets.displayCutout
                val left = cut?.safeInsetLeft ?: 0
                val right = cut?.safeInsetRight ?: 0
                v.setPadding(left, 0, right, 0)
            }
            insets
        }
    }

    private fun startScan() {
        scanJob?.cancel()
        scanJob = lifecycleScope.launch {
            while (true) {
                binding.hint.text = getString(R.string.discovering)
                val found = runCatching { DiscoveryClient(this@ConnectActivity).scan(2200) }.getOrDefault(emptyList())
                servers.clear()
                servers.addAll(found)
                binding.serverList.adapter?.notifyDataSetChanged()
                binding.serverEmpty.visibility = if (servers.isEmpty()) View.VISIBLE else View.GONE
                applyListFocusability()
                if (servers.isNotEmpty()) {
                    binding.hint.text = "发现 ${servers.size} 台服务端，按 OK 连接"
                    if (binding.serverList.hasFocus()) binding.serverList.requestFocus()
                }
                delay(4000)
            }
        }
    }

    /**
     * 空列表必须不可聚焦。
     * 电视遥控器没有鼠标，焦点落在一个空 RecyclerView 上时：
     * ① 屏幕上没有任何高亮 → 用户以为应用没反应；
     * ② 该 View 会吞掉方向键 → 焦点卡死在左侧走不到右侧输入框。
     */
    private fun applyListFocusability() {
        val empty = servers.isEmpty()
        binding.serverList.isFocusable = !empty
        binding.serverList.descendantFocusability = if (empty) {
            ViewGroup.FOCUS_BLOCK_DESCENDANTS
        } else {
            ViewGroup.FOCUS_AFTER_DESCENDANTS
        }
        if (empty && binding.serverList.hasFocus()) binding.inputAddress.requestFocus()
    }

    private fun connectManual() {
        val addr = binding.inputAddress.text.toString().trim()
        val pin = binding.inputPin.text.toString().trim()
        val name = binding.inputName.text.toString().trim().ifBlank { api.deviceName }
        if (addr.isBlank()) {
            toastMsg("请输入服务端地址，或在上方列表中选择")
            return
        }
        doConnect(normalize(addr), pin, name)
    }

    private fun normalize(addr: String): String {
        var a = addr.trim()
        if (!a.startsWith("http")) a = "http://$a"
        val hostPart = a.substringAfter("://")
        if (!hostPart.contains(":")) a = "$a:8099"
        return a.trimEnd('/')
    }

    private fun doConnect(url: String, pin: String, name: String) {
        if (busy) return
        busy = true
        binding.hint.text = "正在连接 $url …"
        lifecycleScope.launch {
            try {
                val info = runCatching { api.probeServer(url) }.getOrElse {
                    toastMsg(it.message ?: "无法连接服务端")
                    binding.hint.text = getString(R.string.discovering)
                    return@launch
                }
                val requirePin = info.optBoolean("requirePin", true)
                if (requirePin && pin.isBlank()) {
                    // 尝试用已有 token 直接恢复
                    api.baseUrl = url
                    val ok = runCatching { api.resume() }.getOrDefault(false)
                    if (ok) return@launch enterBrowse()
                    toastMsg("该服务端需要配对码，请输入服务端顶部显示的 6 位数字")
                    binding.inputPin.requestFocus()
                    binding.hint.text = getString(R.string.discovering)
                    return@launch
                }
                api.baseUrl = url
                api.pair(url, if (requirePin) pin else "", name)
                toastMsg("已连接「${info.optString("name", "LanPlay")}」")
                enterBrowse()
            } catch (e: Exception) {
                toastMsg(e.message ?: "连接失败")
                binding.hint.text = getString(R.string.discovering)
            } finally {
                busy = false
            }
        }
    }

    private fun enterBrowse() {
        // ConnectActivity 只是入口壳：进入列表后销毁自己，
        // 否则「返回 → 又连一次」会在任务栈里留下多层连接页。
        startActivity(Intent(this, BrowseActivity::class.java))
        finish()
    }

    private fun toastMsg(msg: String) {
        binding.hint.text = msg
    }

    override fun onResume() {
        super.onResume()
        busy = false
    }

    override fun onDestroy() {
        scanJob?.cancel()
        super.onDestroy()
    }

    private inner class ServerAdapter : RecyclerView.Adapter<ServerAdapter.Holder>() {
        inner class Holder(val b: ItemServerBinding) : RecyclerView.ViewHolder(b.root)

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder =
            Holder(ItemServerBinding.inflate(layoutInflater, parent, false))

        override fun getItemCount(): Int = servers.size

        override fun onBindViewHolder(holder: Holder, position: Int) {
            val s = servers[position]
            holder.b.name.text = s.name
            holder.b.addr.text = s.url
            holder.b.badge.text = if (s.requirePin) "需配对码" else "开放"
            holder.b.badge.setTextColor(
                androidx.core.content.ContextCompat.getColor(
                    this@ConnectActivity,
                    if (s.requirePin) R.color.yellow else R.color.green
                )
            )
            holder.b.root.setOnClickListener {
                binding.inputAddress.setText(s.url)
                binding.inputPin.requestFocus()
                if (!s.requirePin) doConnect(s.url, "", binding.inputName.text.toString().trim())
            }
            holder.b.root.setOnFocusChangeListener { v, focused ->
                if (focused) v.animate().scaleX(1.0f).scaleY(1.0f).setDuration(90).start()
            }
        }
    }
}
