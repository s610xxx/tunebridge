package com.tunebridge.provider.netease;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.tunebridge.domain.CreatedPlaylist;
import com.tunebridge.domain.Track;
import com.tunebridge.provider.ProviderException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Component;

/** 网易云 eapi 网页端调用：扫码登录、账号校验、搜索与歌单写入。凭据只在参数与返回值之间流动，不落日志。 */
@Component
public class NeteaseWebClient {
    private static final String BASE = "https://music.163.com";
    private static final int MAX_TRACKS = 200;
    private static final int BATCH_SIZE = 20;
    private static final String UNVERIFIED = "网易云歌单写入结果未确认，请到网易云客户端核对后再决定是否重试";

    private final NeteaseTransport transport;
    private final ObjectMapper objectMapper;

    public NeteaseWebClient(NeteaseTransport transport, ObjectMapper objectMapper) {
        this.transport = transport;
        this.objectMapper = objectMapper;
    }

    /** 官方网页端参数集；写操作的 csrf_token 必须取自已登录 Cookie 的 __csrf，留空会被判为 illegal request。 */
    private static Map<String, Object> params(String cookie) {
        Map<String, Object> params = NeteaseEapi.params();
        params.put("csrf_token", csrfToken(cookie));
        return params;
    }

    static String csrfToken(String cookie) {
        if (cookie == null) {
            return "";
        }
        for (String part : cookie.split(";")) {
            String pair = part.trim();
            if (pair.startsWith("__csrf=")) {
                return pair.substring("__csrf=".length());
            }
        }
        return "";
    }

    public QrKeyResult requestQrKey() {
        Map<String, Object> params = NeteaseEapi.params();
        params.put("code", "100");
        params.put("type", 3);
        Reply reply = post("/api/login/qrcode/unikey", params, null);
        String unikey = text(reply.json(), "unikey");
        if (unikey.isBlank()) {
            throw ProviderException.upstream("网易云未返回登录二维码密钥");
        }
        return new QrKeyResult(unikey, reply.setCookies());
    }

    public QrStatus pollQr(String unikey, String cookieHeader) {
        Map<String, Object> params = NeteaseEapi.params();
        params.put("code", "100");
        params.put("key", unikey);
        params.put("type", 3);
        Reply reply = rawPost("/api/login/qrcode/client/login", params, cookieHeader);
        int code = reply.json().path("code").asInt(0);
        return new QrStatus(code, text(reply.json(), "message"), code == 803 ? loginCookie(reply) : "");
    }

    public String accountName(String cookie) {
        JsonNode body = post("/api/nuser/account/get", params(cookie), cookie).json();
        JsonNode account = body.path("account");
        if (account.isMissingNode() || account.isNull()) {
            throw ProviderException.unauthorized("网易云登录态无效，请重新扫码");
        }
        String nickname = text(account, "nickname");
        return nickname.isBlank() ? "网易云用户" : nickname;
    }

    public List<Track> searchTracks(String cookie, String title, String artist, int limit) {
        String keyword = ((title == null ? "" : title.trim()) + " " + (artist == null ? "" : artist.trim())).trim();
        if (keyword.isEmpty()) {
            return List.of();
        }
        int capped = Math.max(1, Math.min(30, limit));
        Map<String, Object> params = params(cookie);
        params.put("s", keyword);
        params.put("type", 1);
        params.put("limit", capped);
        params.put("offset", 0);
        params.put("total", "false");
        JsonNode body = post("/api/cloudsearch/pc", params, cookie).json();
        JsonNode songs = body.path("result").path("songs");
        if (!songs.isArray()) {
            throw ProviderException.upstream("网易云搜索响应格式无效（" + describeRejection(body) + "）");
        }
        List<Track> found = new ArrayList<>();
        for (JsonNode song : songs) {
            if (isUnplayable(song)) {
                continue;
            }
            String id = text(song, "id");
            String name = text(song, "name");
            if (id.isBlank() || name.isBlank()) {
                continue;
            }
            List<String> artists = new ArrayList<>();
            for (JsonNode item : song.path("artists")) {
                String value = text(item, "name");
                if (!value.isBlank()) {
                    artists.add(value);
                }
            }
            String album = text(song.path("album"), "name");
            int seconds = (int) Math.max(0, song.path("duration").asLong(0) / 1000);
            String artwork = text(song, "arturl");
            found.add(new Track(id, name, String.join(" / ", artists), album, seconds, artwork, 0));
            if (found.size() == capped) {
                break;
            }
        }
        return List.copyOf(found);
    }

