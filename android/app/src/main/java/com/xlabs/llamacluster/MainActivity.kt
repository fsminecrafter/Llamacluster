package com.xlabs.llamacluster

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.io.File
import java.net.Inet4Address
import java.net.NetworkInterface
import java.security.SecureRandom

class MainActivity : Activity() {

    private lateinit var prefs: SharedPreferences
    private lateinit var nameIn: EditText
    private lateinit var portIn: EditText
    private lateinit var tokenIn: EditText
    private lateinit var hfIn: EditText
    private lateinit var status: TextView
    private lateinit var toggle: Button
    private lateinit var copyBtn: Button
    private val ui = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() { refresh(); ui.postDelayed(this, 1500) }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences(WorkerService.PREFS, Context.MODE_PRIVATE)
        if (!prefs.contains("token")) prefs.edit().putString("token", randomToken()).apply()

        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(24))
        }
        col.addView(TextView(this).apply {
            text = "LlamaCluster Worker"; textSize = 24f; setTypeface(null, Typeface.BOLD)
        })
        col.addView(TextView(this).apply {
            text = "Turns this phone into a node. Add it in the LlamaCluster controller with the URL and token shown below."
            setPadding(0, dp(4), 0, dp(12))
        })

        nameIn = field(col, "Node name", prefs.getString("name", null) ?: (Build.MODEL ?: "android"))
        portIn = field(col, "Port", prefs.getString("port", "7860") ?: "7860").also {
            it.inputType = InputType.TYPE_CLASS_NUMBER
        }
        tokenIn = field(col, "Token (the controller needs the same one)", prefs.getString("token", "") ?: "")
        hfIn = field(col, "Hugging Face token (optional, for gated models)", prefs.getString("hf", "") ?: "")

        toggle = Button(this).apply { setOnClickListener { onToggle() } }
        col.addView(toggle, lp(top = 16))

        status = TextView(this).apply {
            setTextIsSelectable(true); typeface = Typeface.MONOSPACE; setPadding(0, dp(12), 0, dp(4))
        }
        col.addView(status)

        copyBtn = Button(this).apply {
            text = "Copy URL"
            setOnClickListener {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("worker url", workerUrl()))
                Toast.makeText(this@MainActivity, "Copied " + workerUrl(), Toast.LENGTH_SHORT).show()
            }
        }
        col.addView(copyBtn)

        col.addView(Button(this).apply {
            text = "Allow running in background (battery)"
            setOnClickListener {
                try {
                    startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                } catch (_: Throwable) {
                    Toast.makeText(this@MainActivity, "Open Settings > Battery and exclude this app", Toast.LENGTH_LONG).show()
                }
            }
        })
        col.addView(TextView(this).apply {
            text = "Tips: keep the phone on Wi-Fi and plugged in while it runs models. Models are stored in this app's " +
                "storage (Android/data/com.xlabs.llamacluster/files/models) and are deleted when the app is uninstalled. " +
                "Pick a small model (1B-4B, Q4) for normal use, or use this phone as an RPC helper so a bigger model can " +
                "use its memory (UI: Distributed model)."
            setPadding(0, dp(12), 0, 0); textSize = 13f; setTextColor(Color.GRAY)
        })

        setContentView(ScrollView(this).apply { addView(col) })
    }

    override fun onResume() { super.onResume(); ui.post(tick) }
    override fun onPause() { super.onPause(); ui.removeCallbacks(tick) }

    private fun field(parent: LinearLayout, label: String, value: String): EditText {
        parent.addView(TextView(this).apply { text = label; textSize = 12f; setPadding(0, dp(8), 0, 0) })
        val e = EditText(this).apply {
            setText(value); setSingleLine(true); inputType = inputType or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        }
        parent.addView(e)
        return e
    }

    private fun lp(top: Int = 0) = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
    ).apply { topMargin = dp(top); gravity = Gravity.CENTER }

    private fun onToggle() {
        if (WorkerService.running) {
            startService(Intent(this, WorkerService::class.java).setAction(WorkerService.ACTION_STOP))
            return
        }
        val port = portIn.text.toString().trim().toIntOrNull()
        if (port == null || port !in 1024..65535) {
            Toast.makeText(this, "Port must be 1024-65535", Toast.LENGTH_SHORT).show(); return
        }
        val token = tokenIn.text.toString().trim()
        if (token.isEmpty()) {
            Toast.makeText(this, "A token is required so only your controller can use this phone", Toast.LENGTH_LONG).show(); return
        }
        prefs.edit()
            .putString("name", nameIn.text.toString().trim().ifEmpty { Build.MODEL ?: "android" })
            .putString("port", port.toString())
            .putString("token", token)
            .putString("hf", hfIn.text.toString().trim())
            .apply()
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)   // the service still runs if refused
        }
        startForegroundService(Intent(this, WorkerService::class.java))
        ui.postDelayed({ refresh() }, 300)
    }

    private fun workerUrl(): String = "http://" + (localIp() ?: "<phone-ip>") + ":" + (prefs.getString("port", "7860") ?: "7860")

    private fun refresh() {
        val on = WorkerService.running
        toggle.text = if (on) "Stop worker" else "Start worker"
        nameIn.isEnabled = !on; portIn.isEnabled = !on; tokenIn.isEnabled = !on; hfIn.isEnabled = !on
        copyBtn.visibility = if (on) View.VISIBLE else View.GONE
        val dir = applicationInfo.nativeLibraryDir
        val hasServer = File(dir, "libllama-server.so").exists()
        val hasRpc = File(dir, "librpc-server.so").exists()
        val sb = StringBuilder()
        if (on) {
            sb.append("RUNNING\n\nAdd node in the controller:\n  URL   ").append(workerUrl())
                .append("\n  Token ").append(prefs.getString("token", "")).append("\n")
        } else {
            sb.append("STOPPED\n")
        }
        sb.append("\nllama-server: ").append(if (hasServer) "included" else "MISSING (rebuild with buildandroid.sh)")
        sb.append("\nrpc-server:   ").append(if (hasRpc) "included" else "MISSING")
        WorkerService.lastError?.let { sb.append("\n\nError: ").append(it) }
        status.text = sb.toString()
    }

    private fun localIp(): String? {
        try {
            val all = NetworkInterface.getNetworkInterfaces() ?: return null
            var fallback: String? = null
            for (ni in all) {
                if (!ni.isUp || ni.isLoopback) continue
                for (a in ni.inetAddresses) {
                    if (a !is Inet4Address || a.isLoopbackAddress) continue
                    val ip = a.hostAddress ?: continue
                    if (ni.name.startsWith("wlan") || ni.name.startsWith("eth")) return ip
                    if (fallback == null) fallback = ip
                }
            }
            return fallback
        } catch (_: Throwable) {
            return null
        }
    }

    private fun randomToken(): String {
        val chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        val r = SecureRandom()
        return (1..24).map { chars[r.nextInt(chars.length)] }.joinToString("")
    }
}
