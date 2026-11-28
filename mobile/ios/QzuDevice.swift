import CryptoKit
import Security
import UIKit
import UserNotifications
import WebKit
import Capacitor

@objc(QzuDevice)
public class QzuDevice: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "QzuDevice"
    public let jsName = "QzuDevice"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "sign", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openUpdate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "roomVault", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBadge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "testLocalNotification", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "haptic", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deviceInfo", returnType: CAPPluginReturnPromise)
    ]
    private let tag = Data("cc.qzu.app.device.v1".utf8)
    private let queue = DispatchQueue(label: "cc.qzu.device")

    @objc func deviceInfo(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            #if targetEnvironment(simulator)
            let model = "iOS Simulator"
            #else
            var info = utsname()
            uname(&info)
            let model = withUnsafeBytes(of: info.machine) { bytes in
                String(bytes: bytes.prefix { $0 != 0 }, encoding: .utf8)
            } ?? UIDevice.current.model
            #endif
            call.resolve([
                "model": model,
                "osVersion": UIDevice.current.systemVersion
            ])
        }
    }

    private func signingKey() throws -> SecKey {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: tag,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: true
        ]
        var found: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &found)
        if status == errSecSuccess, let found = found {
            return found as! SecKey
        }
        guard status == errSecItemNotFound else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage], &error) else {
            throw NSError(domain: "qzu.device", code: 1)
        }
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: tag,
                kSecAttrAccessControl as String: access
            ]
        ]
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
            throw NSError(domain: "qzu.device", code: 2)
        }
        return key
    }

    @objc func sign(_ call: CAPPluginCall) {
        guard let message = call.getString("message"), let data = message.data(using: .utf8), data.count <= 4_000_000 else {
            call.reject("Invalid device request.")
            return
        }
        queue.async {
            do {
                let key = try self.signingKey()
                var error: Unmanaged<CFError>?
                guard let publicKey = SecKeyCopyPublicKey(key),
                      let raw = SecKeyCopyExternalRepresentation(publicKey, &error),
                      let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, data as CFData, &error) else {
                    throw NSError(domain: "qzu.device", code: 3)
                }
                call.resolve(["publicKey": (raw as Data).base64EncodedString(), "signature": (signature as Data).base64EncodedString()])
            } catch {
                print("[qzu] Secure device key failure: \((error as NSError).domain) \((error as NSError).code)")
                call.reject("Secure device key unavailable. Use a physical iPhone.")
            }
        }
    }
    @objc func openUpdate(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw), url.scheme == "https",
              url.host != nil, url.user == nil, url.password == nil else {
            call.reject("Invalid update link.")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { success in
                if success { call.resolve() } else { call.reject("Unable to open update link.") }
            }
        }
    }

    @objc func roomVault(_ call: CAPPluginCall) {
        let action = call.getString("action") ?? "", room = call.getString("room") ?? ""
        guard action == "clear" || action == "prune" || action == "sweep" || UUID(uuidString: room) != nil else { call.reject("Invalid room."); return }
        queue.async {
            var query: [String: Any] = [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:(call.getString("vault") == "prekeys" ? "cc.qzu.app.prekeys.v1" : "cc.qzu.app.rooms.v1")]
            if action != "clear" && action != "prune" && action != "sweep" { query[kSecAttrAccount as String] = room }
            switch action {
            case "save":
                guard let value = call.getString("value"), let data = value.data(using:.utf8), data.count <= 8192,
                      let object = (try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
                      let until = object["until"] as? Double, until > Date().timeIntervalSince1970*1000, until < Date().timeIntervalSince1970*1000+691200000 else { call.reject("Invalid key."); return }
                var attrs = query; attrs[kSecValueData as String] = data; attrs[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
                let status = SecItemAdd(attrs as CFDictionary,nil)
                let result = status == errSecDuplicateItem ? SecItemUpdate(query as CFDictionary,[kSecValueData as String:data] as CFDictionary) : status
                if result == errSecSuccess { call.resolve() } else { call.reject("Secure storage unavailable.") }
            case "load":
                var find = query;find[kSecReturnData as String] = true;find[kSecMatchLimit as String] = kSecMatchLimitOne
                var result: CFTypeRef?;let status = SecItemCopyMatching(find as CFDictionary,&result)
                if status == errSecItemNotFound { call.resolve();return }
                guard status == errSecSuccess, let data = result as? Data, let object = (try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let until = object["until"] as? Double else { call.reject("Secure storage unavailable.");return }
                if until <= Date().timeIntervalSince1970*1000 { SecItemDelete(query as CFDictionary);call.resolve();return }
                call.resolve(["value":String(decoding:data,as:UTF8.self)])
            case "remove","clear":
                let status = SecItemDelete(query as CFDictionary)
                if status == errSecSuccess || status == errSecItemNotFound { call.resolve() } else { call.reject("Secure storage unavailable.") }
            case "sweep":
                var find = query;find[kSecReturnAttributes as String] = true;find[kSecReturnData as String] = true;find[kSecMatchLimit as String] = kSecMatchLimitAll
                var result: CFTypeRef?;let status = SecItemCopyMatching(find as CFDictionary,&result)
                if status == errSecSuccess, let items = result as? [[String:Any]] {
                    for item in items {
                        guard let id = item[kSecAttrAccount as String] as? String,let data = item[kSecValueData as String] as? Data,
                              let object = (try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let until = object["until"] as? Double,until <= Date().timeIntervalSince1970*1000 else { continue }
                        var remove = query;remove[kSecAttrAccount as String] = id;SecItemDelete(remove as CFDictionary)
                    }
                }
                call.resolve()
            case "prune":
                let keep = Set(call.getArray("rooms",String.self) ?? [])
                var find = query;find[kSecReturnAttributes as String] = true;find[kSecMatchLimit as String] = kSecMatchLimitAll
                var result: CFTypeRef?;let status = SecItemCopyMatching(find as CFDictionary,&result)
                if status == errSecSuccess, let items = result as? [[String:Any]] { for item in items { if let id = item[kSecAttrAccount as String] as? String, !keep.contains(id) { var remove = query;remove[kSecAttrAccount as String] = id;SecItemDelete(remove as CFDictionary) } } }
                call.resolve()
            default: call.reject("Invalid vault action.")
            }
        }
    }
    @objc func setBadge(_ call: CAPPluginCall) {
        let count = max(0,min(999,call.getInt("count") ?? 0))
        let center = UNUserNotificationCenter.current()
        if call.getBool("requestPermission") == true {
            center.requestAuthorization(options:[.badge,.alert,.sound]) { granted,error in
                if let error = error { call.reject(error.localizedDescription);return }
                if granted { DispatchQueue.main.async { UIApplication.shared.applicationIconBadgeNumber = count } }
                call.resolve(["granted":granted])
            }
        } else {
            center.getNotificationSettings { settings in
                let granted = settings.badgeSetting == .enabled
                if granted { DispatchQueue.main.async { UIApplication.shared.applicationIconBadgeNumber = count } }
                call.resolve(["granted":granted])
            }
        }
    }

    @objc func testLocalNotification(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.bridge?.notificationRouter.localNotificationHandler = self.localNotificationHandler }
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { call.reject("Enable notification permissions in iPhone Settings first.");return }
            let content = UNMutableNotificationContent();content.title = "qzu.";content.body = "Notification test";content.sound = .default
            let identifier = "qzu-test-" + UUID().uuidString
            let request = UNNotificationRequest(identifier:identifier,content:content,trigger:UNTimeIntervalNotificationTrigger(timeInterval:5,repeats:false))
            center.add(request) { error in
                if let error = error { call.reject(error.localizedDescription);return }
                center.getPendingNotificationRequests { pending in
                    let scheduled = pending.contains { $0.identifier == identifier }
                    if !scheduled { call.reject("iOS did not confirm the pending notification.");return }
                    call.resolve(["scheduled":true,"seconds":5,"alerts":settings.alertSetting == .enabled,"sounds":settings.soundSetting == .enabled,"badges":settings.badgeSetting == .enabled])
                }
            }
        }
    }

    @objc func haptic(_ call: CAPPluginCall) {
        DispatchQueue.main.async { UIImpactFeedbackGenerator(style:.light).impactOccurred();call.resolve() }
    }
    private let localNotificationHandler = QzuLocalNotificationHandler()
    private var privacyCover: UIView?

    public override func load() {
        super.load()
        bridge?.notificationRouter.localNotificationHandler = localNotificationHandler
        if let scrollView = bridge?.webView?.scrollView {
            scrollView.bounces = false
            scrollView.alwaysBounceVertical = false
            scrollView.alwaysBounceHorizontal = false
            scrollView.showsHorizontalScrollIndicator = false
        }
        print("[qzu] QzuDevice loaded")
        NotificationCenter.default.addObserver(self, selector: #selector(cover), name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(uncover), name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(captureChanged), name: UIScreen.capturedDidChangeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(screenshotTaken), name: UIApplication.userDidTakeScreenshotNotification, object: nil)
        DispatchQueue.main.async { self.captureChanged() }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func cover() {
        guard privacyCover == nil, let view = bridge?.viewController?.view else { return }
        let panel = UIView(frame: view.bounds)
        panel.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        panel.backgroundColor = UIColor(red: 0.067, green: 0.082, blue: 0.078, alpha: 1)
        panel.accessibilityViewIsModal = true
        let brand = UILabel()
        brand.text = "qzu."
        brand.textColor = .white
        brand.font = .systemFont(ofSize: 38, weight: .bold)
        brand.translatesAutoresizingMaskIntoConstraints = false
        panel.addSubview(brand)
        NSLayoutConstraint.activate([
            brand.centerXAnchor.constraint(equalTo: panel.centerXAnchor),
            brand.centerYAnchor.constraint(equalTo: panel.centerYAnchor)
        ])
        view.addSubview(panel)
        privacyCover = panel
    }

    @objc private func captureChanged() {
        if UIScreen.main.isCaptured {
            cover()
            notifyListeners("screenCaptured", data: [:])
        } else { uncover() }
    }

    @objc private func screenshotTaken() {
        notifyListeners("screenCaptured", data: [:])
    }

    @objc private func uncover() {
        guard !UIScreen.main.isCaptured, UIApplication.shared.applicationState == .active else { return }
        privacyCover?.removeFromSuperview()
        privacyCover = nil
    }
}

private final class QzuLocalNotificationHandler: NSObject, NotificationHandlerProtocol {
    func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions {
        return [.banner, .list, .sound, .badge]
    }
    func didReceive(response: UNNotificationResponse) {}
}

class QzuViewController: CAPBridgeViewController {
    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        configuration.ignoresViewportScaleLimits = false
        return configuration
    }
}
