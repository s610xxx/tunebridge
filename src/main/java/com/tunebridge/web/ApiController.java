package com.tunebridge.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.tunebridge.config.SecurityProperties;
import com.tunebridge.config.TuneBridgeProperties;
import com.tunebridge.domain.ConnectionMode;
import com.tunebridge.domain.MigrationJob;
import com.tunebridge.domain.Playlist;
import com.tunebridge.domain.PlaylistRef;
import com.tunebridge.domain.ProviderConnection;
import com.tunebridge.domain.ProviderId;
import com.tunebridge.domain.Track;
import com.tunebridge.provider.MusicProvider;
import com.tunebridge.provider.ProviderException;
import com.tunebridge.provider.ProviderRegistry;
import com.tunebridge.provider.apple.AppleDeveloperTokenService;
import com.tunebridge.provider.demo.DemoStore;
import com.tunebridge.provider.netease.NeteaseLocalAccess;
import com.tunebridge.provider.netease.NeteaseQrLoginService;
import com.tunebridge.service.ConnectionService;
import com.tunebridge.service.MigrationService;
import com.tunebridge.service.MigrationHistory;
import com.tunebridge.security.CurrentUser;
import com.tunebridge.web.dto.ConnectionView;
import com.tunebridge.web.dto.JobView;
import com.tunebridge.web.dto.PlaylistView;
import com.tunebridge.web.dto.StateView;
import jakarta.servlet.http.HttpSession;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api")
public class ApiController {

    private static final Logger log = LoggerFactory.getLogger(ApiController.class);

    private final ProviderRegistry providerRegistry;
    private final ConnectionService connectionService;
    private final MigrationService migrationService;
    private final DemoStore demoStore;
    private final TuneBridgeProperties properties;
    private final SecurityProperties securityProperties;
    private final AppleDeveloperTokenService appleTokenService;
    private final NeteaseLocalAccess neteaseLocalAccess;
    private final NeteaseQrLoginService neteaseQrLogin;

    public ApiController(ProviderRegistry providerRegistry, ConnectionService connectionService,
                         MigrationService migrationService, DemoStore demoStore,
                         TuneBridgeProperties properties, SecurityProperties securityProperties,
                         AppleDeveloperTokenService appleTokenService,
                         NeteaseLocalAccess neteaseLocalAccess, NeteaseQrLoginService neteaseQrLogin) {
        this.providerRegistry = providerRegistry;
        this.connectionService = connectionService;
        this.migrationService = migrationService;
        this.demoStore = demoStore;
        this.properties = properties;
        this.securityProperties = securityProperties;
        this.appleTokenService = appleTokenService;
        this.neteaseLocalAccess = neteaseLocalAccess;
        this.neteaseQrLogin = neteaseQrLogin;
    }

    @GetMapping("/state")
    public StateView state(HttpSession session) {
        Map<ProviderId, ProviderConnection> current = connectionService.all(session);
        Map<String, ConnectionView> connections = new LinkedHashMap<>();
        List<StateView.ProviderView> providers = new ArrayList<>();
        for (ProviderId providerId : ProviderId.values()) {
            connections.put(providerId.name(), ConnectionView.from(current.get(providerId)));
            MusicProvider provider = providerRegistry.get(providerId);
            providers.add(new StateView.ProviderView(providerId.name(), providerId.label(), provider.sampleUrl()));
        }
        return new StateView(connections, providers, config());
    }

    @GetMapping("/config")
    public StateView.ConfigView config() {
        boolean appleReady = appleTokenService.configured();
        String developerToken = "";
        if (appleReady) {
            try {
                developerToken = appleTokenService.token();
            } catch (ProviderException ex) {
                appleReady = false;
                log.warn("Apple developer token is configured but unavailable: {}", ex.code());
            }
        }
        String authMode = securityProperties.getMode().name().toLowerCase();
        return new StateView.ConfigView(
                appleReady,
                properties.getDemo().isEnabled(),
                properties.getApple().getDefaultStorefront(),
                properties.getMigration().getMaxTracks(),
                developerToken,
                neteaseLocalAccess.enabled(),
                authMode
        );
    }

