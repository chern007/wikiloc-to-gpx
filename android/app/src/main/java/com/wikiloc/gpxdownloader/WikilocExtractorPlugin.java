package com.wikiloc.gpxdownloader;

import android.app.Dialog;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import android.Manifest;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(
    name = "WikilocExtractor",
    permissions = {
        @Permission(
            alias = "location",
            strings = {
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            }
        )
    }
)
public class WikilocExtractorPlugin extends Plugin {

    private Dialog activeDialog = null;
    private WebView activeWebView = null;

    public static class JSBridge {
        private final PluginCall call;
        private final AtomicBoolean isDone;
        private final Dialog dialog;

        public JSBridge(PluginCall call, AtomicBoolean isDone, Dialog dialog) {
            this.call = call;
            this.isDone = isDone;
            this.dialog = dialog;
        }

        @JavascriptInterface
        public void onTrailExtracted(String json) {
            if (isDone.getAndSet(true)) return;
            new Handler(Looper.getMainLooper()).post(() -> {
                if (dialog != null && dialog.isShowing()) {
                    dialog.dismiss();
                }
                JSObject ret = new JSObject();
                ret.put("success", true);
                ret.put("data", json);
                call.resolve(ret);
            });
        }

        @JavascriptInterface
        public void onChallengeDetected() {
            new Handler(Looper.getMainLooper()).post(() -> {
                if (dialog != null && !dialog.isShowing()) {
                    dialog.show();
                }
            });
        }
    }

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
        final AtomicBoolean isDone = new AtomicBoolean(false);

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

        JSBridge bridge = new JSBridge(call, isDone, activeDialog);
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
                    "           var measures = (typeof window.spaMeasures !== 'undefined') ? window.spaMeasures : null;" +
                    "           var authorEl = document.querySelector('.trail-by-author, .author-name, [data-role=\"author-name\"]');" +
                    "           var activityEl = document.querySelector('.trail-activity, .activity-name, .trail-activity-name');" +
                    "           var locationEl = document.querySelector('.trail-near, .location-name');" +
                    "           var payload = {" +
                    "               mapData: window.mapData.mapData," +
                    "               waypoints: window.mapData.waypoints || []," +
                    "               measures: measures," +
                    "               author: authorEl ? authorEl.innerText.replace(/^por\\s*/i, '').trim() : ''," +
                    "               activity: activityEl ? activityEl.innerText.trim() : ''," +
                    "               location: locationEl ? locationEl.innerText.replace(/^cerca de\\s*/i, '').trim() : ''," +
                    "               title: document.title || ''" +
                    "           };" +
                    "           window.WikilocAndroidBridge.onTrailExtracted(JSON.stringify(payload));" +
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
            if (isDone.getAndSet(true)) return;
            if (activeDialog != null && activeDialog.isShowing()) {
                activeDialog.dismiss();
            }
            call.reject("Tiempo de espera agotado al conectar con Wikiloc.");
        }, 35000);
    }

    @PluginMethod
    public void saveGpxToDownloads(PluginCall call) {
        String filename = call.getString("filename");
        String gpxContent = call.getString("content");

        if (filename == null || filename.isEmpty() || gpxContent == null) {
            call.reject("Nombre de archivo o contenido inválido");
            return;
        }

        if (!filename.endsWith(".gpx")) {
            filename += ".gpx";
        }

        final String finalFilename = filename;

        getActivity().runOnUiThread(() -> {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.DISPLAY_NAME, finalFilename);
                    values.put(MediaStore.MediaColumns.MIME_TYPE, "application/gpx+xml");
                    values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);

                    ContentResolver resolver = getContext().getContentResolver();
                    Uri fileUri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);

                    if (fileUri != null) {
                        try (OutputStream os = resolver.openOutputStream(fileUri)) {
                            if (os != null) {
                                os.write(gpxContent.getBytes(StandardCharsets.UTF_8));
                                os.flush();
                            }
                        }
                    } else {
                        throw new Exception("No se pudo registrar el archivo en Descargas.");
                    }
                } else {
                    File downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    if (!downloadsDir.exists()) {
                        downloadsDir.mkdirs();
                    }
                    File file = new File(downloadsDir, finalFilename);
                    try (FileOutputStream fos = new FileOutputStream(file)) {
                        fos.write(gpxContent.getBytes(StandardCharsets.UTF_8));
                        fos.flush();
                    }
                }

                Toast.makeText(getActivity(), "Guardado en Descargas: " + finalFilename, Toast.LENGTH_LONG).show();

                JSObject ret = new JSObject();
                ret.put("success", true);
                ret.put("filename", finalFilename);
                ret.put("path", "Descargas/" + finalFilename);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Error al guardar archivo en Descargas: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void shareGpx(PluginCall call) {
        String filename = call.getString("filename");
        String gpxContent = call.getString("content");

        if (filename == null || filename.isEmpty() || gpxContent == null) {
            call.reject("Nombre de archivo o contenido inválido");
            return;
        }

        if (!filename.endsWith(".gpx")) {
            filename += ".gpx";
        }

        final String finalFilename = filename;

        getActivity().runOnUiThread(() -> {
            try {
                File cacheDir = new File(getContext().getCacheDir(), "shared_gpx");
                if (!cacheDir.exists()) {
                    cacheDir.mkdirs();
                }
                File gpxFile = new File(cacheDir, finalFilename);
                try (FileOutputStream fos = new FileOutputStream(gpxFile)) {
                    fos.write(gpxContent.getBytes(StandardCharsets.UTF_8));
                    fos.flush();
                }

                Uri contentUri = FileProvider.getUriForFile(
                        getContext(),
                        getContext().getPackageName() + ".fileprovider",
                        gpxFile
                );

                Intent shareIntent = new Intent(Intent.ACTION_SEND);
                shareIntent.setType("application/gpx+xml");
                shareIntent.putExtra(Intent.EXTRA_STREAM, contentUri);
                shareIntent.putExtra(Intent.EXTRA_SUBJECT, finalFilename);
                shareIntent.putExtra(Intent.EXTRA_TEXT, "Ruta GPX exportada: " + finalFilename);
                shareIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                Intent chooser = Intent.createChooser(shareIntent, "Compartir ruta GPX con...");
                getActivity().startActivity(chooser);

                JSObject ret = new JSObject();
                ret.put("success", true);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Error al compartir archivo: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void requestLocationPermission(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "locationPermCallback");
        } else {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
        }
    }

    @PermissionCallback
    private void locationPermCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", getPermissionState("location") == PermissionState.GRANTED);
        call.resolve(ret);
    }
}
