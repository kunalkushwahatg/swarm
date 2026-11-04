package com.swarm.desktop

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.Collections
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Foreground service that turns this device into a Swarm compute worker.
 *
 * It owns two native child processes shipped in jniLibs:
 *  - libggml_rpc.so     : GGML RPC server bound to 127.0.0.1:50052 (loopback only)
 *  - libswarm_tunnel.so : encrypted relay tunnel to 127.0.0.1:50052
 *
 * The Tauri Rust backend drives it through [dispatch] over JNI, which keeps the
 * Rust supervisor and the Android lifecycle in a single source of truth.
 */
class SwarmWorkerService : Service() {
    companion object {
        private const val TAG = "SwarmWorkerService"
        private const val CHANNEL_ID = "swarm_worker_channel"
        private const val NOTIF_ID = 1001
        private const val STATUS_FILE = "worker_status.json"
        private const val PREFS = "swarm_worker_prefs"
        private const val KEY_USE_GPU = "use_gpu"
        private const val KEY_PORT = "port"
        private const val KEY_THREADS = "threads"

        // LAN discovery: the coordinator broadcasts a probe, this device answers.
        private const val DISCOVERY_PORT = 50053
        private const val DISCOVERY_MAGIC = "SWARM_DISCOVER"

        // Battery / thermal / idle guardrails. Sharing compute must never drain a
        // phone to 0% or cook it just because the user forgot to stop sharing.
        private const val LOW_BATTERY_STOP_PCT = 15
        private const val GUARDRAIL_INTERVAL_MS = 60_000L
        private const val IDLE_LOCK_RELEASE_MS = 15 * 60 * 1000L
        private const val THERMAL_STATUS_SEVERE = 3
        private const val THERMAL_STATUS_CRITICAL = 4

        const val ACTION_START = "com.swarm.desktop.worker.START"
        const val ACTION_STOP = "com.swarm.desktop.worker.STOP"
        const val EXTRA_USE_GPU = "use_gpu"
        const val EXTRA_PORT = "port"
        const val EXTRA_THREADS = "threads"

        const val ACTION_START_LEADER = "com.swarm.desktop.leader.START"
        const val ACTION_STOP_LEADER = "com.swarm.desktop.leader.STOP"
        const val EXTRA_MODEL_PATH = "model_path"
        const val EXTRA_CTX_SIZE = "ctx_size"
        const val EXTRA_USE_RPC = "use_rpc"
        const val EXTRA_RPC_ENDPOINTS = "rpc_endpoints"
        const val EXTRA_N_GPU_LAYERS = "n_gpu_layers"
        const val EXTRA_PLACEMENT_POLICY = "placement_policy"

        @Volatile private var running = false
        @Volatile private var state = "Stopped"
        @Volatile private var rpcPid = -1
        @Volatile private var endpointId: String? = null
        @Volatile private var relayUrl: String? = null
        @Volatile private var pairingCode: String? = null
        @Volatile private var lastError: String? = null
        @Volatile private var backend = "CPU"
        @Volatile private var threads = 0
        @Volatile private var port = 50052
        @Volatile private var startedAtMs = 0L

        @Volatile private var leaderRunning = false
        @Volatile private var leaderState = "Stopped"
        @Volatile private var leaderPid = -1
        @Volatile private var leaderPort = 8080
        @Volatile private var leaderModelPath = ""
        @Volatile private var leaderStartedAtMs = 0L
        @Volatile private var leaderLastError: String? = null
        @Volatile private var leaderUseRpc = false

        private val logs = ArrayDeque<String>()

        private fun log(line: String) {
            synchronized(logs) {
                logs.addLast(line)
                while (logs.size > 160) logs.removeFirst()
            }
        }

        /**
         * Single JNI entry point used by the Tauri Rust backend.
         *
         * action: "start" | "stop" | "status"
         * payload: JSON object (start accepts useGpu/port/threads)
         * returns: worker status JSON
         */
        @JvmStatic
        fun dispatch(ctx: Context, action: String, payload: String): String {
            try {
                val args = if (payload.isBlank()) JSONObject() else JSONObject(payload)
                when (action) {
                    "start" -> startSharing(
                        ctx,
                        args.optBoolean("useGpu", false),
                        args.optInt("port", 50052),
                        args.optInt("threads", 0),
                    )
                    "stop" -> stopSharing(ctx)
                    "status" -> Unit
                    "start_leader" -> {
                        startLeader(
                            ctx,
                            args.optString("modelPath", ""),
                            args.optInt("port", 8080),
                            args.optInt("ctxSize", 512),
                            args.optInt("threads", 0),
                            args.optBoolean("useRpc", false),
                            args.optString("rpcEndpoints", ""),
                            args.optInt("nGpuLayers", -1),
                            args.optString("placementPolicy", "none")
                        )
                        return leaderStatusJson(ctx)
                    }
                    "stop_leader" -> {
                        stopLeader(ctx)
                        return leaderStatusJson(ctx)
                    }
                    "leader_status" -> return leaderStatusJson(ctx)
                    else -> throw IllegalArgumentException("Unknown worker action '$action'")
                }
            } catch (t: Throwable) {
                lastError = t.message ?: t.toString()
                if (!running) state = "Failed"
                Log.e(TAG, "dispatch($action) failed", t)
            }
            return statusJson(ctx)
        }

        @JvmStatic
        fun startSharing(ctx: Context, useGpu: Boolean, requestedPort: Int, requestedThreads: Int) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean(KEY_USE_GPU, useGpu)
                .putInt(KEY_PORT, requestedPort)
                .putInt(KEY_THREADS, requestedThreads)
                .apply()

            backend = if (useGpu) "Vulkan0" else "CPU"
            port = requestedPort
            lastError = null

            if (running) {
                Log.i(TAG, "Worker already running; configuration updated for next start")
                return
            }

            state = "Starting"
            val intent = Intent(ctx, SwarmWorkerService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_USE_GPU, useGpu)
                putExtra(EXTRA_PORT, requestedPort)
                putExtra(EXTRA_THREADS, requestedThreads)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent)
            } else {
                ctx.startService(intent)
            }
        }

        @JvmStatic
        fun stopSharing(ctx: Context) {
            try {
                ctx.stopService(Intent(ctx, SwarmWorkerService::class.java))
            } catch (t: Throwable) {
                Log.w(TAG, "stopService failed: ${t.message}")
            }
            running = false
            state = "Stopped"
            rpcPid = -1
            endpointId = null
            relayUrl = null
            pairingCode = null
            startedAtMs = 0L
            persistStatus(ctx)
        }

        private fun statusJson(ctx: Context): String {
            val o = JSONObject()
            o.put("running", running)
            o.put("state", state)
            o.put("pid", if (rpcPid > 0) rpcPid else JSONObject.NULL)
            o.put("endpoint_id", endpointId ?: JSONObject.NULL)
            o.put("relay_url", relayUrl ?: JSONObject.NULL)
            o.put("pairing_code", pairingCode ?: JSONObject.NULL)
            o.put("backend", backend)
            o.put("threads", threads)
            o.put("port", port)
            o.put("host", if (running) primaryIpv4() else "0.0.0.0")
            o.put("uptime_secs", if (startedAtMs > 0 && running) (System.currentTimeMillis() - startedAtMs) / 1000 else 0)
            o.put("last_error", lastError ?: JSONObject.NULL)
            val arr = JSONArray()
            synchronized(logs) { logs.forEach { arr.put(it) } }
            o.put("logs", arr)
            persistStatus(ctx, o)
            return o.toString()
        }

        @JvmStatic
        fun leaderStatusJson(ctx: Context): String {
            val o = JSONObject()
            o.put("running", leaderRunning)
            o.put("state", leaderState)
            o.put("pid", if (leaderPid > 0) leaderPid else JSONObject.NULL)
            o.put("port", leaderPort)
            o.put("coord_healthy", leaderState == "Healthy" || leaderState == "Ready")
            o.put(
                "active_profile",
                if (leaderRunning) {
                    if (leaderUseRpc) "default" else "low_memory_cuda_standalone"
                } else {
                    JSONObject.NULL
                }
            )
            o.put("model_path", leaderModelPath)
            o.put("uptime_secs", if (leaderStartedAtMs > 0 && leaderRunning) (System.currentTimeMillis() - leaderStartedAtMs) / 1000 else 0)
            o.put("last_error", leaderLastError ?: JSONObject.NULL)
            val arr = JSONArray()
            synchronized(logs) { logs.forEach { arr.put(it) } }
            o.put("logs", arr)
            return o.toString()
        }

        @JvmStatic
        fun startLeader(
            ctx: Context,
            modelPath: String,
            port: Int,
            ctxSize: Int,
            threads: Int,
            useRpc: Boolean,
            rpcEndpoints: String,
            nGpuLayers: Int,
            placementPolicy: String
        ) {
            leaderPort = port
            leaderModelPath = modelPath
            leaderLastError = null
            leaderUseRpc = useRpc
            leaderState = "Starting"

            val intent = Intent(ctx, SwarmWorkerService::class.java).apply {
                action = ACTION_START_LEADER
                putExtra(EXTRA_MODEL_PATH, modelPath)
                putExtra(EXTRA_PORT, port)
                putExtra(EXTRA_CTX_SIZE, ctxSize)
                putExtra(EXTRA_THREADS, threads)
                putExtra(EXTRA_USE_RPC, useRpc)
                putExtra(EXTRA_RPC_ENDPOINTS, rpcEndpoints)
                putExtra(EXTRA_N_GPU_LAYERS, nGpuLayers)
                putExtra(EXTRA_PLACEMENT_POLICY, placementPolicy)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent)
            } else {
                ctx.startService(intent)
            }
        }

        @JvmStatic
        fun stopLeader(ctx: Context) {
            leaderRunning = false
            leaderState = "Stopped"
            leaderPid = -1
            leaderStartedAtMs = 0L
            val intent = Intent(ctx, SwarmWorkerService::class.java).apply {
                action = ACTION_STOP_LEADER
            }
            try {
                ctx.startService(intent)
            } catch (t: Throwable) {
                Log.w(TAG, "stopLeader intent failed: ${t.message}")
            }
        }

        private fun persistStatus(ctx: Context, json: JSONObject? = null) {
            try {
                val body = json ?: JSONObject().apply {
                    put("running", running)
                    put("state", state)
                    put("port", port)
                    put("backend", backend)
                    put("last_error", lastError ?: JSONObject.NULL)
                }
                File(ctx.filesDir, STATUS_FILE).writeText(body.toString())
            } catch (t: Throwable) {
                Log.w(TAG, "Could not persist worker status: ${t.message}")
            }
        }

        private fun jsonString(value: String?): String {
            if (value == null) return "null"
            return JSONObject.quote(value)
        }

        /**
         * Best-effort primary IPv4 for the discovery reply, in the same priority
         * order the coordinator uses: USB tether, then LAN, then anything else.
         */
        private fun primaryIpv4(): String {
            var usb: String? = null
            var lan: String? = null
            var other: String? = null
            try {
                for (intf in Collections.list(NetworkInterface.getNetworkInterfaces())) {
                    if (intf.isLoopback || !intf.isUp) continue
                    val name = intf.name.lowercase()
                    for (addr in Collections.list(intf.inetAddresses)) {
                        if (addr.isLoopbackAddress) continue
                        val host = addr.hostAddress ?: continue
                        if (host.contains(':')) continue
                        when {
                            name.startsWith("rndis") || name.startsWith("usb") -> if (usb == null) usb = host
                            name.startsWith("wlan") || name.startsWith("eth") || name.startsWith("ap") -> if (lan == null) lan = host
                            else -> if (other == null) other = host
                        }
                    }
                }
            } catch (_: Throwable) {
            }
            return usb ?: lan ?: other ?: "0.0.0.0"
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var rpcProcess: Process? = null
    private var tunnelProcess: Process? = null
    private var coordProcess: Process? = null
    private var discoverySocket: DatagramSocket? = null
    private val shouldRun = AtomicBoolean(false)
    private val shouldRunLeader = AtomicBoolean(false)
    private var lastGuardrailCheckMs = 0L
    private var lastRpcActivityMs = System.currentTimeMillis()
    private var idleLocksReleased = false
    private var thermalWarned = false

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            shutdown()
            stopSelf()
            return START_NOT_STICKY
        }

        if (intent?.action == ACTION_STOP_LEADER) {
            destroyLeader()
            if (!running && !shouldRun.get()) {
                releaseLocks()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
            return START_NOT_STICKY
        }

        if (intent?.action == ACTION_START_LEADER) {
            val modelPath = intent.getStringExtra(EXTRA_MODEL_PATH) ?: ""
            val requestedPort = intent.getIntExtra(EXTRA_PORT, 8080)
            val ctxSize = intent.getIntExtra(EXTRA_CTX_SIZE, 512)
            val requestedThreads = intent.getIntExtra(EXTRA_THREADS, 0)
            val useRpc = intent.getBooleanExtra(EXTRA_USE_RPC, false)
            val rpcEndpoints = intent.getStringExtra(EXTRA_RPC_ENDPOINTS) ?: ""
            val nGpuLayers = intent.getIntExtra(EXTRA_N_GPU_LAYERS, -1)
            val placementPolicy = intent.getStringExtra(EXTRA_PLACEMENT_POLICY) ?: "none"

            leaderPort = requestedPort
            leaderModelPath = modelPath
            startForeground(NOTIF_ID, buildNotification("Starting Swarm Coordinator…"))
            acquireLocks()

            if (shouldRunLeader.getAndSet(true)) {
                Log.i(TAG, "Leader supervisor already running")
                return START_STICKY
            }

            leaderRunning = true
            leaderState = "Starting"
            leaderUseRpc = useRpc
            leaderStartedAtMs = System.currentTimeMillis()
            leaderLastError = null
            Thread({
                superviseLeader(modelPath, requestedPort, ctxSize, requestedThreads, useRpc, rpcEndpoints, nGpuLayers, placementPolicy)
            }, "SwarmLeaderSupervisor").start()
            return START_STICKY
        }

        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val useGpu = intent?.getBooleanExtra(EXTRA_USE_GPU, prefs.getBoolean(KEY_USE_GPU, false))
            ?: prefs.getBoolean(KEY_USE_GPU, false)
        val requestedPort = intent?.getIntExtra(EXTRA_PORT, prefs.getInt(KEY_PORT, 50052))
            ?: prefs.getInt(KEY_PORT, 50052)
        val requestedThreads = intent?.getIntExtra(EXTRA_THREADS, prefs.getInt(KEY_THREADS, 0))
            ?: prefs.getInt(KEY_THREADS, 0)

        port = requestedPort
        backend = if (useGpu) "Vulkan0" else "CPU"

        // Android requires the foreground notification within ~5s of start.
        startForeground(NOTIF_ID, buildNotification(if (useGpu) "Initializing Vulkan0 compute node…" else "Initializing ARM NEON compute node…"))

        if (shouldRun.getAndSet(true)) {
            Log.i(TAG, "Supervisor already running")
            return START_STICKY
        }

        running = true
        state = "Starting"
        startedAtMs = System.currentTimeMillis()
        lastError = null
        lastRpcActivityMs = System.currentTimeMillis()
        idleLocksReleased = false
        lastGuardrailCheckMs = 0L
        thermalWarned = false
        // A fresh six-digit code per sharing session lets a remote desktop
        // derive this device's tunnel identity without any account or VPN.
        pairingCode = String.format("%06d", java.security.SecureRandom().nextInt(1_000_000))
        log("Pairing code generated for this sharing session")
        acquireLocks()
        startDiscoveryResponder()
        Thread({ supervise(useGpu, requestedPort, requestedThreads) }, "SwarmSupervisor").start()
        return START_STICKY
    }

    private fun supervise(useGpu: Boolean, requestedPort: Int, requestedThreads: Int) {
        val nativeDir = File(applicationInfo.nativeLibraryDir)
        val rpcBin = File(nativeDir, "libggml_rpc.so")
        val tunnelBin = File(nativeDir, "libswarm_tunnel.so")

        val cores = Runtime.getRuntime().availableProcessors()
        val nThreads = if (requestedThreads > 0) requestedThreads else maxOf(4, cores - 2)
        threads = nThreads

        val rpcArgs = mutableListOf<String>()
        rpcArgs += rpcBin.absolutePath
        rpcArgs += listOf("-H", "127.0.0.1", "-p", requestedPort.toString())
        if (useGpu) {
            rpcArgs += listOf("-d", "Vulkan0")
            log("Launching ggml-rpc-server on 127.0.0.1:$requestedPort (Vulkan0)")
        } else {
            rpcArgs += listOf("-d", "CPU", "-t", nThreads.toString())
            log("Launching ggml-rpc-server on 127.0.0.1:$requestedPort (CPU, $nThreads threads)")
        }

        val rpcBuilder = ProcessBuilder(rpcArgs)
        rpcBuilder.directory(filesDir)
        rpcBuilder.environment()["LD_LIBRARY_PATH"] = nativeDir.absolutePath
        rpcBuilder.redirectErrorStream(true)

        try {
            val rpc = rpcBuilder.start()
            rpcProcess = rpc
            rpcPid = pidOf(rpc)
            drainToLogcat(rpc, "ggml-rpc")
            log("ggml-rpc-server started (pid $rpcPid)")

            val tunnelBuilder = ProcessBuilder(
                tunnelBin.absolutePath,
                "serve",
                "--rpc",
                "127.0.0.1:$requestedPort",
                "--pair-code",
                pairingCode ?: "000000",
            )
            tunnelBuilder.directory(filesDir)
            tunnelBuilder.redirectErrorStream(true)
            resolveSystemDns()?.let { tunnelBuilder.environment()["SWARM_DNS"] = it }
            tunnelProcess = tunnelBuilder.start()
            log("swarm-tunnel started")
            captureTunnelIdentity(tunnelProcess)

            // The RPC server binds quickly; report Listening once the socket accepts.
            if (awaitPort(requestedPort, 12_000)) {
                state = "Listening"
                updateNotification(
                    if (useGpu) "Active node · Vulkan0 GPU" else "Active node · $nThreads CPU threads"
                )
                log("RPC worker listening on 127.0.0.1:$requestedPort (Loopback Only, Encrypted Tunnel Authenticated)")
            } else {
                state = "Failed"
                lastError = "RPC server did not accept connections on port $requestedPort"
                log(lastError!!)
            }

            while (shouldRun.get()) {
                if (rpcProcess?.isAlive == false) {
                    log("ggml-rpc-server exited; respawning…")
                    try {
                        val respawned = rpcBuilder.start()
                        rpcProcess = respawned
                        rpcPid = pidOf(respawned)
                        drainToLogcat(respawned, "ggml-rpc")
                        if (awaitPort(requestedPort, 8_000)) {
                            state = "Listening"
                            lastError = null
                            log("ggml-rpc-server respawned (pid $rpcPid)")
                        }
                    } catch (t: Throwable) {
                        state = "Failed"
                        lastError = "Respawn failed: ${t.message}"
                        log(lastError!!)
                    }
                }
                if (tunnelProcess?.isAlive == false) {
                    log("swarm-tunnel exited; worker remains reachable directly on the LAN")
                }
                monitorGuardrails()
                Thread.sleep(1500)
            }
        } catch (t: Throwable) {
            state = "Failed"
            lastError = t.message ?: t.toString()
            log("Worker supervisor failed: ${t.message}")
            Log.e(TAG, "Worker supervisor failed", t)
        } finally {
            destroyChildren()
        }
    }

    private fun pidOf(process: Process): Int {
        // java.lang.Process exposes pid() only on API 26+, and the Kotlin
        // Android stdlib does not surface it, so read the implementation field.
        return try {
            val field = process.javaClass.getDeclaredField("pid")
            field.isAccessible = true
            (field.get(process) as? Number)?.toInt() ?: -1
        } catch (_: Throwable) {
            -1
        }
    }

    private fun awaitPort(targetPort: Int, timeoutMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline && (shouldRun.get() || shouldRunLeader.get())) {
            try {
                Socket("127.0.0.1", targetPort).use { return true }
            } catch (_: Throwable) {
                Thread.sleep(200)
            }
        }
        return false
    }

    private fun captureTunnelIdentity(process: Process?) {
        if (process == null) return
        Thread({
            try {
                BufferedReader(InputStreamReader(process.inputStream)).use { reader ->
                    var line = reader.readLine()
                    while (line != null) {
                        Log.i("swarm-tunnel", line)
                        log("tunnel: $line")
                        when {
                            line.startsWith("PAIR_CODE ") -> pairingCode = line.substring(10).trim()
                            line.startsWith("ENDPOINT_ID ") -> endpointId = line.substring(12).trim()
                            line.startsWith("RELAY_URL ") -> relayUrl = line.substring(10).trim()
                        }
                        line = reader.readLine()
                    }
                }
            } catch (t: Throwable) {
                Log.w("swarm-tunnel", "output reader stopped: ${t.message}")
            }
        }, "TunnelOutputReader").start()
    }

    private fun drainToLogcat(process: Process?, tag: String) {
        if (process == null) return
        Thread({
            try {
                BufferedReader(InputStreamReader(process.inputStream)).use { reader ->
                    var line = reader.readLine()
                    while (line != null) {
                        Log.i(tag, line)
                        log("$tag: $line")
                        line = reader.readLine()
                    }
                }
            } catch (t: Throwable) {
                Log.w(tag, "output reader stopped: ${t.message}")
            }
        }, "$tag-reader").start()
    }

    private fun resolveSystemDns(): String? {
        // Cellular networks are often IPv6-only, so public IPv4 resolvers are
        // unreachable. Hand the tunnel the live network's own DNS servers.
        return try {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return null
            val network: Network = cm.activeNetwork ?: return null
            val lp: LinkProperties = cm.getLinkProperties(network) ?: return null
            val servers = lp.dnsServers
                .filter { it != null && !it.isAnyLocalAddress && !it.isLoopbackAddress }
                .joinToString(",") { it.hostAddress ?: "" }
            servers.ifEmpty { null }
        } catch (t: Throwable) {
            Log.w(TAG, "Could not read system DNS: ${t.message}")
            null
        }
    }

    private fun startDiscoveryResponder() {
        Thread({
            var socket: DatagramSocket? = null
            try {
                socket = DatagramSocket(null)
                socket.reuseAddress = true
                socket.bind(InetSocketAddress(DISCOVERY_PORT))
                discoverySocket = socket
                val buf = ByteArray(256)
                log("Discovery responder listening on UDP $DISCOVERY_PORT")
                while (shouldRun.get()) {
                    val packet = DatagramPacket(buf, buf.size)
                    socket.receive(packet)
                    val request = String(packet.data, 0, packet.length, StandardCharsets.UTF_8).trim()
                    if (!request.startsWith(DISCOVERY_MAGIC)) continue
                    val reply = "{\"v\":1,\"platform\":\"android\",\"name\":${jsonString(Build.MODEL)}," +
                        "\"port\":$port,\"host\":${jsonString(primaryIpv4())}," +
                        "\"endpoint_id\":${jsonString(endpointId)}}"
                    val out = reply.toByteArray(StandardCharsets.UTF_8)
                    socket.send(DatagramPacket(out, out.size, packet.address, packet.port))
                }
            } catch (t: Throwable) {
                Log.w(TAG, "Discovery responder stopped: ${t.message}")
            } finally {
                socket?.close()
                if (discoverySocket === socket) discoverySocket = null
            }
        }, "SwarmDiscovery").apply { isDaemon = true }.start()
    }

    private fun acquireLocks() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Swarm:CpuWakeLock").apply { acquire() }
                log("Acquired CPU partial wake lock")
            }
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to acquire wake lock: ${t.message}")
        }
        try {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            if (wm != null) {
                // The low-latency lock removes the 64–280 ms Wi-Fi jitter spikes
                // that dominate RPC round-trip time on mobile.
                val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                } else {
                    WifiManager.WIFI_MODE_FULL_HIGH_PERF
                }
                wifiLock = wm.createWifiLock(mode, "Swarm:LowLatencyLock").apply { acquire() }
                log("Acquired Wi-Fi low-latency lock")
            }
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to acquire low-latency Wi-Fi lock: ${t.message}")
        }
    }

    private fun releaseLocks() {
        try {
            wifiLock?.let { if (it.isHeld) it.release() }
        } catch (_: Throwable) {
        }
        try {
            wakeLock?.let { if (it.isHeld) it.release() }
        } catch (_: Throwable) {
        }
        wifiLock = null
        wakeLock = null
    }

    /**
     * Periodic, cheap device-protection checks.
     *
     * - Low battery (<15%, unplugged) stops sharing instead of draining to 0%.
     * - Critical thermal status stops sharing; severe status raises a warning.
     * - After 15 minutes with no RPC client, wake locks are released so an idle
     *   phone can sleep. They are reacquired automatically on the next client.
     */
    private fun monitorGuardrails() {
        val now = System.currentTimeMillis()
        // Check more often while idle so wake locks are reacquired promptly when
        // a client reconnects.
        val interval = if (idleLocksReleased) 30_000L else GUARDRAIL_INTERVAL_MS
        if (now - lastGuardrailCheckMs < interval) return
        lastGuardrailCheckMs = now

        if (running && shouldRun.get()) {
            val hasClient = hasEstablishedRpcConnection(port)
            if (hasClient) {
                lastRpcActivityMs = now
                if (idleLocksReleased) {
                    acquireLocks()
                    idleLocksReleased = false
                    log("RPC client reconnected — wake locks reacquired")
                }
            } else if (!idleLocksReleased && now - lastRpcActivityMs >= IDLE_LOCK_RELEASE_MS) {
                releaseLocks()
                idleLocksReleased = true
                log("No RPC client for 15 min — released wake locks to save battery")
                updateNotification("Idle · listening (wake locks released)")
            }
        }

        val (batteryPct, charging) = readBattery()
        if (batteryPct in 0..LOW_BATTERY_STOP_PCT && !charging) {
            lastError = "Auto-stopped at ${batteryPct}% battery to protect the device"
            log(lastError!!)
            updateNotification("Auto-stopped · battery ${batteryPct}%")
            shutdown()
            stopSelf()
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
            val thermal = pm?.currentThermalStatus ?: 0
            when {
                thermal >= THERMAL_STATUS_CRITICAL -> {
                    lastError = "Auto-stopped: device thermal status critical"
                    log(lastError!!)
                    updateNotification("Auto-stopped · device too hot")
                    shutdown()
                    stopSelf()
                }
                thermal >= THERMAL_STATUS_SEVERE && !thermalWarned -> {
                    thermalWarned = true
                    log("Thermal status SEVERE — inference will be throttled by Android")
                    updateNotification("Thermal warning · device is hot")
                }
                thermal < THERMAL_STATUS_SEVERE -> thermalWarned = false
            }
        }
    }

    private fun readBattery(): Pair<Int, Boolean> {
        return try {
            val intent = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
            val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
            val pct = if (level >= 0 && scale > 0) level * 100 / scale else -1
            val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                status == BatteryManager.BATTERY_STATUS_FULL
            pct to charging
        } catch (t: Throwable) {
            Log.w(TAG, "Battery read failed: ${t.message}")
            -1 to true
        }
    }

    /** Reads /proc/net/tcp{,6} for an ESTABLISHED (state 01) socket on [targetPort]. */
    private fun hasEstablishedRpcConnection(targetPort: Int): Boolean {
        val hexPort = String.format("%04X", targetPort)
        for (path in listOf("/proc/net/tcp", "/proc/net/tcp6")) {
            try {
                for (line in File(path).readLines()) {
                    val parts = line.trim().split(Regex("\\s+"))
                    if (parts.size > 3 && parts[3] == "01" && parts[1].endsWith(":$hexPort")) {
                        return true
                    }
                }
            } catch (_: Throwable) {
                // /proc may be unavailable on hardened builds; idle release is best-effort.
            }
        }
        return false
    }

    private fun superviseLeader(
        modelPath: String,
        port: Int,
        ctxSize: Int,
        requestedThreads: Int,
        useRpc: Boolean,
        rpcEndpoints: String,
        nGpuLayers: Int,
        placementPolicy: String
    ) {
        val nativeDir = File(applicationInfo.nativeLibraryDir)
        val coordBin = File(nativeDir, "libswarm_node.so")
        if (!coordBin.exists()) {
            leaderState = "Failed"
            leaderLastError = "Coordinator binary missing at ${coordBin.absolutePath}"
            log(leaderLastError!!)
            return
        }

        val cores = Runtime.getRuntime().availableProcessors()
        val nThreads = if (requestedThreads > 0) requestedThreads else maxOf(4, cores - 2)

        val coordArgs = mutableListOf<String>()
        coordArgs += coordBin.absolutePath

        val coordBuilder = ProcessBuilder(coordArgs)
        coordBuilder.directory(filesDir)
        coordBuilder.environment()["LD_LIBRARY_PATH"] = nativeDir.absolutePath
        coordBuilder.environment()["SWARM_MODEL_PATH"] = modelPath
        coordBuilder.environment()["PORT"] = port.toString()
        coordBuilder.environment()["SWARM_CTX_SIZE"] = ctxSize.toString()
        coordBuilder.environment()["SWARM_DEPLOYMENT_ENV"] = "development"
        coordBuilder.environment()["SWARM_USE_RPC"] = if (useRpc) "1" else "0"
        if (rpcEndpoints.isNotBlank()) {
            coordBuilder.environment()["SWARM_RPC_ENDPOINTS"] = rpcEndpoints
        }
        coordBuilder.environment()["SWARM_N_GPU_LAYERS"] = nGpuLayers.toString()
        coordBuilder.environment()["SWARM_PLACEMENT_POLICY"] = placementPolicy
        coordBuilder.redirectErrorStream(true)

        try {
            val proc = coordBuilder.start()
            coordProcess = proc
            leaderPid = pidOf(proc)
            drainToLogcat(proc, "swarm-coord")
            log("swarm_node coordinator started (pid $leaderPid)")

            if (awaitPort(port, 75_000)) {
                leaderState = "Healthy"
                leaderRunning = true
                updateNotification("Swarm Coordinator Active · Standalone Engine")
                log("Coordinator healthy and listening on http://0.0.0.0:$port")
            } else {
                leaderState = "Failed"
                leaderLastError = "Coordinator did not bind to port $port within timeout"
                log(leaderLastError!!)
            }

            while (shouldRunLeader.get()) {
                if (coordProcess?.isAlive == false) {
                    val code = coordProcess?.exitValue() ?: -1
                    log("swarm_node coordinator exited with code $code")
                    if (shouldRunLeader.get()) {
                        leaderState = "Failed"
                        leaderLastError = "Coordinator exited unexpectedly with code $code"
                    }
                    break
                }
                monitorGuardrails()
                Thread.sleep(1500)
            }
        } catch (t: Throwable) {
            leaderState = "Failed"
            leaderLastError = t.message ?: t.toString()
            log("Coordinator failed: ${t.message}")
            Log.e(TAG, "Coordinator failed", t)
        } finally {
            destroyLeader()
        }
    }

    private fun destroyLeader() {
        shouldRunLeader.set(false)
        try {
            coordProcess?.destroyForcibly()
        } catch (_: Throwable) {
        }
        coordProcess = null
        leaderPid = -1
        leaderRunning = false
    }

    private fun destroyChildren() {
        try {
            tunnelProcess?.destroyForcibly()
        } catch (_: Throwable) {
        }
        try {
            rpcProcess?.destroyForcibly()
        } catch (_: Throwable) {
        }
        tunnelProcess = null
        rpcProcess = null
        rpcPid = -1
        try {
            discoverySocket?.close()
        } catch (_: Throwable) {
        }
        discoverySocket = null
    }

    private fun shutdown() {
        shouldRun.set(false)
        destroyLeader()
        destroyChildren()
        releaseLocks()
        running = false
        state = "Stopped"
        endpointId = null
        relayUrl = null
        pairingCode = null
        startedAtMs = 0L
        stopForeground(STOP_FOREGROUND_REMOVE)
        persistStatus(this)
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Swarm Compute",
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "Ongoing compute sharing notification" }
            (getSystemService(NotificationManager::class.java))?.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(text: String): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val title = when {
            leaderRunning && running -> "Swarm Active · Coordinator & Worker"
            leaderRunning -> "Swarm Coordinator Active"
            else -> "Swarm Compute Active"
        }
        return builder
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(text: String) {
        try {
            (getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)?.notify(NOTIF_ID, buildNotification(text))
        } catch (_: Throwable) {
        }
    }

    override fun onDestroy() {
        shutdown()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
