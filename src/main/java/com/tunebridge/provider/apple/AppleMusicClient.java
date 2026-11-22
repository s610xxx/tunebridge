package com.tunebridge.provider.apple;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tunebridge.config.TuneBridgeProperties;
import com.tunebridge.domain.CreatedPlaylist;
import com.tunebridge.domain.Playlist;
import com.tunebridge.domain.PlaylistRef;
import com.tunebridge.domain.Track;
import com.tunebridge.provider.ProviderException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.client.ClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.util.UriComponentsBuilder;

@Component
public class AppleMusicClient {

    private static final Logger log = LoggerFactory.getLogger(AppleMusicClient.class);
    private static final String API_BASE = "https://api.music.apple.com";
    private static final String USER_AGENT = "TuneBridge/1.0";
    private static final int PAGE_SIZE = 100;

    private final RestClient restClient;
    private final ObjectMapper objectMapper;
    private final AppleDeveloperTokenService tokenService;
    private final TuneBridgeProperties properties;

    public AppleMusicClient(ClientHttpRequestFactory requestFactory, ObjectMapper objectMapper,
                            AppleDeveloperTokenService tokenService, TuneBridgeProperties properties) {
        this.restClient = RestClient.builder().requestFactory(requestFactory).build();
        this.objectMapper = objectMapper;
        this.tokenService = tokenService;
        this.properties = properties;
    }

    public String validate(String userToken) {
        requireUserToken(userToken);
        JsonNode root = get("/v1/me/storefront", Map.of(), userToken);
        JsonNode data = root.path("data");
        if (!data.isArray() || data.isEmpty()) {
            throw ProviderException.unauthorized("Apple Music 授权校验失败，请重新授权");
        }
        String storefront = data.get(0).path("id").asText("");
        return normalizeStorefront(storefront);
    }

    public Playlist fetchPlaylist(String url, String userToken, String storefront) {
        AppleUrlParser.ApplePlaylistRef ref = AppleUrlParser.parse(url);
        String region = normalizeStorefront(storefront);
        String path;
        if (ref.library()) {
            requireUserToken(userToken);
            path = "/v1/me/library/playlists/" + ref.id();
        } else {
            path = "/v1/catalog/" + region + "/playlists/" + ref.id();
        }

        JsonNode metaRoot = get(path, Map.of(), userToken);
        JsonNode item = firstItem(metaRoot, "Apple Music 歌单不存在或不可访问");
        JsonNode attributes = item.path("attributes");
        String name = attributes.path("name").asText("");
        if (name.isBlank()) {
            name = "Apple Music 歌单";
        }
        String description = attributes.path("description").isTextual()
                ? attributes.path("description").asText("")
                : attributes.path("description").path("standard").asText("");
        String cover = artworkUrl(attributes.path("artwork"));
        String owner = attributes.path("curatorName").asText("");
        if (owner.isBlank()) {
            owner = attributes.path("artistName").asText("");
        }

        List<Track> tracks = fetchTracks(path + "/tracks", userToken);
        String webUrl = ref.library()
                ? "https://music.apple.com/" + region + "/library/playlist/" + ref.id()
                : "https://music.apple.com/" + region + "/playlist/" + ref.id();
        return new Playlist(ref.id(), name, description, cover, owner, webUrl, tracks);
    }

    public List<PlaylistRef> listLibraryPlaylists(String userToken, String storefront, int limit) {
        requireUserToken(userToken);
        int capped = Math.max(1, Math.min(limit, 100));
        JsonNode root = get("/v1/me/library/playlists", Map.of("limit", String.valueOf(capped)), userToken);
        JsonNode data = root.path("data");
        if (!data.isArray()) {
            throw ProviderException.upstream("Apple Music 未返回资料库歌单，请改用粘贴歌单链接");
        }
        return parseLibraryPlaylists(data, normalizeStorefront(storefront), capped);
    }

    static List<PlaylistRef> parseLibraryPlaylists(JsonNode data, String storefront, int limit) {
        List<PlaylistRef> refs = new ArrayList<>();
        for (JsonNode item : data) {
            if (refs.size() >= limit) {
                break;
            }
            String id = item.path("id").asText("");
            if (!id.startsWith("p.")) {
                continue;
            }
            JsonNode attributes = item.path("attributes");
            String name = attributes.path("name").asText("");
            if (name.isBlank()) {
                name = "Apple Music 歌单";
            }
            String url = attributes.path("url").asText("");
            if (url.isBlank()) {
                url = "https://music.apple.com/" + storefront + "/library/playlist/" + id;
            }
            // The library endpoint reports no track totals here, so 0 means "size unknown".
            refs.add(new PlaylistRef(id, name, url, artworkUrl(attributes.path("artwork")), 0));
        }
        return refs;
    }

