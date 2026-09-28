package com.wikiloc.gpxdownloader;

import android.app.Dialog;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Handler;
import android.os.Looper;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "WikilocExtractor")
public class WikilocExtractorPlugin extends Plugin {

    private Dialog activeDialog = null;
    private WebView activeWebView = null;

    @PluginMethod
    public void extract(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("URL no proporcionada");
            return;
        }

        getActivity().runOnUiThread(() -> {
            try {
                startNativeExtraction(url, call);
            } catch (Exception e) {
                call.reject("Error iniciando extracción: " + e.getMessage());
            }
        });
    }

    private void startNativeExtraction(String url, PluginCall call) {
        // Dismiss previous dialog if any
        if (activeDialog != null && activeDialog.isShowing()) {
            activeDialog.dismiss();
        }

        activeDialog = new Dialog(getActivity());
        activeDialog.setCancelable(true);

        FrameLayout container = new FrameLayout(getActivity());
        container.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));

        activeWebView = new WebView(getActivity());
        activeWebView.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));

        WebSettings settings = activeWebView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        // Genuine Android Chrome User-Agent
        settings.setUserAgentString("Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36");

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(activeWebView, true);

        // Native JavaScript bridge to capture mapData
        class JSBridge {
            private boolean resolved = false;

            @JavascriptInterface
            public void onTrailExtracted(String json) {
                if (resolved) return;
                resolved = true;
                new Handler(Looper.getMainLooper()).post(() -> {
                    if (activeDialog != null && activeDialog.isShowing()) {
                        activeDialog.dismiss();
                    }
                    JSObject ret = new JSObject();
                    ret.put("success", true);
                    ret.put("data", json);
                    call.resolve(ret);
                });
            }

            @JavascriptInterface
            public void onChallengeDetected() {
                // If Cloudflare challenge detected, ensure dialog is visible so user can tap captcha
                new Handler(Looper.getMainLooper()).post(() -> {
                    if (activeDialog != null && !activeDialog.isShowing()) {
                        activeDialog.show();
                    }
                });
            }
        }

        JSBridge bridge = new JSBridge();
        activeWebView.addJavascriptInterface(bridge, "WikilocAndroidBridge");

        activeWebView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String finishedUrl) {
                super.onPageFinished(view, finishedUrl);

                // Inject polling script to detect window.mapData or Cloudflare challenge
                String injection = 
                    "(function() {" +
                    "   var count = 0;" +
                    "   var interval = setInterval(function() {" +
                    "       count++;" +
                    "       if (typeof window.mapData !== 'undefined' && window.mapData.mapData && window.mapData.mapData.length > 0) {" +
                    "           clearInterval(interval);" +
                    "           window.WikilocAndroidBridge.onTrailExtracted(JSON.stringify(window.mapData));" +
                    "           return;" +
                    "       }" +
                    "       if (document.body && (document.body.innerText.indexOf('Cloudflare') !== -1 || document.body.innerText.indexOf('Just a moment') !== -1)) {" +
                    "           window.WikilocAndroidBridge.onChallengeDetected();" +
                    "       }" +
                    "       if (count > 80) { clearInterval(interval); }" +
                    "   }, 250);" +
                    "})();";

                view.evaluateJavascript(injection, null);
            }
        });

        activeWebView.setWebChromeClient(new WebChromeClient());

        container.addView(activeWebView);
        activeDialog.setContentView(container);

        // Load the Wikiloc URL
        activeWebView.loadUrl(url);

        // Show dialog so if Cloudflare requires a human tap, it's visible on the device
        activeDialog.show();

        // 35s timeout fallback
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (!call.isKeptAlive()) return;
            if (activeDialog != null && activeDialog.isShowing()) {
                activeDialog.dismiss();
            }
            call.reject("Tiempo de espera agotado al conectar con Wikiloc.");
        }, 35000);
    }
}
