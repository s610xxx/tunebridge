package com.tunebridge.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.tunebridge.config.TuneBridgeProperties;
import com.tunebridge.domain.ConnectionMode;
import com.tunebridge.domain.CreatedPlaylist;
import com.tunebridge.domain.JobStatus;
import com.tunebridge.domain.MigrationJob;
import com.tunebridge.domain.Playlist;
import com.tunebridge.domain.ProviderConnection;
import com.tunebridge.domain.ProviderId;
import com.tunebridge.domain.Track;
import com.tunebridge.domain.TrackMatch;
import com.tunebridge.provider.MusicProvider;
import com.tunebridge.provider.ProviderException;
import com.tunebridge.provider.ProviderRegistry;
import com.tunebridge.security.AccountPrincipal;
import com.tunebridge.security.AccountService;
import com.tunebridge.service.ConnectionService;
import com.tunebridge.service.MigrationHistory;
import com.tunebridge.service.MigrationService;
import com.tunebridge.service.TrackMatcher;
import com.tunebridge.testsupport.BridgeRequests;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.stream.IntStream;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

@SpringBootTest(properties = "spring.datasource.url=jdbc:h2:mem:flow_test;DB_CLOSE_DELAY=-1")
@AutoConfigureMockMvc
class DemoMigrationFlowTest {

    private static final String PASSWORD = "bridge-test-password";

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private AccountService accounts;

    private AccountPrincipal principal;
    private String ownerId;

    @BeforeEach
    void registerAccount() {
        String username = "t" + UUID.randomUUID().toString().replace("-", "").substring(0, 15);
        accounts.register(username, PASSWORD, null);
        principal = accounts.loadUserByUsername(username);
        ownerId = principal.id();
    }

    @Test
    void migratesBothDirectionsInDemoMode() throws Exception {
        MockHttpSession session = new MockHttpSession();
        connectDemo(session, "QQ_MUSIC");
        connectDemo(session, "APPLE_MUSIC");

        JsonNode state = getJson("/api/state", session);
        assertThat(state.path("connections").path("QQ_MUSIC").path("connected").asBoolean()).isTrue();
        assertThat(state.path("connections").path("QQ_MUSIC").path("mode").asText()).isEqualTo("DEMO");
        assertThat(state.path("connections").path("APPLE_MUSIC").path("connected").asBoolean()).isTrue();
        assertThat(state.path("config").path("demoEnabled").asBoolean()).isTrue();

        JsonNode preview = postJson("/api/playlists/preview", session,
                Map.of("provider", "QQ_MUSIC", "url", "demo://builtin"));
        assertThat(preview.path("totalTracks").asInt()).isEqualTo(12);
        assertThat(preview.path("name").asText()).contains("夏夜循环");

        JsonNode firstJob = startMigration(session, "QQ_MUSIC", "demo://builtin", "APPLE_MUSIC", "");
        JsonNode firstPreview = awaitJob(session, firstJob.path("id").asText());
        assertThat(firstPreview.path("status").asText()).isEqualTo("AWAITING_CONFIRMATION");
        assertThat(firstPreview.path("target").path("mode").asText()).isEqualTo("DEMO");
        assertThat(firstPreview.path("readOnly").asBoolean()).isFalse();
        assertThat(getJson("/api/demo/library?provider=APPLE_MUSIC", session)).isEmpty();
        confirmAllMatches(session, firstPreview);
        JsonNode firstDone = awaitJob(session, firstJob.path("id").asText());
        assertThat(firstDone.path("status").asText()).isEqualTo("COMPLETED");
        assertThat(firstDone.path("result").path("addedCount").asInt()).isEqualTo(10);
        assertThat(firstDone.path("result").path("unmatchedCount").asInt()).isEqualTo(2);
        assertThat(firstDone.path("result").path("matchRate").asInt()).isEqualTo(83);
        assertThat(firstDone.path("matches")).hasSize(12);
        assertThat(firstDone.path("result").path("playlistUrl").asText()).startsWith("demo://library/");

        JsonNode appleLibrary = getJson("/api/demo/library?provider=APPLE_MUSIC", session);
        assertThat(appleLibrary).hasSize(1);
        assertThat(appleLibrary.get(0).path("totalTracks").asInt()).isEqualTo(10);
        String applePlaylistUrl = appleLibrary.get(0).path("webUrl").asText();
        assertThat(applePlaylistUrl).startsWith("demo://library/");

        JsonNode reversePreview = postJson("/api/playlists/preview", session,
                Map.of("provider", "APPLE_MUSIC", "url", applePlaylistUrl));
        assertThat(reversePreview.path("totalTracks").asInt()).isEqualTo(10);

        JsonNode secondJob = startMigration(session, "APPLE_MUSIC", applePlaylistUrl, "QQ_MUSIC", "回迁测试");
        confirmAllMatches(session, awaitJob(session, secondJob.path("id").asText()));
        JsonNode secondDone = awaitJob(session, secondJob.path("id").asText());
        assertThat(secondDone.path("status").asText()).isEqualTo("COMPLETED");
        assertThat(secondDone.path("result").path("playlistName").asText()).isEqualTo("回迁测试");
        assertThat(secondDone.path("result").path("addedCount").asInt()).isEqualTo(10);
        assertThat(secondDone.path("result").path("unmatchedCount").asInt()).isZero();
        assertThat(secondDone.path("result").path("matchRate").asInt()).isEqualTo(100);

        JsonNode qqLibrary = getJson("/api/demo/library?provider=QQ_MUSIC", session);
        assertThat(qqLibrary).hasSize(1);
        assertThat(qqLibrary.get(0).path("totalTracks").asInt()).isEqualTo(10);
    }

