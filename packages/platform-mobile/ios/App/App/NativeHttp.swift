import Capacitor
import Foundation

/**
 * Outbound HTTP for hosts the WKWebView cannot reach.
 *
 * The WebView's origin is `capacitor://localhost`, which an API that sends no CORS headers grants
 * nothing, so requests to those hosts leave from here instead. The `jsName` matches Android's
 * plugin so one shared adapter drives both. See @core/adapters/http.
 *
 * Two rules, and `CapacitorHttp` keeps neither, which is why this exists rather than using it:
 * its `HttpRequestHandler` calls `setCookiesFromResponse` on every reply, parsing the host's
 * `Set-Cookie` into the Capacitor cookie manager and syncing it into the WebView, and outbound
 * the `URLRequest` default of `httpShouldHandleCookies = true` attaches whatever is in shared
 * storage. An ambient session outranking an Authorization header has already cost this repo a
 * day once (1255ab7b).
 *
 * So: an ephemeral session that accepts no cookies and a delegate that refuses redirects. A
 * redirect out of an API call means the session was rejected and the destination is an HTML
 * login page, so the 3xx is returned as itself and the caller can say "bad key" rather than
 * failing opaquely somewhere else.
 */
@objc(NativeHttpPlugin)
public class NativeHttpPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeHttpPlugin"
    public let jsName = "NativeHttp"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise)
    ]

    /// Answers every redirect with "do not follow", which surfaces the 3xx as the response.
    private class RefuseRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest,
            completionHandler: @escaping (URLRequest?) -> Void
        ) {
            completionHandler(nil)
        }
    }

    private let redirectDelegate = RefuseRedirects()

    /// One session for the plugin, so connections are reused and the delegate is retained once.
    /// Cookies are refused four ways because each one alone has been enough to miss: no storage,
    /// no accept policy, no set, and `httpShouldHandleCookies = false` per request below.
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        // Idle vs total: a stalled request dies in 60s, a slow upload still moving gets 600s,
        // the desktop's upload budget. A 60s total failed large vaults on slow uplinks.
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 600
        return URLSession(configuration: config, delegate: redirectDelegate, delegateQueue: nil)
    }()

    @objc func send(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw) else {
            call.reject("Missing or unparseable url")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = call.getString("method") ?? "GET"
        request.httpShouldHandleCookies = false
        if let headers = call.getObject("headers") {
            for (name, value) in headers {
                if let value = value as? String {
                    request.setValue(value, forHTTPHeaderField: name)
                }
            }
        }
        // Bodies cross as base64, as the crypto plugin's bytes do: the bridge is JSON, and a JSON
        // string cannot carry arbitrary bytes.
        if let encoded = call.getString("body") {
            guard let body = Data(base64Encoded: encoded) else {
                call.reject("Request body was not valid base64")
                return
            }
            request.httpBody = body
        }

        // Resolved from the completion handler, never waited on. The bridge dispatches EVERY
        // plugin call in the app on one serial queue, so blocking here would stall every other
        // plugin for the length of a network request. See BiometricVault's keychainQueue.
        session.dataTask(with: request) { data, response, error in
            if let error = error {
                // Offline, DNS, TLS, timeout. All mean the host was not reached, so nothing
                // happened on the other end.
                call.reject(error.localizedDescription)
                return
            }
            guard let http = response as? HTTPURLResponse else {
                call.reject("The host did not answer with an HTTP response")
                return
            }
            call.resolve([
                "status": http.statusCode,
                "body": (data ?? Data()).base64EncodedString()
            ])
        }.resume()
    }
}
