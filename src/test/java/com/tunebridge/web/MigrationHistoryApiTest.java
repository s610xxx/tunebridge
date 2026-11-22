package com.tunebridge.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.tunebridge.domain.ConnectionMode;
import com.tunebridge.domain.CreatedPlaylist;
import com.tunebridge.domain.MigrationJob;
import com.tunebridge.domain.Playlist;
import com.tunebridge.domain.ProviderConnection;
import com.tunebridge.domain.ProviderId;
import com.tunebridge.domain.Track;
import com.tunebridge.domain.TrackMatch;
import com.tunebridge.security.AccountPrincipal;
import com.tunebridge.security.AccountService;
import com.tunebridge.service.MigrationHistory;
import com.tunebridge.service.MigrationService;
import com.tunebridge.testsupport.BridgeRequests;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.UUID;
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

@SpringBootTest(properties = "spring.datasource.url=jdbc:h2:mem:history_api;DB_CLOSE_DELAY=-1")
@AutoConfigureMockMvc
class MigrationHistoryApiTest {

    private static final String PASSWORD = "history-api-password";

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private AccountService accounts;

    @Autowired
    private MigrationHistory history;

    @Autowired
    private MigrationService migrations;

    private AccountPrincipal principal;
    private String ownerId;

    @BeforeEach
    void registerAccount() {
        principal = account();
        ownerId = principal.id();
    }

    @Test
    void listsFinishedMigrationsOnlyForTheAccountThatRanThem() throws Exception {
        MockHttpSession session = new MockHttpSession();
        connectDemo(session, "QQ_MUSIC");
        connectDemo(session, "APPLE_MUSIC");
        String jobId = completedMigration(session);

        JsonNode page = getJson("/api/migrations?offset=0&limit=20", session);
        assertThat(page.path("offset").asInt()).isZero();
        assertThat(page.path("hasMore").asBoolean()).isFalse();
        assertThat(page.path("items")).hasSize(1);
        JsonNode item = page.path("items").get(0);
        assertThat(item.path("id").asText()).isEqualTo(jobId);
        assertThat(item.path("status").asText()).isEqualTo("COMPLETED");
        assertThat(item.path("readOnly").asBoolean()).isTrue();
        assertThat(item.path("result").path("addedCount").asInt()).isEqualTo(10);
        assertThat(item.path("source").path("name").asText()).contains("夏夜循环");

        AccountPrincipal neighbour = account();
        MockHttpSession neighbourSession = new MockHttpSession();
        assertThat(getJson("/api/migrations?offset=0&limit=20", neighbour, neighbourSession)
                .path("items")).isEmpty();
        MvcResult invisible = mvc.perform(BridgeRequests.as(
                        BridgeRequests.get("/api/migrations/" + jobId).session(neighbourSession), neighbour))
                .andExpect(status().isNotFound()).andReturn();
        assertThat(readBody(invisible).path("code").asText()).isEqualTo("NOT_FOUND");

        // Another browser of the same account may read the report but never act on it.
        JsonNode elsewhere = getJson("/api/migrations/" + jobId, principal, new MockHttpSession());
        assertThat(elsewhere.path("readOnly").asBoolean()).isTrue();
        assertThat(getJson("/api/migrations/" + jobId, session).path("readOnly").asBoolean()).isFalse();
    }

    @Test
    void refusesToConfirmOrAbandonAJobThatOnlyExistsInTheHistory() throws Exception {
        String jobId = storedPreview("mig_history_only");

        JsonNode page = getJson("/api/migrations?offset=0&limit=20");
        assertThat(page.path("items").get(0).path("readOnly").asBoolean()).isTrue();

        MvcResult confirm = mvc.perform(BridgeRequests.as(
                        BridgeRequests.post("/api/migrations/" + jobId + "/confirm").session(new MockHttpSession())
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(objectMapper.writeValueAsString(Map.of("selectedIndices", List.of(0)))),
                        principal))
                .andExpect(status().isConflict()).andReturn();
        assertThat(readBody(confirm).path("code").asText()).isEqualTo("HISTORY_READ_ONLY");
        assertThat(readBody(confirm).path("error").asText()).isEqualTo("历史任务只读，不会重新执行写入");

        MvcResult abandon = mvc.perform(BridgeRequests.as(
                        BridgeRequests.post("/api/migrations/" + jobId + "/abandon").session(new MockHttpSession()),
                        principal))
                .andExpect(status().isConflict()).andReturn();
        assertThat(readBody(abandon).path("code").asText()).isEqualTo("HISTORY_READ_ONLY");

        assertThat(history.find(ownerId, jobId).status()).isEqualTo("AWAITING_CONFIRMATION");
        assertThat(getJson("/api/migrations/current").path("id").asText()).isEmpty();
    }

