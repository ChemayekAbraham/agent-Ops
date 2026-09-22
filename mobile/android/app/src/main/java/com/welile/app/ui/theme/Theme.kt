package com.welile.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

private val LightColors = lightColorScheme(
    primary = WelileGreen,
    secondary = WelileGreenLight,
    background = WelileBackground,
    error = WelileError,
)

private val DarkColors = darkColorScheme(
    primary = WelileGreenLight,
    secondary = WelileGreen,
    error = WelileError,
)

@Composable
fun WelileTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colorScheme = if (darkTheme) DarkColors else LightColors
    MaterialTheme(
        colorScheme = colorScheme,
        typography = WelileTypography,
        content = content,
    )
}