    public CreatedPlaylist createPlaylist(String cookie, String name) {
        Map<String, Object> params = params(cookie);
        params.put("name", name);
        params.put("privacy", "0");
        JsonNode body = post("/api/playlist/create", params, cookie).json();
        String id = firstNonBlank(text(body, "id"), text(body.path("playlist"), "id"), text(body.path("data"), "id"));
        if (id.isBlank()) {
            String csrfHint = csrfToken(cookie).isBlank() ? "，Cookie 中缺少 __csrf" : "";
            throw ProviderException.upstream("网易云未返回新歌单 ID（" + describeRejection(body) + csrfHint + "）");
        }
        String returnedName = firstNonBlank(text(body.path("playlist"), "name"), name);
        return new CreatedPlaylist(id, returnedName, BASE + "/#/playlist?id=" + id, 0, Map.of());
    }

    public void addTracks(String cookie, CreatedPlaylist playlist, List<Track> tracks) {
        if (playlist == null || playlist.id().isBlank()) {
            throw ProviderException.badRequest("网易云歌单无效");
        }
        if (tracks == null || tracks.size() > MAX_TRACKS) {
            throw ProviderException.badRequest("网易云单次最多写入 " + MAX_TRACKS + " 首");
        }
        List<String> ids = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (Track track : tracks == null ? List.<Track>of() : tracks) {
            if (track == null || track.providerTrackId().isBlank()) {
                throw ProviderException.badRequest("网易云歌曲 ID 无效");
            }
            if (!seen.add(track.providerTrackId())) {
                throw ProviderException.badRequest("待写入的歌曲里有重复项");
            }
            ids.add(track.providerTrackId());
        }
        if (ids.isEmpty()) {
            return;
        }
        for (int start = 0; start < ids.size(); start += BATCH_SIZE) {
            List<String> batch = ids.subList(start, Math.min(ids.size(), start + BATCH_SIZE));
            writeBatch(cookie, playlist.id(), batch);
        }
        verify(cookie, playlist.id(), ids);
    }

    private void writeBatch(String cookie, String playlistId, List<String> batch) {
        String trackIds;
        try {
            trackIds = objectMapper.writeValueAsString(batch);
        } catch (com.fasterxml.jackson.core.JsonProcessingException ex) {
            throw ProviderException.badRequest("网易云歌曲列表无法序列化");
        }
        Map<String, Object> params = params(cookie);
        params.put("op", "add");
        params.put("pid", playlistId);
        params.put("trackIds", trackIds);
        params.put("d", playlistId);
        JsonNode body = post("/api/playlist/manipulate/tracks", params, cookie).json();
        int code = body.path("code").asInt(0);
        if (code != 200) {
            throw ProviderException.upstream("网易云拒绝了此次写入（业务码 " + code + "），可能触发风控，请稍后重试");
        }
    }

    private void verify(String cookie, String playlistId, List<String> expected) {
        Map<String, Object> params = NeteaseEapi.params();
        params.put("id", playlistId);
        params.put("n", "0");
        params.put("s", "1");
        JsonNode playlist = post("/api/v6/playlist/detail", params, cookie).json().path("playlist");
        Set<String> present = new LinkedHashSet<>();
        for (JsonNode entry : playlist.path("trackIds")) {
            String id = text(entry, "id");
            if (!id.isBlank()) {
                present.add(id);
            }
        }
        if (present.isEmpty()) {
            for (JsonNode track : playlist.path("tracks")) {
                String id = text(track, "id");
                if (!id.isBlank()) {
                    present.add(id);
                }
            }
        }
        if (!present.containsAll(expected)) {
            throw ProviderException.upstream(UNVERIFIED);
        }
    }

