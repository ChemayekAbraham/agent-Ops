package com.welile.app.auth

import com.welile.app.core.SupabaseClientProvider
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.auth.status.SessionStatus
import io.github.jan.supabase.auth.providers.builtin.Email
import io.github.jan.supabase.auth.user.UserInfo
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Columns
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Mirrors the email/password half of src/hooks/auth/authOperations.ts against
 * the same Supabase project (wirntoujqoyjobfhyelc). Phone OTP (sms-otp /
 * otp-login edge functions) is intentionally out of scope for this first
 * pass — it lands in a follow-up once this flow is verified end to end.
 */
class AuthRepository {

    private val client = SupabaseClientProvider.client

    val sessionStatus: StateFlow<SessionStatus>
        get() = client.auth.sessionStatus

    fun currentUser(): UserInfo? = client.auth.currentUserOrNull()

    suspend fun signUp(
        email: String,
        password: String,
        fullName: String,
        phone: String,
        role: String,
    ) {
        client.auth.signUpWith(Email) {
            this.email = email
            this.password = password
            data = buildJsonObject {
                put("full_name", fullName)
                put("phone", phone)
                put("role", role)
                put("signup_source", "android_native")
            }
        }
    }

    suspend fun signIn(email: String, password: String) {
        client.auth.signInWith(Email) {
            this.email = email
            this.password = password
        }
    }

    suspend fun signOut() {
        client.auth.signOut()
    }

    /** Reads the same `user_roles` table roleManager.ts uses for persona gating. */
    suspend fun fetchRoles(userId: String): List<String> {
        return client.postgrest.from("user_roles")
            .select(columns = Columns.list("role")) {
                filter { eq("user_id", userId) }
            }
            .decodeList<UserRoleRow>()
            .map { it.role }
    }

    @Serializable
    private data class UserRoleRow(val role: String)
}
