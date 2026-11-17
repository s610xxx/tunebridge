package com.tunebridge.provider.qq;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tunebridge.config.TuneBridgeProperties;
import com.tunebridge.domain.CreatedPlaylist;
import com.tunebridge.domain.Playlist;
import com.tunebridge.domain.Track;
import com.tunebridge.provider.ProviderException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.client.ClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.util.UriComponentsBuilder;

@Component
public class QqMusicClient {

    private static final Logger log = LoggerFactory.getLogger(QqMusicClient.class);
    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
    private static final String REFERER = "https://y.qq.com/";
    private static final String MUSICU_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg";
    private static final String PLAYLIST_URL =
            "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg";
    private static final String SMARTBOX_URL = "https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg";

    private final RestClient restClient;
    private final ObjectMapper objectMapper;
    private final TuneBridgeProperties properties;

    public QqMusicClient(ClientHttpRequestFactory requestFactory, ObjectMapper objectMapper,
                         TuneBridgeProperties properties) {
        this.restClient = RestClient.builder().requestFactory(requestFactory).build();
        this.objectMapper = objectMapper;
        this.properties = properties;
    }

    public Playlist fetchPlaylist(String dissid, QqCookie cookie) {
        String uri = UriComponentsBuilder.fromUriString(PLAYLIST_URL)
                .queryParam("type", "1")
                .queryParam("json", "1")
                .queryParam("utf8", "1")
                .queryParam("onlysong", "0")
                .queryParam("disstid", dissid)
                .queryParam("format", "json")
                .queryParam("platform", "yqq.json")
                .queryParam("needNewCode", "0")
                .build()
                .encode()
                .toUriString();

        JsonNode root = getJson(uri, cookie);
        if (root.path("code").asInt(0) != 0) {
            throw ProviderException.upstream("QQ 音乐返回错误（" + root.path("code").asInt() + "）");
        }
        JsonNode cdlist = root.path("cdlist");
        if (!cdlist.isArray() || cdlist.isEmpty()) {
            throw ProviderException.notFound("歌单不存在或不可访问，请确认歌单是公开状态");
        }

        JsonNode playlist = cdlist.get(0);
        List<Track> tracks = new ArrayList<>();
        for (JsonNode song : playlist.path("songlist")) {
            String id = text(song, "songid");
            if (id.isBlank()) {
                id = text(song, "songmid");
            }
            String title = text(song, "songname");
            if (title.isBlank()) {
                title = text(song, "name");
            }
            String artist = joinSingers(song.path("singer"));
            String album = text(song, "albumname");
            int duration = song.path("interval").asInt(0);
            int songType = song.has("songtype") ? song.path("songtype").asInt(0) : song.path("type").asInt(0);
            String artwork = "";
            String albumMid = text(song, "albummid");
            if (!albumMid.isBlank()) {
                artwork = "https://y.gtimg.cn/music/photo_new/T002R300x300M000" + albumMid + ".jpg";
            }
            if (!id.isBlank() && !title.isBlank()) {
                tracks.add(new Track(id, title, artist, album, duration, artwork, songType));
            }
        }

        String owner = text(playlist, "nickname");
        if (owner.isBlank()) {
            owner = text(playlist.path("creator"), "nickname");
        }
        String name = text(playlist, "dissname");
        if (name.isBlank()) {
            name = "QQ 音乐歌单";
        }
        String description = text(playlist, "desc");
        String cover = text(playlist, "logo");

        return new Playlist(dissid, name, description, cover, owner,
                "https://y.qq.com/n/ryqq/playlist/" + dissid, tracks);
    }

    public String validate(QqCookie cookie) {
        ObjectNode param = objectMapper.createObjectNode();
        param.put("disstid", 0);
        param.put("dirid", 201);
        param.put("tag", true);
        param.put("song_begin", 0);
        param.put("song_num", 1);
        param.put("userinfo", true);
        param.put("orderlist", true);

        try {
            call(cookie, "music.srfDissInfo.DissInfo", "CgiGetDiss", param);
        } catch (ProviderException ex) {
            if (ex.status() == HttpStatus.UNAUTHORIZED) {
                throw ex;
            }
            log.warn("QQ cookie validation was inconclusive: {}", ex.code());
        }
        return cookie.maskedUin();
    }

