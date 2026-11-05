package com.gustavo.patrimonio;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.util.Xml;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.xmlpull.v1.XmlPullParser;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Confere periodicamente o Google Notícias para cada ticker da carteira e
 * notifica as matérias novas. Roda pelo WorkManager, mesmo com o app fechado.
 */
public class NewsWorker extends Worker {

    static final String PREFS = "patrimonio_news";
    static final String CHANNEL = "news";
    private static final int MAX_SEEN = 600;
    private static final int MAX_PER_TICKER = 3;
    private static final long MAX_AGE_MS = 24L * 60 * 60 * 1000;

    static class Item {
        String title, link, source;
        long time;
    }

    public NewsWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!prefs.getBoolean("enabled", false)) return Result.success();

        try {
            JSONArray tickers = new JSONArray(prefs.getString("tickers", "[]"));
            Set<String> seen = loadSeen(prefs);
            SharedPreferences.Editor edit = prefs.edit();
            boolean canNotify = NotificationManagerCompat.from(ctx).areNotificationsEnabled();
            if (canNotify) createChannel(ctx);

            for (int i = 0; i < tickers.length(); i++) {
                String ticker = tickers.getString(i);
                List<Item> items;
                try {
                    items = fetch(ticker);
                } catch (Exception e) {
                    continue; // sem rede para este ticker; tenta na próxima rodada
                }
                // Na primeira vez que um ticker entra, só marca como visto (evita avalanche de avisos).
                boolean initialized = prefs.getBoolean("init_" + ticker, false);
                int sent = 0;
                for (Item it : items) {
                    if (seen.contains(it.link)) continue;
                    seen.add(it.link);
                    boolean recent = System.currentTimeMillis() - it.time < MAX_AGE_MS;
                    if (initialized && canNotify && recent && sent < MAX_PER_TICKER) {
                        notify(ctx, ticker, it);
                        sent++;
                    }
                }
                edit.putBoolean("init_" + ticker, true);
            }
            saveSeen(edit, seen);
            edit.apply();
            return Result.success();
        } catch (Exception e) {
            return Result.retry();
        }
    }

    static List<Item> fetch(String ticker) throws Exception {
        String q = URLEncoder.encode(ticker + " when:1d", "UTF-8");
        URL url = new URL("https://news.google.com/rss/search?q=" + q + "&hl=pt-BR&gl=BR&ceid=BR:pt-419");
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(15000);
        conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36");
        try (InputStream in = conn.getInputStream()) {
            return parse(in);
        } finally {
            conn.disconnect();
        }
    }

    static List<Item> parse(InputStream in) throws Exception {
        List<Item> out = new ArrayList<>();
        XmlPullParser p = Xml.newPullParser();
        p.setInput(in, null);
        SimpleDateFormat rfc = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US);
        Item cur = null;
        String tag = null;
        for (int ev = p.getEventType(); ev != XmlPullParser.END_DOCUMENT; ev = p.next()) {
            if (ev == XmlPullParser.START_TAG) {
                tag = p.getName();
                if ("item".equals(tag)) cur = new Item();
            } else if (ev == XmlPullParser.TEXT && cur != null && tag != null) {
                String text = p.getText().trim();
                if (text.isEmpty()) continue;
                switch (tag) {
                    case "title": cur.title = text; break;
                    case "link": cur.link = text; break;
                    case "source": cur.source = text; break;
                    case "pubDate":
                        try { cur.time = rfc.parse(text).getTime(); } catch (Exception ignored) { }
                        break;
                }
            } else if (ev == XmlPullParser.END_TAG) {
                if ("item".equals(p.getName()) && cur != null) {
                    if (cur.title != null && cur.link != null) {
                        if (cur.source != null && cur.title.endsWith(" - " + cur.source)) {
                            cur.title = cur.title.substring(0, cur.title.length() - cur.source.length() - 3);
                        }
                        out.add(cur);
                    }
                    cur = null;
                }
                tag = null;
            }
        }
        return out;
    }

    private static void createChannel(Context ctx) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Notícias da carteira", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("Avisos de notícias sobre as ações da sua carteira");
            ctx.getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
    }

    private static void notify(Context ctx, String ticker, Item it) {
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(it.link));
        PendingIntent pi = PendingIntent.getActivity(ctx, it.link.hashCode(), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String subtitle = ticker + (it.source != null ? " · " + it.source : "");
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_news)
                .setContentTitle(subtitle)
                .setContentText(it.title)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(it.title))
                .setColor(0xFF0A0A0A)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setWhen(it.time > 0 ? it.time : System.currentTimeMillis())
                .setShowWhen(true);
        try {
            NotificationManagerCompat.from(ctx).notify(it.link.hashCode(), b.build());
        } catch (SecurityException ignored) {
            // permissão revogada entre a checagem e o envio
        }
    }

    private static Set<String> loadSeen(SharedPreferences prefs) throws Exception {
        Set<String> seen = new LinkedHashSet<>();
        JSONArray arr = new JSONArray(prefs.getString("seen", "[]"));
        for (int i = 0; i < arr.length(); i++) seen.add(arr.getString(i));
        return seen;
    }

    private static void saveSeen(SharedPreferences.Editor edit, Set<String> seen) {
        List<String> list = new ArrayList<>(seen);
        int from = Math.max(0, list.size() - MAX_SEEN); // mantém só os mais recentes
        edit.putString("seen", new JSONArray(list.subList(from, list.size())).toString());
    }
}