    @Test
    void followsTheLiveJobAndStopsFollowingItOnceTheSessionEnds() throws Exception {
        MockHttpSession session = new MockHttpSession();
        connectDemo(session, "QQ_MUSIC");
        connectDemo(session, "APPLE_MUSIC");
        String jobId = startMigration(session);
        awaitStatus(session, jobId, "AWAITING_CONFIRMATION");

        JsonNode current = getJson("/api/migrations/current", session);
        assertThat(current.path("id").asText()).isEqualTo(jobId);
        assertThat(current.path("status").asText()).isEqualTo("AWAITING_CONFIRMATION");
        assertThat(current.path("readOnly").asBoolean()).isFalse();

        migrations.endSession(session.getId());

        JsonNode interrupted = awaitStatus(session, jobId, "INTERRUPTED");
        assertThat(interrupted.path("recoveryNotice").asText()).contains("登录会话已结束").contains("未开始写入");
        assertThat(getJson("/api/migrations/current", session).path("id").asText()).isEmpty();

        MvcResult late = mvc.perform(BridgeRequests.as(
                        BridgeRequests.post("/api/migrations/" + jobId + "/confirm").session(session)
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(objectMapper.writeValueAsString(Map.of("selectedIndices", List.of(0)))),
                        principal))
                .andExpect(status().isConflict()).andReturn();
        assertThat(readBody(late).path("code").asText()).isEqualTo("MIGRATION_STATE");

        JsonNode stored = getJson("/api/migrations?offset=0&limit=20", session).path("items").get(0);
        assertThat(stored.path("status").asText()).isEqualTo("INTERRUPTED");
        assertThat(stored.path("readOnly").asBoolean()).isTrue();
    }

    @Test
    void filtersHistoryThroughTheApiWithoutLeakingAcrossAccounts() throws Exception {
        storedPreview("mig_api_qq_to_apple");
        storedBackupJob("mig_api_backup_to_qq");
        storedCompletedJob("mig_api_completed");

        assertThat(ids(getJson("/api/migrations?source=QQ_MUSIC")))
                .containsExactlyInAnyOrder("mig_api_qq_to_apple", "mig_api_completed");
        assertThat(ids(getJson("/api/migrations?source=LOCAL_BACKUP&target=QQ_MUSIC")))
                .containsExactly("mig_api_backup_to_qq");
        assertThat(ids(getJson("/api/migrations?status=AWAITING_CONFIRMATION&target=APPLE_MUSIC")))
                .containsExactly("mig_api_qq_to_apple");
        assertThat(ids(getJson("/api/migrations?from=" + LocalDate.now(ZoneOffset.UTC)
                + "&to=" + LocalDate.now(ZoneOffset.UTC).plusDays(1))))
                .hasSize(3);
        assertThat(ids(getJson("/api/migrations?from=" + LocalDate.now(ZoneOffset.UTC).plusDays(1)))).isEmpty();

        AccountPrincipal neighbour = account();
        assertThat(getJson("/api/migrations?source=QQ_MUSIC", neighbour, new MockHttpSession()).path("items"))
                .isEmpty();
    }

    @Test
    void rejectsFilterValuesItCannotMapOntoAProviderOrStatus() throws Exception {
        List<String> queries = List.of(
                "source=SPOTIFY",
                "target=LOCAL_BACKUP",
                "status=MIGRATED",
                "from=last-month",
                "to=2026-13-45",
                "from=" + LocalDate.now(ZoneOffset.UTC).plusDays(1) + "&to=" + LocalDate.now(ZoneOffset.UTC));
        for (String query : queries) {
            MvcResult rejected = mvc.perform(BridgeRequests.as(
                            BridgeRequests.get("/api/migrations?" + query).session(new MockHttpSession()), principal))
                    .andExpect(status().isBadRequest()).andReturn();
            assertThat(readBody(rejected).path("code").asText()).as(query).isEqualTo("INVALID_INPUT");
        }
    }

    @Test
    void rejectsPaginationThatWouldNotFitAReasonableRequest() throws Exception {
        for (String query : List.of("offset=-1", "limit=0", "limit=51", "offset=100001")) {
            MvcResult rejected = mvc.perform(BridgeRequests.as(
                            BridgeRequests.get("/api/migrations?" + query).session(new MockHttpSession()), principal))
                    .andExpect(status().isBadRequest()).andReturn();
            assertThat(readBody(rejected).path("code").asText()).isEqualTo("INVALID_INPUT");
        }
        assertThat(getJson("/api/migrations?limit=50").path("items")).isEmpty();
    }