    @Test
    void migratesQqToNeteaseInDemoMode() throws Exception {
        MockHttpSession session = new MockHttpSession();
        connectDemo(session, "QQ_MUSIC");
        connectDemo(session, "NETEASE_MUSIC");

        JsonNode job = startMigration(session, "QQ_MUSIC", "demo://builtin", "NETEASE_MUSIC", "网易云演示");
        JsonNode matched = awaitJob(session, job.path("id").asText());
        assertThat(matched.path("status").asText()).isEqualTo("AWAITING_CONFIRMATION");
        assertThat(getJson("/api/demo/library?provider=NETEASE_MUSIC", session)).isEmpty();
        confirmAllMatches(session, matched);
        JsonNode done = awaitJob(session, job.path("id").asText());
        assertThat(done.path("status").asText()).isEqualTo("COMPLETED");
        assertThat(done.path("result").path("addedCount").asInt()).isEqualTo(12);
        assertThat(done.path("result").path("playlistName").asText()).isEqualTo("网易云演示");
        assertThat(getJson("/api/demo/library?provider=NETEASE_MUSIC", session)).hasSize(1);
        assertThat(getJson("/api/demo/library?provider=NETEASE_MUSIC", new MockHttpSession())).isEmpty();
    }

    @Test
    void backsUpDemoQqPlaylistWithoutAppleConnection() throws Exception {
        MockHttpSession session = new MockHttpSession();
        connectDemo(session, "QQ_MUSIC");

        JsonNode state = getJson("/api/state", session);
        assertThat(state.path("connections").path("APPLE_MUSIC").path("connected").asBoolean()).isFalse();
        JsonNode backup = postJson("/api/playlists/backup", session,
                Map.of("provider", "QQ_MUSIC", "url", " demo://builtin "));
        assertThat(backup.path("name").asText()).contains("夏夜循环");
        assertThat(backup.path("totalTracks").asInt()).isEqualTo(12);
        assertThat(backup.path("tracks")).hasSize(12);
        assertThat(backup.path("truncated").asBoolean()).isFalse();
    }

