package com.tunebridge.provider.qq;

import com.tunebridge.provider.ProviderException;
import java.net.URI;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class QqUrlParser {

    private static final Pattern NUMERIC = Pattern.compile("^\\d{5,20}$");
    private static final Pattern PATH_PLAYLIST = Pattern.compile("/playlist/(\\d{5,20})");
    private static final Pattern QUERY_ID = Pattern.compile("[?&#](?:id|disstid|dissid)=(\\d{5,20})");

    private QqUrlParser() {
    }

    public static String parsePlaylistId(String raw) {
        if (raw == null || raw.isBlank()) {
            throw ProviderException.badRequest("请粘贴 QQ 音乐歌单链接");
        }
        String value = raw.trim();
        if (NUMERIC.matcher(value).matches()) {
            return value;
        }
        if (!value.startsWith("http://") && !value.startsWith("https://")) {
            throw ProviderException.badRequest("无法识别歌单链接，请粘贴完整的 QQ 音乐歌单分享链接");
        }

        URI uri;
        try {
            uri = URI.create(value);
        } catch (IllegalArgumentException ex) {
            throw ProviderException.badRequest("歌单链接格式不正确");
        }
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase();
        if (!host.equals("qq.com") && !host.endsWith(".qq.com")) {
            throw ProviderException.badRequest("这不是 QQ 音乐链接，请确认来源平台");
        }

        Matcher pathMatcher = PATH_PLAYLIST.matcher(uri.getPath() == null ? "" : uri.getPath());
        if (pathMatcher.find()) {
            return pathMatcher.group(1);
        }
        String query = uri.getRawQuery();
        String fragment = uri.getRawFragment();
        Matcher queryMatcher = QUERY_ID.matcher("?" + (query == null ? "" : query) + "#" + (fragment == null ? "" : fragment));
        if (queryMatcher.find()) {
            return queryMatcher.group(1);
        }
        throw ProviderException.badRequest("链接中没有找到歌单 ID，请使用歌单页的分享链接");
    }
}