    @PostMapping("/connections/{provider}")
    public ConnectionView connect(@PathVariable("provider") String providerValue,
                                  @RequestBody ConnectRequest request,
                                  HttpSession session) {
        ProviderId providerId = ProviderId.from(providerValue);
        if (request == null || request.mode() == null) {
            throw ProviderException.badRequest("请选择连接方式");
        }
        if ("demo".equalsIgnoreCase(request.mode()) && !properties.getDemo().isEnabled()) {
            throw ProviderException.notConfigured("演示模式未开启，请使用真实账号连接");
        }
        Map<String, String> credentials = new LinkedHashMap<>();
        if (providerId == ProviderId.QQ_MUSIC) {
            credentials.put("cookie", request.cookie());
        } else if (providerId == ProviderId.APPLE_MUSIC) {
            credentials.put("musicUserToken", request.musicUserToken());
        } else if (providerId == ProviderId.NETEASE_MUSIC) {
            credentials.put("cookie", request.cookie());
            credentials.put("pairingCode", request.pairingCode());
        }
        ProviderConnection connection = connectionService.connect(session, providerId, request.mode(), credentials);
        return ConnectionView.from(connection);
    }

    @DeleteMapping("/connections/{provider}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void disconnect(@PathVariable("provider") String providerValue, HttpSession session) {
        connectionService.disconnect(session, ProviderId.from(providerValue));
    }

    @PostMapping("/connections/netease/qr")
    public NeteaseQrLoginService.StartView neteaseQrStart(HttpSession session) {
        return neteaseQrLogin.start(session);
    }

    @GetMapping("/connections/netease/qr/{loginId}")
    public NeteaseQrLoginService.PollView neteaseQrPoll(@PathVariable("loginId") String loginId,
                                                         HttpSession session) {
        return neteaseQrLogin.poll(session, loginId);
    }

    /** 启动 ncm-cli 后台登录，返回二维码 URL */
    @PostMapping("/connections/netease/cli-login")
    public Map<String, Object> neteaseCliLoginStart() {
        try {
            // 执行 ncm-cli login --background
            Process process = new ProcessBuilder("ncm-cli", "login", "--background")
                    .redirectErrorStream(true)
                    .start();
            
            StringBuilder output = new StringBuilder();
            try (var reader = new java.io.BufferedReader(
                    new java.io.InputStreamReader(process.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line);
                }
            }
            
            if (!process.waitFor(10, java.util.concurrent.TimeUnit.SECONDS)) {
                process.destroyForcibly();
                throw ProviderException.upstream("ncm-cli 登录启动超时");
            }
            
            if (process.exitValue() != 0) {
                throw ProviderException.upstream("ncm-cli 登录启动失败: " + output);
            }
            
            // 解析 JSON 输出获取二维码 URL
            var mapper = new com.fasterxml.jackson.databind.ObjectMapper();
            JsonNode result = mapper.readTree(output.toString());
            String qrCodeUrl = result.path("qrCodeUrl").asText("");
            String clickableUrl = result.path("clickableUrl").asText("");
            
            return Map.of(
                "success", true,
                "qrCodeUrl", qrCodeUrl,
                "clickableUrl", clickableUrl
            );
        } catch (Exception ex) {
            throw ProviderException.upstream("ncm-cli 登录启动失败: " + ex.getMessage());
        }
    }