    @Test
    void backsUpAllTracksWhilePreviewRemainsLimited() throws Exception {
        MockHttpSession session = new MockHttpSession();
        MusicProvider provider = mock(MusicProvider.class);
        ProviderRegistry registry = mock(ProviderRegistry.class);
        ProviderConnection connection = mock(ProviderConnection.class);
        ConnectionService connections = mock(ConnectionService.class);
        TuneBridgeProperties properties = new TuneBridgeProperties();
        properties.getMigration().setMaxTracks(200);
        List<Track> tracks = IntStream.range(0, 250)
                .mapToObj(i -> Track.of("track-" + i, "Song " + i, "Artist", "Album", 180))
                .toList();
        Playlist playlist = new Playlist("id", "name", "description", "cover", "owner", "url", tracks);
        when(registry.get(ProviderId.QQ_MUSIC)).thenReturn(provider);
        when(connections.get(session, ProviderId.QQ_MUSIC)).thenReturn(connection);
        when(provider.fetchPlaylist(connection, "demo://large")).thenReturn(playlist);
        ApiController controller = new ApiController(registry, connections, null, null, properties, null, null);
        var mockMvc = org.springframework.test.web.servlet.setup.MockMvcBuilders.standaloneSetup(controller)
                .setControllerAdvice(new ApiExceptionHandler()).build();
        String request = objectMapper.writeValueAsString(Map.of("provider", "QQ_MUSIC", "url", " demo://large "));

        MvcResult backupResult = mockMvc.perform(BridgeRequests.post("/api/playlists/backup").session(session)
                        .contentType(MediaType.APPLICATION_JSON).content(request))
                .andExpect(status().isOk()).andReturn();
        JsonNode backup = readBody(backupResult);
        assertThat(backup.path("totalTracks").asInt()).isEqualTo(250);
        assertThat(backup.path("tracks")).hasSize(250);
        assertThat(backup.path("tracks").get(249).path("id").asText()).isEqualTo("track-249");
        assertThat(backup.path("truncated").asBoolean()).isFalse();

        MvcResult previewResult = mockMvc.perform(BridgeRequests.post("/api/playlists/preview").session(session)
                        .contentType(MediaType.APPLICATION_JSON).content(request))
                .andExpect(status().isOk()).andReturn();
        JsonNode preview = readBody(previewResult);
        assertThat(preview.path("totalTracks").asInt()).isEqualTo(250);
        assertThat(preview.path("tracks")).hasSize(200);
        assertThat(preview.path("truncated").asBoolean()).isTrue();
        verify(provider, times(2)).fetchPlaylist(connection, "demo://large");
    }

    @Test
    void rejectsBackupWithBlankOrMissingUrl() throws Exception {
        MockHttpSession session = new MockHttpSession();
        for (Map<String, String> request : List.of(
                Map.of("provider", "QQ_MUSIC", "url", "   "),
                Map.of("provider", "QQ_MUSIC"))) {
            MvcResult result = mvc.perform(BridgeRequests.as(
                            BridgeRequests.post("/api/playlists/backup").session(session)
                                    .contentType(MediaType.APPLICATION_JSON)
                                    .content(objectMapper.writeValueAsString(request)), principal))
                    .andExpect(status().isBadRequest()).andReturn();
            JsonNode error = readBody(result);
            assertThat(error.path("code").asText()).isEqualTo("INVALID_INPUT");
            assertThat(error.path("error").asText()).isEqualTo("请粘贴来源歌单链接");
        }
    }

    @Test
    void restoresLocalBackupToDemoTarget() throws Exception {
        MockHttpSession session = new MockHttpSession();
        connectDemo(session, "QQ_MUSIC");
        connectDemo(session, "APPLE_MUSIC");

        JsonNode backup = postJson("/api/playlists/backup", session,
                Map.of("provider", "QQ_MUSIC", "url", "demo://builtin"));
        List<Map<String, Object>> tracks = new java.util.ArrayList<>();
        for (JsonNode track : backup.path("tracks")) {
            tracks.add(Map.of(
                    "title", track.path("title").asText(),
                    "artist", track.path("artist").asText(),
                    "album", track.path("album").asText(),
                    "durationSec", track.path("durationSec").asInt()));
        }

        JsonNode job = postJson("/api/backups/migrations", session, Map.of(
                "targetProvider", "APPLE_MUSIC",
                "playlistName", "备份恢复",
                "sourceName", "夏夜循环",
                "tracks", tracks));
        confirmAllMatches(session, awaitJob(session, job.path("id").asText()));
        JsonNode done = awaitJob(session, job.path("id").asText());

        assertThat(done.path("status").asText()).isEqualTo("COMPLETED");
        assertThat(done.path("source").path("provider").asText()).isEqualTo("LOCAL_BACKUP");
        assertThat(done.path("source").path("providerLabel").asText()).isEqualTo("本地备份");
        assertThat(done.path("source").path("name").asText()).isEqualTo("夏夜循环");
        assertThat(done.path("result").path("playlistName").asText()).isEqualTo("备份恢复");
        assertThat(done.path("result").path("addedCount").asInt()).isEqualTo(10);
        assertThat(done.path("result").path("unmatchedCount").asInt()).isEqualTo(2);
        assertThat(done.path("result").path("matchRate").asInt()).isEqualTo(83);

        JsonNode library = getJson("/api/demo/library?provider=APPLE_MUSIC", session);
        assertThat(library).hasSize(1);
        assertThat(library.get(0).path("name").asText()).isEqualTo("备份恢复");
        assertThat(library.get(0).path("totalTracks").asInt()).isEqualTo(10);
    }

