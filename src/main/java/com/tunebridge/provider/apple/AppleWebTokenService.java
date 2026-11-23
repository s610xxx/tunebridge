package com.tunebridge.provider.apple;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.tunebridge.provider.ProviderException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * 读取 Apple Music 网页播放器随包发布的访问令牌（JWT 的 iss 为 AMPWebPlay）。
 * 有了它，没有 Apple 开发者账号的部署也能读取用户自己的资料库。这是非官方通道：
 * 只用于读取，且可能随网页版改版失效。
 */
@Component
public class AppleWebTokenService {

    private static final Logger log = LoggerFactory.getLogger(AppleWebTokenService.class);
    private static final String WEB_PLAYER_BASE = "https://music.apple.com";
    private static final String ISSUER = "AMPWebPlay";
    private static final Pattern SCRIPT_URL = Pattern.compile("(/assets/[^\"'()\\s]+\\.js)");
    private static final Pattern COMPACT_JWT =
            Pattern.compile("eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}");
    private static final int MAX_SCRIPTS = 4;
    /** 网页令牌一般几十天后过期：提前一天轮换，寿命太短的候选直接跳过。 */
    private static final long ROTATION_MARGIN_SECONDS = 86_400;
    private static final long MIN_LIFETIME_SECONDS = 3_600;
    private static final long MIN_CACHE_SECONDS = 600;
    private static final ObjectMapper JSON = new ObjectMapper();

    record Token(String value, long expiresAt) {
    }

    private final AppleBundleSource bundles;

    private Token cached;

    public AppleWebTokenService(AppleBundleSource bundles) {
        this.bundles = bundles;
    }

    public String token() {
        Token current = cached;
        long now = Instant.now().getEpochSecond();
        if (current != null && now < cacheUntil(current, now)) {
            return current.value();
        }
        synchronized (this) {
            now = Instant.now().getEpochSecond();
            if (cached != null && now < cacheUntil(cached, now)) {
                return cached.value();
            }
            cached = discover(now);
            log.info("Refreshed the Apple Music web-player access token");
            return cached.value();
        }
    }

    private Token discover(long now) {
        String html = bundles.html();
        for (String script : scriptUrls(html)) {
            String js;
            try {
                js = bundles.script(script);
            } catch (RuntimeException ex) {
                continue;
            }
            Token token = webToken(js, now);
            if (token != null) {
                return token;
            }
        }
        throw unavailable();
    }

    static Set<String> scriptUrls(String html) {
        Set<String> urls = new LinkedHashSet<>();
        Matcher matcher = SCRIPT_URL.matcher(html == null ? "" : html);
        while (matcher.find() && urls.size() < MAX_SCRIPTS) {
            urls.add(WEB_PLAYER_BASE + matcher.group(1));
        }
        return urls;
    }

    /** 在打包脚本里找网页播放器的签名令牌；签发者不对或快过期的都跳过。 */
    static Token webToken(String script, long now) {
        Matcher matcher = COMPACT_JWT.matcher(script == null ? "" : script);
        while (matcher.find()) {
            Token token = claims(matcher.group(), now);
            if (token != null) {
                return token;
            }
        }
        return null;
    }

    private static Token claims(String jwt, long now) {
        String[] segments = jwt.split("\\.");
        if (segments.length != 3) {
            return null;
        }
        try {
            JsonNode claims = JSON.readTree(new String(
                    Base64.getUrlDecoder().decode(segments[1]), StandardCharsets.UTF_8));
            if (!ISSUER.equals(claims.path("iss").asText(""))) {
                return null;
            }
            long expiresAt = claims.path("exp").asLong(0);
            return expiresAt > now + MIN_LIFETIME_SECONDS ? new Token(jwt, expiresAt) : null;
        } catch (Exception ex) {
            return null;
        }
    }

    private static long cacheUntil(Token token, long now) {
        long rotateAt = token.expiresAt() - ROTATION_MARGIN_SECONDS;
        return rotateAt > now ? rotateAt : now + MIN_CACHE_SECONDS;
    }

    private static ProviderException unavailable() {
        return ProviderException.upstream("暂时取不到 Apple Music 网页版的访问令牌，"
                + "可能是网络受限或网页版已改版；请稍后重试，或先用演示模式");
    }
}
