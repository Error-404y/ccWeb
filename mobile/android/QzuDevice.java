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
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import android.content.SharedPreferences;
import org.json.JSONObject;
import org.json.JSONArray;
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

    private static final String ROOM_ALIAS = "cc.qzu.app.rooms.v1";
    private synchronized SecretKey vaultKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");store.load(null);
        if(!store.containsAlias(ROOM_ALIAS)){
            KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ROOM_ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());generator.generateKey();
        }
        return (SecretKey)store.getKey(ROOM_ALIAS,null);
    }
    @PluginMethod public synchronized void roomVault(PluginCall call){
        try{
            String action=call.getString("action",""),id=call.getString("room","");
            SharedPreferences prefs=getContext().getSharedPreferences("qzu_room_vault",0);
            if(action.equals("clear")){if(!prefs.edit().clear().commit())throw new Exception();call.resolve();return;}
            if(action.equals("prune")){JSONArray rooms=call.getArray("rooms");java.util.HashSet<String> keep=new java.util.HashSet<>();if(rooms!=null)for(int x=0;x<rooms.length();x++)keep.add(rooms.getString(x));SharedPreferences.Editor edit=prefs.edit();for(String k:prefs.getAll().keySet())if(!keep.contains(k))edit.remove(k);if(!edit.commit())throw new Exception();call.resolve();return;}
            if(!id.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))throw new Exception();
            if(action.equals("remove")){if(!prefs.edit().remove(id).commit())throw new Exception();call.resolve();return;}
            Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
            if(action.equals("save")){
                String value=call.getString("value");if(value==null||value.length()>8192)throw new Exception();long until=new JSONObject(value).getLong("until"),now=System.currentTimeMillis();if(until<=now||until>now+7200000L)throw new Exception();
                cipher.init(Cipher.ENCRYPT_MODE,vaultKey());cipher.updateAAD(id.getBytes(StandardCharsets.UTF_8));String packed=Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);
                if(!prefs.edit().putString(id,packed).commit())throw new Exception();call.resolve();return;
            }
            if(action.equals("load")){
                String packed=prefs.getString(id,null);if(packed==null){call.resolve();return;}
                String[] parts=packed.split(":",2);cipher.init(Cipher.DECRYPT_MODE,vaultKey(),new GCMParameterSpec(128,Base64.decode(parts[0],Base64.NO_WRAP)));cipher.updateAAD(id.getBytes(StandardCharsets.UTF_8));
                String value=new String(cipher.doFinal(Base64.decode(parts[1],Base64.NO_WRAP)),StandardCharsets.UTF_8);
                if(new JSONObject(value).getLong("until")<=System.currentTimeMillis()){prefs.edit().remove(id).commit();call.resolve();return;}JSObject result=new JSObject();result.put("value",value);call.resolve(result);return;
            }
            throw new Exception();
        }catch(Exception e){call.reject("Secure room storage unavailable.");}
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
