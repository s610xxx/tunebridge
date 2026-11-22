package com.tunebridge.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.tunebridge.domain.ProviderId;
import com.tunebridge.domain.Track;
import com.tunebridge.provider.demo.DemoStore;
import com.tunebridge.security.AccountPrincipal;
import com.tunebridge.security.AccountService;
import com.tunebridge.testsupport.BridgeRequests;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

@SpringBootTest(properties = "spring.datasource.url=jdbc:h2:mem:source_playlists;DB_CLOSE_DELAY=-1")
@AutoConfigureMockMvc
class SourcePlaylistListApiTest {

    private static final String PASSWORD = "source-list-password";

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private AccountService accounts;

    @Autowired
    private DemoStore demoStore;

    @Test
    void listsWhatTheConnectedSourceAccountCanMigrate() throws Exception {
        AccountPrincipal account = account();
        MockHttpSession session = new MockHttpSession();
        connectDemo(account, session, "QQ_MUSIC");
        connectDemo(account, session, "APPLE_MUSIC");
        var created = demoStore.create(session.getId(), ProviderId.APPLE_MUSIC, "上次迁完的歌单", "");
        demoStore.addTracks(session.getId(), ProviderId.APPLE_MUSIC, created.id(),
                List.of(new Track("d1", "晴天", "周杰伦", "叶惠美", 269, "", 0)));

        JsonNode apple = get(account, session, "/api/playlists?provider=APPLE_MUSIC");
        assertThat(apple).hasSize(2);
        assertThat(apple.get(0).path("url").asText()).isEqualTo("demo://builtin");
        assertThat(apple.get(0).path("trackCount").asInt()).isEqualTo(10);
        assertThat(apple.get(1).path("id").asText()).isEqualTo(created.id());
        assertThat(apple.get(1).path("name").asText()).isEqualTo("上次迁完的歌单");
        assertThat(apple.get(1).path("trackCount").asInt()).isEqualTo(1);

        assertThat(get(account, session, "/api/playlists?provider=QQ_MUSIC")).singleElement()
                .extracting(ref -> ref.path("url").asText()).isEqualTo("demo://builtin");
    }

    @Test
    void refusesWhenTheSourceAccountIsNotConnectedYet() throws Exception {
        AccountPrincipal account = account();
        MvcResult result = mvc.perform(BridgeRequests.as(
                        BridgeRequests.get("/api/playlists?provider=QQ_MUSIC").session(new MockHttpSession()),
                        account))
                .andExpect(status().isConflict()).andReturn();

        JsonNode body = readBody(result);
        assertThat(body.path("code").asText()).isEqualTo("NOT_CONNECTED");
        assertThat(body.path("error").asText()).contains("请先连接");
    }

    @Test
    void rejectsProvidersThatCannotActAsABatchSource() throws Exception {
        AccountPrincipal account = account();
        MockHttpSession session = new MockHttpSession();
        connectDemo(account, session, "NETEASE_MUSIC");

        JsonNode netease = expectError(account, session, "/api/playlists?provider=NETEASE_MUSIC", 400);
        assertThat(netease.path("error").asText()).contains("网易云音乐暂不支持作为来源平台");

        assertThat(expectError(account, session, "/api/playlists?provider=SPOTIFY", 400).path("code").asText())
                .isEqualTo("INVALID_INPUT");
        assertThat(expectError(account, session, "/api/playlists", 400).path("code").asText())
                .isEqualTo("MISSING_PARAMETER");
    }

    @Test
    void showsEachDemoAccountOnlyItsOwnCreatedPlaylists() throws Exception {
        AccountPrincipal owner = account();
        MockHttpSession ownerSession = new MockHttpSession();
        connectDemo(owner, ownerSession, "QQ_MUSIC");
        var created = demoStore.create(ownerSession.getId(), ProviderId.QQ_MUSIC, "仅本人可见", "");
        demoStore.addTracks(ownerSession.getId(), ProviderId.QQ_MUSIC, created.id(),
                List.of(new Track("d1", "稻香", "周杰伦", "魔杰座", 223, "", 0)));

        AccountPrincipal neighbour = account();
        MockHttpSession neighbourSession = new MockHttpSession();
        connectDemo(neighbour, neighbourSession, "QQ_MUSIC");

        assertThat(get(neighbour, neighbourSession, "/api/playlists?provider=QQ_MUSIC"))
                .extracting(ref -> ref.path("name").asText()).containsExactly("夏夜循环 · 华语流行");
    }

    @Test
    void requiresAnAccountBeforeListingAnything() throws Exception {
        mvc.perform(BridgeRequests.get("/api/playlists?provider=QQ_MUSIC"))
                .andExpect(status().isUnauthorized());
    }

    private void connectDemo(AccountPrincipal account, MockHttpSession session, String provider) throws Exception {
        MvcResult result = mvc.perform(BridgeRequests.as(BridgeRequests.post("/api/connections/" + provider)
                        .session(session)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("mode", "demo"))), account))
                .andExpect(status().is2xxSuccessful()).andReturn();
        readBody(result);
    }

    private JsonNode get(AccountPrincipal account, MockHttpSession session, String path) throws Exception {
        MvcResult result = mvc.perform(BridgeRequests.as(BridgeRequests.get(path).session(session), account))
                .andExpect(status().isOk()).andReturn();
        return readBody(result);
    }

    private JsonNode expectError(AccountPrincipal account, MockHttpSession session, String path, int code)
            throws Exception {
        MvcResult result = mvc.perform(BridgeRequests.as(BridgeRequests.get(path).session(session), account))
                .andExpect(status().is(code)).andReturn();
        return readBody(result);
    }

    private JsonNode readBody(MvcResult result) throws Exception {
        return objectMapper.readTree(result.getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    private AccountPrincipal account() {
        String username = "src" + UUID.randomUUID().toString().replace("-", "").substring(0, 14);
        accounts.register(username, PASSWORD, null);
        return accounts.loadUserByUsername(username);
    }
}
