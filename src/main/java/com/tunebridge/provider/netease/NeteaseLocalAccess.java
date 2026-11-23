package com.tunebridge.provider.netease;

import com.tunebridge.provider.ProviderException;
import jakarta.annotation.PostConstruct;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HashSet;
import java.util.Set;
import java.util.function.Supplier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class NeteaseLocalAccess {

    private final String pairingCode;
    private final String serverAddress;
    private final String forwardHeadersStrategy;
    private final String nodeExecutable;
    private final String cliEntry;
    private final SecureRandom random = new SecureRandom();
    private final Set<String> grants = new HashSet<>();

    public NeteaseLocalAccess(@Value("${tunebridge.netease.pairing-code:}") String pairingCode,
                              @Value("${server.address:}") String serverAddress,
                              @Value("${server.forward-headers-strategy:none}") String forwardHeadersStrategy,
                              @Value("${tunebridge.netease.node-executable:}") String nodeExecutable,
                              @Value("${tunebridge.netease.cli-entry:}") String cliEntry) {
        this.pairingCode = pairingCode;
        this.serverAddress = serverAddress;
        this.forwardHeadersStrategy = forwardHeadersStrategy;
        this.nodeExecutable = nodeExecutable;
        this.cliEntry = cliEntry;
    }

    @PostConstruct
    public void validateConfiguration() {
        if (!enabled()) {
            return;
        }
        // 配对码仅用于 LOCAL 模式，PUBLIC 模式下忽略该配置
        boolean isPublic = "PUBLIC".equalsIgnoreCase(System.getenv("TUNEBRIDGE_SECURITY_MODE"));
        if (isPublic) {
            // PUBLIC 模式下不启用配对码功能，避免与扫码登录混淆
            return;
        }
        if (!"127.0.0.1".equals(serverAddress)) {
            throw new IllegalStateException("网易云本机模式要求 server.address=127.0.0.1");
        }
        if (!"none".equalsIgnoreCase(forwardHeadersStrategy)) {
            throw new IllegalStateException("网易云本机模式要求关闭转发头处理");
        }
        if (!pairingCode.matches("[A-Za-z0-9_-]{32,128}")) {
            throw new IllegalStateException("网易云本机配对码必须由 32 至 128 位字母、数字、下划线或连字符组成");
        }
        if (!isAbsoluteFile(nodeExecutable) || !isAbsoluteFile(cliEntry)) {
            throw new IllegalStateException("网易云本机模式需要有效的 Node 和 CLI 文件绝对路径");
        }
    }

    /** PUBLIC 模式下配对码被忽略，只有 LOCAL 模式才启用。 */
    public boolean cliEnabled() {
        return enabled() && !"PUBLIC".equalsIgnoreCase(System.getenv("TUNEBRIDGE_SECURITY_MODE"));
    }

    public boolean enabled() {
        return pairingCode != null && !pairingCode.isBlank();
    }

    public synchronized String authorize(String candidate) {
        if (!enabled()) {
            throw ProviderException.notConfigured("网易云本机模式尚未启用");
        }
        byte[] actual = candidate == null ? new byte[0] : candidate.getBytes(StandardCharsets.UTF_8);
        if (!MessageDigest.isEqual(pairingCode.getBytes(StandardCharsets.UTF_8), actual)) {
            throw ProviderException.unauthorized("网易云本机配对码不正确");
        }
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        String grant = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        grants.add(grant);
        return grant;
    }

    public synchronized <T> T withGrant(String grant, Supplier<T> work) {
        if (grant == null || !grants.contains(grant)) {
            throw ProviderException.notConnected("网易云本机连接已失效，请重新连接");
        }
        return work.get();
    }

    public synchronized void revoke(String grant) {
        if (grant != null) {
            grants.remove(grant);
        }
    }

    private static boolean isAbsoluteFile(String value) {
        if (value == null || value.isBlank()) {
            return false;
        }
        try {
            Path path = Path.of(value);
            return path.isAbsolute() && Files.isRegularFile(path);
        } catch (RuntimeException ex) {
            return false;
        }
    }
}