    @Test
    void restoresBackupWithoutASourceConnection() throws Exception {
        MockHttpSession session = new MockHttpSession();
        connectDemo(session, "APPLE_MUSIC");

        JsonNode job = postJson("/api/backups/migrations", session, Map.of(
                "targetProvider", "APPLE_MUSIC",
                "playlistName", "纯本地恢复",
                "sourceName", "手动清单",
                "tracks", List.of(Map.of(
                        "title", "晴天",
                        "artist", "周杰伦",
                        "album", "叶惠美",
                        "durationSec", 269))));
        confirmAllMatches(session, awaitJob(session, job.path("id").asText()));
        JsonNode done = awaitJob(session, job.path("id").asText());

        assertThat(done.path("status").asText()).isEqualTo("COMPLETED");
        assertThat(done.path("result").path("addedCount").asInt()).isEqualTo(1);
        assertThat(done.path("result").path("matchRate").asInt()).isEqualTo(100);
    }

    @Test
    void rejectsBackupRestoreWithoutTargetConnection() throws Exception {
        MockHttpSession session = new MockHttpSession();
        mvc.perform(BridgeRequests.as(
                        BridgeRequests.post("/api/backups/migrations").session(session)
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(objectMapper.writeValueAsString(Map.of(
                                        "targetProvider", "APPLE_MUSIC",
                                        "playlistName", "未连接",
                                        "tracks", List.of(Map.of("title", "晴天"))))), principal))
                .andExpect(status().isConflict());
    }

    @Test
    void rejectsEmptyBackupRestore() throws Exception {
        MockHttpSession session = new MockHttpSession();
        connectDemo(session, "APPLE_MUSIC");
        MvcResult result = mvc.perform(BridgeRequests.as(
                        BridgeRequests.post("/api/backups/migrations").session(session)
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(objectMapper.writeValueAsString(Map.of(
                                        "targetProvider", "APPLE_MUSIC",
                                        "playlistName", "空备份",
                                        "tracks", List.of()))), principal))
                .andExpect(status().isBadRequest()).andReturn();
        JsonNode error = readBody(result);
        assertThat(error.path("code").asText()).isEqualTo("INVALID_INPUT");
        assertThat(error.path("error").asText()).isEqualTo("备份中没有可迁移的曲目");
    }

    @Test
    void rejectsMigrationWhenTargetIsNotConnected() throws Exception {
        MockHttpSession session = new MockHttpSession();
        connectDemo(session, "QQ_MUSIC");

        mvc.perform(BridgeRequests.as(
                        BridgeRequests.post("/api/migrations").session(session)
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(objectMapper.writeValueAsString(Map.of(
                                        "sourceProvider", "QQ_MUSIC",
                                        "sourceUrl", "demo://builtin",
                                        "targetProvider", "APPLE_MUSIC",
                                        "playlistName", ""))), principal))
                .andExpect(status().isConflict());
    }

