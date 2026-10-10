package chat.wisp.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registered before super.onCreate so the bridge sees it on first load.
        registerPlugin(WispPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
