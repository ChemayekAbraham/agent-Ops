package com.welile.app.ui.screens

import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoleSelector(
    roles: List<String>,
    selected: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyRow(modifier = modifier) {
        items(roles) { role ->
            FilterChip(
                selected = role == selected,
                onClick = { onSelect(role) },
                label = { Text(role.replaceFirstChar { it.uppercase() }) },
                modifier = Modifier.padding(end = 8.dp),
            )
        }
    }
}
