//
//  FoliaLoginBridge.swift
//  Folia iOS 容器自带的登录桥（Capacitor 本地插件，编进 App target，不经 npm 插件包分发）。
//
//  为什么需要它：各平台网页登录成功后，登录凭据是写在 HttpOnly cookie 里的（网易云 MUSIC_U、QQ 音乐
//  qm_keyst、酷狗 KuGoo/token）。WKWebView 里 document.cookie 读不到 HttpOnly，fetch 也带不走，
//  只有原生 WKWebsiteDataStore.default().httpCookieStore 能读到全量 cookie。所以这里开一个全屏
//  WKWebView 让用户在平台官方页面上登录，登录完成后由原生把该域名的全部 cookie 交给 Web 层。
//
//  暴露给 Web 的方法（window.Capacitor.Plugins.FoliaLoginBridge）：
//    openLoginPage({ url, domain, loginCookieNames, userAgent, title })
//    readCookies({ domain })        -> { cookieHeader, cookies, names }
//    peekLoginCookie({ domain, loginCookieNames }) -> { found, names }
//    clearCookies({ domain })       -> { removed }
//    closeLoginPage()
//  另有两个事件：loginCookieFound（轮询到登录 cookie 出现）、loginPageClosed（页面被用户收起）。
//

import Foundation
import UIKit
import WebKit
import Capacitor

@objc(FoliaLoginBridge)
public class FoliaLoginBridge: CAPPlugin, CAPBridgedPlugin, WKNavigationDelegate, WKUIDelegate {

