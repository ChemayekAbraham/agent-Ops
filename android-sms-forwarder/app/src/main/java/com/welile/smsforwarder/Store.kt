package com.welile.smsforwarder

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.security.MessageDigest

/** A message is written here BEFORE any upload is attempted, and only counts as delivered after the server acks it. */
data class Sms(val cid: String, val sender: String, val body: String, val tsMs: Long, val simSlot: Int)

class Store private constructor(ctx: Context) : SQLiteOpenHelper(ctx, "forwarder.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE msgs(
                 id INTEGER PRIMARY KEY AUTOINCREMENT, cid TEXT UNIQUE NOT NULL, sender TEXT NOT NULL,
                 body TEXT NOT NULL, ts INTEGER NOT NULL, sim INTEGER NOT NULL,
                 status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
                 last_error TEXT, created_at INTEGER NOT NULL)"""
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, o: Int, n: Int) {}

    /** Idempotent: same sender+timestamp+body always yields the same cid, so a rescan can't double-store. */
    fun save(sender: String, body: String, tsMs: Long, simSlot: Int): Boolean {
        val cid = sha256("$sender|$tsMs|$body")
        val cv = ContentValues().apply {
            put("cid", cid); put("sender", sender); put("body", body); put("ts", tsMs)
            put("sim", simSlot); put("created_at", System.currentTimeMillis())
        }
        return writableDatabase.insertWithOnConflict("msgs", null, cv, SQLiteDatabase.CONFLICT_IGNORE) != -1L
    }

    fun pending(limit: Int): List<Sms> = readableDatabase.rawQuery(
        "SELECT cid,sender,body,ts,sim FROM msgs WHERE status='pending' ORDER BY ts LIMIT ?", arrayOf(limit.toString())
    ).use { c -> buildList { while (c.moveToNext()) add(Sms(c.getString(0), c.getString(1), c.getString(2), c.getLong(3), c.getInt(4))) } }

    fun markReceived(cids: List<String>) = cids.forEach {
        writableDatabase.execSQL("UPDATE msgs SET status='received', last_error=NULL WHERE cid=?", arrayOf(it))
    }

    fun markFailed(cid: String, err: String) =
        writableDatabase.execSQL("UPDATE msgs SET status='failed', last_error=? WHERE cid=?", arrayOf(err, cid))

    fun bumpAttempts(cids: List<String>, err: String) = cids.forEach {
        writableDatabase.execSQL("UPDATE msgs SET attempts=attempts+1, last_error=? WHERE cid=?", arrayOf(err, it))
    }

    /** Failed rows can be re-queued from the UI once the cause is fixed. */
    fun requeueFailed() = writableDatabase.execSQL("UPDATE msgs SET status='pending', attempts=0 WHERE status='failed'")

    fun count(status: String): Int = readableDatabase.rawQuery(
        "SELECT COUNT(*) FROM msgs WHERE status=?", arrayOf(status)
    ).use { it.moveToFirst(); it.getInt(0) }

    companion object {
        @Volatile private var inst: Store? = null
        fun get(ctx: Context) = inst ?: synchronized(this) { inst ?: Store(ctx.applicationContext).also { inst = it } }
        fun sha256(s: String): String =
            MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}

object Config {
    private fun p(ctx: Context) = ctx.getSharedPreferences("cfg", Context.MODE_PRIVATE)
    const val DEFAULT_URL = "https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/sms-forwarder-ingest"
    fun url(ctx: Context) = p(ctx).getString("url", DEFAULT_URL)!!
    fun token(ctx: Context) = p(ctx).getString("token", "")!!
    fun save(ctx: Context, url: String, token: String) =
        p(ctx).edit().putString("url", url.trim()).putString("token", token.trim()).apply()

    /** Only SMS from these senders (case-insensitive substring) are forwarded; everything else stays private on the phone. */
    val ALLOWED_SENDERS = listOf("mtn", "momo", "airtel", "yello")
    fun allowed(sender: String) = ALLOWED_SENDERS.any { sender.contains(it, ignoreCase = true) }
}
