package com.tunebridge.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.Map;
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
