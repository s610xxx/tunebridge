package com.tunebridge.provider.apple;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tunebridge.config.TuneBridgeProperties;
import com.tunebridge.provider.ProviderException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.time.Instant;
import java.util.Base64;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

@Component
public class AppleDeveloperTokenService {

    private static final Logger log = LoggerFactory.getLogger(AppleDeveloperTokenService.class);
    private static final long TOKEN_TTL_SECONDS = 3600;
    private static final long REFRESH_SKEW_SECONDS = 300;

    private final TuneBridgeProperties properties;
    private final ObjectMapper objectMapper;

    private String cachedToken = "";
    private long cachedUntil;

    public AppleDeveloperTokenService(TuneBridgeProperties properties, ObjectMapper objectMapper) {
        this.properties = properties;
        this.objectMapper = objectMapper;
    }

    public boolean configured() {
        TuneBridgeProperties.Apple apple = properties.getApple();
        boolean staticToken = apple.getDeveloperToken() != null && !apple.getDeveloperToken().isBlank();
        boolean keyPair = !apple.getTeamId().isBlank()
                && !apple.getKeyId().isBlank()
                && !apple.getPrivateKeyPath().isBlank();
        return staticToken || keyPair;
    }

    public String token() {
        TuneBridgeProperties.Apple apple = properties.getApple();
        if (apple.getDeveloperToken() != null && !apple.getDeveloperToken().isBlank()) {
            return apple.getDeveloperToken().trim();
        }
        if (!configured()) {
            throw ProviderException.notConfigured(
                    "服务端未配置 Apple 开发者令牌：迁入 Apple Music 需要它，读取资料库会改用 Apple 网页版通道");
        }
        synchronized (this) {
            long now = Instant.now().getEpochSecond();
            if (!cachedToken.isBlank() && now < cachedUntil) {
                return cachedToken;
            }
            cachedToken = generate(now);
            cachedUntil = now + TOKEN_TTL_SECONDS - REFRESH_SKEW_SECONDS;
            log.info("Generated a new Apple Music developer token");
            return cachedToken;
        }
    }

    private String generate(long now) {
        TuneBridgeProperties.Apple apple = properties.getApple();
        try {
            ObjectNode header = objectMapper.createObjectNode();
            header.put("alg", "ES256");
            header.put("kid", apple.getKeyId());
            header.put("typ", "JWT");

            ObjectNode payload = objectMapper.createObjectNode();
            payload.put("iss", apple.getTeamId());
            payload.put("iat", now);
            payload.put("exp", now + TOKEN_TTL_SECONDS);

            String signingInput = base64Url(objectMapper.writeValueAsBytes(header))
                    + "." + base64Url(objectMapper.writeValueAsBytes(payload));
            byte[] signature = sign(signingInput.getBytes(StandardCharsets.US_ASCII), loadPrivateKey(apple));
            return signingInput + "." + base64Url(signature);
        } catch (ProviderException ex) {
            throw ex;
        } catch (Exception ex) {
            throw ProviderException.notConfigured("Apple 开发者令牌签发失败，请检查 .p8 私钥、Team ID 与 Key ID 配置");
        }
    }

    private PrivateKey loadPrivateKey(TuneBridgeProperties.Apple apple) throws Exception {
        String path = apple.getPrivateKeyPath();
        if (path.startsWith("~/")) {
            path = System.getProperty("user.home") + path.substring(1);
        }
        String pem = Files.readString(Path.of(path));
        String base64 = pem
                .replace("-----BEGIN PRIVATE KEY-----", "")
                .replace("-----END PRIVATE KEY-----", "")
                .replaceAll("\\s", "");
        byte[] der = Base64.getDecoder().decode(base64);
        return KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(der));
    }

    private byte[] sign(byte[] input, PrivateKey key) throws Exception {
        try {
            Signature signature = Signature.getInstance("SHA256withECDSAinP1363Format");
            signature.initSign(key);
            signature.update(input);
            return signature.sign();
        } catch (java.security.NoSuchAlgorithmException ex) {
            Signature signature = Signature.getInstance("SHA256withECDSA");
            signature.initSign(key);
            signature.update(input);
            return derToJose(signature.sign(), 32);
        }
    }

    private byte[] derToJose(byte[] der, int partLength) {
        int offset = 2;
        if ((der[1] & 0xff) > 128) {
            offset = 3;
        }
        int rLength = der[offset + 1];
        int rOffset = offset + 2;
        int sLength = der[rOffset + rLength + 1];
        int sOffset = rOffset + rLength + 2;

        byte[] jose = new byte[partLength * 2];
        copyFixed(der, rOffset, rLength, jose, 0, partLength);
        copyFixed(der, sOffset, sLength, jose, partLength, partLength);
        return jose;
    }

    private void copyFixed(byte[] source, int sourceOffset, int length,
                           byte[] target, int targetStart, int partLength) {
        int copyLength = Math.min(length, partLength);
        System.arraycopy(source, sourceOffset + (length - copyLength),
                target, targetStart + (partLength - copyLength), copyLength);
    }

    private static String base64Url(byte[] value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
    }
}
