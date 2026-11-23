package com.tunebridge.provider.netease;

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
import com.tunebridge.provider.demo.DemoStore;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

@Component
public class NeteaseMusicProvider implements MusicProvider {
    private final NeteaseMusicClient client;
    private final NeteaseWebClient webClient;
    private final NeteaseLocalAccess access;
    private final DemoCatalog catalog;
    private final DemoStore store;

    public NeteaseMusicProvider(NeteaseMusicClient client, NeteaseWebClient webClient,
                                NeteaseLocalAccess access, DemoCatalog catalog, DemoStore store) {
        this.client = client;
        this.webClient = webClient;
        this.access = access;
        this.catalog = catalog;
        this.store = store;
    }

    @Override
    public ProviderId id() { return ProviderId.NETEASE_MUSIC; }

    @Override
    public String sampleUrl() { return ""; }

    @Override
    public ProviderConnection connectDemo(String sessionId) {
        return new ProviderConnection(id(), ConnectionMode.DEMO, "网易云音乐 · 演示账号",
                Map.of("demoSessionId", sessionId));
    }

    @Override
    public ProviderConnection connectReal(Map<String, String> credentials) {
        String cookie = credentials == null || credentials.get("cookie") == null ? "" : credentials.get("cookie");
        if (!cookie.isBlank()) {
            String nickname = webClient.accountName(cookie);
            return new ProviderConnection(id(), ConnectionMode.REAL, "网易云音乐 · " + nickname,
                    Map.of("neteaseCookie", cookie));
        }
        // 配对码连接：PUBLIC 和 LOCAL 模式都支持
        if (!access.enabled()) {
            throw ProviderException.notConfigured("网易云本机模式尚未启用，请配置配对码或使用扫码登录");
        }
        String pairingCode = credentials == null ? null : credentials.get("pairingCode");
        // 如果配对码为空，说明用户通过 ncm-cli 扫码登录，直接验证 CLI 登录状态
        if (pairingCode == null || pairingCode.isBlank()) {
            try {
                // 验证 ncm-cli 是否已登录
                client.validateLogin();
                // 使用一个特殊的 grant 标识这是通过 ncm-cli 登录的连接
                String grant = "ncm-cli-auto-" + System.currentTimeMillis();
                return new ProviderConnection(id(), ConnectionMode.REAL, "网易云音乐 · ncm-cli 登录",
                        Map.of("neteaseGrant", grant));
            } catch (RuntimeException ex) {
                throw ProviderException.notConnected("ncm-cli 未登录或登录已过期，请先完成扫码登录");
            }
        }
        String grant = access.authorize(pairingCode);
        try {
            // PUBLIC 模式下不调用 CLI 验证登录态（避免子进程调用），LOCAL 模式下需要验证
            boolean isPublic = "PUBLIC".equalsIgnoreCase(System.getenv("TUNEBRIDGE_SECURITY_MODE"));
            if (!isPublic) {
                access.withGrant(grant, () -> { client.validateLogin(); return null; });
            }
            return new ProviderConnection(id(), ConnectionMode.REAL, "网易云音乐 · 本机账号",
                    Map.of("neteaseGrant", grant));
        } catch (RuntimeException ex) {
            access.revoke(grant);
            throw ex;
        }
    }

    @Override
    public Playlist fetchPlaylist(ProviderConnection connection, String url) {
        throw ProviderException.badRequest("网易云音乐暂不支持作为来源平台");
    }

    @Override
    public List<PlaylistRef> listPlaylists(ProviderConnection connection) {
        throw ProviderException.badRequest("网易云音乐暂不支持作为来源平台");
    }

    @Override
    public List<Track> searchTracks(ProviderConnection connection, String title, String artist, int limit) {
        if (isDemo(connection)) return catalog.targetCatalog(id());
        String cookie = webCookie(connection);
        if (cookie != null) return webClient.searchTracks(cookie, title, artist, limit);
        return access.withGrant(grant(connection), () -> client.searchTracks(title, artist, limit));
    }

    @Override
    public CreatedPlaylist createPlaylist(ProviderConnection connection, String name, String description) {
        if (isDemo(connection)) {
            Playlist playlist = store.create(sessionId(connection), id(), name, description);
            return CreatedPlaylist.of(playlist.id(), playlist.name(), playlist.webUrl(), 0);
        }
        String cookie = webCookie(connection);
        if (cookie != null) return webClient.createPlaylist(cookie, name);
        return access.withGrant(grant(connection), () -> client.createPlaylist(name));
    }

    @Override
    public void addTracks(ProviderConnection connection, CreatedPlaylist playlist, List<Track> tracks) {
        if (isDemo(connection)) {
            store.addTracks(sessionId(connection), id(), playlist.id(), tracks);
            return;
        }
        String cookie = webCookie(connection);
        if (cookie != null) {
            webClient.addTracks(cookie, playlist, tracks);
            return;
        }
        access.withGrant(grant(connection), () -> { client.addTracks(playlist, tracks); return null; });
    }

    private boolean isDemo(ProviderConnection connection) {
        return connection != null && connection.provider() == id() && connection.mode() == ConnectionMode.DEMO;
    }

    /** 网页端登录返回该连接的凭据；本机 CLI 连接返回 null，交给 grant 分支。 */
    private String webCookie(ProviderConnection connection) {
        if (connection == null || connection.provider() != id() || connection.mode() != ConnectionMode.REAL) {
            throw ProviderException.notConnected("请先连接网易云音乐目标账号");
        }
        String cookie = connection.credential("neteaseCookie");
        return cookie == null || cookie.isBlank() ? null : cookie;
    }

    private String grant(ProviderConnection connection) {
        if (connection == null || connection.provider() != id() || connection.mode() != ConnectionMode.REAL
                || connection.credential("neteaseGrant") == null || connection.credential("neteaseGrant").isBlank()) {
            throw ProviderException.notConnected("请先连接网易云音乐目标账号");
        }
        return connection.credential("neteaseGrant");
    }

    private String sessionId(ProviderConnection connection) {
        String sessionId = connection.credential("demoSessionId");
        if (sessionId == null || sessionId.isBlank()) {
            throw ProviderException.notConnected("演示会话已过期，请重新连接演示账号");
        }
        return sessionId;
    }
}