    @Test
    void writesOnlyConfirmedTracksInSourceOrderAndSeparatesSkippedFromUnmatched() throws Exception {
        MockHttpSession session = new MockHttpSession();
        connectDemo(session, "QQ_MUSIC");
        connectDemo(session, "APPLE_MUSIC");
        JsonNode job = startMigration(session, "QQ_MUSIC", "demo://builtin", "APPLE_MUSIC", "人工确认");
        JsonNode preview = awaitJob(session, job.path("id").asText());
        assertThat(preview.path("status").asText()).isEqualTo("AWAITING_CONFIRMATION");
        List<Integer> matched = IntStream.range(0, preview.path("matches").size())
                .filter(index -> preview.path("matches").get(index).path("matched").asBoolean()).boxed().toList();
        int first = matched.getFirst();
        int last = matched.getLast();
        postJson("/api/migrations/" + job.path("id").asText() + "/confirm", session,
                Map.of("selectedIndices", List.of(last, first)));
        JsonNode done = awaitJob(session, job.path("id").asText());
        assertThat(done.path("status").asText()).isEqualTo("COMPLETED");
        JsonNode result = done.path("result");
        assertThat(result.path("addedCount").asInt()).isEqualTo(2);
        assertThat(result.path("matchedCount").asInt()).isEqualTo(10);
        assertThat(result.path("skippedCount").asInt()).isEqualTo(8);
        assertThat(result.path("unmatchedCount").asInt()).isEqualTo(2);
        assertThat(result.path("matchRate").asInt()).isEqualTo(83);
        for (int index = 0; index < done.path("matches").size(); index++) {
            assertThat(done.path("matches").get(index).path("index").asInt()).isEqualTo(index);
            assertThat(done.path("matches").get(index).path("selected").asBoolean())
                    .isEqualTo(index == first || index == last);
        }
        JsonNode library = getJson("/api/demo/library?provider=APPLE_MUSIC", session);
        assertThat(library).hasSize(1);
        assertThat(library.get(0).path("tracks")).hasSize(2);
        assertThat(library.get(0).path("tracks").get(0).path("title").asText())
                .isEqualTo(preview.path("matches").get(first).path("targetTitle").asText());
        assertThat(library.get(0).path("tracks").get(1).path("title").asText())
                .isEqualTo(preview.path("matches").get(last).path("targetTitle").asText());
    }

