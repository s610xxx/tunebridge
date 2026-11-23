package com.tunebridge.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.tunebridge.config.TuneBridgeProperties;
import com.tunebridge.domain.ConnectionMode;
import com.tunebridge.domain.ProviderConnection;
import com.tunebridge.domain.ProviderId;
import com.tunebridge.provider.netease.NeteaseQrLoginService;
import com.tunebridge.provider.netease.NeteaseWebClient;
import com.tunebridge.provider.netease.NeteaseWebClient.QrStatus;
import com.tunebridge.service.ConnectionService;
import com.tunebridge.testsupport.BridgeRequests;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class NeteaseQrLoginApiTest {

    private static final String COOKIE = "MUSIC_U=secret-token; NMTID=abc";

    private final NeteaseWebClient client = mock(NeteaseWebClient.class);
    private final ConnectionService connections = mock(ConnectionService.class);
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final MockMvc mvc = MockMvcBuilders
            .standaloneSetup(new ApiController(null, connections, null, null,
                    new TuneBridgeProperties(), null, null,
                    new NeteaseQrLoginService(client, connections)))
            .setControllerAdvice(new ApiExceptionHandler()).build();

    @BeforeEach
    void handOutAKey() {
        when(client.requestQrKey()).thenReturn(new NeteaseWebClient.QrKeyResult("unikey-1", List.of()));
    }

    @Test
    void handsBackAnInlineSvgWithoutAnyCredential() throws Exception {
        MvcResult result = mvc.perform(BridgeRequests.post("/api/connections/netease/qr")
                        .session(new MockHttpSession()))
                .andExpect(status().isOk()).andReturn();

        JsonNode body = read(result);
        assertThat(body.path("loginId").asText()).matches("[0-9a-f]{32}");
        assertThat(body.path("svg").asText()).startsWith("<svg").contains("<path");
        assertThat(body.path("target").asText()).isEqualTo("https://music.163.com/login?codekey=unikey-1");
        assertThat(body.path("expiresInSeconds").asInt()).isEqualTo(120);
        assertThat(result.getResponse().getContentAsString(StandardCharsets.UTF_8)).doesNotContain("secret-token");
    }

    @Test
    void surfacesTheScanProgressReportedByThePlatform() throws Exception {
        MockHttpSession session = new MockHttpSession();
        String loginId = start(session);
        when(client.pollQr(eq("unikey-1"), any())).thenReturn(new QrStatus(802, "已扫码，请在手机上确认", ""));

        JsonNode scanned = read(mvc.perform(BridgeRequests.get("/api/connections/netease/qr/" + loginId)
                .session(session)).andExpect(status().isOk()).andReturn());

        assertThat(scanned.path("state").asText()).isEqualTo("scanned");
        assertThat(scanned.path("message").asText()).contains("确认");
        verifyNoInteractions(connections);
    }

    @Test
    void connectsTheAccountOnConfirmationWithoutEchoingTheCookie() throws Exception {
        MockHttpSession session = new MockHttpSession();
        String loginId = start(session);
        when(connections.connect(eq(session), eq(ProviderId.NETEASE_MUSIC), eq("real"), any()))
                .thenReturn(new ProviderConnection(ProviderId.NETEASE_MUSIC, ConnectionMode.REAL,
                        "网易云音乐 · 小明", Map.of("neteaseCookie", COOKIE)));
        when(client.pollQr(eq("unikey-1"), any())).thenReturn(new QrStatus(803, "登录成功", COOKIE));

        MvcResult result = mvc.perform(BridgeRequests.get("/api/connections/netease/qr/" + loginId)
                .session(session)).andExpect(status().isOk()).andReturn();

        JsonNode body = read(result);
        assertThat(body.path("state").asText()).isEqualTo("connected");
        assertThat(body.path("accountName").asText()).isEqualTo("网易云音乐 · 小明");
        assertThat(result.getResponse().getContentAsString(StandardCharsets.UTF_8)).doesNotContain("secret-token");
    }

    @Test
    void rejectsLoginsRequestedByAnotherSession() throws Exception {
        String loginId = start(new MockHttpSession());

        JsonNode denied = read(mvc.perform(BridgeRequests.get("/api/connections/netease/qr/" + loginId)
                .session(new MockHttpSession())).andExpect(status().isBadRequest()).andReturn());

        assertThat(denied.path("code").asText()).isEqualTo("INVALID_INPUT");
        assertThat(denied.path("error").asText()).contains("失效");
        verifyNoInteractions(connections);
    }

    private String start(MockHttpSession session) throws Exception {
        return read(mvc.perform(BridgeRequests.post("/api/connections/netease/qr").session(session))
                .andExpect(status().isOk()).andReturn()).path("loginId").asText();
    }

    private JsonNode read(MvcResult result) throws Exception {
        return objectMapper.readTree(result.getResponse().getContentAsString(StandardCharsets.UTF_8));
    }
}