    public List<Track> search(String term, String storefront, int limit) {
        if (term == null || term.isBlank()) {
            return List.of();
        }
        String region = normalizeStorefront(storefront);
        JsonNode root = get("/v1/catalog/" + region + "/search",
                Map.of(
                        "term", term.trim(),
                        "types", "songs",
                        "limit", String.valueOf(Math.max(1, Math.min(limit, 25)))
                ), null);
        JsonNode songs = root.path("results").path("songs").path("data");
        List<Track> tracks = new ArrayList<>();
        if (songs.isArray()) {
            for (JsonNode song : songs) {
                Track track = mapTrack(song);
                if (track != null) {
                    tracks.add(track);
                }
            }
        }
        return tracks;
    }

    public CreatedPlaylist createPlaylist(String userToken, String storefront, String name, String description) {
        requireUserToken(userToken);
        String region = normalizeStorefront(storefront);

        ObjectNode body = objectMapper.createObjectNode();
        ObjectNode attributes = body.putObject("attributes");
        attributes.put("name", name);
        attributes.put("description", description);

        JsonNode root = post("/v1/me/library/playlists", body.toString(), userToken);
        JsonNode item = firstItem(root, "Apple Music 未返回新建歌单");
        String id = item.path("id").asText("");
        if (id.isBlank()) {
            throw ProviderException.upstream("Apple Music 未返回新歌单 ID，请稍后重试");
        }
        String finalName = item.path("attributes").path("name").asText(name);
        String url = "https://music.apple.com/" + region + "/library/playlist/" + id;
        return new CreatedPlaylist(id, finalName, url, 0, Map.of("storefront", region));
    }

    public void addTracks(String userToken, CreatedPlaylist playlist, List<Track> tracks) {
        requireUserToken(userToken);
        if (tracks.isEmpty()) {
            return;
        }
        int batchSize = Math.max(1, Math.min(properties.getMigration().getBatchSize(), PAGE_SIZE));
        for (int start = 0; start < tracks.size(); start += batchSize) {
            int end = Math.min(start + batchSize, tracks.size());
            List<Track> batch = tracks.subList(start, end);

            ObjectNode body = objectMapper.createObjectNode();
            ArrayNode data = body.putArray("data");
            for (Track track : batch) {
                if (track.providerTrackId().isBlank()) {
                    continue;
                }
                ObjectNode item = data.addObject();
                item.put("id", track.providerTrackId());
                item.put("type", "songs");
            }
            post("/v1/me/library/playlists/" + playlist.id() + "/tracks", body.toString(), userToken);
            log.info("Apple playlist {}: wrote {}/{} tracks", playlist.id(), end, tracks.size());
            if (end < tracks.size()) {
                sleep(properties.getMigration().getRequestIntervalMs());
            }
        }
    }

    private List<Track> fetchTracks(String path, String userToken) {
        List<Track> tracks = new ArrayList<>();
        int offset = 0;
        for (int page = 0; page < 10; page++) {
            JsonNode root = get(path, Map.of(
                    "limit", String.valueOf(PAGE_SIZE),
                    "offset", String.valueOf(offset)
            ), userToken);
            JsonNode data = root.path("data");
            if (!data.isArray() || data.isEmpty()) {
                break;
            }
            for (JsonNode item : data) {
                Track track = mapTrack(item);
                if (track != null) {
                    tracks.add(track);
                }
            }
            offset += data.size();
            if (data.size() < PAGE_SIZE) {
                break;
            }
        }
        return tracks;
    }

    private Track mapTrack(JsonNode item) {
        JsonNode attributes = item.path("attributes");
        String id = item.path("id").asText("");
        String title = attributes.path("name").asText("");
        if (id.isBlank() || title.isBlank()) {
            return null;
        }
        String artist = attributes.path("artistName").asText("");
        String album = attributes.path("albumName").asText("");
        int duration = Math.max(0, attributes.path("durationInMillis").asInt(0) / 1000);
        String artwork = artworkUrl(attributes.path("artwork"));
        return new Track(id, title, artist, album, duration, artwork, 0);
    }

