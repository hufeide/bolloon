package com.hibs.bolloon;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RokidBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
