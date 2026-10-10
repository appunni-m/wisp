package chat.wisp.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * Keeps the process alive while a peer connection is open.
 *
 * This is the whole reason the native app exists. A browser tab that goes to the
 * background stops running within seconds and the WebRTC data channel dies with
 * it. Android will not let an app hold a connection open indefinitely unless it
 * shows the user that it is doing so — hence the ongoing notification. There is
 * no way to keep the connection AND avoid the notification; the platform does not
 * offer one.
 */
public class ConnectionService extends Service {

    public static final String CHANNEL_ID = "linkline-connection";
    public static final int NOTIFICATION_ID = 1201;

    private static volatile boolean running = false;

    public static boolean isRunning() {
        return running;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String text = intent != null ? intent.getStringExtra("text") : null;
        if (text == null || text.isEmpty()) text = "Keeping your direct connection open";

        createChannel(this);
        startForeground(NOTIFICATION_ID, buildNotification(this, text));
        running = true;

        // Restart with the last intent if the system kills us while a peer is
        // still connected.
        return START_REDELIVER_INTENT;
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Open connection", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while a direct peer connection is open");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    static Notification buildNotification(Context context, String text) {
        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending = PendingIntent.getActivity(context, 0, open, pendingFlags);

        return new NotificationCompat.Builder(context, CHANNEL_ID)
                .setContentTitle("Linkline")
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_linkline)
                .setContentIntent(pending)
                .setOngoing(true)
                .setShowWhen(false)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .build();
    }
}
