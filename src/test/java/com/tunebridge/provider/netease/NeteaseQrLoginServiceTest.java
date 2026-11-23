package com.tunebridge.provider.netease;

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

import com.tunebridge.domain.ConnectionMode;
import com.tunebridge.domain.ProviderConnection;
import com.tunebridge.domain.ProviderId;
import com.tunebridge.provider.ProviderException;
import com.tunebridge.provider.netease.NeteaseWebClient.QrStatus;
import com.tunebridge.service.ConnectionService;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpSession;

class NeteaseQrLoginServiceTest {

    private static final String COOKIE = "MUSIC_U=token; NMTID=abc";

    private final NeteaseWebClient client = mock(NeteaseWebClient.class);
    private final ConnectionService connections = mock(ConnectionService.class);
    private final NeteaseQrLoginService service = new NeteaseQrLoginService(client, connections);

    @BeforeEach
    void handOutAKey() {
        when(client.requestQrKey()).thenReturn("unikey-1");
    }

    @Test
    void rendersTheQrTargetAndReusesItWhileItIsStillValid() {
        MockHttpSession session = new MockHttpSession();
        NeteaseQrLoginService.StartView first = service.start(session);
        NeteaseQrLoginService.StartView second = service.start(session);

        assertThat(first.target()).isEqualTo("https://music.163.com/login?codekey=unikey-1");
        assertThat(first.svg()).startsWith("<svg").contains("<path");
        assertThat(second.loginId()).isEqualTo(first.loginId());
        verify(client, times(1)).requestQrKey();
    }

    @Test
    void bindsEveryLoginToTheSessionThatAskedForIt() {
        String loginId = service.start(new MockHttpSession()).loginId();
        MockHttpSession stranger = new MockHttpSession();

        assertThatThrownBy(() -> service.poll(stranger, loginId))
                .isInstanceOf(ProviderException.class)
                .hasMessageContaining("已失效");
        verify(client, never()).pollQr(anyString());
    }

    @Test
    void connectsTheAccountOnceThePhoneConfirmsAndRetiresTheLogin() {
        MockHttpSession session = new MockHttpSession();
        String loginId = service.start(session).loginId();
        when(client.pollQr("unikey-1")).thenReturn(new QrStatus(803, "登录成功", COOKIE));
        when(connections.connect(eq(session), eq(ProviderId.NETEASE_MUSIC), eq("real"), any()))
                .thenReturn(new ProviderConnection(ProviderId.NETEASE_MUSIC, ConnectionMode.REAL,
                        "网易云音乐 · 小明", Map.of("neteaseCookie", COOKIE)));

        NeteaseQrLoginService.PollView view = service.poll(session, loginId);

        assertThat(view.state()).isEqualTo("connected");
        assertThat(view.accountName()).isEqualTo("网易云音乐 · 小明");
        verify(connections).connect(session, ProviderId.NETEASE_MUSIC, "real", Map.of("cookie", COOKIE));
        assertThatThrownBy(() -> service.poll(session, loginId)).isInstanceOf(ProviderException.class);
    }

    @Test
    void reportsAnExpiredCodeOnlyOnceAndThenRetiresTheLogin() {
        MockHttpSession session = new MockHttpSession();
        String loginId = service.start(session).loginId();
        when(client.pollQr("unikey-1")).thenReturn(new QrStatus(800, "二维码已过期", ""));

        NeteaseQrLoginService.PollView view = service.poll(session, loginId);

        assertThat(view.state()).isEqualTo("expired");
        assertThat(view.message()).contains("重新获取");
        assertThatThrownBy(() -> service.poll(session, loginId)).isInstanceOf(ProviderException.class);
    }

    @Test
    void throttlesPollingSoOneScanCannotFloodUpstream() {
        MockHttpSession session = new MockHttpSession();
        String loginId = service.start(session).loginId();
        when(client.pollQr("unikey-1")).thenReturn(new QrStatus(801, "等待扫码", ""));

        NeteaseQrLoginService.PollView first = service.poll(session, loginId);
        NeteaseQrLoginService.PollView second = service.poll(session, loginId);

        assertThat(first.state()).isEqualTo("waiting");
        assertThat(second).isSameAs(first);
        verify(client, times(1)).pollQr("unikey-1");
    }

    @Test
    void keepsAScannedCodePendingUntilTheUserConfirmsOnThePhone() {
        MockHttpSession session = new MockHttpSession();
        String loginId = service.start(session).loginId();
        when(client.pollQr("unikey-1")).thenReturn(new QrStatus(802, "已扫码", ""));

        NeteaseQrLoginService.PollView view = service.poll(session, loginId);

        assertThat(view.state()).isEqualTo("scanned");
        assertThat(view.message()).contains("确认");
        verify(connections, never()).connect(any(), any(), anyString(), any());
    }

    @Test
    void reportsTheUpstreamCodeWhenTheLoginStateIsUnexpected() {
        MockHttpSession session = new MockHttpSession();
        String loginId = service.start(session).loginId();
        when(client.pollQr("unikey-1")).thenReturn(new QrStatus(502, "该账号存在风险，请稍后再试", ""));

        NeteaseQrLoginService.PollView view = service.poll(session, loginId);

        assertThat(view.state()).isEqualTo("failed");
        assertThat(view.message()).contains("502").contains("该账号存在风险");
        verify(connections, never()).connect(any(), any(), anyString(), any());
    }

    @Test
    void reportsAMissingLoginCodeWithoutAnEmptyStatusCode() {
        MockHttpSession session = new MockHttpSession();
        String loginId = service.start(session).loginId();
        when(client.pollQr("unikey-1")).thenReturn(new QrStatus(0, "", ""));

        NeteaseQrLoginService.PollView view = service.poll(session, loginId);

        assertThat(view.state()).isEqualTo("failed");
        assertThat(view.message()).contains("响应里没有登录状态码").doesNotContain("状态码 0");
    }
}