    private JsonNode get(String path, Map<String, String> query, String userToken) {
        UriComponentsBuilder builder = UriComponentsBuilder.fromUriString(API_BASE).path(path);
        for (Map.Entry<String, String> entry : query.entrySet()) {
            builder.queryParam(entry.getKey(), entry.getValue());
        }
        String uri = builder.build().encode().toUriString();
        try {
            RestClient.RequestHeadersSpec<?> spec = restClient.get()
                    .uri(uri)
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + tokenService.token())
                    .header(HttpHeaders.USER_AGENT, USER_AGENT);
            if (userToken != null && !userToken.isBlank()) {
                spec = spec.header("Music-User-Token", userToken);
            }
            JsonNode response = spec.retrieve().body(JsonNode.class);
            if (response == null) {
                throw ProviderException.upstream("Apple Music 返回了空响应");
            }
            return response;
        } catch (RestClientResponseException ex) {
            throw mapHttpError(ex);
        } catch (ResourceAccessException ex) {
            throw ProviderException.upstream("Apple Music 响应超时，请稍后重试");
        }
    }

    private JsonNode post(String path, String body, String userToken) {
        requireUserToken(userToken);
        String uri = UriComponentsBuilder.fromUriString(API_BASE).path(path).build().encode().toUriString();
        try {
            return restClient.post()
                    .uri(uri)
                    .contentType(MediaType.APPLICATION_JSON)
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + tokenService.token())
                    .header(HttpHeaders.USER_AGENT, USER_AGENT)
                    .header("Music-User-Token", userToken)
                    .body(body)
                    .retrieve()
                    .body(JsonNode.class);
        } catch (RestClientResponseException ex) {
            throw mapHttpError(ex);
        } catch (ResourceAccessException ex) {
            throw ProviderException.upstream("Apple Music 响应超时，请稍后重试");
        }
    }

    private ProviderException mapHttpError(RestClientResponseException ex) {
        int status = ex.getStatusCode().value();
        String detail = errorDetail(ex);
        if (status == 401) {
            return ProviderException.unauthorized("Apple Music 授权已过期或无效，请重新授权" + detail);
        }
        if (status == 403) {
            return ProviderException.unauthorized("Apple Music 拒绝访问，请确认账号已开通 Apple Music 订阅" + detail);
        }
        if (status == 404) {
            return ProviderException.notFound("Apple Music 歌单不存在或不可访问");
        }
        if (status == 429) {
            return ProviderException.rateLimited("Apple Music 请求过于频繁，请稍后再试");
        }
        return ProviderException.upstream("Apple Music 暂时不可用（HTTP " + status + "）" + detail);
    }

    private String errorDetail(RestClientResponseException ex) {
        try {
            JsonNode errors = objectMapper.readTree(ex.getResponseBodyAsString()).path("errors");
            if (errors.isArray() && !errors.isEmpty()) {
                JsonNode first = errors.get(0);
                String detail = first.path("detail").asText("");
                if (detail.isBlank()) {
                    detail = first.path("title").asText("");
                }
                if (!detail.isBlank()) {
                    return "：" + truncate(detail, 100);
                }
            }
        } catch (Exception ignored) {
            // Response body is not JSON; keep the generic message.
        }
        return "";
    }

    private JsonNode firstItem(JsonNode root, String errorMessage) {
        JsonNode data = root.path("data");
        if (!data.isArray() || data.isEmpty()) {
            throw ProviderException.notFound(errorMessage);
        }
        return data.get(0);
    }

    private String normalizeStorefront(String storefront) {
        String value = storefront == null || storefront.isBlank()
                ? properties.getApple().getDefaultStorefront()
                : storefront;
        if (value == null || !value.matches("[A-Za-z]{2,3}")) {
            return "cn";
        }
        return value.toLowerCase();
    }

    private static void requireUserToken(String userToken) {
        if (userToken == null || userToken.isBlank()) {
            throw ProviderException.unauthorized("Apple Music 授权已失效，请重新连接");
        }
    }

    private static String artworkUrl(JsonNode artwork) {
        String url = artwork.path("url").asText("");
        if (url.isBlank()) {
            return "";
        }
        return url.replace("{w}", "300").replace("{h}", "300");
    }

    private static String truncate(String value, int max) {
        if (value == null) {
            return "";
        }
        String clean = value.replaceAll("\\s+", " ").trim();
        return clean.length() <= max ? clean : clean.substring(0, max) + "…";
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
        }
    }
}