    /** 轮询 ncm-cli 登录状态 */
    @GetMapping("/connections/netease/cli-login/status")
    public Map<String, Object> neteaseCliLoginStatus() {
        try {
            Process process = new ProcessBuilder("ncm-cli", "login", "--check")
                    .redirectErrorStream(true)
                    .start();
            
            StringBuilder output = new StringBuilder();
            try (var reader = new java.io.BufferedReader(
                    new java.io.InputStreamReader(process.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line);
                }
            }
            
            if (!process.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) {
                process.destroyForcibly();
                return Map.of("status", "checking");
            }
            
            var mapper = new com.fasterxml.jackson.databind.ObjectMapper();
            JsonNode result = mapper.readTree(output.toString());
            boolean loggedIn = result.path("loggedIn").asBoolean(false);
            String message = result.path("message").asText("");
            
            return Map.of(
                "status", loggedIn ? "logged_in" : "waiting",
                "message", message
            );
        } catch (Exception ex) {
            return Map.of("status", "error", "message", ex.getMessage());
        }
    }

    /** 使用已登录的 ncm-cli 建立连接（无需配对码） */
    @PostMapping("/connections/netease/cli-connect")
    public ConnectionView neteaseCliConnect(HttpSession session) {
        // 先检查 ncm-cli 是否已登录
        try {
            Process process = new ProcessBuilder("ncm-cli", "login", "--check")
                    .redirectErrorStream(true)
                    .start();
            
            StringBuilder output = new StringBuilder();
            try (var reader = new java.io.BufferedReader(
                    new java.io.InputStreamReader(process.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line);
                }
            }
            
            if (!process.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) {
                process.destroyForcibly();
                throw ProviderException.notConnected("ncm-cli 登录检查超时");
            }
            
            if (process.exitValue() != 0) {
                throw ProviderException.notConnected("ncm-cli 未登录或登录已过期");
            }
            
            var mapper = new com.fasterxml.jackson.databind.ObjectMapper();
            JsonNode result = mapper.readTree(output.toString());
            boolean loggedIn = result.path("loggedIn").asBoolean(false);
            
            if (!loggedIn) {
                throw ProviderException.notConnected("ncm-cli 未登录，请先完成扫码登录");
            }
        } catch (ProviderException ex) {
            throw ex;
        } catch (Exception ex) {
            throw ProviderException.upstream("ncm-cli 状态检查失败: " + ex.getMessage());
        }
        
        // 使用空配对码连接（NeteaseMusicProvider 会处理这种情况）
        Map<String, String> credentials = Map.of("pairingCode", "");
        ProviderConnection connection = connectionService.connect(session, ProviderId.NETEASE_MUSIC, "real", credentials);
        return ConnectionView.from(connection);
    }

    @GetMapping("/playlists")
    public List<PlaylistRef> sourcePlaylists(@RequestParam("provider") String providerValue, HttpSession session) {
        ProviderId providerId = ProviderId.from(providerValue);
        MusicProvider provider = providerRegistry.get(providerId);
        return provider.listPlaylists(connectionService.get(session, providerId));
    }

    @PostMapping("/playlists/preview")
    public PlaylistView preview(@RequestBody PreviewRequest request, HttpSession session) {
        return PlaylistView.from(fetchPlaylist(request, session), properties.getMigration().getMaxTracks());
    }

    @PostMapping("/playlists/backup")
    public PlaylistView backup(@RequestBody PreviewRequest request, HttpSession session) {
        return PlaylistView.from(fetchPlaylist(request, session), Integer.MAX_VALUE);
    }

    private Playlist fetchPlaylist(PreviewRequest request, HttpSession session) {
        ProviderId providerId = ProviderId.from(request.provider());
        if (request.url() == null || request.url().isBlank()) {
            throw ProviderException.badRequest("请粘贴来源歌单链接");
        }
        MusicProvider provider = providerRegistry.get(providerId);
        ProviderConnection connection = connectionService.get(session, providerId);
        return provider.fetchPlaylist(connection, request.url().trim());
    }

