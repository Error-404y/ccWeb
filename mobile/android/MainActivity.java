package cc.qzu.app;

import android.os.Bundle;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.view.Gravity;
import android.view.WindowManager;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private TextView privacyCover;

    @Override
    public void onCreate(Bundle state) {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        registerPlugin(QzuDevice.class);
        super.onCreate(state);
        if(Build.VERSION.SDK_INT>=26){NotificationManager manager=(NotificationManager)getSystemService(Context.NOTIFICATION_SERVICE);NotificationChannel channel=new NotificationChannel("qzu_messages","Messages",NotificationManager.IMPORTANCE_HIGH);channel.setDescription("New private messages");channel.enableVibration(true);channel.setShowBadge(true);manager.createNotificationChannel(channel);}
        getBridge().getWebView().setOverScrollMode(View.OVER_SCROLL_NEVER);
        getBridge().getWebView().setHorizontalScrollBarEnabled(false);
        getBridge().getWebView().getSettings().setDisplayZoomControls(false);
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false);
    }

    @Override
    public void onPause() {
        FrameLayout content = findViewById(android.R.id.content);
        if (privacyCover == null && content != null) {
            privacyCover = new TextView(this);
            privacyCover.setText("qzu.");
            privacyCover.setTextSize(38);
            privacyCover.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
            privacyCover.setTextColor(Color.WHITE);
            privacyCover.setBackgroundColor(Color.rgb(17, 21, 20));
            privacyCover.setGravity(Gravity.CENTER);
            privacyCover.setClickable(true);
            content.addView(privacyCover, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        super.onPause();
    }

    @Override
    public void onResume() {
        super.onResume();
        if (privacyCover != null) {
            FrameLayout content = findViewById(android.R.id.content);
            if (content != null) content.removeView(privacyCover);
            privacyCover = null;
        }
    }
}
