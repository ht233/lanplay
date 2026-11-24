package com.lanplay.client.discovery

import com.lanplay.client.model.DiscoveredServer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException

/**
 * 局域网自动发现：UDP 广播 "LANPLAY1 DISCOVER" 到 52310，
 * 服务端回 JSON {magic:'LANPLAY1', type:'ANNOUNCE', name, serverId, port, ...}
 *
 * 注意：Android 的 WiFi 驱动默认会丢弃部分广播包，需要 MulticastLock 才能稳定接收。
 */
class DiscoveryClient(
    private val context: android.content.Context? = null,
    private val port: Int = 52310
) {

    suspend fun scan(timeoutMs: Long = 2200): List<DiscoveredServer> = withContext(Dispatchers.IO) {
        val found = LinkedHashMap<String, DiscoveredServer>()
        var socket: DatagramSocket? = null
        var lock: android.net.wifi.WifiManager.MulticastLock? = null
        try {
            context?.let { ctx ->
                runCatching {
                    val wifi = ctx.applicationContext.getSystemService(android.content.Context.WIFI_SERVICE)
                        as? android.net.wifi.WifiManager
                    lock = wifi?.createMulticastLock("lanplay-discovery")?.apply {
                        setReferenceCounted(false)
                        acquire()
                    }
                }
            }
            socket = DatagramSocket().apply {
                broadcast = true
                soTimeout = 300
                reuseAddress = true
            }
            val payload = "LANPLAY1 DISCOVER".toByteArray()
            val broadcast = InetAddress.getByName("255.255.255.255")
            // 广播 3 次，覆盖丢包
            repeat(3) {
                runCatching {
                    socket.send(DatagramPacket(payload, payload.size, broadcast, port))
                }
            }
            val deadline = System.currentTimeMillis() + timeoutMs
            val buf = ByteArray(2048)
            while (System.currentTimeMillis() < deadline) {
                try {
                    val packet = DatagramPacket(buf, buf.size)
                    socket.receive(packet)
                    val text = String(packet.data, 0, packet.length, Charsets.UTF_8)
                    val obj = runCatching { JSONObject(text) }.getOrNull() ?: continue
                    if (obj.optString("magic") != "LANPLAY1") continue
                    val host = obj.optString("host").ifBlank { packet.address.hostAddress ?: "" }
                    val p = obj.optInt("port", 8099)
                    val id = obj.optString("serverId", "$host:$p")
                    found[id] = DiscoveredServer(
                        name = obj.optString("name", "LanPlay 服务端"),
                        serverId = id,
                        host = host,
                        port = p,
                        requirePin = obj.optBoolean("requirePin", true)
                    )
                } catch (_: SocketTimeoutException) {
                    // 继续等到 deadline
                }
            }
        } catch (_: Exception) {
            // 网络不可用/权限问题：返回已发现结果
        } finally {
            runCatching { socket?.close() }
            runCatching { lock?.release() }
        }
        found.values.toList()
    }
}
