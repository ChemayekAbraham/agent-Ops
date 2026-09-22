package com.welile.app.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.jan.supabase.auth.status.SessionStatus
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class AuthViewModel(
    private val repository: AuthRepository = AuthRepository(),
) : ViewModel() {

    private val _uiState = MutableStateFlow(AuthUiState())
    val uiState: StateFlow<AuthUiState> = _uiState.asStateFlow()

    init {
        viewModelScope.launch {
            repository.sessionStatus.collect { status ->
                _uiState.value = _uiState.value.copy(
                    isAuthenticated = status is SessionStatus.Authenticated,
                )
            }
        }
    }

    fun signIn(email: String, password: String) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, errorMessage = null)
            runCatching { repository.signIn(email.trim(), password) }
                .onFailure { error ->
                    _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        errorMessage = error.message ?: "Sign in failed. Please try again.",
                    )
                }
                .onSuccess {
                    _uiState.value = _uiState.value.copy(isLoading = false)
                }
        }
    }

    fun signUp(email: String, password: String, fullName: String, phone: String, role: String) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, errorMessage = null)
            runCatching {
                repository.signUp(email.trim(), password, fullName.trim(), phone.trim(), role)
            }
                .onFailure { error ->
                    _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        errorMessage = error.message ?: "Sign up failed. Please try again.",
                    )
                }
                .onSuccess {
                    _uiState.value = _uiState.value.copy(isLoading = false)
                }
        }
    }

    fun signOut() {
        viewModelScope.launch {
            runCatching { repository.signOut() }
        }
    }

    fun dismissError() {
        _uiState.value = _uiState.value.copy(errorMessage = null)
    }
}
