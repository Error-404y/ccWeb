package cc.qzu.app;

import android.content.Intent;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;

@CapacitorPlugin(name = "QzuDevice")
public class QzuDevice extends Plugin {
    private static final String ALIAS = "cc.qzu.app.device.v1";

    private synchronized KeyStore.Entry key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
            generator.initialize(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build());
            generator.generateKeyPair();
        }
        return store.getEntry(ALIAS, null);
    }

    private static void coordinate(BigInteger value, byte[] target, int offset) {
        byte[] source = value.toByteArray();
        int length = Math.min(32, source.length);
        System.arraycopy(source, source.length - length, target, offset + 32 - length, length);
    }

    @PluginMethod
    public void openUpdate(PluginCall call) {
        String raw = call.getString("url");
        Uri uri = raw == null ? null : Uri.parse(raw);
        if (uri == null || !"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null) {
            call.reject("Invalid update link.");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().startActivity(new Intent(Intent.ACTION_VIEW, uri));
                call.resolve();
            } catch (Exception error) {
                call.reject("Unable to open update link.");
            }
        });
    }

    @PluginMethod
    public void sign(PluginCall call) {
        String message = call.getString("message");
        if (message == null || message.getBytes(StandardCharsets.UTF_8).length > 4000000) {
            call.reject("Invalid device request.");
            return;
        }
        try {
            KeyStore.PrivateKeyEntry entry = (KeyStore.PrivateKeyEntry) key();
            ECPublicKey publicKey = (ECPublicKey) entry.getCertificate().getPublicKey();
            byte[] raw = new byte[65];
            raw[0] = 4;
            coordinate(publicKey.getW().getAffineX(), raw, 1);
            coordinate(publicKey.getW().getAffineY(), raw, 33);
            Signature signer = Signature.getInstance("SHA256withECDSA");
            signer.initSign(entry.getPrivateKey());
            signer.update(message.getBytes(StandardCharsets.UTF_8));
            JSObject result = new JSObject();
            result.put("publicKey", Base64.encodeToString(raw, Base64.NO_WRAP));
            result.put("signature", Base64.encodeToString(signer.sign(), Base64.NO_WRAP));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Secure device key unavailable.");
        }
    }
}
