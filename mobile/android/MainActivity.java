package cc.qzu.app;

import android.os.Bundle;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import android.view.WindowManager;
import android.view.View;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle state) {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        registerPlugin(QzuDevice.class);
        super.onCreate(state);
        if(Build.VERSION.SDK_INT>=26){NotificationManager manager=(NotificationManager)getSystemService(Context.NOTIFICATION_SERVICE);NotificationChannel channel=new NotificationChannel("qzu_messages","Messages",NotificationManager.IMPORTANCE_HIGH);channel.setDescription("New private messages");channel.enableVibration(true);channel.setShowBadge(true);manager.createNotificationChannel(channel);}
        getBridge().getWebView().setOverScrollMode(View.OVER_SCROLL_NEVER);
        getBridge().getWebView().setHorizontalScrollBarEnabled(false);
        getBridge().getWebView().getSettings().setSupportZoom(false);
        getBridge().getWebView().getSettings().setBuiltInZoomControls(false);
        getBridge().getWebView().getSettings().setDisplayZoomControls(false);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false);
    }
}