    private String loginCookie(Reply reply) {
        StringBuilder cookie = new StringBuilder();
        for (String header : reply.setCookies()) {
            String pair = header.split(";", 2)[0].trim();
            String name = pair.split("=", 2)[0];
            if (pair.length() > name.length() + 1
                    && List.of("MUSIC_U", "MUSIC_T", "NMTID", "__csrf", "MUSIC_A_T").contains(name)) {
                if (!cookie.isEmpty()) {
                    cookie.append("; ");
                }
                cookie.append(pair);
            }
        }
        if (cookie.toString().contains("MUSIC_U=")) {
            return cookie.toString();
        }
        throw ProviderException.upstream("网易云扫码确认成功但未返回登录凭据");
    }

    private Reply post(String apiPath, Map<String, Object> params, String cookie) {
        return rawPost(apiPath, params, cookie);
    }

    private Reply rawPost(String apiPath, Map<String, Object> params, String cookie) {
        NeteaseTransport.Response response;
        try {
            response = transport.post(BASE + "/eapi" + apiPath.substring("/api".length()),
                    NeteaseEapi.formBody(apiPath, params), cookie);
        } catch (org.springframework.web.client.RestClientException ex) {
            throw ProviderException.upstream("网易云响应超时或不可达，请稍后重试");
        }
        if (response.status() < 200 || response.status() >= 300) {
            throw ProviderException.upstream("网易云返回 HTTP " + response.status());
        }
        JsonNode json;
        try {
            json = objectMapper.readTree(response.body() == null ? "{}" : response.body());
        } catch (com.fasterxml.jackson.core.JsonProcessingException ex) {
            throw ProviderException.upstream("网易云响应格式无效");
        }
        return new Reply(json, response.setCookies());
    }

    /**
     * 网易云用多个字段表达"不可播"，且各通道字段不齐：只在字段明确判定时丢弃，
     * 缺失一律保留——误杀会让整首歌迁移失败，留下只是歌单里多一首灰歌。
     */
    private static boolean isUnplayable(JsonNode song) {
        JsonNode visible = song.path("visible");
        if (visible.isBoolean() && !visible.asBoolean()) {
            return true;
        }
        if (song.path("noCopyrightRcmd").isObject()) {
            return true;
        }
        return song.path("privilege").path("st").asInt(0) == -200;
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node == null ? null : node.path(field);
        return value == null || value.isNull() || value.isMissingNode() ? "" : String.valueOf(value.asText(""));
    }

    /** 网易云把拒因放在 header.code/msg，顶层 code/msg 只是兜底；风控命中时这是唯一的线索，不能吞掉。 */
    private static String describeRejection(JsonNode body) {
        JsonNode header = body.path("header");
        String code = firstNonBlank(text(header, "code"), text(body, "code"));
        String message = firstNonBlank(text(header, "msg"), text(body, "msg"));
        if (code.isBlank() && message.isBlank()) {
            List<String> names = new ArrayList<>();
            body.fieldNames().forEachRemaining(names::add);
            return names.isEmpty() ? "无业务码，响应为空"
                    : "无业务码，字段 " + String.join("/", names.subList(0, Math.min(6, names.size())));
        }
        String trimmed = message.length() > 80 ? message.substring(0, 80) : message;
        return trimmed.isBlank() ? "业务码 " + code : "业务码 " + code + "：" + trimmed;
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return "";
    }

    private record Reply(JsonNode json, List<String> setCookies) {
    }

    public record QrStatus(int code, String message, String cookie) {
    }

    public record QrKeyResult(String unikey, List<String> setCookies) {
    }
}
