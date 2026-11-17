package com.tunebridge.provider.qq;

import com.tunebridge.domain.ConnectionMode;
import com.tunebridge.domain.CreatedPlaylist;
import com.tunebridge.domain.Playlist;
import com.tunebridge.domain.ProviderConnection;
import com.tunebridge.domain.ProviderId;
import com.tunebridge.domain.Track;
import com.tunebridge.provider.MusicProvider;
import com.tunebridge.provider.ProviderException;
import com.tunebridge.provider.demo.DemoCatalog;
import com.tunebridge.provider.demo.DemoStore;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

@Component
public class QqMusicProvider implements MusicProvider {

    private final QqMusicClient client;
    private final DemoCatalog demoCatalog;
    private final DemoStore demoStore;

    public QqMusicProvider(QqMusicClient client, DemoCatalog demoCatalog, DemoStore demoStore) {
        this.client = client;
        this.demoCatalog = demoCatalog;
        this.demoStore = demoStore;
    }

    @Override
    public ProviderId id() {
        return ProviderId.QQ_MUSIC;
    }

    @Override
    public String sampleUrl() {
        return "https://y.qq.com/n/ryqq/playlist/7300098051";
    }

    @Override
    public ProviderConnection connectDemo(String sessionId) {
        return new ProviderConnection(ProviderId.QQ_MUSIC, ConnectionMode.DEMO,
                "演示账号 · 阿桥", Map.of("demoSessionId", sessionId));
    }

    @Override
    public ProviderConnection connectReal(Map<String, String> credentials) {
        QqCookie cookie = QqCookie.parse(credentials.get("cookie"));
        String maskedUin = client.validate(cookie);
        return new ProviderConnection(ProviderId.QQ_MUSIC, ConnectionMode.REAL,
                "QQ 音乐 · " + maskedUin, Map.of("cookie", cookie.rawCookie()));
    }

    @Override
    public Playlist fetchPlaylist(ProviderConnection connection, String url) {
        if (url != null && url.startsWith("demo://")) {
            if (connection == null || connection.mode() != ConnectionMode.DEMO) {
                throw ProviderException.badRequest("演示歌单链接需要先连接 QQ 音乐演示账号");
            }
            return fetchDemoPlaylist(connection, url);
        }
        if (connection != null && connection.mode() == ConnectionMode.DEMO) {
            throw ProviderException.badRequest("当前是演示连接，请使用演示歌单链接，或切换为真实 QQ 音乐连接");
        }
        QqCookie cookie = connection == null ? null : QqCookie.parse(connection.credential("cookie"));
        String playlistId = QqUrlParser.parsePlaylistId(url);
        return client.fetchPlaylist(playlistId, cookie);
    }

    @Override
    public List<Track> searchTracks(ProviderConnection connection, String title, String artist, int limit) {
        if (connection != null && connection.mode() == ConnectionMode.DEMO) {
            return demoCatalog.targetCatalog(ProviderId.QQ_MUSIC);
        }
        return client.searchTracks(title, artist, limit);
    }

    @Override
    public CreatedPlaylist createPlaylist(ProviderConnection connection, String name, String description) {
        if (connection == null) {
            throw ProviderException.notConnected("请先连接 QQ 音乐（目标平台）");
        }
        if (connection.mode() == ConnectionMode.DEMO) {
            Playlist playlist = demoStore.create(sessionId(connection), ProviderId.QQ_MUSIC, name, description);
            return CreatedPlaylist.of(playlist.id(), playlist.name(), playlist.webUrl(), 0);
        }
        QqCookie cookie = QqCookie.parse(connection.credential("cookie"));
        return client.createPlaylist(cookie, name, description);
    }

    @Override
    public void addTracks(ProviderConnection connection, CreatedPlaylist playlist, List<Track> tracks) {
        if (connection == null) {
            throw ProviderException.notConnected("请先连接 QQ 音乐（目标平台）");
        }
        if (connection.mode() == ConnectionMode.DEMO) {
            demoStore.addTracks(sessionId(connection), ProviderId.QQ_MUSIC, playlist.id(), tracks);
            return;
        }
        QqCookie cookie = QqCookie.parse(connection.credential("cookie"));
        client.addTracks(cookie, playlist, tracks);
    }

    private Playlist fetchDemoPlaylist(ProviderConnection connection, String url) {
        String sessionId = sessionId(connection);
        if ("demo://builtin".equals(url) || "demo://playlist/builtin".equals(url)) {
            return demoCatalog.builtin(ProviderId.QQ_MUSIC);
        }
        String prefix = "demo://library/";
        if (url.startsWith(prefix)) {
            return demoStore.find(sessionId, ProviderId.QQ_MUSIC, url.substring(prefix.length()));
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