    @PostMapping("/backups/migrations")
    public JobView startBackupMigration(@RequestBody BackupMigrationRequest request, HttpSession session) {
        if (request == null || request.targetProvider() == null) {
            throw ProviderException.badRequest("请选择目标平台");
        }
        ProviderId target = ProviderId.from(request.targetProvider());
        List<Track> tracks = new ArrayList<>();
        if (request.tracks() != null) {
            for (BackupTrack item : request.tracks()) {
                if (item == null) {
                    continue;
                }
                int duration = item.durationSec() == null ? 0 : Math.max(0, item.durationSec());
                tracks.add(new Track("", item.title(), item.artist(), item.album(), duration, "", 0));
            }
        }
        MigrationJob job = migrationService.createBackupJob(session, CurrentUser.id(), target,
                request.playlistName(), request.sourceName(), tracks);
        return JobView.from(job);
    }

    @PostMapping("/migrations")
    public JobView startMigration(@RequestBody MigrationRequest request, HttpSession session) {
        ProviderId source = ProviderId.from(request.sourceProvider());
        ProviderId target = ProviderId.from(request.targetProvider());
        MigrationJob job = migrationService.createJob(session, CurrentUser.id(), source, request.sourceUrl(),
                target, request.playlistName());
        return JobView.from(job);
    }

    @GetMapping("/migrations")
    public MigrationHistory.Page history(@RequestParam(defaultValue = "0") int offset,
                                         @RequestParam(defaultValue = "20") int limit,
                                         @RequestParam(required = false) String source,
                                         @RequestParam(required = false) String target,
                                         @RequestParam(required = false) String status,
                                         @RequestParam(required = false) String from,
                                         @RequestParam(required = false) String to) {
        return migrationService.listHistory(CurrentUser.id(), offset, limit,
                MigrationHistory.Filters.of(source, target, status, from, to));
    }

    @GetMapping("/migrations/current")
    public JobView currentMigration(HttpSession session) {
        return migrationService.currentJob(session, CurrentUser.id());
    }

    @GetMapping("/migrations/{id}")
    public JobView migration(@PathVariable("id") String id, HttpSession session) {
        return migrationService.getJobView(session, CurrentUser.id(), id);
    }

    @PostMapping("/migrations/{id}/abandon")
    public JobView abandonMigration(@PathVariable("id") String id, HttpSession session) {
        return migrationService.abandonJob(session, CurrentUser.id(), id);
    }

    @PostMapping("/migrations/{id}/confirm")
    public JobView confirmMigration(@PathVariable("id") String id, @RequestBody ConfirmRequest request,
                                    HttpSession session) {
        if (request == null || request.selectedIndices() == null) {
            throw ProviderException.badRequest("请至少选择一首已匹配的歌曲");
        }
        List<Integer> indices = request.selectedIndices().stream().map(index -> {
            if (index == null || !index.isIntegralNumber() || !index.canConvertToInt()) {
                throw ProviderException.badRequest("所选歌曲序号必须是整数");
            }
            return index.intValue();
        }).toList();
        return JobView.from(migrationService.confirmJob(session, CurrentUser.id(), id, indices));
    }

    @GetMapping("/demo/library")
    public List<PlaylistView> demoLibrary(@RequestParam("provider") String providerValue, HttpSession session) {
        ProviderId providerId = ProviderId.from(providerValue);
        ProviderConnection connection = connectionService.get(session, providerId);
        if (connection == null || connection.mode() != ConnectionMode.DEMO) {
            return List.of();
        }
        return demoStore.list(session.getId(), providerId).stream()
                .map(playlist -> PlaylistView.from(playlist, Integer.MAX_VALUE))
                .toList();
    }

    public record ConnectRequest(String mode, String cookie, String musicUserToken, String pairingCode) {
    }

    public record PreviewRequest(String provider, String url) {
    }

    public record MigrationRequest(String sourceProvider, String sourceUrl,
                                   String targetProvider, String playlistName) {
    }

    public record BackupMigrationRequest(String targetProvider, String playlistName,
                                         String sourceName, List<BackupTrack> tracks) {
    }

    public record BackupTrack(String title, String artist, String album, Integer durationSec) {
    }

    public record ConfirmRequest(List<JsonNode> selectedIndices) {
    }
}
