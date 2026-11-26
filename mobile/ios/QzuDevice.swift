import CryptoKit
import Security
import UIKit
import Capacitor

@objc(QzuDevice)
public class QzuDevice: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "QzuDevice"
    public let jsName = "QzuDevice"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "sign", returnType: CAPPluginReturnPromise)
    ]
    private let tag = Data("cc.qzu.app.device.v1".utf8)
    private let queue = DispatchQueue(label: "cc.qzu.device")

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
}

class QzuViewController: CAPBridgeViewController {
    private var privacyCover: UIView?

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(QzuDevice())
        print("[qzu] QzuDevice registered: \(bridge != nil)")
        NotificationCenter.default.addObserver(self, selector: #selector(cover), name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(uncover), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    @objc private func cover() {
        guard privacyCover == nil else { return }
        let panel = UIView(frame: view.bounds)
        panel.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        panel.backgroundColor = UIColor(red: 0.067, green: 0.082, blue: 0.078, alpha: 1)
        view.addSubview(panel)
        privacyCover = panel
    }

    @objc private func uncover() {
        privacyCover?.removeFromSuperview()
        privacyCover = nil
    }
}
