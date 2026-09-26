package app.bramble.mobile

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.TimeUnit
import okhttp3.CookieJar
import okhttp3.Headers.Companion.toHeaders
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Outbound HTTP for hosts the WebView cannot reach.
 *
 * The WebView's origin is `https://localhost`, which an API that sends no CORS headers grants
 * nothing, so requests to those hosts leave from here instead. The JS name matches iOS's
 * `NativeHttp` so one shared adapter drives both. See @core/adapters/http.
 *
 * Two rules, and both need saying because the obvious implementations break them:
 *
 * **No ambient cookies.** `HttpURLConnection` is not usable here. It obeys the process-global
 * `CookieHandler.getDefault()`, and Capacitor's Bridge registers `CapacitorCookies` as a built-in
 * (Bridge.java) whose `load()` calls `CookieHandler.setDefault(...)` with `ACCEPT_ALL`, wiring the
 * WebView's cookie jar into every `java.net` client in this process. That happens whether or not
 * `CapacitorCookies` is enabled in config: the `enabled` flag only gates the JS-side shim. There
 * is no per-connection opt-out, which is why this uses OkHttp and states `CookieJar.NO_COOKIES`
 * on its own client. An ambient session outranking an Authorization header has already cost this
 * repo a day once (1255ab7b).
 *
 * **No redirects.** A redirect out of an API call means the session was rejected and the
 * destination is an HTML login page. The 3xx is returned as itself so the caller can say "bad
 * key" instead of failing opaquely on the login page.
 */
@CapacitorPlugin(name = "NativeHttp")
class NativeHttpPlugin : Plugin() {
    /**
     * One client for the plugin, so the connection pool is reused across calls.
     *
     * Capacitor runs `@PluginMethod` off the main thread, so a blocking call here is safe and
     * cannot ANR. (iOS is the opposite: there every plugin call in the app shares one serial
     * queue, so its half of this plugin must not block.)
     */
    private val client = OkHttpClient.Builder()
        .cookieJar(CookieJar.NO_COOKIES)
        .followRedirects(false)
        .followSslRedirects(false)
        // Idle vs total, as on iOS. Read/write are per-operation idle limits and default to 10s,
        // which a single blocked write on a poor uplink can exceed; the total matches the
        // desktop's 600s upload budget, where 60s failed large vaults on slow uplinks.
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .callTimeout(600, TimeUnit.SECONDS)
        .build()

    @PluginMethod
    fun send(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("Missing url")
        val method = call.getString("method") ?: "GET"

        val headers = mutableMapOf<String, String>()
        call.getObject("headers")?.let { obj ->
            for (key in obj.keys()) obj.getString(key)?.let { headers[key] = it }
        }

        // Bodies cross as base64, as the crypto plugin's bytes do: the bridge is JSON, and a
        // JSON string cannot carry arbitrary bytes.
        val body = call.getString("body")?.let { Base64.decode(it, Base64.NO_WRAP) }

        try {
            // OkHttp refuses a body on GET/HEAD and insists on one for POST/PUT/PATCH, so absence
            // has to mean "empty" everywhere else. Phrased as "which methods take no body" rather
            // than listing the ones that need one, so WebDAV's verbs (PROPFIND, MKCOL, REPORT)
            // work when backups start using this in turn.
            val requestBody = when {
                method in BODYLESS_METHODS -> null
                else -> (body ?: ByteArray(0))
                    .toRequestBody(headers["Content-Type"]?.toMediaTypeOrNull())
            }
            val request = Request.Builder()
                .url(url)
                .method(method, requestBody)
                .headers(headers.toHeaders())
                .build()

            client.newCall(request).execute().use { res ->
                val bytes = res.body?.bytes() ?: ByteArray(0)
                call.resolve(
                    JSObject()
                        .put("status", res.code)
                        .put("body", Base64.encodeToString(bytes, Base64.NO_WRAP))
                )
            }
        } catch (e: Throwable) {
            // Offline, DNS, TLS, timeout. All of them mean the same thing to the caller: the host
            // was not reached, so nothing happened on the other end.
            call.reject(e.message ?: e.toString())
        }
    }

    private companion object {
        val BODYLESS_METHODS = setOf("GET", "HEAD")
    }
}