    public List<Track> searchTracks(String title, String artist, int limit) {
        if (title == null || title.isBlank()) {
            return List.of();
        }
        Map<String, Track> candidates = new LinkedHashMap<>();
        boolean anySuccess = false;
        ProviderException lastError = null;

        try {
            collectSmartbox(title, candidates);
            anySuccess = true;
        } catch (ProviderException ex) {
            lastError = ex;
            log.debug("QQ smartbox search failed: {}", ex.code());
        }

        try {
            collectMusicuSearch((title + " " + (artist == null ? "" : artist)).trim(), limit, candidates);
            anySuccess = true;
        } catch (ProviderException ex) {
            lastError = ex;
            log.debug("QQ musicu search failed: {}", ex.code());
        }

        if (!anySuccess && lastError != null) {
            throw lastError;
        }
        int cappedLimit = Math.max(1, limit);
        return candidates.values().stream().limit(cappedLimit).toList();
    }

    public CreatedPlaylist createPlaylist(QqCookie cookie, String name, String description) {
        ObjectNode param = objectMapper.createObjectNode();
        param.put("dirName", truncate(name, 20));
        param.put("dirDesc", truncate(description, 80));
        param.put("dirPicUrl", "");
        param.put("taglist", "");
        param.put("dirShow", 2);

        JsonNode block = call(cookie, "music.musicasset.PlaylistBaseWrite", "AddPlaylist", param);
        JsonNode data = block.path("data");
        JsonNode result = data.path("result").isObject() ? data.path("result") : data;
        String dirId = text(result, "dirId");
        if (dirId.isBlank()) {
            dirId = text(data, "dirId");
        }
        String tid = text(result, "tid");
        if (tid.isBlank()) {
            tid = text(data, "tid");
        }
        if (dirId.isBlank()) {
            throw ProviderException.upstream("QQ 音乐未返回新歌单 ID，请稍后重试");
        }
        String finalName = text(result, "dirName");
        if (finalName.isBlank()) {
            finalName = truncate(name, 20);
        }
        return new CreatedPlaylist(
                dirId,
                finalName,
                "https://y.qq.com/n/ryqq/playlist/" + dirId,
                0,
                Map.of("tid", tid, "dirId", dirId)
        );
    }

    public void addTracks(QqCookie cookie, CreatedPlaylist playlist, List<Track> tracks) {
        if (tracks.isEmpty()) {
            return;
        }
        String tid = playlist.metadata().getOrDefault("tid", "");
        if (tid.isBlank()) {
            throw ProviderException.upstream("QQ 音乐未返回歌单 tid，无法写入歌曲，请重新迁移");
        }
        long dirId;
        try {
            dirId = Long.parseLong(playlist.id());
        } catch (NumberFormatException ex) {
            throw ProviderException.upstream("QQ 音乐返回的歌单 ID 无法识别");
        }

        int batchSize = Math.max(1, properties.getMigration().getBatchSize());
        for (int start = 0; start < tracks.size(); start += batchSize) {
            int end = Math.min(start + batchSize, tracks.size());
            List<Track> batch = tracks.subList(start, end);

            ObjectNode param = objectMapper.createObjectNode();
            param.put("dirId", dirId);
            param.put("tid", tid);
            param.put("bFmtUtf8", true);
            ArrayNode songInfo = param.putArray("v_songInfo");
            for (Track track : batch) {
                long songId;
                try {
                    songId = Long.parseLong(track.providerTrackId());
                } catch (NumberFormatException ex) {
                    throw ProviderException.upstream("QQ 歌曲 ID 无法识别：" + track.providerTrackId());
                }
                ObjectNode item = songInfo.addObject();
                item.put("songId", songId);
                item.put("songType", track.songType());
            }

            call(cookie, "music.musicasset.PlaylistDetailWrite", "AddSonglist", param);
            log.info("QQ playlist {}: wrote {}/{} tracks", playlist.id(), end, tracks.size());
            if (end < tracks.size()) {
                sleep(properties.getMigration().getRequestIntervalMs());
            }
        }
    }

