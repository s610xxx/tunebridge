package com.tunebridge.provider.netease;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.IllegalBlockSizeException;
import javax.crypto.NoSuchPaddingException;
import javax.crypto.spec.SecretKeySpec;

/**
 * 网易云 eapi 通道：请求发往 /eapi/...，但签名里用的是对应的 /api/... 路径。
 * 实测两端点必须这样配对，否则返回“接口未找到”。
 */
public final class NeteaseEapi {
    private static final SecretKeySpec AES_KEY =
            new SecretKeySpec("e82ckenh8dichen8".getBytes(StandardCharsets.US_ASCII), "AES");
    private static final String SEPARATOR = "36cd479b6b5";
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String DEVICE_ID = java.util.UUID.randomUUID().toString().replace("-", "");

    private NeteaseEapi() {
    }

    /** 官方网页端会随参数一起提交这组客户端标识，缺失会被判为参数错误。 */
    public static Map<String, Object> params() {
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("os", "pc");
        params.put("appver", "9.2.0");
        params.put("versioncode", "150");
        params.put("mobilename", "chrome");
        params.put("buildver", String.valueOf(System.currentTimeMillis() / 1000L));
        params.put("channelId", "desktop");
        params.put("deviceId", DEVICE_ID);
        params.put("csrf_token", "");
        return params;
    }

    public static String formBody(String apiPath, Map<String, Object> params) {
        return "params=" + sign(apiPath, toJson(params));
    }

    public static String sign(String apiPath, String paramsJson) {
        String digest = md5("nobody" + apiPath + "use" + paramsJson + "md5forencrypt");
        String payload = apiPath + "-" + SEPARATOR + "-" + paramsJson + "-" + SEPARATOR + "-" + digest;
        return hex(encrypt(payload));
    }

    private static String toJson(Map<String, Object> params) {
        try {
            return MAPPER.writeValueAsString(params);
        } catch (JsonProcessingException ex) {
            throw new IllegalArgumentException("网易云请求参数无法序列化", ex);
        }
    }

    private static String md5(String value) {
        try {
            return hex(MessageDigest.getInstance("MD5").digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException(ex);
        }
    }

    private static byte[] encrypt(String payload) {
        try {
            Cipher cipher = Cipher.getInstance("AES/ECB/PKCS5Padding");
            cipher.init(Cipher.ENCRYPT_MODE, AES_KEY);
            return cipher.doFinal(payload.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException | NoSuchPaddingException | IllegalBlockSizeException
                | javax.crypto.BadPaddingException | java.security.InvalidKeyException ex) {
            throw new IllegalStateException("网易云 eapi 加密不可用", ex);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder text = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            text.append(Character.toUpperCase(Character.forDigit((b >> 4) & 0xF, 16)));
            text.append(Character.toUpperCase(Character.forDigit(b & 0xF, 16)));
        }
        return text.toString();
    }
}
