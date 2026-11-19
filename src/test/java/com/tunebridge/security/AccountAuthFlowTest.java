package com.tunebridge.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.tunebridge.testsupport.BridgeRequests;
import java.nio.charset.StandardCharsets;
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

@SpringBootTest(properties = "spring.datasource.url=jdbc:h2:mem:auth_flow;DB_CLOSE_DELAY=-1")
@AutoConfigureMockMvc
class AccountAuthFlowTest {

    private static final String PASSWORD = "a-bridge-test-password";

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private AccountService accounts;

    @Test
    void rejectsAnonymousApiAccessButServesTheAuthSnapshot() throws Exception {
        MockHttpSession session = new MockHttpSession();

        MvcResult denied = mvc.perform(BridgeRequests.get("/api/state").session(session))
                .andExpect(status().isUnauthorized()).andReturn();
        assertThat(body(denied).path("code").asText()).isEqualTo("AUTH_REQUIRED");

        JsonNode auth = body(mvc.perform(BridgeRequests.get("/api/auth").session(session))
                .andExpect(status().isOk()).andReturn());
        assertThat(auth.path("authenticated").asBoolean()).isFalse();
        assertThat(auth.path("username").isNull()).isTrue();
        assertThat(auth.path("csrfToken").asText()).isNotBlank();
        assertThat(auth.path("csrfHeader").asText()).isNotBlank();
        assertThat(auth.path("mode").asText()).isEqualTo("local");
        assertThat(auth.path("registrationCodeRequired").asBoolean()).isFalse();
    }

    @Test
    void loginGrantsApiAccessAndLogoutRevokesIt() throws Exception {
        String username = randomUsername();
        MockHttpSession session = new MockHttpSession();
        register(session, username, PASSWORD);

        mvc.perform(BridgeRequests.form("/api/auth/login").session(session)
                        .param("username", username).param("password", PASSWORD))
                .andExpect(status().isOk());

        JsonNode auth = body(mvc.perform(BridgeRequests.get("/api/auth").session(session))
                .andExpect(status().isOk()).andReturn());
        assertThat(auth.path("authenticated").asBoolean()).isTrue();
        assertThat(auth.path("username").asText()).isEqualTo(username.toLowerCase());

        mvc.perform(BridgeRequests.as(BridgeRequests.get("/api/state").session(session),
                        accounts.loadUserByUsername(username)))
                .andExpect(status().isOk());

        mvc.perform(BridgeRequests.form("/api/auth/logout").session(session))
                .andExpect(status().isNoContent());
        MvcResult afterLogout = mvc.perform(BridgeRequests.get("/api/state").session(session))
                .andExpect(status().isUnauthorized()).andReturn();
        assertThat(body(afterLogout).path("code").asText()).isEqualTo("AUTH_REQUIRED");
    }

