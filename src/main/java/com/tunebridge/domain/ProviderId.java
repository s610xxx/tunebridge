package com.tunebridge.domain;

import java.util.Locale;

public enum ProviderId {
    QQ_MUSIC("QQ 音乐"),
    APPLE_MUSIC("Apple Music"),
    NETEASE_MUSIC("网易云音乐");

    private final String label;

    ProviderId(String label) {
        this.label = label;
    }

    public String label() {
        return label;
    }

    public static ProviderId from(String value) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("请选择音乐平台");
        }
        String normalized = value.trim().toUpperCase(Locale.ROOT).replace('-', '_').replace(' ', '_');
        return switch (normalized) {
            case "QQ", "QQ_MUSIC", "QQMUSIC" -> QQ_MUSIC;
            case "APPLE", "APPLE_MUSIC", "APPLEMUSIC" -> APPLE_MUSIC;
            case "NETEASE", "NETEASE_MUSIC", "NETEASEMUSIC", "NCM" -> NETEASE_MUSIC;
            default -> throw new IllegalArgumentException("不支持的音乐平台：" + value);
        };
    }
}
