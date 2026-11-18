package com.tunebridge.provider.qq;

import com.tunebridge.provider.ProviderException;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

public record QqCookie(String uin, String musicKey, String rawCookie) {

    public static QqCookie parse(String raw) {
        if (raw == null || raw.isBlank()) {
            throw ProviderException.badRequest("请粘贴 QQ 音乐 Cookie");
        }
        String cleaned = raw.trim();
        if (cleaned.regionMatches(true, 0, "cookie:", 0, 7)) {
            cleaned = cleaned.substring(7).trim();
        }
        if (cleaned.length() < 12 || !cleaned.contains("=")) {
            throw ProviderException.badRequest("Cookie 格式不完整，请从 y.qq.com 复制完整的请求 Cookie");
        }

        Map<String, String> values = new LinkedHashMap<>();
        for (String part : cleaned.split(";")) {
            String token = part.trim();
            int index = token.indexOf('=');
            if (index > 0) {
                values.put(token.substring(0, index).trim().toLowerCase(Locale.ROOT), token.substring(index + 1).trim());
            }
        }

        String uin = firstNonBlank(values, "uin", "qqmusic_uin", "wxuin", "p_uin");
        if (uin == null) {
            throw ProviderException.badRequest("Cookie 中缺少 uin，请确认复制的是 y.qq.com 登录后的 Cookie");
        }
        uin = normalizeUin(uin);

        String key = firstNonBlank(values, "qm_keyst", "qqmusic_key", "music_key");
        if (key == null) {
            throw ProviderException.badRequest("Cookie 中缺少音乐登录票据（qm_keyst / qqmusic_key），请重新登录 y.qq.com 后复制");
        }

        return new QqCookie(uin, key, cleaned);
    }

    public int gTk() {
        return hash33(musicKey);
    }

    public String maskedUin() {
        if (uin.length() <= 4) {
            return "***";
        }
        return uin.substring(0, 2) + "****" + uin.substring(uin.length() - 2);
    }

    private static String firstNonBlank(Map<String, String> values, String... keys) {
        for (String key : keys) {
            String value = values.get(key);
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return null;
    }

    private static String normalizeUin(String value) {
        String normalized = value.trim();
        if (normalized.regionMatches(true, 0, "o", 0, 1)) {
            normalized = normalized.substring(1);
        }
        while (normalized.length() > 1 && normalized.startsWith("0")) {
            normalized = normalized.substring(1);
        }
        if (!normalized.matches("\\d{3,}")) {
            throw ProviderException.badRequest("Cookie 中的 uin 无法识别，请重新登录 y.qq.com 后复制");
        }
        return normalized;
    }

    private static int hash33(String key) {
        int hash = 5381;
        for (int i = 0; i < key.length(); i++) {
            hash += (hash << 5) + key.charAt(i);
        }
        return hash & 0x7fffffff;
    }
}
