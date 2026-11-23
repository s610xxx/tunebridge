package com.tunebridge.provider.apple;

import com.tunebridge.config.TuneBridgeProperties;
import com.tunebridge.domain.ConnectionMode;
import com.tunebridge.domain.CreatedPlaylist;
import com.tunebridge.domain.Playlist;
import com.tunebridge.domain.PlaylistRef;
import com.tunebridge.domain.ProviderConnection;
import com.tunebridge.domain.ProviderId;
import com.tunebridge.domain.Track;
import com.tunebridge.provider.MusicProvider;
import com.tunebridge.provider.ProviderException;
import com.tunebridge.provider.demo.DemoCatalog;
import com.tunebridge.provider.demo.DemoPlaylists;
import com.tunebridge.provider.demo.DemoStore;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.springframework.stereotype.Component;

@Component
public class AppleMusicProvider implements MusicProvider {

    private static final int SOURCE_LIST_LIMIT = 50;

    private final AppleMusicClient client;
    private final AppleAccessTokenService tokens;
    private final DemoCatalog demoCatalog;
    private final DemoStore demoStore;
    private final TuneBridgeProperties properties;

    public AppleMusicProvider(AppleMusicClient client, AppleAccessTokenService tokens,
                              DemoCatalog demoCatalog, DemoStore demoStore,
                              TuneBridgeProperties properties) {
        this.client = client;
        this.tokens = tokens;
        this.demoCatalog = demoCatalog;
        this.demoStore = demoStore;
        this.properties = properties;
    }

    @Override
    public ProviderId id() {
        return ProviderId.APPLE_MUSIC;
    }

    @Override
    public String sampleUrl() {
        return "https://music.apple.com/cn/playlist/jason-mraz-essentials/pl.77d8b27b5ca1442e8378920504f115d1";
    }

    @Override
    public ProviderConnection connectDemo(String sessionId) {
        return new ProviderConnection(ProviderId.APPLE_MUSIC, ConnectionMode.DEMO,
                "演示账号 · Bridge", Map.of("demoSessionId", sessionId));
    }

    @Override
    public ProviderConnection connectReal(Map<String, String> credentials) {
        String userToken = credentials.get("musicUserToken");
        if (userToken == null || userToken.isBlank()) {
            throw ProviderException.badRequest("请粘贴 Apple Music 网页版的 media-user-token");
        }
        String storefront = client.validate(userToken.trim());
        return new ProviderConnection(ProviderId.APPLE_MUSIC, ConnectionMode.REAL,
                "Apple Music · " + storefront.toUpperCase(Locale.ROOT) + (tokens.writesAllowed() ? "" : "（仅迁出）"),
                Map.of("musicUserToken", userToken.trim(), "storefront", storefront));
    }

    @Override
    public Playlist fetchPlaylist(ProviderConnection connection, String url) {
        if (url != null && url.startsWith("demo://")) {
            if (connection == null || connection.mode() != ConnectionMode.DEMO) {
                throw ProviderException.badRequest("演示歌单链接需要先连接 Apple Music 演示账号");
            }
            return fetchDemoPlaylist(connection, url);
        }
        if (connection == null) {
            throw ProviderException.notConnected("请先连接 Apple Music");
        }
        if (connection.mode() == ConnectionMode.DEMO) {
            throw ProviderException.badRequest("当前是演示连接，请使用演示歌单链接，或切换为真实 Apple Music 连接");
        }
        return client.fetchPlaylist(url,
                connection.credential("musicUserToken"),
                connection.credential("storefront"));
    }

    @Override
    public List<PlaylistRef> listPlaylists(ProviderConnection connection) {
        if (connection == null) {
            throw ProviderException.notConnected("请先连接 Apple Music（来源平台）");
        }
        if (connection.mode() == ConnectionMode.DEMO) {
            return DemoPlaylists.of(demoCatalog, demoStore, ProviderId.APPLE_MUSIC, sessionId(connection));
        }
        return client.listLibraryPlaylists(connection.credential("musicUserToken"),
                connection.credential("storefront"), SOURCE_LIST_LIMIT);
    }

    @Override
    public List<Track> searchTracks(ProviderConnection connection, String title, String artist, int limit) {
        if (connection != null && connection.mode() == ConnectionMode.DEMO) {
            return demoCatalog.targetCatalog(ProviderId.APPLE_MUSIC);
        }
        String storefront = connection == null
                ? properties.getApple().getDefaultStorefront()
                : connection.credential("storefront");
        String term = (title + " " + (artist == null ? "" : artist)).trim();
        return client.search(term, storefront, limit);
    }

    @Override
    public CreatedPlaylist createPlaylist(ProviderConnection connection, String name, String description) {
        if (connection == null) {
            throw ProviderException.notConnected("请先连接 Apple Music（目标平台）");
        }
        if (connection.mode() == ConnectionMode.DEMO) {
            Playlist playlist = demoStore.create(sessionId(connection), ProviderId.APPLE_MUSIC, name, description);
            return CreatedPlaylist.of(playlist.id(), playlist.name(), playlist.webUrl(), 0);
        }
        requireWritable();
        return client.createPlaylist(connection.credential("musicUserToken"),
                connection.credential("storefront"), name, description);
    }

    @Override
    public void addTracks(ProviderConnection connection, CreatedPlaylist playlist, List<Track> tracks) {
        if (connection == null) {
            throw ProviderException.notConnected("请先连接 Apple Music（目标平台）");
        }
        if (connection.mode() == ConnectionMode.DEMO) {
            demoStore.addTracks(sessionId(connection), ProviderId.APPLE_MUSIC, playlist.id(), tracks);
            return;
        }
        requireWritable();
        client.addTracks(connection.credential("musicUserToken"), playlist, tracks);
    }

    /** 迁入 Apple 要用开发者账号签发的令牌；非官方网页通道只放开读取。 */
    private void requireWritable() {
        if (!tokens.writesAllowed()) {
            throw ProviderException.notConfigured(
                    "音桥已停用「迁入 Apple Music」：真实账号写入需要 Apple 开发者账号。"
                            + "请把 QQ 音乐或网易云音乐作为目标平台，或用「备份歌单」导出 Apple 歌单");
        }
    }

    private Playlist fetchDemoPlaylist(ProviderConnection connection, String url) {
        String sessionId = sessionId(connection);
        if ("demo://builtin".equals(url) || "demo://playlist/builtin".equals(url)) {
            return demoCatalog.builtin(ProviderId.APPLE_MUSIC);
        }
        String prefix = "demo://library/";
        if (url.startsWith(prefix)) {
            return demoStore.find(sessionId, ProviderId.APPLE_MUSIC, url.substring(prefix.length()));
        }
        throw ProviderException.badRequest("演示歌单链接无法识别，请使用 demo://builtin 或演示音乐库中的歌单");
    }

    private String sessionId(ProviderConnection connection) {
        String sessionId = connection.credential("demoSessionId");
        if (sessionId == null || sessionId.isBlank()) {
            throw ProviderException.notConnected("演示会话已过期，请重新连接演示账号");
        }
        return sessionId;
    }
}
