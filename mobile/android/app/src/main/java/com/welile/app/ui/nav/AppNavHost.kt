package com.welile.app.ui.nav

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.welile.app.auth.AuthViewModel
import com.welile.app.ui.screens.HomeScreen
import com.welile.app.ui.screens.LoginScreen
import com.welile.app.ui.screens.SignUpScreen

private object Routes {
    const val LOGIN = "login"
    const val SIGN_UP = "signup"
    const val HOME = "home"
}

@Composable
fun AppNavHost(
    authViewModel: AuthViewModel = viewModel(),
    navController: NavHostController = rememberNavController(),
) {
    val uiState by authViewModel.uiState.collectAsState()

    // Compose Navigation's startDestination is fixed at graph creation, so
    // auth-state changes after the first composition are driven here instead
    // of by recomputing startDestination.
    LaunchedEffect(uiState.isAuthenticated) {
        val target = if (uiState.isAuthenticated) Routes.HOME else Routes.LOGIN
        navController.navigate(target) {
            popUpTo(0) { inclusive = true }
            launchSingleTop = true
        }
    }

    NavHost(navController = navController, startDestination = Routes.LOGIN) {
        composable(Routes.LOGIN) {
            LoginScreen(
                uiState = uiState,
                onSignIn = authViewModel::signIn,
                onNavigateToSignUp = { navController.navigate(Routes.SIGN_UP) },
            )
        }
        composable(Routes.SIGN_UP) {
            SignUpScreen(
                uiState = uiState,
                onSignUp = authViewModel::signUp,
                onNavigateToLogin = { navController.popBackStack() },
            )
        }
        composable(Routes.HOME) {
            HomeScreen(onSignOut = authViewModel::signOut)
        }
    }
}
