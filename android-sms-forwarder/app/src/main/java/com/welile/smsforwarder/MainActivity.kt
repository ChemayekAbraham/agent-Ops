package com.welile.smsforwarder

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

/** Deliberately plain, programmatic UI: setup plus a status board (pending / received / failed). */
class MainActivity : Activity() {
    private lateinit var status: TextView
    private val ui = Handler(Looper.getMainLooper())
    private val refresh = object : Runnable {
        override fun run() {
            render()
            ui.postDelayed(this, 3000)
        }
    }

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad) }
        val url = EditText(this).apply { hint = "Endpoint URL"; setText(Config.url(this@MainActivity)) }
        val token = EditText(this).apply { hint = "Device token"; setText(Config.token(this@MainActivity)) }
        fun btn(t: String, f: () -> Unit) = Button(this).apply { text = t; setOnClickListener { f() } }
        status = TextView(this).apply { textSize = 16f; setPadding(0, pad, 0, pad) }
        col.addView(url)
        col.addView(token)
        col.addView(btn("Save and grant SMS permission") {
            Config.save(this, url.text.toString(), token.text.toString())
            requestPermissions(arrayOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS), 1)
            Uploader.scheduleHeartbeat(this)
            Uploader.schedule(this)
        })
        col.addView(btn("Re-scan last 24h of inbox") {
            val n = if (checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED)
                Uploader.rescanInbox(this, 24) else -1
            toast(if (n < 0) "READ_SMS not granted" else "$n new message(s) queued")
        })
        col.addView(btn("Retry failed") { Store.get(this).requeueFailed(); Uploader.schedule(this) })
        col.addView(btn("Upload now") { Uploader.schedule(this) })
        col.addView(status)
        setContentView(ScrollView(this).apply { addView(col) })
    }

    override fun onResume() {
        super.onResume()
        ui.post(refresh)
    }

    override fun onPause() {
        super.onPause()
        ui.removeCallbacks(refresh)
    }

    private fun render() {
        val s = Store.get(this)
        status.text = "Pending upload: ${s.count("pending")}\nReceived by server: ${s.count("received")}\nFailed: ${s.count("failed")}\n\n" +
            "Set this app's battery usage to Unrestricted, or the phone may stop receiving while asleep."
    }

    private fun toast(m: String) = Toast.makeText(this, m, Toast.LENGTH_SHORT).show()
}
