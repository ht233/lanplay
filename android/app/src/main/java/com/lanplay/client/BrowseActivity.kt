package com.lanplay.client

import android.app.Dialog
import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.bumptech.glide.Glide
import com.lanplay.client.databinding.ActivityBrowseBinding
import com.lanplay.client.databinding.ItemMediaBinding
import com.lanplay.client.databinding.ItemMediaGridBinding
import com.lanplay.client.model.ApiException
import com.lanplay.client.model.MediaEntry
import com.lanplay.client.model.RootInfo
import com.lanplay.client.net.LanPlayApi
import com.lanplay.client.ui.TvEditText // 保留 import 无害；「添加媒体源」UI 入口已按用户要求移除（见 onCreate 注释）
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class BrowseActivity : AppCompatActivity() {

    private lateinit var binding: ActivityBrowseBinding
    private lateinit var api: LanPlayApi

    private val roots = mutableListOf<RootInfo>()
    private val entries = mutableListOf<MediaEntry>()

    private var currentRootId: String? = null
    private var currentPath: String = ""
    /** 右栏当前**实际显示**的目录（焦点预览时与 currentRootId/currentPath 一致，但 takeFocus=false） */
    private var loadedRootId: String? = null
    private var loadedPath: String = ""
    private var syncJob: Job? = null
    private var gridMode = false
    /** 目录请求序号：快速上下移动焦点预览时，丢弃迟到的旧响应 */
    private var loadSeq = 0

    private val fileAdapter = FileAdapter()
    private val gridAdapter = GridAdapter()
    private val rootAdapter = RootAdapter()

    private val sortOptions = listOf(
        "name" to "名称 ↑", "name-desc" to "名称 ↓",
        "mtime" to "时间 ↑", "mtime-desc" to "时间 ↓",
        "size" to "大小 ↑", "size-desc" to "大小 ↓",
        "kind" to "类型 ↑", "kind-desc" to "类型 ↓"
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityBrowseBinding.inflate(layoutInflater)
        setContentView(binding.root)
        api = LanPlayApi.get(this)
        gridMode = api.viewMode == "grid"

        binding.serverName.text = api.baseUrl.replace("http://", "")
        binding.fileList.layoutManager = LinearLayoutManager(this)
        binding.fileList.adapter = fileAdapter
        binding.fileGrid.layoutManager = GridLayoutManager(this, 4)
        binding.fileGrid.adapter = gridAdapter
        binding.rootList.layoutManager = LinearLayoutManager(this)
        binding.rootList.adapter = rootAdapter

        binding.btnView.setOnClickListener { toggleViewMode() }
        binding.btnSort.setOnClickListener { showSortMenu() }
        // 媒体源排序入口仅保留长按菜单（showRootMenu 第三项「媒体源排序…」）——应用户要求去掉独立按钮
        // 应用户要求：客户端不提供「添加媒体源」入口（添加在服务端 GUI 完成）；长按媒体源仍可禁用/移除

        applyViewMode()
        loadRoots()
        startSync()
    }

    // ---------------- 视图模式 ----------------

    private fun toggleViewMode() {
        gridMode = !gridMode
        api.viewMode = if (gridMode) "grid" else "list"
        applyViewMode()
    }

    private fun applyViewMode() {
        binding.listView.visibility = if (gridMode) View.GONE else View.VISIBLE
        binding.gridView.visibility = if (gridMode) View.VISIBLE else View.GONE
        binding.btnView.text = if (gridMode) getString(R.string.view_list) else getString(R.string.view_grid)
        binding.pathGrid.text = binding.path.text
        // 只有焦点本来就在右栏时才把焦点带过去，否则会把左侧媒体源的焦点抢走
        val rightHadFocus = binding.fileList.hasFocus() || binding.fileGrid.hasFocus() ||
            (binding.fileList.findFocus() != null) || (binding.fileGrid.findFocus() != null)
        if (rightHadFocus && entries.isNotEmpty()) {
            val rv = if (gridMode) binding.fileGrid else binding.fileList
            rv.post { focusFirstEntry(rv) }
        }
    }

    private fun showSortMenu() {
        val labels = sortOptions.map { it.second }.toTypedArray()
        val current = sortOptions.indexOfFirst { it.first == api.sortMode }.coerceAtLeast(0)
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.sort_title))
            .setSingleChoiceItems(labels, current) { dialog, which ->
                api.sortMode = sortOptions[which].first
                dialog.dismiss()
                currentRootId?.let { loadDir(it, currentPath) }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ---------------- 媒体源（与服务端双向同步） ----------------

    // 「添加媒体源」入口已按用户要求移除（客户端只浏览/播放/移除，添加在服务端 GUI 完成）。
    // showAddRootDialog 及其调用的 api.addRoots 留在 api 层未删（服务端接口仍在），只是没有 UI 入口。

    private fun showRootMenu(root: RootInfo) {
        // 弹窗确定后 loadRoots() 会 notifyDataSetChanged 回收持有焦点的行，
        // 焦点掉到顶栏「大图」按钮 —— **在菜单打开前**就把触发行记下来：
        // 菜单/排序弹窗显示期间 Activity 窗口失去焦点，回调里 rootList.findFocus()
        // 永远是 null，等 onClick 再记就晚了（这是第一版恢复失败的原因）。
        if (binding.rootList.findFocus() != null) captureRootFocus()
        if (pendingRootFocus == null) pendingRootFocus = root.id
        val actions = arrayOf(
            if (root.enabled) "禁用此媒体源" else "启用此媒体源",
            "移除此媒体源",
            "媒体源排序…"
        )
        AlertDialog.Builder(this)
            .setTitle(root.name)
            .setItems(actions) { _, which ->
                when (which) {
                    0 -> lifecycleScope.launch {
                        try {
                            api.batchRoots(if (root.enabled) "disable" else "enable", listOf(root.id))
                            loadRoots()
                        } catch (e: Exception) {
                            android.widget.Toast.makeText(this@BrowseActivity, e.message ?: "操作失败", android.widget.Toast.LENGTH_LONG).show()
                        }
                    }
                    1 -> lifecycleScope.launch {
                        try {
                            api.batchRoots("remove", listOf(root.id))
                            if (currentRootId == root.id) {
                                currentRootId = null
                                currentPath = ""
                                entries.clear()
                                fileAdapter.notifyDataSetChanged()
                                gridAdapter.notifyDataSetChanged()
                            }
                            loadRoots()
                        } catch (e: Exception) {
                            android.widget.Toast.makeText(this@BrowseActivity, e.message ?: "操作失败", android.widget.Toast.LENGTH_LONG).show()
                        }
                    }
                    2 -> showRootSortMenu()
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun loadRoots() {
        lifecycleScope.launch {
            try {
                val list = api.roots()
                // 媒体源排序（客户端本地设置，与服务端 GUI 互不影响）：
                // default=添加顺序；name/mtime/size±（时间/大小用服务端下发的 mtime/size 字段）；
                // type：asc=文件夹在前文件在后、desc=文件在前；组内二级按名称
                val sorted = when (api.rootSortMode) {
                    "name" -> list.sortedBy { it.name.lowercase() }
                    "name-desc" -> list.sortedByDescending { it.name.lowercase() }
                    "mtime", "mtime-desc" -> {
                        val s = list.sortedBy { it.mtime }
                        if (api.rootSortMode == "mtime-desc") s.reversed() else s
                    }
                    "size", "size-desc" -> {
                        val s = list.sortedBy { it.size }
                        if (api.rootSortMode == "size-desc") s.reversed() else s
                    }
                    "type", "type-desc" -> {
                        val s = list.sortedBy { if (it.type == "dir") 0 else 1 }
                        if (api.rootSortMode == "type-desc") s.reversed() else s
                    }
                    else -> list
                }
                roots.clear()
                roots.addAll(sorted)
                rootAdapter.notifyDataSetChanged()
                binding.status.text = "${roots.size} 个媒体源"
                binding.rootsTitle.text = "媒体源 · 已启用 ${roots.count { it.enabled }} 个"
                // 弹窗操作（禁用/移除/排序）后的焦点恢复：回到触发长按前的那一行
                restoreRootFocus()

                // 首次进入：优先恢复上次位置，否则打开第一个启用的源
                if (currentRootId == null) {
                    val lastRoot = api.lastRootId?.let { id -> roots.firstOrNull { it.id == id && it.enabled } }
                        ?: roots.firstOrNull { it.enabled }
                    if (lastRoot != null) {
                        val lastPath = api.lastPath
                        currentRootId = lastRoot.id
                        loadDir(lastRoot.id, if (lastPath.isNullOrBlank()) "" else lastPath)
                    }
                }
            } catch (e: Exception) {
                binding.status.text = e.message ?: "加载失败"
            }
        }
    }

    /**
     * 弹窗（禁用/移除/排序）确定前调用：记住当前焦点所在的媒体源行（按 root.id）。
     * loadRoots() notifyDataSetChanged 会回收持有焦点的行 View，系统就近把焦点
     * 交给第一个可聚焦控件 = 顶栏「大图」按钮（用户报告的「弹窗确定后焦点固定
     * 刷到右上角」）。loadRoots() 末尾按 pendingRootFocus 恢复焦点。
     */
    private var pendingRootFocus: String? = null

    private fun captureRootFocus() {
        val focused = binding.rootList.findFocus() ?: return
        val pos = binding.rootList.getChildAdapterPosition(focused)
        pendingRootFocus = roots.getOrNull(pos)?.id
    }

    /** 弹窗操作后把焦点放回触发长按前的那一行（行没了则放回第一个启用的源） */
    private fun restoreRootFocus() {
        val target = pendingRootFocus
        pendingRootFocus = null
        if (target == null) return
        val pos = roots.indexOfFirst { it.id == target }
        if (pos < 0) return
        // notifyDataSetChanged 后行 View 未必立刻布局完成（post 一帧可能还不够），
        // 用多轮重试直到 holder 出现（与 focusFirstEntry 的重试模式一致）。
        binding.rootList.post {
            restoreRootFocusAttempt(pos, 0)
        }
    }

    private fun restoreRootFocusAttempt(pos: Int, attempt: Int) {
        val holder = binding.rootList.findViewHolderForAdapterPosition(pos)
            ?: binding.rootList.findViewHolderForLayoutPosition(pos)
        val view = holder?.itemView
        if (view != null && view.isFocusable) {
            view.requestFocus()
            return
        }
        if (attempt < 8) binding.rootList.postDelayed({ restoreRootFocusAttempt(pos, attempt + 1) }, 40)
    }

    /** 媒体源排序弹窗（客户端本地设置，与服务端 GUI 互不影响） */
    private val rootSortOptions = listOf(
        "default" to "添加顺序",
        "name" to "名称 ↑",
        "name-desc" to "名称 ↓",
        "mtime" to "时间 ↑",
        "mtime-desc" to "时间 ↓",
        "size" to "大小 ↑",
        "size-desc" to "大小 ↓",
        "type" to "类型 ↑",
        "type-desc" to "类型 ↓"
    )

    private fun showRootSortMenu() {
        // 排序弹窗是从长按菜单（showRootMenu case 2）打开的二级弹窗：
        // 此刻 Activity 焦点仍被一级菜单/弹窗窗口持有，rootList.findFocus() 拿不到行 ——
        // captureRootFocus() 会得到 null 导致恢复失败。长按菜单打开前已把触发行
        // 存进 pendingRootFocus（showRootMenu 入口处），这里**不要覆盖**它，
        // 直接沿用即可：无论排序确定还是取消，焦点都回到最初长按的那一行。
        val labels = rootSortOptions.map { it.second }.toTypedArray()
        val current = rootSortOptions.indexOfFirst { it.first == api.rootSortMode }.coerceAtLeast(0)
        AlertDialog.Builder(this)
            .setTitle("媒体源排序")
            .setSingleChoiceItems(labels, current) { dialog, which ->
                dialog.dismiss()
                api.rootSortMode = rootSortOptions[which].first
                loadRoots()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    /** 定时轮询服务端媒体库版本；变了才重拉引用列表与当前目录 */
    private fun startSync() {
        syncJob?.cancel()
        syncJob = lifecycleScope.launch {
            var unauthorized = 0
            while (isActive) {
                delay(4000)
                try {
                    val res = api.sync(api.lastLibraryVersion)
                    val version = res.optInt("version", api.lastLibraryVersion)
                    unauthorized = 0
                    if (res.optBoolean("changed", false) || version != api.lastLibraryVersion) {
                        val before = api.lastLibraryVersion
                        api.lastLibraryVersion = version
                        withContext(Dispatchers.Main) {
                            val keep = currentRootId
                            val keepPath = currentPath
                            val keepEntry = focusedEntryPath()
                            loadRoots()
                            // 后台同步刷新不能抢用户焦点：保持右栏内容更新但不移动焦点。
                            // 同时记住刷新前焦点所在条目，刷新后原位恢复 —— 否则
                            // notifyDataSetChanged 回收焦点行 → 焦点掉到顶栏「大图」按钮。
                            if (keep != null && before > 0) {
                                loadDir(keep, keepPath, focusEntry = keepEntry, takeFocus = false)
                            }
                        }
                    }
                } catch (e: ApiException) {
                    // 服务端重启/换了 PIN 后旧 token 会失效。继续每 4 秒重试只会让
                    // 服务端日志每 4 秒刷一条 401，对用户也毫无帮助 —— 连中两次就停下来，
                    // 提示用户回连接页重新配对。
                    if (e.code == 401) {
                        unauthorized++
                        if (unauthorized >= 2) {
                            withContext(Dispatchers.Main) {
                                android.widget.Toast.makeText(
                                    this@BrowseActivity,
                                    getString(R.string.pair_expired),
                                    android.widget.Toast.LENGTH_LONG
                                ).show()
                                // A-8：finish() 后回退可能落到 PlayerActivity/桌面 —— 主动回连接页
                                //（CLEAR_TOP 复用已有实例，用户直接看到配对码输入界面）
                                val it = Intent(this@BrowseActivity, ConnectActivity::class.java)
                                it.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                                startActivity(it)
                                finish()
                            }
                            return@launch
                        }
                    }
                } catch (_: Exception) {
                    // 服务端离线时静默重试，不影响已有列表
                }
            }
        }
    }

    private fun openRoot(root: RootInfo) {
        if (!root.enabled) {
            android.widget.Toast.makeText(this, "该媒体源已禁用", android.widget.Toast.LENGTH_SHORT).show()
            return
        }
        // 单文件源：直接起播，**不改动 currentRootId**——
        // 右侧浏览上下文（当前目录/列表）保持不变，播完回来点右栏仍是原来那份列表。
        // （改了会导致：右边明明显示文件夹 A 的内容，点击却把路径拼到单文件源上 → 播错文件）
        if (root.type == "file") {
            startPlay(root.id, "")
            return
        }
        // 目录源：焦点预览已经加载过内容（takeFocus=false），这里只需要把焦点交给右栏第一项。
        // 若还没加载过（例如刚启动、焦点没经过它），先加载再给焦点。
        if (currentRootId != root.id || currentPath.isNotBlank() || loadedRootId != root.id) {
            currentRootId = root.id
            currentPath = ""
            loadDir(root.id, "")
        } else {
            focusRightFirst()
        }
    }

    /**
     * 焦点停在左侧目录源上（尚未按 OK）时，右侧**自动预览**该目录内容。
     *
     * 这是「遥控器优先」的关键交互：上下移动焦点就能预览各目录内容，
     * 按 OK / 右方向键才真正把焦点交给右侧列表 —— 少按一次键，也不会误播。
     */
    private fun previewRoot(root: RootInfo) {
        if (!root.enabled || root.type != "dir") return
        if (loadedRootId == root.id && loadedPath.isEmpty()) return
        currentRootId = root.id
        currentPath = ""
        loadDir(root.id, "", takeFocus = false)
    }

    /**
     * 当前持有焦点的右栏条目 path（按显示名匹配 entries），没有则 null。
     * 后台 sync 刷新 / 返回上级时用它把焦点放回原条目，避免焦点漂移。
     */
    private fun focusedEntryPath(): String? {
        val rv = if (gridMode) binding.fileGrid else binding.fileList
        val focused = rv.findFocus() ?: return null
        val pos = rv.getChildAdapterPosition(focused)
        if (pos < 0 || pos >= entries.size) return null
        val e = entries[pos]
        if (e.isDir) return e.path.substringAfterLast('/')
        // 文件条目：同名即视为同一项（目录内容刷新后 path 可能不变，但稳妥起见用名字）
        return e.name
    }

    private fun loadDir(
        rootId: String,
        relPath: String,
        focusEntry: String? = null,
        takeFocus: Boolean = true
    ) {
        val seq = ++loadSeq
        binding.status.text = getString(R.string.loading)
        lifecycleScope.launch {
            try {
                val sort = api.sortMode
                val parts = sort.split("-")
                val res = api.browse(rootId, relPath, parts[0], parts.getOrElse(1) { "asc" })
                // 左侧上下移动焦点会连续触发预览请求：只认最后一次，迟到的旧响应直接丢弃，
                // 否则右栏会被上一个目录的内容覆盖（表现为「焦点停在 A，右边却是 B」）。
                if (seq != loadSeq) return@launch
                currentRootId = rootId
                currentPath = relPath
                loadedRootId = rootId
                loadedPath = relPath
                api.lastRootId = rootId
                api.lastPath = relPath
                // 刷新期间先把焦点「锁」在右栏 RecyclerView 自己身上：
                // notifyDataSetChanged 会把旧的子项回收掉，原本持有焦点的子 View 被移除后
                // 系统会就近找一个可聚焦控件 → 顶栏「大图」按钮，这就是用户看到的
                // 「先闪一下跳到右上角大图，再回到列表」。让 RecyclerView 自己吃住焦点就不会闪。
                val rvNow = if (gridMode) binding.fileGrid else binding.fileList
                val holdFocus = takeFocus && (rvNow.findFocus() != null || rvNow.hasFocus())
                if (holdFocus) {
                    rvNow.descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
                    rvNow.isFocusable = true
                    rvNow.requestFocus()
                }
                // 换目录前把旧目录的缩略图请求全部取消：notifyDataSetChanged 复用 holder 时，
                // 旧目录几十个仍在途的 Glide 回调会把旧图画进新列表（「文件夹图标串位」残余）。
                clearPendingThumbRequests()
                entries.clear()
                entries.addAll(res.items)
                fileAdapter.notifyDataSetChanged()
                gridAdapter.notifyDataSetChanged()
                val files = entries.count { !it.isDir }
                val dirs = entries.size - files
                // 面包屑与统计合并为单行：/路径 · N 项
                val label = "/" + relPath
                val stat = when {
                    entries.isEmpty() -> "空目录"
                    files == 0 -> "$dirs 个文件夹"
                    dirs > 0 -> "$dirs 个文件夹 · $files 个视频"
                    else -> "$files 个视频"
                }
                val combined = if (entries.isEmpty()) label else "$label · $stat"
                binding.path.text = combined
                binding.pathGrid.text = combined
                binding.status.text = if (entries.isEmpty()) "空目录" else ""
                binding.fileEmpty.visibility = if (entries.isEmpty()) View.VISIBLE else View.GONE
                // 焦点只在需要时（用户按了 OK/右方向键）才进右栏；
                // 而且必须等 RecyclerView 布局完成后再 requestFocus，
                // 否则子项还不存在 → requestFocus 失败 → 焦点被系统丢到顶栏「大图」按钮上（用户看到的闪跳）。
                if (takeFocus || focusEntry != null) {
                    rvNow.post {
                        rvNow.descendantFocusability = ViewGroup.FOCUS_AFTER_DESCENDANTS
                        if (seq == loadSeq) {
                            if (focusEntry != null) focusEntryAfterLayout(focusEntry) else focusFirstEntry(rvNow)
                        }
                    }
                }
            } catch (e: Exception) {
                binding.status.text = e.message ?: "读取失败"
            }
        }
    }

    /**
     * 取消右栏所有还在途的缩略图请求。
     *
     * 只 clear() 绑定在子 View 上的请求（不走内存缓存回收，开销极小）；
     * 打开大目录后立刻返回时，旧目录几十个请求还在 Glide 队列里，
     * notify 后 holder 被复用，回调会把旧图画到新行上 —— tag=url 校验只能拦
     * 「回调时 URL 已变」的情况，拦不住缓存命中路径，这里从源头取消。
     */
    private fun clearPendingThumbRequests() {
        val rv = if (gridMode) binding.fileGrid else binding.fileList
        for (i in 0 until rv.childCount) {
            val thumb = rv.getChildAt(i).findViewById<ImageView>(R.id.thumb)
            if (thumb != null) Glide.with(this).clear(thumb)
        }
    }

    /** 让右栏拿到焦点并落在第一项（布局未就绪时自动重试，绝不落到顶栏按钮） */
    private fun focusRightFirst() {
        val rv = if (gridMode) binding.fileGrid else binding.fileList
        focusFirstEntry(rv)
    }

    /**
     * 把焦点放到右栏**数据第一条**（adapter position 0，即左上角第一个条目）。
     *
     * 三个坑：
     * 1. RecyclerView 有子项时不接收焦点（焦点在子项上），直接对 RecyclerView requestFocus
     *    **无效** —— 这正是「焦点先闪到右上角『大图』按钮」的原因；
     * 2. notifyDataSetChanged 后首帧还没布局，childCount = 0，此时取第一个 child 也会失败。
     *    所以要 postDelayed 重试，直到子项真正出现。
     * 3. **getChildAt(0) 是视口顶部的 child，不一定是数据第一条** —— RecyclerView 复用同一实例，
     *    从深层目录换回浅目录 / 排序切换后，若滚动位置未复位，视口顶部可能是 adapter position N>0
     *    的条目（用户报告的「进入目录没定位到第一个，不同排序定位的还不一样」就是它）。
     *    修法：先无条件 scrollToPosition(0)，布局后按 **getChildAdapterPosition == 0** 找条目，
     *    而不是盲取视口第一个。
     */
    private fun focusFirstEntry(rv: RecyclerView, attempt: Int = 0) {
        if (entries.isEmpty()) return
        if (attempt == 0) rv.scrollToPosition(0)
        if (rv.childCount > 0) {
            for (i in 0 until rv.childCount) {
                val child = rv.getChildAt(i) ?: continue
                if (rv.getChildAdapterPosition(child) == 0) {
                    child.requestFocus()
                    return
                }
            }
        }
        if (attempt < 8) rv.postDelayed({ focusFirstEntry(rv, attempt + 1) }, 40)
    }

    /**
     * 布局完成后按 path 找到 ViewHolder 并请求焦点。
     *
     * 两个坑：
     * 1. notifyDataSetChanged 后首帧布局可能尚未完成（childCount=0），
     *    用 postDelayed 重试直到卡片出现（最多 8 次）。
     * 2. 目标行**不在屏幕内**时，`rv.getChildAt(i)` 根本拿不到它 —— 这就是
     *    「返回上级后焦点没有定位到刚退出的文件夹」的主因。找到 entries 下标后
     *    先 `scrollToPosition` 把目标滚进视口，下一轮重试再请求焦点。
     */
    private fun focusEntryAfterLayout(path: String, attempt: Int = 0) {
        val rv = if (gridMode) binding.fileGrid else binding.fileList
        val target = entries.indexOfFirst {
            it.path.substringAfterLast('/') == path || it.name == path
        }
        if (target >= 0) {
            for (i in 0 until rv.childCount) {
                val child = rv.getChildAt(i) ?: continue
                val pos = rv.getChildAdapterPosition(child)
                if (pos == target) {
                    child.requestFocus()
                    return
                }
            }
            // 屏幕里还没有目标行：先滚过去，等下一轮重试（行会出现）
            rv.scrollToPosition(target)
        }
        if (attempt < 8) {
            rv.postDelayed({ focusEntryAfterLayout(path, attempt + 1) }, 60)
        }
    }

    private fun startPlay(rootId: String, relPath: String) {
        val intent = Intent(this, PlayerActivity::class.java)
            .putExtra(PlayerActivity.EXTRA_ROOT_ID, rootId)
            .putExtra(PlayerActivity.EXTRA_PATH, relPath)
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        startActivity(intent)
    }

    override fun onBackPressed() {
        if (currentPath.isNotBlank()) {
            // 返回上一级（不是直接回根）：焦点定位到刚才所在的目录项。
            // 记得退出前先抢焦点占位（FOCUS_BLOCK_DESCENDANTS），
            // 防止 notify 瞬间焦点行被回收掉到顶栏按钮上。
            val fromDir = currentPath.substringAfterLast('/')
            val parent = if (currentPath.contains('/')) currentPath.substringBeforeLast('/') else ""
            currentRootId?.let { loadDir(it, parent, fromDir, takeFocus = true) }
            return
        }
        super.onBackPressed()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_MENU) {
            binding.rootList.requestFocus()
            return true
        }
        val leftFocused = binding.rootList.findFocus() != null || binding.rootList.hasFocus()
        // 焦点在左栏目录源上时，按 RIGHT → 把焦点交给右侧第一项。
        // （左侧的 OK 已经由点击打开目录，这里主要处理「预览后想直接进列表」）
        //
        // **CENTER/ENTER 完全不拦截（补充 22）**：View 的按键长按机制是
        // 「行 View 收到**第一个** DOWN 时启动 500ms 长按计时器」，若 Activity 在这里
        // 消费首按（repeatCount==0），行 View 永远收不到 DOWN，长按计时器不会启动，
        // 长按 OK 弹「禁用/移除」菜单就永不触发（用户报告的不稳定根因）。
        // 放行后：单击 OK 走行 View 的 onClick（openRoot：目录源进入/单文件源起播，
        // 与原先「Activity 消费后 loadDir/focusRightFirst」行为等价）；
        // 按住 OK 500ms 走行 View 的 performLongClick（showRootMenu 弹菜单）。
        if (keyCode == KeyEvent.KEYCODE_DPAD_RIGHT && leftFocused) {
            val root = roots.firstOrNull { it.id == currentRootId }
            if (root != null && root.type == "dir") {
                if (loadedRootId != root.id) loadDir(root.id, "") else focusRightFirst()
                return true
            }
        }
        // 左栏最后一项再按 DOWN 时不要让焦点跳到顶栏「大图/排序」按钮上
        // （这是「焦点莫名跑到右上角」的另一个来源），焦点留在原地。
        if (keyCode == KeyEvent.KEYCODE_DPAD_DOWN && leftFocused) {
            val list = binding.rootList
            val focused = list.findFocus()
            if (focused != null) {
                val pos = list.getChildAdapterPosition(focused)
                if (pos >= 0 && pos >= roots.size - 1) {
                    return true
                }
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        syncJob?.cancel()
        super.onDestroy()
    }

    override fun onResume() {
        super.onResume()
        // 从播放页返回/自动重连进浏览页时，窗口重新获得焦点，系统会把焦点交给布局里
        // 第一个可聚焦控件 → 顶栏「大图」按钮，于是用户看到「先闪一下右上角再回到列表」。
        // 这里在窗口拿到焦点之前（onResume 阶段）就把焦点抢到右栏容器上，先占住位置，
        // 布局完成后再交给第一条，整个过程不会经过顶栏。
        // A-4 修复：仅当「当前无焦点」时才抢——若焦点已留在某个具体控件上
        //（如从播放页返回时焦点还停在左栏媒体源行），保留用户上下文不抢焦点。
        val rv = if (gridMode) binding.fileGrid else binding.fileList
        val hasExplicitFocus = currentFocus != null && currentFocus !== binding.root
        if (entries.isNotEmpty() && rv.visibility == View.VISIBLE && !hasExplicitFocus) {
            rv.descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
            rv.isFocusable = true
            rv.requestFocus()
            rv.post {
                rv.descendantFocusability = ViewGroup.FOCUS_AFTER_DESCENDANTS
                if (rv.findFocus() == null || rv.hasFocus()) focusFirstEntry(rv)
            }
        } else if (currentFocus == null || currentFocus === binding.root) {
            binding.rootList.requestFocus()
        }
    }

    // ---------------- 列表适配器 ----------------

    private inner class FileAdapter : RecyclerView.Adapter<FileAdapter.Holder>() {
        inner class Holder(val b: ItemMediaBinding) : RecyclerView.ViewHolder(b.root)

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder =
            Holder(ItemMediaBinding.inflate(layoutInflater, parent, false))

        override fun getItemCount(): Int = entries.size

        override fun onBindViewHolder(holder: Holder, position: Int) {
            val e = entries[position]
            // 无论这一行最终显示什么（缩略图/文件夹图标/emoji），都先取消该 ImageView 上仍在途的旧请求：
            // 快速进出目录时旧目录的视频帧请求还挂在 Glide 队列里，holder 被复用成本行的
            // 「文件夹」后回调才回来，就会把视频帧画上去盖掉图标 —— 真机上「前两个文件夹
            // 图标变成刚退出目录里的媒体缩略图」就是它（此前只在缩略图分支里 clear，
            // 目录分支没有 clear，恰恰漏掉了这个场景；模拟器 localhost 缩略图 <50ms 完成
            // 赶在返回前，真机 WiFi 延迟几百 ms 必现，所以一直没复现）。
            Glide.with(this@BrowseActivity).clear(holder.b.thumb)
            val rootId = currentRootId
            // 视频/图片显示真实抽帧缩略图；目录用铺满的矢量文件夹图标；音频用 emoji。
            // 复用大图视图同一套缩略图接口，服务端已做磁盘缓存，列表滚动不会反复抽帧。
            if (e.hasThumb && rootId != null) {
                holder.b.icon.visibility = View.GONE
                holder.b.thumb.visibility = View.VISIBLE
                // 图片也走服务端缩略图（scale=480 的 jpeg，几 KB）：原图直出会并发下载几十 MB
                // 的全尺寸位图，Glide 全尺寸解码直接把内存吃穿（大图目录越点越卡、最后卡死）。
                // 全屏查看器（showImageViewer）才用原图。
                val url = api.thumbUrl(rootId, e.path, at = thumbTimeOf(e))
                // URL 当 tag：回调回到这个 holder 时，URL 不一致说明已被复用，直接丢弃
                // （顶部已统一 clear 过在途请求，这里只做回调时校验）。
                holder.b.thumb.tag = url
                Glide.with(this@BrowseActivity)
                    .load(url)
                    .centerCrop()
                    .placeholder(R.color.bg)
                    .error(R.color.bg)
                    .into(holder.b.thumb)
            } else if (e.isDir) {
                // 文件夹：位图图标 FIT_CENTER 完整显示（不裁剪不撑爆，留自然边距）。
                // 必须先清 tag 再换图：上一次视频请求的 tag 留着会让下面的判断失效。
                holder.b.thumb.tag = null
                holder.b.thumb.setImageDrawable(null)
                holder.b.icon.text = ""
                holder.b.thumb.visibility = View.VISIBLE
                holder.b.thumb.scaleType = ImageView.ScaleType.FIT_CENTER
                holder.b.thumb.setImageResource(R.drawable.ic_folder_filled)
            } else {
                holder.b.thumb.tag = null
                holder.b.thumb.setImageDrawable(null)
                holder.b.thumb.visibility = View.GONE
                holder.b.icon.visibility = View.VISIBLE
                holder.b.icon.text = if (e.kind == "audio") "🎵" else "🎬"
            }
            holder.b.name.text = e.name
            holder.b.meta.text = when {
                e.isDir -> "文件夹"
                e.kind == "audio" -> listOfNotNull(
                    if (e.duration > 0) formatDuration(e.duration) else null,
                    humanSize(e.size).ifBlank { null }
                ).joinToString(" · ").ifBlank { "音频" }
                e.duration > 0 -> "${formatDuration(e.duration)} · ${humanSize(e.size)}"
                e.size > 0 -> humanSize(e.size)
                else -> "视频"
            }
            holder.b.arrow.text = if (e.isDir) "›" else "▶"
            holder.b.root.setOnClickListener { onEntryClick(e) }
        }
    }

    // ---------------- 大图适配器（缩略图网格） ----------------

    private inner class GridAdapter : RecyclerView.Adapter<GridAdapter.Holder>() {
        inner class Holder(val b: ItemMediaGridBinding) : RecyclerView.ViewHolder(b.root)

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder =
            Holder(ItemMediaGridBinding.inflate(layoutInflater, parent, false))

        override fun getItemCount(): Int = entries.size

        override fun onBindViewHolder(holder: Holder, position: Int) {
            val e = entries[position]
            // 无论这一行最终显示什么（缩略图/文件夹图标/emoji），都先取消该 ImageView 上仍在途的旧请求：
            // 快速进出目录时旧目录的视频帧请求还挂在 Glide 队列里，holder 被复用成本行的
            // 「文件夹」后回调才回来，就会把视频帧画上去盖掉图标 —— 真机上「前两个文件夹
            // 图标变成刚退出目录里的媒体缩略图」就是它（此前只在缩略图分支里 clear，
            // 目录分支没有 clear，恰恰漏掉了这个场景；模拟器 localhost 缩略图 <50ms 完成
            // 赶在返回前，真机 WiFi 延迟几百 ms 必现，所以一直没复现）。
            Glide.with(this@BrowseActivity).clear(holder.b.thumb)
            holder.b.name.text = e.name
            holder.b.meta.text = when {
                e.isDir -> "文件夹"
                e.duration > 0 -> formatDuration(e.duration)
                e.size > 0 -> humanSize(e.size)
                else -> ""
            }
            holder.b.duration.visibility = if (!e.isDir && e.duration > 0) View.VISIBLE else View.GONE
            holder.b.duration.text = formatDuration(e.duration)
            holder.b.root.setOnClickListener { onEntryClick(e) }
            holder.b.root.setOnLongClickListener { onEntryClick(e); true }

            // 缩略图：目录用铺满的位图图标，音频用 emoji，视频取服务端抽帧
            val rootId = currentRootId
            if (e.hasThumb && rootId != null) {
                holder.b.thumbPlaceholder.visibility = View.GONE
                holder.b.thumb.visibility = View.VISIBLE
                // 图片同样走服务端缩略图（原图直出在大图目录 = 并发几十 MB 下载 + 全尺寸解码）
                val url = api.thumbUrl(rootId, e.path, at = thumbTime(e))
                // tag=url 回调校验（顶部已统一 clear 在途请求）
                holder.b.thumb.tag = url
                Glide.with(this@BrowseActivity)
                    .load(url)
                    .centerCrop()
                    .placeholder(R.color.bg_elev)
                    .error(R.color.bg_elev)
                    .into(holder.b.thumb)
            } else if (e.isDir) {
                holder.b.thumb.tag = null
                holder.b.thumb.setImageDrawable(null)
                holder.b.thumbPlaceholder.visibility = View.GONE
                holder.b.thumb.visibility = View.VISIBLE
                holder.b.thumb.scaleType = ImageView.ScaleType.FIT_CENTER
                holder.b.thumb.setImageResource(R.drawable.ic_folder_filled)
            } else {
                holder.b.thumb.tag = null
                holder.b.thumb.setImageDrawable(null)
                holder.b.thumb.visibility = View.GONE
                holder.b.thumbPlaceholder.visibility = View.VISIBLE
                holder.b.thumbPlaceholder.text = if (e.kind == "audio") "🎵" else "🎬"
            }
        }

        /** 抽帧位置：有片长的取 25% 处（片头常是黑屏/厂标，25% 已进入正片），最多 5 分钟 */
        private fun thumbTime(e: MediaEntry): Double = thumbTimeOf(e)
    }

    /** 抽帧位置：有片长的取 25% 处（片头常是黑屏/厂标，25% 已进入正片），最多 5 分钟 */
    private fun thumbTimeOf(e: MediaEntry): Double =
        if (e.duration > 8) minOf(e.duration / 4.0, 300.0) else 3.0

    private fun onEntryClick(e: MediaEntry) {
        val rootId = currentRootId ?: return
        if (e.isDir) {
            // 进下一级目录：内容加载完把焦点放到右侧第一项
            loadDir(rootId, e.path, takeFocus = true)
        } else if (e.kind == "image") {
            showImageViewer(rootId, e)
        } else {
            startPlay(rootId, e.path)
        }
    }

    /** 图片查看：全屏对话框 + 双击/OK 缩放交给系统图库，简单起见直接弹全屏 ImageView */
    private var imageDialog: android.app.Dialog? = null

    private fun showImageViewer(rootId: String, e: MediaEntry) {
        // P3 修复：连点两张图时旧 Dialog 未 dismiss → WindowLeaked；先关旧的再开新的
        imageDialog?.dismiss()
        imageDialog = null
        val dialog = android.app.Dialog(this, R.style.FullScreenDialog)
        dialog.setContentView(R.layout.dialog_image_viewer)
        val iv = dialog.findViewById<ImageView>(R.id.image_view)
        // 全屏查看器保留原图（要看大图细节），但把解码尺寸限到屏幕大小：
        // 几十 MB 的 4000x3000 PNG 全尺寸解码一次就是 ~48MB 位图，快速开关几次就 OOM/卡死。
        val dp = resources.displayMetrics
        Glide.with(this)
            .load(api.rawUrl(rootId, e.path))
            .override(dp.widthPixels, dp.heightPixels)
            .fitCenter()
            .placeholder(R.color.bg)
            .error(R.color.bg)
            .into(iv)
        iv.setOnClickListener { dialog.dismiss() }
        dialog.setOnKeyListener { _, keyCode, event ->
            if (event.action == KeyEvent.ACTION_DOWN && keyCode == KeyEvent.KEYCODE_BACK) {
                dialog.dismiss(); true
            } else false
        }
        dialog.setOnDismissListener {
            if (imageDialog === dialog) imageDialog = null
        }
        imageDialog = dialog
        dialog.show()
    }

    // ---------------- 媒体源适配器（支持长按删除/禁用） ----------------

    private inner class RootAdapter : RecyclerView.Adapter<RootAdapter.Holder>() {
        inner class Holder(val b: ItemMediaBinding) : RecyclerView.ViewHolder(b.root)

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder =
            Holder(ItemMediaBinding.inflate(layoutInflater, parent, false))

        override fun getItemCount(): Int = roots.size

        override fun onBindViewHolder(holder: Holder, position: Int) {
            val r = roots[position]
            // 同 FileAdapter：绑定任何行前先取消在途请求（左栏媒体源列表同样可能复用 holder）
            Glide.with(this@BrowseActivity).clear(holder.b.thumb)
            // 单文件媒体源显示真实缩略图；文件夹源用铺满的位图图标（服务端 /thumb/<rootId>/ 空路径 = 该文件本身）
            val thumbReady = r.exists && r.enabled
            if (r.type == "file" && thumbReady) {
                holder.b.icon.visibility = View.GONE
                holder.b.thumb.visibility = View.VISIBLE
                val url = api.thumbUrl(r.id, "", at = 3.0)
                holder.b.thumb.tag = url
                Glide.with(this@BrowseActivity)
                    .load(url)
                    .centerCrop()
                    .placeholder(R.color.bg)
                    .into(holder.b.thumb)
            } else if (r.type == "dir") {
                holder.b.thumb.tag = null
                holder.b.thumb.setImageDrawable(null)
                holder.b.icon.text = ""
                holder.b.icon.visibility = View.GONE
                holder.b.thumb.visibility = View.VISIBLE
                holder.b.thumb.scaleType = ImageView.ScaleType.FIT_CENTER
                holder.b.thumb.setImageResource(R.drawable.ic_folder_filled)
            } else {
                holder.b.thumb.tag = null
                holder.b.thumb.setImageDrawable(null)
                holder.b.thumb.visibility = View.GONE
                holder.b.icon.visibility = View.VISIBLE
                holder.b.icon.text = "🎬"
            }
            holder.b.name.text = r.name
            holder.b.meta.text = when {
                !r.exists -> "路径丢失"
                !r.enabled -> "已禁用"
                else -> r.path
            }
            holder.b.name.alpha = if (r.enabled) 1f else 0.5f
            holder.b.arrow.text = ""
            holder.b.root.setOnClickListener { openRoot(r) }
            holder.b.root.setOnFocusChangeListener { _, hasFocus ->
                // 焦点落在左侧目录源上（还没按 OK）就预览右侧内容
                if (hasFocus) previewRoot(r)
            }
            holder.b.root.setOnLongClickListener {
                showRootMenu(r)
                true
            }
        }
    }

    companion object {
        fun formatDuration(sec: Double): String {
            if (sec <= 0) return "--:--"
            val total = sec.toLong()
            val h = total / 3600
            val m = (total % 3600) / 60
            val s = total % 60
            return if (h > 0) String.format("%d:%02d:%02d", h, m, s) else String.format("%02d:%02d", m, s)
        }

        fun humanSize(bytes: Long): String {
            if (bytes <= 0) return ""
            val units = arrayOf("B", "KB", "MB", "GB", "TB")
            var n = bytes.toDouble()
            var i = 0
            while (n >= 1024 && i < units.size - 1) { n /= 1024; i++ }
            return if (i == 0) "${n.toInt()} ${units[i]}" else String.format("%.1f %s", n, units[i])
        }
    }
}
