package com.welile.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Placeholder landing screen once signed in. Persona-specific dashboards
 * (tenant/agent/landlord/supporter) are the next feature after auth.
 */
@Composable
fun HomeScreen(onSignOut: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(text = "Signed in", style = MaterialTheme.typography.titleLarge)
        Button(onClick = onSignOut, modifier = Modifier.padding(top = 16.dp)) {
            Text("Sign out")
        }
    }
}