    private void collectSmartbox(String title, Map<String, Track> candidates) {
        String uri = UriComponentsBuilder.fromUriString(SMARTBOX_URL)
                .queryParam("key", title)
                .queryParam("format", "json")
                .queryParam("inCharset", "utf-8")
                .queryParam("outCharset", "utf-8")
                .queryParam("platform", "yqq.json")
                .build()
                .encode()
                .toUriString();

        JsonNode root = getJson(uri, null);
        for (JsonNode song : root.path("data").path("song").path("itemlist")) {
            addCandidate(candidates, text(song, "id"), text(song, "name"),
                    text(song, "singer"), "", 0, 0);
        }
    }

    private void collectMusicuSearch(String query, int limit, Map<String, Track> candidates) {
        ObjectNode root = objectMapper.createObjectNode();
        ObjectNode block = root.putObject("music.search.SearchCgiService");
        block.put("module", "music.search.SearchCgiService");
        block.put("method", "DoSearchForQQMusicDesktop");
        ObjectNode param = block.putObject("param");
        param.put("search_type", 0);
        param.put("query", query);
        param.put("page_num", 1);
        param.put("num_per_page", Math.max(limit, 8));

        JsonNode response = postJson(MUSICU_URL, root.toString(), null);
        JsonNode searchBlock = response.path("music.search.SearchCgiService");
        if (searchBlock.path("code").asInt(0) != 0) {
            throw businessError(searchBlock.path("code").asInt());
        }
        for (JsonNode song : searchBlock.path("data").path("body").path("song").path("list")) {
            String id = text(song, "id");
            if (id.isBlank()) {
                id = text(song, "songid");
            }
            String name = text(song, "name");
            if (name.isBlank()) {
                name = text(song, "title");
            }
            String artist = joinSingers(song.path("singer"));
            String album = text(song.path("album"), "name");
            int type = song.path("type").asInt(0);
            addCandidate(candidates, id, name, artist, album, 0, type);
        }
    }

    private void addCandidate(Map<String, Track> candidates, String id, String title, String artist,
                              String album, int duration, int songType) {
        if (id == null || id.isBlank() || title == null || title.isBlank() || candidates.containsKey(id)) {
            return;
        }
        candidates.put(id, new Track(id, title, artist, album, duration, "", songType));
    }

    private JsonNode call(QqCookie cookie, String module, String method, ObjectNode param) {
        ObjectNode root = objectMapper.createObjectNode();
        ObjectNode comm = root.putObject("comm");
        comm.put("ct", 24);
        comm.put("cv", 4747474);
        comm.put("platform", "yqq.json");
        comm.put("uin", cookie == null ? "0" : cookie.uin());
        comm.put("g_tk", cookie == null ? 5381 : cookie.gTk());
        comm.put("g_tk_new_20200303", cookie == null ? 5381 : cookie.gTk());
        comm.put("format", "json");
        comm.put("inCharset", "utf-8");
        comm.put("outCharset", "utf-8");
        comm.put("notice", 0);
        comm.put("need_new_code", 1);
        if (cookie != null) {
            comm.put("authst", cookie.musicKey());
        }

        ObjectNode request = root.putObject("req_0");
        request.put("module", module);
        request.put("method", method);
        request.set("param", param);

        JsonNode response = postJson(MUSICU_URL, root.toString(), cookie);
        int outerCode = response.path("code").asInt(0);
        if (outerCode != 0) {
            throw businessError(outerCode);
        }
        JsonNode block = response.path("req_0");
        if (!block.isObject()) {
            throw ProviderException.upstream("QQ 音乐返回了无法识别的数据");
        }
        int blockCode = block.path("code").asInt(0);
        if (blockCode != 0) {
            throw businessError(blockCode);
        }
        JsonNode data = block.path("data");
        int retCode = data.path("retCode").asInt(0);
        JsonNode result = data.path("result");
        if (retCode == 0 && result.isObject()) {
            retCode = result.path("retCode").asInt(0);
        }
        if (retCode != 0) {
            throw businessError(retCode);
        }
        return block;
    }

