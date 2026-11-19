package com.tunebridge.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.tunebridge.config.TuneBridgeProperties;
import com.tunebridge.domain.Playlist;
import com.tunebridge.domain.ProviderConnection;
import com.tunebridge.domain.ProviderId;
import com.tunebridge.domain.Track;
import com.tunebridge.provider.MusicProvider;
import com.tunebridge.provider.ProviderRegistry;
import com.tunebridge.service.ConnectionService;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

@SpringBootTest
@AutoConfigureMockMvc
class DemoMigrationFlowTest {

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper objectMapper;

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
        MockMvc mockMvc = org.springframework.test.web.servlet.setup.MockMvcBuilders.standaloneSetup(controller)
                .setControllerAdvice(new ApiExceptionHandler()).build();
        String request = objectMapper.writeValueAsString(Map.of("provider", "QQ_MUSIC", "url", " demo://large "));

        MvcResult backupResult = mockMvc.perform(post("/api/playlists/backup").session(session)
                        .contentType(MediaType.APPLICATION_JSON).content(request))
                .andExpect(status().isOk()).andReturn();
        JsonNode backup = readBody(backupResult);
        assertThat(backup.path("totalTracks").asInt()).isEqualTo(250);
        assertThat(backup.path("tracks")).hasSize(250);
        assertThat(backup.path("tracks").get(249).path("id").asText()).isEqualTo("track-249");
        assertThat(backup.path("truncated").asBoolean()).isFalse();

        MvcResult previewResult = mockMvc.perform(post("/api/playlists/preview").session(session)
                        .contentType(MediaType.APPLICATION_JSON).content(request))
                .andExpect(status().isOk()).andReturn();
        JsonNode preview = readBody(previewResult);
        assertThat(preview.path("totalTracks").asInt()).isEqualTo(250);
        assertThat(preview.path("tracks")).hasSize(200);
        assertThat(preview.path("truncated").asBoolean()).isTrue();
        verify(provider, org.mockito.Mockito.times(2)).fetchPlaylist(connection, "demo://large");
    }

    @Test
    void rejectsBackupWithBlankOrMissingUrl() throws Exception {
        MockHttpSession session = new MockHttpSession();
        for (Map<String, String> request : List.of(
                Map.of("provider", "QQ_MUSIC", "url", "   "),
                Map.of("provider", "QQ_MUSIC"))) {
            MvcResult result = mvc.perform(post("/api/playlists/backup").session(session)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(request)))
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
        JsonNode done = awaitJob(session, job.path("id").asText());

        assertThat(done.path("status").asText()).isEqualTo("COMPLETED");
        assertThat(done.path("result").path("addedCount").asInt()).isEqualTo(1);
        assertThat(done.path("result").path("matchRate").asInt()).isEqualTo(100);
    }

    @Test
    void rejectsBackupRestoreWithoutTargetConnection() throws Exception {
        MockHttpSession session = new MockHttpSession();
        mvc.perform(post("/api/backups/migrations")
                        .session(session)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "targetProvider", "APPLE_MUSIC",
                                "playlistName", "未连接",
                                "tracks", List.of(Map.of("title", "晴天"))))))
                .andExpect(status().isConflict());
    }

    @Test
    void rejectsEmptyBackupRestore() throws Exception {
        MockHttpSession session = new MockHttpSession();
        connectDemo(session, "APPLE_MUSIC");
        MvcResult result = mvc.perform(post("/api/backups/migrations")
                        .session(session)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "targetProvider", "APPLE_MUSIC",
                                "playlistName", "空备份",
                                "tracks", List.of()))))
                .andExpect(status().isBadRequest()).andReturn();
        JsonNode error = readBody(result);
        assertThat(error.path("code").asText()).isEqualTo("INVALID_INPUT");
        assertThat(error.path("error").asText()).isEqualTo("备份中没有可迁移的曲目");
    }

    @Test
    void rejectsMigrationWhenTargetIsNotConnected() throws Exception {
        MockHttpSession session = new MockHttpSession();
        connectDemo(session, "QQ_MUSIC");

        mvc.perform(post("/api/migrations")
                        .session(session)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "sourceProvider", "QQ_MUSIC",
                                "sourceUrl", "demo://builtin",
                                "targetProvider", "APPLE_MUSIC",
                                "playlistName", ""))))
                .andExpect(status().isConflict());
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

    private JsonNode awaitJob(MockHttpSession session, String jobId) throws Exception {
        JsonNode job = null;
        for (int attempt = 0; attempt < 240; attempt++) {
            job = getJson("/api/migrations/" + jobId, session);
            String status = job.path("status").asText();
            if ("COMPLETED".equals(status) || "FAILED".equals(status)) {
                return job;
            }
            Thread.sleep(50);
        }
        throw new AssertionError("Migration job did not finish in time: " + job);
    }

    private JsonNode postJson(String path, MockHttpSession session, Object body) throws Exception {
        MvcResult result = mvc.perform(post(path)
                        .session(session)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().is2xxSuccessful())
                .andReturn();
        return readBody(result);
    }

    private JsonNode getJson(String path, MockHttpSession session) throws Exception {
        MvcResult result = mvc.perform(get(path).session(session))
                .andExpect(status().isOk())
                .andReturn();
        return readBody(result);
    }

    private JsonNode readBody(MvcResult result) throws Exception {
        return objectMapper.readTree(result.getResponse().getContentAsString(StandardCharsets.UTF_8));
    }
}
