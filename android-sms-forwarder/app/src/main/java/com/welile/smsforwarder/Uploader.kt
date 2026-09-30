package com.welile.smsforwarder

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.provider.Telephony
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

object Uploader {
    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun schedule(ctx: Context) {
        val req = OneTimeWorkRequestBuilder<UploadWorker>()
            .setConstraints(online)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(ctx).enqueueUniqueWork("upload", ExistingWorkPolicy.APPEND_OR_REPLACE, req)
    }

    /** Heartbeat every 15 min (WorkManager's minimum) so ops can see when a phone goes quiet; it also drains any stuck backlog. */
    fun scheduleHeartbeat(ctx: Context) {
        val req = PeriodicWorkRequestBuilder<HeartbeatWorker>(15, TimeUnit.MINUTES).setConstraints(online).build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("heartbeat", ExistingPeriodicWorkPolicy.KEEP, req)
    }

    /** Re-read the phone's inbox for the last [hours]h. The server dedups by client_message_id, so this is safe to repeat. */
    fun rescanInbox(ctx: Context, hours: Int): Int {
        val since = System.currentTimeMillis() - hours * 3_600_000L
        var added = 0
        ctx.contentResolver.query(
            Telephony.Sms.Inbox.CONTENT_URI, arrayOf("address", "body", "date"), "date >= ?", arrayOf(since.toString()), "date ASC"
        )?.use { c ->
            while (c.moveToNext()) {
                val addr = c.getString(0) ?: continue
                if (Config.allowed(addr) && Store.get(ctx).save(addr, c.getString(1) ?: "", c.getLong(2), -1)) added++
            }
        }
        if (added > 0) schedule(ctx)
        return added
    }

    fun post(ctx: Context, payload: JSONObject): JSONObject {
        val token = Config.token(ctx)
        require(token.isNotEmpty()) { "no device token set" }
        val conn = URL(Config.url(ctx)).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.outputStream.use { it.write(payload.toString().toByteArray()) }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.readText() ?: "{}"
            if (code !in 200..299) throw IllegalStateException("HTTP $code $text".take(200))
            return JSONObject(text)
        } finally {
            conn.disconnect()
        }
    }

    fun heartbeatPayload(ctx: Context): JSONObject {
        val b = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val pct = b?.let { it.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) * 100 / it.getIntExtra(BatteryManager.EXTRA_SCALE, 100) } ?: -1
        val store = Store.get(ctx)
        return JSONObject().put("action", "heartbeat").put("battery_pct", pct)
            .put("app_version", BuildConfig.VERSION_NAME)
            .put("pending_count", store.count("pending")).put("failed_count", store.count("failed"))
    }
}

class UploadWorker(ctx: Context, p: WorkerParameters) : Worker(ctx, p) {
    override fun doWork(): Result {
        val store = Store.get(applicationContext)
        while (true) {
            val batch = store.pending(50)
            if (batch.isEmpty()) return Result.success()
            try {
                val arr = JSONArray()
                batch.forEach {
                    arr.put(
                        JSONObject().put("client_message_id", it.cid).put("sender", it.sender)
                            .put("body", it.body).put("received_at_ms", it.tsMs).put("sim_slot", it.simSlot)
                    )
                }
                val res = Uploader.post(applicationContext, JSONObject().put("action", "upload").put("messages", arr))
                val acked = res.optJSONArray("acked")?.let { a -> List(a.length()) { a.getString(it) } } ?: emptyList()
                store.markReceived(acked) // only NOW is the message considered delivered
                res.optJSONArray("failed")?.let { f ->
                    for (i in 0 until f.length()) f.getJSONObject(i).let { store.markFailed(it.getString("id"), it.optString("error")) }
                }
                if (acked.isEmpty()) return Result.retry()
            } catch (e: Exception) {
                store.bumpAttempts(batch.map { it.cid }, e.message ?: "error")
                return Result.retry() // stays pending, exponential backoff, never dropped
            }
        }
    }
}

class HeartbeatWorker(ctx: Context, p: WorkerParameters) : Worker(ctx, p) {
    override fun doWork(): Result = try {
        Uploader.post(applicationContext, Uploader.heartbeatPayload(applicationContext))
        Uploader.schedule(applicationContext)
        Result.success()
    } catch (e: Exception) {
        Result.retry()
    }
}