    private ProviderException businessError(int code) {
        if (code == 301 || code == 401 || code == 1000) {
            return ProviderException.unauthorized("QQ 音乐登录态已失效，请重新复制 Cookie 后连接");
        }
        if (code == 2000) {
            return ProviderException.upstream("QQ 音乐要求签名请求（业务码 2000），当前通道暂不支持；请使用演示模式体验");
        }
        if (code == 2001) {
            return ProviderException.rateLimited("QQ 音乐请求过于频繁，请稍后再试");
        }
        if (code == 80105) {
            return ProviderException.upstream("QQ 音乐拒绝了此次写入（业务码 80105），可能触发风控或需要签名通道；请稍后重试或使用演示模式");
        }
        return ProviderException.upstream("QQ 音乐返回业务错误（" + code + "）");
    }

    private JsonNode getJson(String uri, QqCookie cookie) {
        try {
            return restClient.get()
                    .uri(uri)
                    .header(HttpHeaders.REFERER, REFERER)
                    .header(HttpHeaders.USER_AGENT, USER_AGENT)
                    .headers(headers -> {
                        if (cookie != null) {
                            headers.set(HttpHeaders.COOKIE, cookie.rawCookie());
                        }
                    })
                    .retrieve()
                    .body(JsonNode.class);
        } catch (RestClientResponseException ex) {
            throw mapHttpError(ex);
        } catch (ResourceAccessException ex) {
            throw ProviderException.upstream("QQ 音乐响应超时，请稍后重试");
        }
    }

    private JsonNode postJson(String uri, String body, QqCookie cookie) {
        try {
            JsonNode response = restClient.post()
                    .uri(uri)
                    .contentType(MediaType.APPLICATION_JSON)
                    .header(HttpHeaders.REFERER, REFERER)
                    .header(HttpHeaders.USER_AGENT, USER_AGENT)
                    .headers(headers -> {
                        if (cookie != null) {
                            headers.set(HttpHeaders.COOKIE, cookie.rawCookie());
                        }
                    })
                    .body(body)
                    .retrieve()
                    .body(JsonNode.class);
            if (response == null) {
                throw ProviderException.upstream("QQ 音乐返回了空响应");
            }
            return response;
        } catch (RestClientResponseException ex) {
            throw mapHttpError(ex);
        } catch (ResourceAccessException ex) {
            throw ProviderException.upstream("QQ 音乐响应超时，请稍后重试");
        }
    }

    private ProviderException mapHttpError(RestClientResponseException ex) {
        int code = ex.getStatusCode().value();
        if (code == 401 || code == 403) {
            return ProviderException.unauthorized("QQ 音乐拒绝了请求（HTTP " + code + "），请重新连接账号");
        }
        if (code == 404) {
            return ProviderException.notFound("QQ 音乐歌单不存在或不可访问");
        }
        if (code == 429) {
            return ProviderException.rateLimited("QQ 音乐请求过于频繁，请稍后再试");
        }
        return ProviderException.upstream("QQ 音乐暂时不可用（HTTP " + code + "），请稍后重试");
    }

    private static String joinSingers(JsonNode singers) {
        if (singers == null || !singers.isArray()) {
            return "";
        }
        List<String> names = new ArrayList<>();
        for (JsonNode singer : singers) {
            String name = text(singer, "name");
            if (!name.isBlank()) {
                names.add(name);
            }
        }
        return String.join(" / ", names);
    }

    private static String text(JsonNode node, String field) {
        if (node == null || node.isMissingNode() || node.isNull()) {
            return "";
        }
        JsonNode value = node.path(field);
        return value.isMissingNode() || value.isNull() ? "" : value.asText("");
    }

    private static String truncate(String value, int maxCodePoints) {
        String safe = value == null ? "" : value.trim();
        int count = safe.codePointCount(0, safe.length());
        if (count <= maxCodePoints) {
            return safe;
        }
        return safe.substring(0, safe.offsetByCodePoints(0, maxCodePoints));
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
        }
    }
}
