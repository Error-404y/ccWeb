package cc.qzu.app;

import android.os.Bundle;
import android.view.WindowManager;
import android.view.View;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle state) {
        registerPlugin(QzuDevice.class);
        super.onCreate(state);
        getBridge().getWebView().setOverScrollMode(View.OVER_SCROLL_NEVER);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }
}