    private String completedMigration(MockHttpSession session) throws Exception {
        String jobId = startMigration(session);
        JsonNode preview = awaitStatus(session, jobId, "AWAITING_CONFIRMATION");
        List<Integer> indices = IntStream.range(0, preview.path("matches").size())
                .filter(index -> preview.path("matches").get(index).path("matched").asBoolean()).boxed().toList();
        postJson("/api/migrations/" + jobId + "/confirm", session, Map.of("selectedIndices", indices));
        awaitStatus(session, jobId, "COMPLETED");
        return jobId;
    }

    private String startMigration(MockHttpSession session) throws Exception {
        JsonNode job = postJson("/api/migrations", session, Map.of(
                "sourceProvider", "QQ_MUSIC",
                "sourceUrl", "demo://builtin",
                "targetProvider", "APPLE_MUSIC",
                "playlistName", ""));
        return job.path("id").asText();
    }

    /** Persists a matched-but-never-confirmed job without registering it with the live service. */
    private String storedPreview(String jobId) {
        return storedJob(jobId, ProviderId.QQ_MUSIC, ProviderId.APPLE_MUSIC, null, false);
    }

    private String storedBackupJob(String jobId) {
        return storedJob(jobId, ProviderId.QQ_MUSIC, ProviderId.QQ_MUSIC, "本地备份", false);
    }

    private String storedCompletedJob(String jobId) {
        return storedJob(jobId, ProviderId.QQ_MUSIC, ProviderId.APPLE_MUSIC, null, true);
    }

    private String storedJob(String jobId, ProviderId source, ProviderId target, String sourceLabel,
                             boolean complete) {
        ProviderConnection connection = new ProviderConnection(target, ConnectionMode.DEMO, "demo", Map.of());
        MigrationJob job = sourceLabel == null
                ? new MigrationJob(jobId, "session-old", ownerId, source, target, "demo://builtin", "夏夜循环",
                        connection, history::save)
                : new MigrationJob(jobId, "session-old", ownerId, source, target, "backup://local", "夏夜循环",
                        sourceLabel, connection, history::save);
        Track sourceTrack = Track.of("dq-1", "晴天", "周杰伦", "叶惠美", 269);
        Track targetTrack = new Track("1440857792", "晴天", "周杰伦", "叶惠美", 269, "", 0);
        job.start();
        job.sourceLoaded(new Playlist("demo-qq", "夏夜循环", "", "", "阿桥", "demo://builtin", List.of(sourceTrack)));
        job.addMatch(TrackMatch.matched(sourceTrack, targetTrack, 0.91, false, "标题与歌手一致"), targetTrack);
        job.awaitConfirmation();
        if (complete) {
            job.confirm(List.of(0));
            job.beginWrite();
            job.targetCreated(new CreatedPlaylist("pl-old", "夏夜循环", "url", 0, Map.of()));
            job.complete(new CreatedPlaylist("pl-old", "夏夜循环", "url", 1, Map.of()));
        }
        return jobId;
    }

    private List<String> ids(JsonNode page) {
        List<String> ids = new java.util.ArrayList<>();
        page.path("items").forEach(item -> ids.add(item.path("id").asText()));
        return ids;
    }

    private JsonNode awaitStatus(MockHttpSession session, String jobId, String expected) throws Exception {
        JsonNode job = null;
        for (int attempt = 0; attempt < 240; attempt++) {
            job = getJson("/api/migrations/" + jobId, session);
            if (expected.equals(job.path("status").asText())) {
                return job;
            }
            Thread.sleep(50);
        }
        throw new AssertionError("Job " + jobId + " never reached " + expected + ": " + job);
    }

    private void connectDemo(MockHttpSession session, String provider) throws Exception {
        postJson("/api/connections/" + provider, session, Map.of("mode", "demo"));
    }

    private JsonNode getJson(String path) throws Exception {
        return getJson(path, principal, new MockHttpSession());
    }

    private JsonNode getJson(String path, MockHttpSession session) throws Exception {
        return getJson(path, principal, session);
    }

    private JsonNode getJson(String path, AccountPrincipal account, MockHttpSession session) throws Exception {
        MvcResult result = mvc.perform(BridgeRequests.as(BridgeRequests.get(path).session(session), account))
                .andExpect(status().isOk()).andReturn();
        return readBody(result);
    }

    private JsonNode postJson(String path, MockHttpSession session, Object body) throws Exception {
        MvcResult result = mvc.perform(BridgeRequests.as(
                        BridgeRequests.post(path).session(session)
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(objectMapper.writeValueAsString(body)), principal))
                .andExpect(status().is2xxSuccessful()).andReturn();
        return readBody(result);
    }

    private JsonNode readBody(MvcResult result) throws Exception {
        return objectMapper.readTree(result.getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    private AccountPrincipal account() {
        String username = "h" + UUID.randomUUID().toString().replace("-", "").substring(0, 15);
        accounts.register(username, PASSWORD, null);
        return accounts.loadUserByUsername(username);
    }
}
