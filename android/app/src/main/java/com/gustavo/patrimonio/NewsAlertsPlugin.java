package com.gustavo.patrimonio;

import android.Manifest;
import android.content.Context;
import android.os.Build;

import androidx.core.app.NotificationManagerCompat;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.concurrent.TimeUnit;

/** Ponte entre o app (JS) e os alertas em segundo plano (notícias e proventos). */
@CapacitorPlugin(
        name = "NewsAlerts",
        permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") }
)
public class NewsAlertsPlugin extends Plugin {

    private static final String PERIODIC = "news-alerts";

    /** news, provents: chaves ligadas; holdings: [{ticker, qty, b3}] */
    @PluginMethod
    public void configure(PluginCall call) {
        boolean news = Boolean.TRUE.equals(call.getBoolean("news", false));
        boolean provents = Boolean.TRUE.equals(call.getBoolean("provents", false));
        JSArray holdings = call.getArray("holdings", new JSArray());
        getContext().getSharedPreferences(NewsWorker.PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean("news_enabled", news)
                .putBoolean("prov_enabled", provents)
                .remove("enabled").remove("tickers") // formato antigo
                .putString("holdings", holdings.toString())
                .apply();
        schedule(getContext(), news || provents);
        call.resolve();
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            resolveGranted(call);
        } else {
            requestPermissionForAlias("notifications", call, "notificationsCallback");
        }
    }

    @PermissionCallback
    private void notificationsCallback(PluginCall call) {
        resolveGranted(call);
    }

    private void resolveGranted(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
        call.resolve(r);
    }

    @PluginMethod
    public void checkNow(PluginCall call) {
        WorkManager.getInstance(getContext()).enqueue(new OneTimeWorkRequest.Builder(NewsWorker.class)
                .setInputData(new Data.Builder().putBoolean("force", true).build())
                .setConstraints(networkOnly()).build());
        call.resolve();
    }

    static void schedule(Context ctx, boolean enabled) {
        WorkManager wm = WorkManager.getInstance(ctx);
        if (!enabled) {
            wm.cancelUniqueWork(PERIODIC);
            wm.cancelUniqueWork(NewsWorker.CHAIN);
            return;
        }
        // rede de segurança: 15 min é o mínimo do Android; a corrente de ~5 min roda por cima
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(NewsWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(networkOnly())
                .build();
        wm.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, req);
        NewsWorker.scheduleNext(ctx);
    }

    private static Constraints networkOnly() {
        return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
    }
}