    @Test
    void normalizesTheUsernameAndRejectsWeakOrDuplicateRegistrations() throws Exception {
        MockHttpSession session = new MockHttpSession();
        String username = randomUsername();

        assertThat(body(register(session, username.toUpperCase(), PASSWORD))
                .path("registered").asBoolean()).isTrue();
        assertThat(accounts.loadUserByUsername(username).getUsername()).isEqualTo(username.toLowerCase());

        for (Map<String, String> attempt : java.util.List.of(
                Map.of("username", username, "password", PASSWORD),
                Map.of("username", " " + username + " ", "password", PASSWORD),
                Map.of("username", "ab", "password", PASSWORD),
                Map.of("username", "has-dash", "password", PASSWORD),
                Map.of("username", username, "password", "short-password"),
                Map.of("username", username, "password", "x".repeat(200)))) {
            MvcResult rejected = mvc.perform(BridgeRequests.post("/api/auth/register").session(session)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(attempt)))
                    .andExpect(status().isBadRequest()).andReturn();
            assertThat(body(rejected).path("code").asText()).isEqualTo("REGISTRATION_FAILED");
            assertThat(body(rejected).path("error").asText()).doesNotContain(username);
        }
    }

    @Test
    void keepsLoginFailuresIndistinguishableAndRequiresLogoutFirst() throws Exception {
        String username = randomUsername();
        MockHttpSession session = new MockHttpSession();
        register(session, username, PASSWORD);

        for (Map<String, String> attempt : java.util.List.of(
                Map.of("username", username, "password", "wrong-but-long-enough"),
                Map.of("username", "nobody_here", "password", PASSWORD),
                Map.of("username", username, "password", "short"),
                Map.of("username", username.toUpperCase(), "password", "wrong-but-long-enough"))) {
            var builder = BridgeRequests.form("/api/auth/login").session(session);
            attempt.forEach(builder::param);
            MvcResult failed = mvc.perform(builder).andExpect(status().isUnauthorized()).andReturn();
            assertThat(body(failed).path("code").asText()).isEqualTo("LOGIN_FAILED");
        }

        // Duplicated credentials are never guessed at; they are refused before authentication.
        MvcResult duplicated = mvc.perform(BridgeRequests.form("/api/auth/login").session(session)
                        .param("username", username).param("password", PASSWORD).param("password", PASSWORD))
                .andExpect(status().isUnauthorized()).andReturn();
        assertThat(body(duplicated).path("code").asText()).isEqualTo("LOGIN_FAILED");

        mvc.perform(BridgeRequests.form("/api/auth/login").session(session)
                        .param("username", username).param("password", PASSWORD))
                .andExpect(status().isOk());
        MvcResult whileLoggedIn = mvc.perform(BridgeRequests.form("/api/auth/login").session(session)
                        .param("username", username).param("password", PASSWORD))
                .andExpect(status().isConflict()).andReturn();
        assertThat(body(whileLoggedIn).path("code").asText()).isEqualTo("LOGOUT_REQUIRED");
    }

    @Test
    void requiresTheSessionCsrfTokenForEveryMutation() throws Exception {
        MockHttpSession session = new MockHttpSession();
        String username = randomUsername();
        register(session, username, PASSWORD);
        AccountPrincipal principal = accounts.loadUserByUsername(username);

        MvcResult missingToken = mvc.perform(BridgeRequests.as(
                        BridgeRequests.unguardedPost("/api/connections/QQ_MUSIC").session(session)
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(objectMapper.writeValueAsString(Map.of("mode", "demo"))), principal))
                .andExpect(status().isForbidden()).andReturn();
        assertThat(body(missingToken).path("code").asText()).isEqualTo("CSRF_INVALID");

        MvcResult withToken = mvc.perform(BridgeRequests.as(
                        BridgeRequests.post("/api/connections/QQ_MUSIC").session(session)
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(objectMapper.writeValueAsString(Map.of("mode", "demo"))), principal))
                .andExpect(status().isOk()).andReturn();
        assertThat(body(withToken).path("mode").asText()).isEqualTo("DEMO");
    }

    @Test
    void rejectsUntrustedOriginsProxiesAndOversizedBodies() throws Exception {
        MockHttpSession session = new MockHttpSession();
        String username = randomUsername();
        register(session, username, PASSWORD);
        AccountPrincipal principal = accounts.loadUserByUsername(username);

        MvcResult crossSite = mvc.perform(BridgeRequests.as(BridgeRequests.post("/api/playlists/preview")
                        .session(session).header("Origin", "https://evil.example")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"provider\":\"QQ_MUSIC\",\"url\":\"demo://builtin\"}"), principal))
                .andExpect(status().isForbidden()).andReturn();
        assertThat(body(crossSite).path("code").asText()).isEqualTo("BOUNDARY_REJECTED");

        MvcResult forwarded = mvc.perform(BridgeRequests.as(BridgeRequests.post("/api/playlists/preview")
                        .session(session).header("X-Forwarded-For", "203.0.113.9")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"provider\":\"QQ_MUSIC\",\"url\":\"demo://builtin\"}"), principal))
                .andExpect(status().isForbidden()).andReturn();
        assertThat(body(forwarded).path("code").asText()).isEqualTo("BOUNDARY_REJECTED");

        MvcResult remote = mvc.perform(BridgeRequests.get("/api/state").header("Host", "tunebridge.example:8080"))
                .andExpect(status().isForbidden()).andReturn();
        assertThat(body(remote).path("code").asText()).isEqualTo("BOUNDARY_REJECTED");

        MvcResult tooLarge = mvc.perform(BridgeRequests.as(BridgeRequests.post("/api/playlists/preview")
                        .session(session).contentType(MediaType.APPLICATION_JSON)
                        .content("{\"provider\":\"QQ_MUSIC\",\"url\":\"" + "a".repeat(70 * 1024) + "\"}"), principal))
                .andExpect(status().isPayloadTooLarge()).andReturn();
        assertThat(body(tooLarge).path("code").asText()).isEqualTo("REQUEST_TOO_LARGE");
    }

    private MvcResult register(MockHttpSession session, String username, String password) throws Exception {
        return mvc.perform(BridgeRequests.post("/api/auth/register").session(session)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("username", username, "password", password))))
                .andExpect(status().isCreated()).andReturn();
    }

    private static String randomUsername() {
        return "u" + UUID.randomUUID().toString().replace("-", "").substring(0, 15);
    }

    private JsonNode body(MvcResult result) throws Exception {
        return objectMapper.readTree(result.getResponse().getContentAsString(StandardCharsets.UTF_8));
    }
}
