package com.swarm.desktop

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    requestWorkerNotificationPermission()
  }

  /**
   * The compute worker runs as a foreground service, so Android 13+ needs the
   * notification permission for its ongoing status entry to be visible.
   */
  private fun requestWorkerNotificationPermission() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    val granted = ContextCompat.checkSelfPermission(
      this,
      Manifest.permission.POST_NOTIFICATIONS
    ) == PackageManager.PERMISSION_GRANTED
    if (!granted) {
      ActivityCompat.requestPermissions(
        this,
        arrayOf(Manifest.permission.POST_NOTIFICATIONS),
        1001
      )
    }
  }
}
