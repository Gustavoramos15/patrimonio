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
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;
import org.xmlpull.v1.XmlPullParser;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.text.NumberFormat;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.TimeUnit;

/**
 * Alertas em segundo plano (roda pelo WorkManager, mesmo com o app fechado):
 *  - notícias novas das ações da carteira (Google Notícias);
 *  - proventos: anúncio de dividendo/JCP e aviso no dia do pagamento (Status Invest).
 * Cada execução agenda a próxima para daqui a ~5 min; um trabalho periódico de 15 min
 * (mínimo do Android) garante que a corrente volte a rodar se o sistema a interromper.
 */
public class NewsWorker extends Worker {

    static final String PREFS = "patrimonio_news";
    static final String CHANNEL_NEWS = "news";
    static final String CHANNEL_PROV = "provents";
    static final String CHAIN = "alerts-next";
    static final long CHAIN_MINUTES = 5;

    private static final int MAX_SEEN = 600;
    private static final int MAX_PER_TICKER = 3;
    private static final long DAY = 24L * 60 * 60 * 1000;
    private static final long PROV_REFRESH = 6L * 60 * 60 * 1000;
    private static final int PAY_HOUR = 9; // aviso de pagamento a partir das 9h
    private static final String UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";

    static class Item { String title, link, source; long time; }
    static class Holding { String ticker; double qty; boolean b3; }
    static class Provent { String type, id; long ex, pay; double value; }

    public NewsWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        boolean news = newsEnabled(prefs);
        boolean prov = prefs.getBoolean("prov_enabled", false);
        if (!news && !prov) return Result.success();

        long now = System.currentTimeMillis();
        boolean force = getInputData().getBoolean("force", false);
        // a corrente e o periódico podem coincidir: evita rodar duas vezes seguidas
        if (!force && now - prefs.getLong("last_run", 0) < 3 * 60 * 1000) {
            scheduleNext(ctx);
            return Result.success();
        }
        prefs.edit().putLong("last_run", now).apply();

