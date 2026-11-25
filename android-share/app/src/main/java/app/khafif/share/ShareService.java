package app.khafif.share;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

// Foreground service required by Android 14+ before MediaProjection capture starts.
public class ShareService extends Service {
  static final String CHANNEL = "share";
  // Explicit readiness coordination: MainActivity sets onForeground once before
  // starting the service; it fires only after startForeground() has returned,
  // so MediaProjection capture never races the foreground-service requirement.
  static volatile Runnable onForeground;
  static volatile Runnable onFailed;

  @Override public IBinder onBind(Intent i) { return null; }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    try {
      NotificationManager nm = getSystemService(NotificationManager.class);
      if (nm.getNotificationChannel(CHANNEL) == null) {
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "مشاركة الشاشة", NotificationManager.IMPORTANCE_LOW));
      }
      Notification n = new Notification.Builder(this, CHANNEL)
        .setContentTitle("خفيف")
        .setContentText("مشاركة الشاشة شغالة")
        .setSmallIcon(android.R.drawable.presence_video_online)
        .build();
      if (Build.VERSION.SDK_INT >= 34) {
        startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
      } else {
        startForeground(1, n);
      }
      MainActivity.log("خدمة المقدمة اشتغلت");
      Runnable r = onForeground; onForeground = null;
      if (r != null) r.run();
    } catch (Throwable t) {
      MainActivity.log("خطأ في خدمة المقدمة: " + t);
      onForeground = null;
      Runnable f = onFailed; onFailed = null;
      if (f != null) f.run();
      try { stopSelf(); } catch (Throwable t2) {}
    }
    return START_STICKY;
  }
}