    public let identifier = "FoliaLoginBridge"
    public let jsName = "FoliaLoginBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openLoginPage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readCookies", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "peekLoginCookie", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearCookies", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeLoginPage", returnType: CAPPluginReturnPromise),
    ]

    // 桌面 UA：三个平台的登录页在桌面 UA 下才给完整的账号密码 / 扫码面板，
    // 手机 UA 会跳到「打开 App」的下载页，网页登录在 App 里就没法用。
    private static let desktopUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"

    private var hostController: UIViewController?
    private var webView: WKWebView?
    private var pollTimer: Timer?
    private var pollDomain: String = ""
    private var pollCookieNames: [String] = []
    private var announcedCookieNames: Set<String> = []
    private var titleLabel: UILabel?
    private var addressLabel: UILabel?
    private var doneButton: UIButton?
    private var doneReady = false
    private var progressView: UIProgressView?
    private var progressObservation: NSKeyValueObservation?

    // MARK: - 生命周期

    public override func load() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleBridgeWillDeallocate),
            name: NSNotification.Name("CAPBridgeWillDeallocate"),
            object: nil
        )
    }

    @objc private func handleBridgeWillDeallocate() {
        DispatchQueue.main.async { [weak self] in self?.tearDown(silent: true) }
    }

    // MARK: - openLoginPage

    @objc func openLoginPage(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("openLoginPage: url is missing")
            return
        }
        let domain = (call.getString("domain") ?? url.host ?? "").lowercased()
        let names = call.getArray("loginCookieNames", String.self) ?? []
        let title = call.getString("title") ?? url.host ?? "登录"
        let userAgent = call.getString("userAgent") ?? FoliaLoginBridge.desktopUserAgent

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard let presenter = self.bridge?.viewController else {
                call.reject("openLoginPage: no view controller to present from")
                return
            }
            // 已经在登录页里了：把新的地址直接载进同一个页面，不再叠一层。
            if let webView = self.webView {
                self.titleLabel?.text = title
                webView.customUserAgent = userAgent
                webView.load(URLRequest(url: url))
                self.startPolling(domain: domain, names: names)
                call.resolve(["opened": true, "reused": true])
                return
            }

            let configuration = WKWebViewConfiguration()
            // 用 App 自己持久的 cookie 库：网页登录拿到的 cookie 和之后 App 里的请求是同一份。
            configuration.websiteDataStore = WKWebsiteDataStore.default()
            configuration.defaultWebpagePreferences.allowsContentJavaScript = true
            let webView = WKWebView(frame: .zero, configuration: configuration)
            webView.customUserAgent = userAgent
            webView.navigationDelegate = self
            webView.uiDelegate = self
            webView.allowsBackForwardNavigationGestures = true
            self.webView = webView

            let controller = self.makeLoginController(title: title, webView: webView)
            controller.modalPresentationStyle = .fullScreen
            self.hostController = controller
            presenter.present(controller, animated: true) {
                webView.load(URLRequest(url: url))
            }
            self.startPolling(domain: domain, names: names)
            call.resolve(["opened": true, "reused": false])
        }
    }

    // MARK: - readCookies

    @objc func readCookies(_ call: CAPPluginCall) {
        let domain = (call.getString("domain") ?? "").lowercased()
        readStoreCookies(domain: domain) { cookies in
            let header = cookies
                .map { "\($0["name"] as? String ?? "")=\($0["value"] as? String ?? "")" }
                .joined(separator: "; ")
            let names = cookies.compactMap { $0["name"] as? String }
            call.resolve([
                "domain": domain,
                "cookieHeader": header,
                "cookies": cookies,
                "names": names,
            ])
        }
    }

    // MARK: - peekLoginCookie

    @objc func peekLoginCookie(_ call: CAPPluginCall) {
        let domain = (call.getString("domain") ?? "").lowercased()
        let wanted = call.getArray("loginCookieNames", String.self) ?? []
        readStoreCookies(domain: domain) { cookies in
            let names = Set(cookies.compactMap { $0["name"] as? String })
            let found = wanted.filter { name in
                guard names.contains(name) else { return false }
                let value = cookies.first { ($0["name"] as? String) == name }?["value"] as? String ?? ""
                return !value.isEmpty
            }
            call.resolve(["found": !found.isEmpty, "names": found])
        }
    }

    // MARK: - clearCookies

    @objc func clearCookies(_ call: CAPPluginCall) {
        let domain = (call.getString("domain") ?? "").lowercased()
        let store = WKWebsiteDataStore.default().httpCookieStore
        store.getAllCookies { cookies in
            let matched = cookies.filter { domain.isEmpty || $0.domain.lowercased().contains(domain) }
            let group = DispatchGroup()
            matched.forEach { cookie in
                group.enter()
                store.delete(cookie) { group.leave() }
            }
            group.notify(queue: .main) {
                call.resolve(["removed": matched.count])
            }
        }
    }

    // MARK: - closeLoginPage

    @objc func closeLoginPage(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.tearDown(silent: false)
            call.resolve(["closed": true])
        }
    }

    // MARK: - 页面

    private func makeLoginController(title: String, webView: WKWebView) -> UIViewController {
        let controller = UIViewController()
        controller.view.backgroundColor = UIColor(red: 0.035, green: 0.035, blue: 0.043, alpha: 1)

        let bar = UIView()
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.backgroundColor = UIColor(red: 0.07, green: 0.07, blue: 0.086, alpha: 1)
        controller.view.addSubview(bar)

        let titleLabel = UILabel()
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.text = title
        titleLabel.textColor = .white
        titleLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        titleLabel.textAlignment = .center
        titleLabel.lineBreakMode = .byTruncatingTail
        bar.addSubview(titleLabel)
        self.titleLabel = titleLabel

        let addressLabel = UILabel()
        addressLabel.translatesAutoresizingMaskIntoConstraints = false
        addressLabel.textColor = UIColor(white: 1, alpha: 0.45)
        addressLabel.font = .systemFont(ofSize: 11)
        addressLabel.textAlignment = .center
        addressLabel.lineBreakMode = .byTruncatingMiddle
        bar.addSubview(addressLabel)
        self.addressLabel = addressLabel

        let closeButton = UIButton(type: .system)
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.setTitle("取消", for: .normal)
        closeButton.titleLabel?.font = .systemFont(ofSize: 15)
        closeButton.addTarget(self, action: #selector(onCancelTapped), for: .touchUpInside)
        bar.addSubview(closeButton)

        let doneButton = UIButton(type: .system)
        doneButton.translatesAutoresizingMaskIntoConstraints = false
        doneButton.setTitle("完成登录", for: .normal)
        doneButton.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
        doneButton.addTarget(self, action: #selector(onDoneTapped), for: .touchUpInside)
        self.doneButton = doneButton
        bar.addSubview(doneButton)

        webView.translatesAutoresizingMaskIntoConstraints = false
        controller.view.addSubview(webView)

        let progress = UIProgressView(progressViewStyle: .bar)
        progress.translatesAutoresizingMaskIntoConstraints = false
        progress.progressTintColor = UIColor(red: 0.93, green: 0.29, blue: 0.34, alpha: 1)
        progress.trackTintColor = .clear
        controller.view.addSubview(progress)
        self.progressView = progress

        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.topAnchor),
            bar.leadingAnchor.constraint(equalTo: controller.view.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: controller.view.trailingAnchor),
            bar.heightAnchor.constraint(equalToConstant: 52),

            closeButton.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 12),
            closeButton.centerYAnchor.constraint(equalTo: bar.centerYAnchor),

            doneButton.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -12),
            doneButton.centerYAnchor.constraint(equalTo: bar.centerYAnchor),

            titleLabel.centerXAnchor.constraint(equalTo: bar.centerXAnchor),
            titleLabel.topAnchor.constraint(equalTo: bar.topAnchor, constant: 9),
            titleLabel.leadingAnchor.constraint(equalTo: closeButton.trailingAnchor, constant: 8),
            titleLabel.trailingAnchor.constraint(equalTo: doneButton.leadingAnchor, constant: -8),

            addressLabel.centerXAnchor.constraint(equalTo: bar.centerXAnchor),
            addressLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 2),
            addressLabel.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 76),
            addressLabel.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -76),

            progress.topAnchor.constraint(equalTo: bar.bottomAnchor),
            progress.leadingAnchor.constraint(equalTo: controller.view.leadingAnchor),
            progress.trailingAnchor.constraint(equalTo: controller.view.trailingAnchor),
            progress.heightAnchor.constraint(equalToConstant: 2),

            webView.topAnchor.constraint(equalTo: progress.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: controller.view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: controller.view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: controller.view.bottomAnchor),
        ])
        return controller
    }

    @objc private func onCancelTapped() {
        // 取消：什么都没登录，Web 层据此说「已关闭网页」，而不是去读一份没变的 cookie。
        tearDown(silent: false, reason: "cancel")
    }

    @objc private func onDoneTapped() {
        // 「完成登录」只把网页收起：cookie 由 Web 层紧接着 readCookies 取走，
        // 页面收起后数据仍在 App 的 cookie 库里，取不取得到与页面是否开着无关。
        tearDown(silent: false, reason: "done")
    }

    /// 轮询到登录 cookie 之后把「完成登录」点亮：用的人不用猜该不该点。
    private func markDoneReady() {
        doneReady = true
        doneButton?.setTitle("完成登录 ✓", for: .normal)
        doneButton?.tintColor = UIColor(red: 0.93, green: 0.29, blue: 0.34, alpha: 1)
        titleLabel?.textColor = .white
        addressLabel?.text = "已获取登录凭据，点「完成登录」"
        addressLabel?.textColor = UIColor(red: 0.93, green: 0.29, blue: 0.34, alpha: 1)
    }

    private func resetDoneReady() {
        doneReady = false
        doneButton?.setTitle("完成登录", for: .normal)
        doneButton?.tintColor = nil
        addressLabel?.textColor = UIColor(white: 1, alpha: 0.45)
    }

    private func tearDown(silent: Bool, reason: String = "other") {
        pollTimer?.invalidate()
        pollTimer = nil
        let controller = hostController
        hostController = nil
        let hadPage = controller != nil || webView != nil
        webView?.navigationDelegate = nil
        webView?.uiDelegate = nil
        if controller != nil {
            controller?.dismiss(animated: true) { [weak self] in
                self?.webView?.stopLoading()
                self?.webView = nil
                self?.doneButton = nil
                self?.doneReady = false
                if hadPage && !silent {
                    self?.notifyListeners("loginPageClosed", data: ["reason": reason])
                }
            }
        } else {
            webView = nil
            doneButton = nil
            doneReady = false
            if hadPage && !silent {
                notifyListeners("loginPageClosed", data: ["reason": reason])
            }
        }
    }

    // MARK: - cookie

    private func readStoreCookies(domain: String, completion: @escaping ([[String: Any]]) -> Void) {
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
            let matched = cookies.filter { cookie in
                if domain.isEmpty { return true }
                let cookieDomain = cookie.domain.lowercased()
                return cookieDomain.contains(domain) || domain.contains(cookieDomain.trimmingCharacters(in: CharacterSet(charactersIn: ".")))
            }
            let result: [[String: Any]] = matched.map { cookie in
                var entry: [String: Any] = [
                    "name": cookie.name,
                    "value": cookie.value,
                    "domain": cookie.domain,
                    "path": cookie.path,
                    "httpOnly": cookie.isHTTPOnly,
                    "secure": cookie.isSecure,
                    "sessionOnly": cookie.isSessionOnly,
                ]
                if let expires = cookie.expiresDate {
                    entry["expires"] = Int(expires.timeIntervalSince1970 * 1000)
                }
                return entry
            }
            DispatchQueue.main.async { completion(result) }
        }
    }

    private func startPolling(domain: String, names: [String]) {
        pollTimer?.invalidate()
        pollDomain = domain
        pollCookieNames = names
        announcedCookieNames = []
        resetDoneReady()
        guard !names.isEmpty else { return }
        let timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            self?.pollOnce()
        }
        pollTimer = timer
    }

    private func pollOnce() {
        let domain = pollDomain
        let wanted = pollCookieNames
        guard !wanted.isEmpty else { return }
        readStoreCookies(domain: domain) { [weak self] cookies in
            guard let self = self else { return }
            let named = cookies.filter { cookie in
                guard let name = cookie["name"] as? String, wanted.contains(name) else { return false }
                let value = cookie["value"] as? String ?? ""
                return !value.isEmpty
            }
            let foundNames = Set(named.compactMap { $0["name"] as? String })
            let fresh = foundNames.subtracting(self.announcedCookieNames)
            guard !fresh.isEmpty else { return }
            self.announcedCookieNames.formUnion(fresh)
            self.markDoneReady()
            self.notifyListeners("loginCookieFound", data: [
                "domain": domain,
                "names": Array(foundNames),
                "newNames": Array(fresh),
            ])
        }
    }

    // MARK: - WKNavigationDelegate

    public func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        progressView?.isHidden = false
        progressObservation = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] webView, _ in
            self?.progressView?.setProgress(Float(webView.estimatedProgress), animated: true)
        }
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        progressView?.setProgress(1, animated: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.progressObservation = nil
            self?.progressView?.isHidden = true
        }
        addressLabel?.text = webView.url?.host
        if doneReady { markDoneReady() }
        if let title = webView.title, !title.isEmpty {
            notifyListeners("loginPageTitle", data: ["title": title, "url": webView.url?.absoluteString ?? ""])
        }
        // 页面自己可能刚把登录 cookie 写好（同域 SPA 跳转不会走完 loading），这里顺手看一眼。
        pollOnce()
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        progressView?.isHidden = true
        notifyListeners("loginPageError", data: ["message": error.localizedDescription])
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        progressView?.isHidden = true
        notifyListeners("loginPageError", data: ["message": error.localizedDescription])
    }

    // 微信扫码登录会开新窗口：在这个页面里接着加载，不另开窗口（App 里没有多窗口）。
    public func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            webView.load(URLRequest(url: url))
        }
        return nil
    }
}
