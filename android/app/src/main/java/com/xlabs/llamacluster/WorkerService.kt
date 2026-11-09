package com.xlabs.llamacluster

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform

/**
 * Keeps the LlamaCluster worker (worker.py, run by Chaquopy) alive in the background.
 * The worker starts llama-server / rpc-server from this app's native library directory on request
 * of the controller.
 */
class WorkerService : Service() {

    companion object {
        const val ACTION_STOP = "com.xlabs.llamacluster.STOP"
        const val CHANNEL = "worker"
        const val PREFS = "worker"
        @Volatile var running = false
        @Volatile var lastError: String? = null
    }

    private var thread: Thread? = null
    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (running) return START_STICKY

        val p = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val port = p.getString("port", "7860") ?: "7860"
        val name = p.getString("name", null) ?: (Build.MODEL ?: "android")
        val token = p.getString("token", "") ?: ""
        val hf = p.getString("hf", "") ?: ""
        val modelsDir = (getExternalFilesDir(null) ?: filesDir).absolutePath + "/models"
        val device = ((Build.MANUFACTURER ?: "") + " " + (Build.MODEL ?: "")).trim()
        val nativeDir = applicationInfo.nativeLibraryDir

        startForegroundCompat(buildNotification("Worker '$name' listening on port $port"))
        acquireLocks()
        lastError = null
        running = true

        thread = Thread({
            try {
                if (!Python.isStarted()) Python.start(AndroidPlatform(applicationContext))
                Python.getInstance().getModule("android_main")
                    .callAttr("run", name, token, modelsDir, nativeDir, port.toInt(), device, hf)
            } catch (t: Throwable) {
                lastError = t.message ?: t.toString()
            } finally {
                running = false
                stopSelf()
            }
        }, "llamacluster-worker")
        thread!!.start()
        return START_STICKY
    }

    override fun onDestroy() {
        // Stop the HTTP server and the llama-server / rpc-server children. Done off the main thread because
        // the worker waits up to a few seconds for the children to exit.
        val stopper = Thread {
            try {
                if (Python.isStarted()) Python.getInstance().getModule("android_main").callAttr("stop")
            } catch (_: Throwable) {
            }
        }
        stopper.start()
        try { stopper.join(6000) } catch (_: InterruptedException) { }
        running = false
        releaseLocks()
        super.onDestroy()
    }

    // ---- notification / locks
    private fun buildNotification(text: String): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Worker", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, WorkerService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("LlamaCluster worker")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(android.R.drawable.ic_media_pause, "Stop", stop).build())
            .build()
    }

    private fun startForegroundCompat(n: Notification) {
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(1, n)
        }
    }

    @Suppress("DEPRECATION")
    private fun acquireLocks() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "llamacluster:worker").apply {
            setReferenceCounted(false); acquire()
        }
        val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                   else WifiManager.WIFI_MODE_FULL_HIGH_PERF
        wifi = wm.createWifiLock(mode, "llamacluster:worker").apply {
            setReferenceCounted(false); acquire()
        }
    }

    private fun releaseLocks() {
        try { wake?.takeIf { it.isHeld }?.release() } catch (_: Throwable) { }
        try { wifi?.takeIf { it.isHeld }?.release() } catch (_: Throwable) { }
        wake = null; wifi = null
    }
}