        try {
            List<Holding> holdings = loadHoldings(prefs);
            boolean canNotify = NotificationManagerCompat.from(ctx).areNotificationsEnabled();
            if (canNotify) createChannels(ctx);
            if (news) checkNews(ctx, prefs, holdings, canNotify);
            if (prov) checkProvents(ctx, prefs, holdings, canNotify);
        } catch (Exception ignored) {
            // tenta de novo na próxima rodada
        }
        scheduleNext(ctx);
        return Result.success();
    }

    static boolean newsEnabled(SharedPreferences prefs) {
        return prefs.getBoolean("news_enabled", prefs.getBoolean("enabled", false));
    }

    static void scheduleNext(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!newsEnabled(prefs) && !prefs.getBoolean("prov_enabled", false)) return;
        OneTimeWorkRequest next = new OneTimeWorkRequest.Builder(NewsWorker.class)
                .setInitialDelay(CHAIN_MINUTES, TimeUnit.MINUTES)
                .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build();
        WorkManager.getInstance(ctx).enqueueUniqueWork(CHAIN, ExistingWorkPolicy.REPLACE, next);
    }

    // ------------------------------------------------------------------ carteira

    private static List<Holding> loadHoldings(SharedPreferences prefs) throws Exception {
        List<Holding> out = new ArrayList<>();
        String raw = prefs.getString("holdings", null);
        if (raw != null) {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                Holding h = new Holding();
                h.ticker = o.getString("ticker");
                h.qty = o.optDouble("qty", 0);
                h.b3 = o.optBoolean("b3", false);
                out.add(h);
            }
        } else { // formato da versão 1.1 (só tickers)
            JSONArray arr = new JSONArray(prefs.getString("tickers", "[]"));
            for (int i = 0; i < arr.length(); i++) {
                Holding h = new Holding();
                h.ticker = arr.getString(i);
                out.add(h);
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ notícias

    private static void checkNews(Context ctx, SharedPreferences prefs, List<Holding> holdings, boolean canNotify) throws Exception {
        Set<String> seen = loadSet(prefs, "seen");
        SharedPreferences.Editor edit = prefs.edit();
        for (Holding h : holdings) {
            List<Item> items;
            try { items = fetchNews(h.ticker); } catch (Exception e) { continue; }
            // Na primeira vez que um ticker entra, só marca como visto (evita avalanche de avisos).
            boolean initialized = prefs.getBoolean("init_" + h.ticker, false);
            int sent = 0;
            for (Item it : items) {
                if (seen.contains(it.link)) continue;
                seen.add(it.link);
                boolean recent = System.currentTimeMillis() - it.time < DAY;
                if (initialized && canNotify && recent && sent < MAX_PER_TICKER) {
                    notifyNews(ctx, h.ticker, it);
                    sent++;
                }
            }
            edit.putBoolean("init_" + h.ticker, true);
        }
        saveSet(edit, "seen", seen);
        edit.apply();
    }

    static List<Item> fetchNews(String ticker) throws Exception {
        String q = URLEncoder.encode(ticker + " when:1d", "UTF-8");
        HttpURLConnection conn = open("https://news.google.com/rss/search?q=" + q + "&hl=pt-BR&gl=BR&ceid=BR:pt-419");
        try (InputStream in = conn.getInputStream()) {
            return parseRss(in);
        } finally {
            conn.disconnect();
        }
    }

    static List<Item> parseRss(InputStream in) throws Exception {
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

    private static void notifyNews(Context ctx, String ticker, Item it) {
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(it.link));
        PendingIntent pi = PendingIntent.getActivity(ctx, it.link.hashCode(), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String subtitle = ticker + (it.source != null ? " · " + it.source : "");
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_NEWS)
                .setSmallIcon(R.drawable.ic_stat_news)
                .setContentTitle(subtitle)
                .setContentText(it.title)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(it.title))
                .setColor(0xFF0A0A0A)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setWhen(it.time > 0 ? it.time : System.currentTimeMillis())
                .setShowWhen(true);
        post(ctx, it.link.hashCode(), b);
    }

    // ------------------------------------------------------------------ proventos

    private static void checkProvents(Context ctx, SharedPreferences prefs, List<Holding> holdings, boolean canNotify) throws Exception {
        Set<String> seen = loadSet(prefs, "prov_seen");
        Set<String> paid = loadSet(prefs, "prov_paid");
        SharedPreferences.Editor edit = prefs.edit();
        long now = System.currentTimeMillis();
        long today = startOfDay(now);
        int hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);

        for (Holding h : holdings) {
            if (!h.b3) continue; // proventos vêm do Status Invest (B3)
            String listKey = "prov_list_" + h.ticker;
            String raw = prefs.getString(listKey, null);
            if (raw == null || now - prefs.getLong("prov_at_" + h.ticker, 0) > PROV_REFRESH) {
                try {
                    raw = fetchProventsRaw(h.ticker);
                    edit.putString(listKey, raw).putLong("prov_at_" + h.ticker, now);
                } catch (Exception ignored) { /* usa a última lista salva */ }
            }
            if (raw == null) continue;
            List<Provent> list = parseProvents(h.ticker, raw);

            // anúncios: proventos que ainda não tínhamos visto
            boolean initialized = prefs.getBoolean("prov_init_" + h.ticker, false);
            for (Provent p : list) {
                if (seen.contains(p.id)) continue;
                seen.add(p.id);
                boolean upcoming = p.pay == 0 || p.pay >= today;
                if (initialized && canNotify && upcoming) notifyAnnounced(ctx, h, p);
            }
            edit.putBoolean("prov_init_" + h.ticker, true);

            // pagamento: no dia (a partir das 9h) ou até 2 dias depois, se o celular estava desligado
            for (Provent p : list) {
                if (p.pay == 0 || paid.contains(p.id)) continue;
                boolean due = (p.pay < today && p.pay >= today - 2 * DAY) || (p.pay == today && hour >= PAY_HOUR);
                if (!due) continue;
                paid.add(p.id);
                if (canNotify && h.qty > 0) notifyPaid(ctx, h, p);
            }
        }
        saveSet(edit, "prov_seen", seen);
        saveSet(edit, "prov_paid", paid);
        edit.apply();
    }

    private static String fetchProventsRaw(String ticker) throws Exception {
        for (String kind : new String[] { "acao", "fii", "bdr" }) {
            HttpURLConnection conn = open("https://statusinvest.com.br/" + kind
                    + "/companytickerprovents?ticker=" + URLEncoder.encode(ticker, "UTF-8") + "&chartProventsType=2");
            String body;
            try (InputStream in = conn.getInputStream()) {
                body = readAll(in);
            } finally {
                conn.disconnect();
            }
            JSONArray models = new JSONObject(body).optJSONArray("assetEarningsModels");
            if (models != null && models.length() > 0) return recentOnly(models).toString();
        }
        return "[]";
    }

    /**
     * O histórico completo tem centenas de itens; só interessam os futuros e os pagos há pouco.
     * Isso também mantém pequeno o conjunto de "já vistos", que não pode transbordar
     * (um item esquecido seria anunciado de novo).
     */
    private static JSONArray recentOnly(JSONArray models) throws Exception {
        long cutoff = startOfDay(System.currentTimeMillis()) - 10 * DAY;
        JSONArray out = new JSONArray();
        for (int i = 0; i < models.length(); i++) {
            JSONObject m = models.getJSONObject(i);
            long pay = parseBR(m.optString("pd")), ex = parseBR(m.optString("ed"));
            boolean keep = pay > 0 ? pay >= cutoff : ex >= cutoff - 60 * DAY;
            if (keep) out.put(m);
        }
        return out;
    }

    private static List<Provent> parseProvents(String ticker, String raw) throws Exception {
        List<Provent> out = new ArrayList<>();
        JSONArray arr = new JSONArray(raw);
        for (int i = 0; i < arr.length(); i++) {
            JSONObject m = arr.getJSONObject(i);
            Provent p = new Provent();
            p.type = shortType(m.optString("et", "Provento"));
            p.ex = parseBR(m.optString("ed"));
            p.pay = parseBR(m.optString("pd"));
            p.value = m.optDouble("v", 0);
            p.id = ticker + "|" + p.type + "|" + m.optString("ed") + "|" + m.optString("pd") + "|" + p.value;
            if (p.value > 0) out.add(p);
        }
        return out;
    }

    private static String shortType(String t) {
        String s = t.toLowerCase(Locale.ROOT);
        if (s.contains("juros") || s.contains("jcp")) return "JCP";
        if (s.contains("rend")) return "Rendimento";
        if (s.contains("divid")) return "Dividendo";
        return t;
    }

    private static void notifyAnnounced(Context ctx, Holding h, Provent p) {
        NumberFormat brl = brl();
        StringBuilder text = new StringBuilder(fmtUnit(p.value) + " por ação");
        text.append(p.pay > 0 ? " · pagamento em " + fmtDate(p.pay) : " · pagamento a definir");
        if (h.qty > 0) {
            double gross = h.qty * p.value;
            text.append(" · você deve receber ≈ ")
                .append(brl.format(isJcp(p) ? gross * 0.85 : gross))
                .append(isJcp(p) ? " líquido" : "");
        }
        if (p.ex > 0) text.append(". Data com: ").append(fmtDate(p.ex)).append('.');
        String title = h.ticker + " anunciou " + (isJcp(p) ? "JCP" : p.type.toLowerCase(Locale.ROOT));
        post(ctx, ("a" + p.id).hashCode(), provBuilder(ctx, title, text.toString()));
    }

    private static void notifyPaid(Context ctx, Holding h, Provent p) {
        NumberFormat brl = brl();
        double gross = h.qty * p.value;
        double net = isJcp(p) ? gross * 0.85 : gross;
        String title = "Caiu na conta: " + brl.format(net);
        String qty = h.qty % 1 == 0 ? String.valueOf((long) h.qty) : String.valueOf(h.qty);
        String text = p.type + " da " + h.ticker + " · " + qty + " ações × " + fmtUnit(p.value)
                + (isJcp(p) ? " (bruto " + brl.format(gross) + ", 15% de IR retido)" : "")
                + ". Valor estimado com a quantidade atual.";
        post(ctx, ("p" + p.id).hashCode(), provBuilder(ctx, title, text));
    }

    private static NotificationCompat.Builder provBuilder(Context ctx, String title, String text) {
        Intent launch = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        PendingIntent pi = PendingIntent.getActivity(ctx, 7, launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(ctx, CHANNEL_PROV)
                .setSmallIcon(R.drawable.ic_stat_news)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setColor(0xFF0A0A0A)
                .setAutoCancel(true)
                .setContentIntent(pi);
    }

    private static boolean isJcp(Provent p) { return "JCP".equals(p.type); }

    // ------------------------------------------------------------------ utilidades

    private static void createChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        NotificationChannel news = new NotificationChannel(CHANNEL_NEWS, "Notícias da carteira", NotificationManager.IMPORTANCE_DEFAULT);
        news.setDescription("Notícias novas sobre as ações da sua carteira");
        nm.createNotificationChannel(news);
        NotificationChannel prov = new NotificationChannel(CHANNEL_PROV, "Proventos", NotificationManager.IMPORTANCE_HIGH);
        prov.setDescription("Anúncios e pagamentos de dividendos e JCP");
        nm.createNotificationChannel(prov);
    }

    private static void post(Context ctx, int id, NotificationCompat.Builder b) {
        try {
            NotificationManagerCompat.from(ctx).notify(id, b.build());
        } catch (SecurityException ignored) {
            // permissão revogada entre a checagem e o envio
        }
    }

    private static HttpURLConnection open(String url) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(15000);
        conn.setRequestProperty("User-Agent", UA);
        return conn;
    }

    private static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        return out.toString("UTF-8");
    }

    private static long parseBR(String d) {
        try {
            SimpleDateFormat f = new SimpleDateFormat("dd/MM/yyyy", Locale.ROOT);
            f.setLenient(false);
            return startOfDay(f.parse(d).getTime());
        } catch (Exception e) {
            return 0;
        }
    }

    private static long startOfDay(long t) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(t);
        c.set(Calendar.HOUR_OF_DAY, 0); c.set(Calendar.MINUTE, 0); c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0);
        return c.getTimeInMillis();
    }

    private static NumberFormat brl() { return NumberFormat.getCurrencyInstance(new Locale("pt", "BR")); }

    private static String fmtUnit(double v) {
        NumberFormat f = brl();
        f.setMaximumFractionDigits(4);
        return f.format(v);
    }

    private static String fmtDate(long t) {
        return new SimpleDateFormat("dd/MM/yyyy", new Locale("pt", "BR")).format(t);
    }

    private static Set<String> loadSet(SharedPreferences prefs, String key) throws Exception {
        Set<String> set = new LinkedHashSet<>();
        JSONArray arr = new JSONArray(prefs.getString(key, "[]"));
        for (int i = 0; i < arr.length(); i++) set.add(arr.getString(i));
        return set;
    }

    private static void saveSet(SharedPreferences.Editor edit, String key, Set<String> set) {
        List<String> list = new ArrayList<>(set);
        int from = Math.max(0, list.size() - MAX_SEEN); // mantém só os mais recentes
        edit.putString(key, new JSONArray(list.subList(from, list.size())).toString());
    }
}
