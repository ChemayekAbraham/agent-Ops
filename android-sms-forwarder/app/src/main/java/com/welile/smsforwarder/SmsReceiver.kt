package com.welile.smsforwarder

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        if (parts.isEmpty()) return
        val sender = parts[0].originatingAddress ?: return
        if (!Config.allowed(sender)) return
        // Multipart SMS arrive as several PDUs of one message: rebuild the COMPLETE original text.
        val body = parts.joinToString("") { it.messageBody ?: "" }
        val slot = intent.getIntExtra("slot", -1)
        // Save first (durable), upload second. If the process dies between the two, the rescan recovers it.
        Store.get(ctx).save(sender, body, parts[0].timestampMillis, slot)
        Uploader.schedule(ctx)
    }
}