    @Test
    void rejectsInvalidSelectionsWithoutCreatingAnyPlaylist() throws Exception {
        MockHttpSession session = new MockHttpSession();
        connectDemo(session, "QQ_MUSIC");
        connectDemo(session, "APPLE_MUSIC");
        JsonNode job = startMigration(session, "QQ_MUSIC", "demo://builtin", "APPLE_MUSIC", "");
        JsonNode preview = awaitJob(session, job.path("id").asText());
        int unmatched = IntStream.range(0, preview.path("matches").size())
                .filter(index -> !preview.path("matches").get(index).path("matched").asBoolean()).findFirst().orElseThrow();
        String confirmUrl = "/api/migrations/" + job.path("id").asText() + "/confirm";
        for (Object request : List.of(Map.of(),
                Map.of("selectedIndices", List.of()),
                Map.of("selectedIndices", List.of(0, 0)),
                Map.of("selectedIndices", List.of(-1)),
                Map.of("selectedIndices", List.of(12)),
                Map.of("selectedIndices", List.of(unmatched)),
                Map.of("selectedIndices", Arrays.asList((Integer) null)),
                Map.of("selectedIndices", List.of(0.5)),
                Map.of("selectedIndices", List.of("0")),
                Map.of("selectedIndices", List.of(2147483648L)))) {
            mvc.perform(BridgeRequests.as(BridgeRequests.post(confirmUrl).session(session)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(request)), principal))
                    .andExpect(status().isBadRequest());
            assertThat(getJson("/api/migrations/" + job.path("id").asText(), session)
                    .path("status").asText()).isEqualTo("AWAITING_CONFIRMATION");
            assertThat(getJson("/api/demo/library?provider=APPLE_MUSIC", session)).isEmpty();
        }
    }

    @Test
    void isolatesConfirmationBySessionAndRejectsReplacedOrDisconnectedTarget() throws Exception {
        MockHttpSession session = new MockHttpSession();
        connectDemo(session, "QQ_MUSIC");
        connectDemo(session, "APPLE_MUSIC");
        JsonNode job = startMigration(session, "QQ_MUSIC", "demo://builtin", "APPLE_MUSIC", "");
        awaitJob(session, job.path("id").asText());
        String confirmUrl = "/api/migrations/" + job.path("id").asText() + "/confirm";
        String body = objectMapper.writeValueAsString(Map.of("selectedIndices", List.of(0)));
        // Another session of the same account may read the job but never confirm it.
        MvcResult otherSession = mvc.perform(BridgeRequests.as(
                        BridgeRequests.post(confirmUrl).session(new MockHttpSession())
                                .contentType(MediaType.APPLICATION_JSON).content(body), principal))
                .andExpect(status().isConflict()).andReturn();
        assertThat(readBody(otherSession).path("code").asText()).isEqualTo("HISTORY_READ_ONLY");
        connectDemo(session, "APPLE_MUSIC");
        MvcResult replaced = mvc.perform(BridgeRequests.as(
                        BridgeRequests.post(confirmUrl).session(session)
                                .contentType(MediaType.APPLICATION_JSON).content(body), principal))
                .andExpect(status().isConflict()).andReturn();
        assertThat(readBody(replaced).path("code").asText()).isEqualTo("TARGET_CHANGED");
        mvc.perform(BridgeRequests.as(BridgeRequests.delete("/api/connections/APPLE_MUSIC")
                .session(session), principal)).andExpect(status().isNoContent());
        mvc.perform(BridgeRequests.as(BridgeRequests.post(confirmUrl).session(session)
                        .contentType(MediaType.APPLICATION_JSON).content(body), principal))
                .andExpect(status().isConflict());
        connectDemo(session, "APPLE_MUSIC");
        assertThat(getJson("/api/demo/library?provider=APPLE_MUSIC", session)).isEmpty();
    }

    @Test
    void acceptsOnlyOneOfConcurrentConfirmations() throws Exception {
        MockHttpSession session = new MockHttpSession();
        connectDemo(session, "QQ_MUSIC");
        connectDemo(session, "APPLE_MUSIC");
        JsonNode job = startMigration(session, "QQ_MUSIC", "demo://builtin", "APPLE_MUSIC", "");
        awaitJob(session, job.path("id").asText());
        String confirmUrl = "/api/migrations/" + job.path("id").asText() + "/confirm";
        String body = objectMapper.writeValueAsString(Map.of("selectedIndices", List.of(0)));
        CountDownLatch start = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            java.util.concurrent.Callable<Integer> confirm = () -> {
                start.await();
                return mvc.perform(BridgeRequests.as(BridgeRequests.post(confirmUrl).session(session)
                                .contentType(MediaType.APPLICATION_JSON).content(body), principal))
                        .andReturn().getResponse().getStatus();
            };
            var first = executor.submit(confirm);
            var second = executor.submit(confirm);
            start.countDown();
            assertThat(List.of(first.get(10, TimeUnit.SECONDS), second.get(10, TimeUnit.SECONDS)))
                    .containsExactlyInAnyOrder(200, 409);
        }
        assertThat(awaitJob(session, job.path("id").asText()).path("status").asText()).isEqualTo("COMPLETED");
        assertThat(getJson("/api/demo/library?provider=APPLE_MUSIC", session)).hasSize(1);
        mvc.perform(BridgeRequests.as(BridgeRequests.post(confirmUrl).session(session)
                        .contentType(MediaType.APPLICATION_JSON).content(body), principal))
                .andExpect(status().isConflict());
        assertThat(getJson("/api/demo/library?provider=APPLE_MUSIC", session)).hasSize(1);
    }

    @Test
    void retainsFullTargetTracksAndNeverSearchesAgainDuringConfirmedWrite() throws Exception {
        MockHttpSession session = new MockHttpSession();
        MusicProvider source = mock(MusicProvider.class);
        MusicProvider target = mock(MusicProvider.class);
        ProviderRegistry registry = mock(ProviderRegistry.class);
        ConnectionService connections = mock(ConnectionService.class);
        MigrationHistory history = mock(MigrationHistory.class);
        ProviderConnection targetConnection = new ProviderConnection(ProviderId.APPLE_MUSIC,
                ConnectionMode.DEMO, "demo", Map.of());
        Track firstSource = Track.of("source-0", "Song A", "Artist", "Album", 180);
        Track secondSource = Track.of("source-1", "Song B", "Artist", "Album", 180);
        Track firstTarget = new Track("target-0", "Song A", "Artist", "Album", 180, "artwork", 7);
        Track secondTarget = new Track("target-1", "Song B", "Artist", "Album", 180, "artwork", 9);
        Playlist playlist = new Playlist("id", "name", "description", "cover", "owner", "url",
                List.of(firstSource, secondSource));
        CreatedPlaylist created = new CreatedPlaylist("created", "name", "url", 0, Map.of());
        when(registry.get(ProviderId.QQ_MUSIC)).thenReturn(source);
        when(registry.get(ProviderId.APPLE_MUSIC)).thenReturn(target);
        when(connections.require(session, ProviderId.APPLE_MUSIC)).thenReturn(targetConnection);
        when(connections.get(session, ProviderId.APPLE_MUSIC)).thenReturn(targetConnection);
        when(source.fetchPlaylist(null, "source-url")).thenReturn(playlist);
        when(target.searchTracks(targetConnection, "Song A", "Artist", 6)).thenReturn(List.of(firstTarget));
        when(target.searchTracks(targetConnection, "Song B", "Artist", 6)).thenReturn(List.of(secondTarget));
        when(target.createPlaylist(eq(targetConnection), anyString(), anyString())).thenReturn(created);
        try (var executor = Executors.newSingleThreadExecutor()) {
            MigrationService service = new MigrationService(registry, connections, new TrackMatcher(),
                    new TuneBridgeProperties(), executor, history);
            MigrationJob job = service.createJob(session, ownerId, ProviderId.QQ_MUSIC, "source-url",
                    ProviderId.APPLE_MUSIC, "name");
            executor.submit(() -> { }).get(10, TimeUnit.SECONDS);
            assertThat(job.status()).isEqualTo(JobStatus.AWAITING_CONFIRMATION);
            verify(target, never()).createPlaylist(any(), anyString(), anyString());
            verify(target, never()).addTracks(any(), any(), any());
            service.confirmJob(session, ownerId, job.id(), List.of(1, 0));
            executor.submit(() -> { }).get(10, TimeUnit.SECONDS);
            assertThat(job.status()).isEqualTo(JobStatus.COMPLETED);
            verify(source, times(1)).fetchPlaylist(null, "source-url");
            verify(target, times(1)).searchTracks(targetConnection, "Song A", "Artist", 6);
            verify(target, times(1)).searchTracks(targetConnection, "Song B", "Artist", 6);
            verify(target, times(1)).createPlaylist(eq(targetConnection), anyString(), anyString());
            verify(target).addTracks(targetConnection, created, List.of(firstTarget, secondTarget));
            verify(history, org.mockito.Mockito.atLeastOnce()).save(any(MigrationJob.class));
            assertThatThrownBy(() -> service.confirmJob(session, ownerId, job.id(), List.of(0)))
                    .isInstanceOf(ProviderException.class).hasMessageContaining("重复确认");

            MigrationJob changed = service.createJob(session, ownerId, ProviderId.QQ_MUSIC, "source-url",
                    ProviderId.APPLE_MUSIC, "name");
            executor.submit(() -> { }).get(10, TimeUnit.SECONDS);
            CountDownLatch release = new CountDownLatch(1);
            executor.submit(() -> {
                release.await(10, TimeUnit.SECONDS);
                return null;
            });
            try {
                service.confirmJob(session, ownerId, changed.id(), List.of(0));
                when(connections.get(session, ProviderId.APPLE_MUSIC)).thenReturn(new ProviderConnection(
                        ProviderId.APPLE_MUSIC, ConnectionMode.DEMO, "another", Map.of()));
            } finally {
                release.countDown();
            }
            executor.submit(() -> { }).get(10, TimeUnit.SECONDS);
            assertThat(changed.status()).isEqualTo(JobStatus.FAILED);
            assertThat(changed.error()).contains("目标连接已断开或更换");
            verify(target, times(1)).createPlaylist(eq(targetConnection), anyString(), anyString());
            verify(target, times(1)).addTracks(targetConnection, created, List.of(firstTarget, secondTarget));
        }
    }

    @Test
    void allowsExplicitLowConfidenceSelectionButRejectsPrematureAndDuplicateNeteaseTargets() {
        ProviderConnection connection = new ProviderConnection(ProviderId.NETEASE_MUSIC,
                ConnectionMode.DEMO, "demo", Map.of());
        MigrationJob job = new MigrationJob("job", "session", ownerId, ProviderId.QQ_MUSIC,
                ProviderId.NETEASE_MUSIC, "source", "name", connection, ignored -> { });
        Track source = Track.of("source", "Song (Live)", "Artist", "Album", 180);
        Track target = new Track("encrypted", "Song", "Artist", "Album", 180, "artwork", 7);
        assertThatThrownBy(() -> job.confirm(List.of(0))).isInstanceOf(ProviderException.class)
                .hasMessageContaining("等待确认");
        job.start();
        job.addMatch(TrackMatch.matched(source, target, 0.56, true, "版本差异"), target);
        job.addMatch(TrackMatch.matched(source, target, 0.56, true, "版本差异"), target);
        assertThatThrownBy(() -> job.confirm(List.of(0))).isInstanceOf(ProviderException.class)
                .hasMessageContaining("等待确认");
        job.awaitConfirmation();
        assertThat(job.selectedIndicesSnapshot()).isEmpty();
        assertThatThrownBy(() -> job.confirm(List.of(0, 1))).isInstanceOf(ProviderException.class)
                .hasMessageContaining("重复加入");
        assertThat(job.status()).isEqualTo(JobStatus.AWAITING_CONFIRMATION);
        assertThat(job.confirm(List.of(0))).containsExactly(target);
        assertThat(job.selectedIndicesSnapshot()).containsExactly(0);
        assertThat(job.status()).isEqualTo(JobStatus.RUNNING);
    }

    private void connectDemo(MockHttpSession session, String provider) throws Exception {
        postJson("/api/connections/" + provider, session, Map.of("mode", "demo"));
    }

    private JsonNode startMigration(MockHttpSession session, String source, String url,
                                    String target, String name) throws Exception {
        return postJson("/api/migrations", session, Map.of(
                "sourceProvider", source,
                "sourceUrl", url,
                "targetProvider", target,
                "playlistName", name));
    }

    private void confirmAllMatches(MockHttpSession session, JsonNode job) throws Exception {
        assertThat(job.path("status").asText()).isEqualTo("AWAITING_CONFIRMATION");
        List<Integer> indices = IntStream.range(0, job.path("matches").size())
                .filter(index -> job.path("matches").get(index).path("matched").asBoolean()).boxed().toList();
        postJson("/api/migrations/" + job.path("id").asText() + "/confirm", session,
                Map.of("selectedIndices", indices));
    }

    private JsonNode awaitJob(MockHttpSession session, String jobId) throws Exception {
        JsonNode job = null;
        for (int attempt = 0; attempt < 240; attempt++) {
            job = getJson("/api/migrations/" + jobId, session);
            String status = job.path("status").asText();
            if ("AWAITING_CONFIRMATION".equals(status) || "COMPLETED".equals(status) || "FAILED".equals(status)
                    || "INTERRUPTED".equals(status)) {
                return job;
            }
            Thread.sleep(50);
        }
        throw new AssertionError("Migration job did not finish in time: " + job);
    }

    private JsonNode postJson(String path, MockHttpSession session, Object body) throws Exception {
        MvcResult result = mvc.perform(BridgeRequests.as(
                        BridgeRequests.post(path).session(session)
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(objectMapper.writeValueAsString(body)), principal))
                .andExpect(status().is2xxSuccessful())
                .andReturn();
        return readBody(result);
    }

    private JsonNode getJson(String path, MockHttpSession session) throws Exception {
        MvcResult result = mvc.perform(BridgeRequests.as(BridgeRequests.get(path).session(session), principal))
                .andExpect(status().isOk())
                .andReturn();
        return readBody(result);
    }

    private JsonNode readBody(MvcResult result) throws Exception {
        return objectMapper.readTree(result.getResponse().getContentAsString(StandardCharsets.UTF_8));
    }
}
