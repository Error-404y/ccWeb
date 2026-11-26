package cc.qzu.app;

import android.os.Bundle;
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
        getBridge().getWebView().setOverScrollMode(View.OVER_SCROLL_NEVER);
        getBridge().getWebView().setHorizontalScrollBarEnabled(false);
        getBridge().getWebView().getSettings().setSupportZoom(false);
        getBridge().getWebView().getSettings().setBuiltInZoomControls(false);
        getBridge().getWebView().getSettings().setDisplayZoomControls(false);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false);
    }
}
