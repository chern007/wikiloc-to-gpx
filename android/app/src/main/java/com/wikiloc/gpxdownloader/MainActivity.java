package com.wikiloc.gpxdownloader;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WikilocExtractorPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
