package com.tunebridge.provider.apple;

import com.tunebridge.provider.ProviderException;
import java.net.URI;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class AppleUrlParser {

    private static final Pattern RAW_ID = Pattern.compile("^((?:pl|p)\\.[A-Za-z0-9][A-Za-z0-9._-]*)$");
    private static final Pattern PLAYLIST_ID = Pattern.compile("(/|\\b)((?:pl|p)\\.[A-Za-z0-9][A-Za-z0-9._-]*)");

    private AppleUrlParser() {
    }

    public static ApplePlaylistRef parse(String raw) {
        if (raw == null || raw.isBlank()) {
            throw ProviderException.badRequest("请粘贴 Apple Music 歌单链接");
        }
        String value = raw.trim();
        Matcher rawMatcher = RAW_ID.matcher(value);
        if (rawMatcher.matches()) {
            return new ApplePlaylistRef(rawMatcher.group(1), rawMatcher.group(1).startsWith("p."));
        }
        if (!value.startsWith("http://") && !value.startsWith("https://")) {
            throw ProviderException.badRequest("无法识别歌单链接，请粘贴完整的 Apple Music 歌单分享链接");
        }

        URI uri;
        try {
            uri = URI.create(value);
        } catch (IllegalArgumentException ex) {
            throw ProviderException.badRequest("歌单链接格式不正确");
        }
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase();
        if (!host.equals("music.apple.com") && !host.equals("itunes.apple.com") && !host.endsWith(".music.apple.com")) {
            throw ProviderException.badRequest("这不是 Apple Music 链接，请确认来源平台");
        }
        String pathAndQuery = (uri.getPath() == null ? "" : uri.getPath())
                + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery());
        if (pathAndQuery.contains("/album/") && !pathAndQuery.contains("/playlist/")) {
            throw ProviderException.badRequest("这是专辑链接，请粘贴 Apple Music 歌单链接");
        }
        Matcher matcher = PLAYLIST_ID.matcher(pathAndQuery);
        if (matcher.find()) {
            String id = matcher.group(2);
            return new ApplePlaylistRef(id, id.startsWith("p."));
        }
        throw ProviderException.badRequest("链接中没有找到 Apple Music 歌单 ID，请使用歌单页的分享链接");
    }

    public record ApplePlaylistRef(String id, boolean library) {
    }
}
